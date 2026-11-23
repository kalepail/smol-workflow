import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { xdr as stellarXdr } from '@stellar/stellar-sdk/minimal'
import type { HonoEnv } from '../types'
import { parseAuth } from '../middleware/auth'
import { deriveMintPair, isLedgerSequence } from '../utils/chain'
import { parseIdList, parseTrackTarget, readChainTarget, type MintBatchRow } from '../utils/chain-target'
import { privateNoStore, readJsonBody } from './mixtapes'

const mint = new Hono<HonoEnv>()
const MAX_BATCH_MINT_IDS = 100
const D1_IN_CHUNK_SIZE = 90
// Current Mainnet Soroban contract_bandwidth_v0.tx_max_size_bytes.
const MAX_SIGNED_XDR_BYTES = 132096

function assertSignedXdr(value: unknown): string {
	if (!value || typeof value !== 'string') {
		throw new HTTPException(400, { message: 'Missing signed transaction' })
	}

	let byteLength: number
	try {
		byteLength = stellarXdr.TransactionEnvelope.fromXDR(value, 'base64').toXDR().length
	} catch {
		throw new HTTPException(400, { message: 'Invalid signed transaction XDR' })
	}

	if (byteLength > MAX_SIGNED_XDR_BYTES) {
		throw new HTTPException(400, { message: `Signed transaction exceeds ${MAX_SIGNED_XDR_BYTES} bytes` })
	}

	return value
}

function assertMintIds(value: unknown): string[] {
	if (!value || !Array.isArray(value) || value.length === 0) {
		throw new HTTPException(400, { message: 'Missing or invalid ids array' })
	}

	if (value.length > MAX_BATCH_MINT_IDS) {
		throw new HTTPException(400, { message: `Max ${MAX_BATCH_MINT_IDS} smols per batch mint` })
	}

	const ids = value.map((id) => {
		if (typeof id !== 'string' || !id.trim()) {
			throw new HTTPException(400, { message: 'Invalid smol id in ids array' })
		}

		return id.trim()
	})

	if (new Set(ids).size !== ids.length) {
		throw new HTTPException(400, { message: 'Duplicate smol ids are not allowed' })
	}

	return ids
}

async function computeMintWorkflowId(prefix: string, parts: string[]): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(parts.join(':'))
	)
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
	return `${prefix}-${hex.slice(0, 48)}`
}

function isDuplicateWorkflowError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error)
	return /already\s*exists|duplicate|instance.*exists/i.test(msg)
}

async function createDedupedTxWorkflow(
	env: Env,
	id: string,
	params: WorkflowTxParams
): Promise<void> {
	const ids = params.mintableIds ?? [params.entropy!]
	const claim = await env.SMOL_D1.prepare(`
		INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids) VALUES (?1, ?2, ?3)
		ON CONFLICT (Workflow_Id) DO UPDATE SET Workflow_Id = excluded.Workflow_Id
		WHERE MintBatchStatus."Address" = excluded."Address"
		RETURNING Workflow_Id
	`).bind(id, params.sub, JSON.stringify(ids)).first()
	if (!claim) throw new HTTPException(409, { message: 'Mint workflow already exists' })

	try {
		await env.TX_WORKFLOW.create({ id, params: { ...params, trackStatus: true } })
	} catch (err) {
		if (!isDuplicateWorkflowError(err)) {
			throw new HTTPException(503, { message: 'Mint workflow creation unavailable' })
		}
	}
}

mint.post('/', parseAuth, async (c) => {
	const { env, req } = c
	const payload = c.get('jwtPayload')
	if (typeof payload?.sub !== 'string' || !payload.sub) throw new HTTPException(401, { message: 'User session required' })
	const body = await req.json() as { xdr?: string; ids?: string[] }
	const xdr = assertSignedXdr(body?.xdr)
	const ids = assertMintIds(body?.ids)

	type MintSmolRow = {
		Id: string
		Title: string
		Address: string | null
		Mint_Token: string | null
		Mint_Amm: string | null
	}

	const allResults: MintSmolRow[] = []
	for (let i = 0; i < ids.length; i += D1_IN_CHUNK_SIZE) {
		const chunk = ids.slice(i, i + D1_IN_CHUNK_SIZE)
		const chunkResult = await env.SMOL_D1.prepare(
			`SELECT Id, Title, Address, Mint_Token, Mint_Amm FROM Smols WHERE Id IN (${chunk.map(() => '?').join(', ')})`
		)
			.bind(...chunk)
			.all<MintSmolRow>()
		allResults.push(...(chunkResult.results ?? []))
	}

	if (allResults.length === 0) {
		throw new HTTPException(404, { message: 'No smols found' })
	}

	if (allResults.length !== ids.length) {
		throw new HTTPException(404, { message: 'Some smols not found' })
	}

	const recordsById = new Map(allResults.map((record) => [record.Id, record]))
	const ownerSubsById: Record<string, string> = {}
	const mintableIds: string[] = []
	const alreadyMintedIds: string[] = []

	for (const id of ids) {
		const record = recordsById.get(id)!
		if (!record.Address) {
			throw new HTTPException(404, { message: `Smol ${record.Id} not found` })
		}

		ownerSubsById[record.Id] = record.Address

		if (record.Mint_Token || record.Mint_Amm) {
			alreadyMintedIds.push(record.Id)
		} else {
			mintableIds.push(record.Id)
		}
	}

	if (mintableIds.length === 0) {
		return c.json({
			workflowId: null,
			acceptedIds: [],
			skipped: {
				alreadyMinted: alreadyMintedIds,
			},
		})
	}

	const workflowId = await computeMintWorkflowId('batch-mint', [mintableIds.join(','), xdr])

	// Do not require Smols.Address to match the authenticated user. Minting is
	// intentionally an artist/collector action, and public smols may be minted by
	// people who did not create the original generated smol.
	await createDedupedTxWorkflow(env, workflowId, {
		type: 'batch-mint',
		xdr,
		ids,
		mintableIds,
		sub: payload.sub,
		ownerSubsById,
	})

	return c.json({
		workflowId,
		acceptedIds: mintableIds,
		skipped: {
			alreadyMinted: alreadyMintedIds,
		},
	}, 202)
})

async function batchProgress(env: Env, batch: MintBatchRow) {
	const { phase, txHash, confirmedLedger } = batch
	const progress = {
		phase: phase === 'submitting' ? 'queued' : phase,
		...(txHash ? { txHash } : {}),
		...(confirmedLedger ? { confirmedLedger } : {}),
	}
	if (phase === 'persisted' || phase === 'failed') return progress
	try {
		const instance = await env.TX_WORKFLOW.get(batch.workflowId)
		const { status, output } = await instance.status()
		if (status === 'complete' && output && typeof output === 'object' && 'hash' in output
			&& typeof output.hash === 'string' && /^[0-9a-f]{64}$/.test(output.hash)) {
			// The workflow can settle after the D1 read. Its final output follows persistence.
			const ledger = 'ledger' in output && isLedgerSequence(output.ledger) ? output.ledger : confirmedLedger
			return { phase: 'persisted', txHash: output.hash, ...(ledger ? { confirmedLedger: ledger } : {}) }
		}
		if (status === 'errored' || status === 'terminated') {
			return { ...progress, phase: phase === 'queued' ? 'failed' : 'uncertain' }
		}
		if (status === 'unknown' || status === 'complete') return { ...progress, phase: 'uncertain' }
	} catch {
		// A transient Workflow lookup failure leaves the durable D1 checkpoint usable.
	}
	return progress
}

mint.post('/status', privateNoStore, parseAuth, async (c) => {
	const sub = c.get('jwtPayload')?.sub
	if (typeof sub !== 'string' || !sub) throw new HTTPException(401, { message: 'User session required' })
	const body = await readJsonBody(c)
	const workflowIds = body.workflowIds === undefined ? [] : parseIdList(body.workflowIds, 'workflow IDs')
	const ids = body.ids === undefined ? [] : parseIdList(body.ids, 'track IDs')
	const target = body.target === undefined ? (ids.length ? { trackIds: ids } : undefined) : parseTrackTarget(body.target)
	if (!target && !workflowIds.length) throw new HTTPException(400, { message: 'Supply a target, IDs or workflow IDs' })

	const { revision, batches, tracks } = await readChainTarget(c.env, target, sub, workflowIds)
	const visible = new Set(tracks.map(({ Id }) => Id))
	const selected = batches.map((batch) => ({ ...batch, ids: batch.ids.filter((id) => visible.has(id)) }))
	const statuses = []
	for (let i = 0; i < selected.length; i += 20) {
		const group = await Promise.all(selected.slice(i, i + 20).map(async (batch) => ({
			workflowId: batch.workflowId,
			ids: batch.ids,
			...await batchProgress(c.env, batch),
		})))
		statuses.push(...group)
	}
	return c.json({
		revision,
		batches: statuses,
		tracks: tracks.map(({ Id, Mint_Token, Mint_Amm }) => ({ id: Id, sac: Mint_Token, pool: Mint_Amm })),
	})
})

mint.post('/:id', parseAuth, async (c) => {
	const { env, req } = c
	const payload = c.get('jwtPayload')
	if (typeof payload?.sub !== 'string' || !payload.sub) throw new HTTPException(401, { message: 'User session required' })
	const id = req.param('id')
	const body = await req.json() as { xdr?: string }
	const xdr = assertSignedXdr(body?.xdr)

	if (!deriveMintPair(id)) {
		throw new HTTPException(400, { message: 'Invalid canonical smol ID' })
	}

	const smolRecord = await env.SMOL_D1.prepare(
		`SELECT Title, Address, Mint_Token, Mint_Amm FROM Smols WHERE Id = ?1`
	)
		.bind(id)
		.first<{
			Title: string
			Address: string | null
			Mint_Token: string | null
			Mint_Amm: string | null
		}>()

	if (!smolRecord) {
		throw new HTTPException(404, { message: 'Smol not found' })
	}

	if (smolRecord.Mint_Token || smolRecord.Mint_Amm) {
		throw new HTTPException(409, { message: 'Smol already minted' })
	}

	if (!smolRecord.Address) {
		throw new HTTPException(404, { message: 'Smol not found' })
	}

	const workflowId = await computeMintWorkflowId('mint', [id, xdr])

	await createDedupedTxWorkflow(env, workflowId, {
		type: 'mint',
		xdr,
		entropy: id,
		sub: payload.sub,
		ownerSub: smolRecord.Address,
	})

	return c.body(null, 202)
})

export default mint
