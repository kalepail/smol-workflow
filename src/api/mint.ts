import { Hono, type Context, type Next } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { HonoEnv } from '../types'
import { parseAuth } from '../middleware/auth'
import { isLedgerSequence } from '../utils/chain'
import { parseIdList, parseTrackTarget, readChainTarget, type MintBatchRow } from '../utils/chain-target'
import { isWorkflowAlreadyExistsError, isWorkflowNotFoundError } from '../utils/workflow-errors'
import { readBoundedJsonObject } from '../utils/bounded-read'
import {
	assertMintConfig,
	assertUnsignedMintEnvelope,
	buildMintExpectation,
	decodeMintCarrier,
	isCanonicalMintId,
	MAX_COIN_THEM_TRACKS,
	MAX_MINT_REQUEST_BODY_BYTES,
	MintRejected,
	type DecodedMintCarrier,
	type MintKind,
	type MintTrack,
} from '../chain/mint-authorization'
import {
	assertMintEligible,
	assertMintVisible,
	assertNoUnresolvedMintReceipt,
	isMintedRow,
	MintIneligible,
	MintReceiptUnreadable,
	newMintClaimToken,
	readMintFacts,
	releaseMintPrefixesIfAbsent,
	reserveMintPrefixes,
} from '../utils/mint-eligibility'
import { privateNoStore, readJsonBody } from '../utils/http'

const mint = new Hono<HonoEnv>()

function mintError(status: ContentfulStatusCode, body: Record<string, unknown>): never {
	throw new HTTPException(status, { res: Response.json(body) })
}

/** Closed-by-default kill switch. Runs before auth, body reads, D1 claims and workflow creation. */
async function requireMintSigningEnabled(c: Context<HonoEnv, string>, next: Next) {
	if (c.env.MINT_SIGNING_ENABLED !== 'true') return c.json({ error: 'mint_paused' }, 503)
	await next()
}

/** The verified session must be a smart-wallet contract: it becomes `user` and the fee minter. */
function requireMintSession(c: Context<HonoEnv>): string {
	const sub = c.get('jwtPayload')?.sub
	if (typeof sub !== 'string' || !sub) throw new HTTPException(401, { message: 'User session required' })
	return sub
}

async function readMintBody(c: Context<HonoEnv>): Promise<Record<string, unknown>> {
	const body = await readBoundedJsonObject(c.req.raw, MAX_MINT_REQUEST_BODY_BYTES)
	if (body.ok) return body.value
	return body.reason === 'too_large'
		? mintError(413, { error: 'payload_too_large' })
		: mintError(400, { error: 'invalid_json' })
}

function logMintReject(route: string, code: string, sub: string, ids: readonly string[]) {
	console.warn(JSON.stringify({ event: 'mint_validation_reject', route, code, sub, ids: ids.filter(isCanonicalMintId) }))
}

function rejectMint(route: string, sub: string, ids: readonly string[], error: unknown): never {
	if (error instanceof MintRejected) {
		logMintReject(route, error.code, sub, ids)
		if (error.code === 'config_mismatch' || error.code === 'network_mismatch') {
			mintError(503, { error: 'mint_unavailable' })
		}
		mintError(400, { error: 'mint_tx_rejected', code: error.code })
	}
	if (error instanceof MintReceiptUnreadable) {
		// Fail closed: an unresolved receipt whose songs cannot be read may cover any prefix.
		console.warn(JSON.stringify({ event: 'mint_receipt_unreadable', route, sub, workflow_ids: error.workflowIds }))
		mintError(503, { error: 'mint_unavailable' })
	}
	if (error instanceof MintIneligible) {
		logMintReject(route, error.code, sub, error.ids)
		switch (error.code) {
			case 'not_found':
				mintError(404, { error: 'not_found', ids: error.ids })
			case 'not_public':
				mintError(403, { error: 'mint_not_eligible', code: 'not_public', ids: error.ids })
			case 'missing_creator':
				mintError(400, { error: 'mint_not_eligible', code: 'missing_creator', ids: error.ids })
			case 'already_minted':
				mintError(409, { error: 'already_minted', ids: error.ids })
			case 'mint_in_progress':
			case 'dispatch_uncertain':
				mintError(409, { error: 'mint_in_progress', ids: error.ids })
			case 'prefix_minted':
			case 'prefix_reserved':
				mintError(409, { error: 'prefix_conflict', code: error.code })
		}
	}
	throw error
}

function decodeCarrierOrReject(route: string, sub: string, value: unknown, kind: MintKind): DecodedMintCarrier {
	try {
		return decodeMintCarrier(value, kind)
	} catch (error) {
		rejectMint(route, sub, [], error)
	}
}

function parseBatchIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COIN_THEM_TRACKS) {
		mintError(400, { error: 'invalid_ids' })
	}
	if (!value.every(isCanonicalMintId) || new Set(value).size !== value.length) {
		mintError(400, { error: 'invalid_ids' })
	}
	return value
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

/**
 * The workflow id is a pure function of the signed carrier: its salts in carrier order plus the
 * exact base64. Reordered or padded posted ids for identical XDR dedupe to the same workflow.
 */
function mintWorkflowId(carrier: DecodedMintCarrier, xdr: string): Promise<string> {
	return computeMintWorkflowId(carrier.kind === 'coin_it' ? 'mint' : 'batch-mint', [carrier.ids.join(','), xdr])
}

/**
 * Creates (or joins) the deduplicated workflow. When this admission fails (claim row or creation), it
 * releases the provisional claims it acquired (`claimToken`) only if the workflow is proven absent and
 * no identical-carrier admission ever joined the claim: a joiner may already have queued the workflow
 * and answered 202, and a lost creation response may have queued it too. Otherwise the claim is
 * retained under its creation lease until lease-expiry recovery verifies the workflow absent or
 * terminal. A claim this admission merely joined, or one another admission acquired, is never touched.
 */
async function createDedupedTxWorkflow(
	env: Env,
	id: string,
	params: WorkflowTxParams,
	claimToken: string,
): Promise<void> {
	const ids = params.mintableIds ?? [params.entropy!]
	let claim: unknown
	try {
		claim = await env.SMOL_D1.prepare(`
			INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids) VALUES (?1, ?2, ?3)
			ON CONFLICT (Workflow_Id) DO UPDATE SET Workflow_Id = excluded.Workflow_Id
			WHERE MintBatchStatus."Address" = excluded."Address"
			RETURNING Workflow_Id
		`).bind(id, params.sub, JSON.stringify(ids)).first()
	} catch {
		// This request created nothing, but a joining admission for the identical carrier may have.
		await releaseMintPrefixesIfAbsent(env, id, ids, claimToken)
		throw new HTTPException(503, { message: 'Mint admission unavailable' })
	}
	if (!claim) throw new HTTPException(409, { message: 'Mint workflow already exists' })

	let phase: 'queued' | 'existing' = 'queued'
	try {
		await env.TX_WORKFLOW.create({ id, params: { ...params, trackStatus: true } })
	} catch (error) {
		if (!isWorkflowAlreadyExistsError(error)) {
			// The creation response is ambiguous: the instance may be queued. The claim is released
			// only once the instance is proven absent (and never if another admission joined it).
			await releaseMintPrefixesIfAbsent(env, id, ids, claimToken)
			throw new HTTPException(503, { message: 'Mint workflow creation unavailable' })
		}
		// The duplicate can predate status checkpoints. Its submission history is unknown.
		phase = 'existing'
	}

	// A fast workflow or another accepted request may already have advanced the phase.
	await env.SMOL_D1.prepare(`
		UPDATE MintBatchStatus SET Phase = ?1
		WHERE Workflow_Id = ?2 AND "Address" = ?3
			AND (Phase = 'unverified' OR (Phase = 'existing' AND ?1 = 'queued'))
	`).bind(phase, id, params.sub).run()
}

mint.post('/', privateNoStore, requireMintSigningEnabled, parseAuth, async (c) => {
	const { env } = c
	const sub = requireMintSession(c)
	const body = await readMintBody(c)
	const ids = parseBatchIds(body.ids)
	const carrier = decodeCarrierOrReject('batch', sub, body.xdr, 'coin_them')
	// Every signed salt must be a posted id. Posted ids outside the carrier may only be ones that
	// are already minted (checked against D1 below).
	if (!carrier.ids.every((id) => ids.includes(id))) {
		rejectMint('batch', sub, ids, new MintRejected('ids_mismatch'))
	}

	let workflowId: string
	let tracks: MintTrack[]
	let acceptedIds: string[]
	let alreadyMinted: string[]
	const claimToken = newMintClaimToken()
	try {
		const identity = assertMintConfig(env)
		const facts = await readMintFacts(env, ids)
		// Visibility and creator first, for every posted id: a private or creatorless song never
		// reveals its mint status through no-work, stale_batch or skipped.
		assertMintVisible(ids, facts)
		alreadyMinted = ids.filter((id) => isMintedRow(facts.rows.get(id)!))
		// Nothing left to do: a retry after success. Nothing is signed or queued.
		if (alreadyMinted.length === ids.length) {
			return c.json({ workflowId: null, acceptedIds: [], skipped: { alreadyMinted } })
		}
		// The signed carrier itself includes a minted salt, so it can never succeed on-chain.
		if (carrier.ids.some((id) => alreadyMinted.includes(id))) {
			logMintReject('batch', 'stale_batch', sub, alreadyMinted)
			mintError(409, { error: 'stale_batch', alreadyMinted })
		}
		// The carrier must sign exactly the posted ids that are still unminted.
		acceptedIds = ids.filter((id) => !alreadyMinted.includes(id))
		if (acceptedIds.length !== carrier.ids.length) throw new MintRejected('ids_mismatch')
		tracks = assertMintEligible(carrier.ids, facts)
		assertUnsignedMintEnvelope(carrier, buildMintExpectation({ identity, kind: 'coin_them', sub, tracks }))
		workflowId = await mintWorkflowId(carrier, body.xdr as string)
		// Before any claim: another workflow's unresolved receipt (e.g. a pre-v7 one with no v7 lock).
		await assertNoUnresolvedMintReceipt(env, carrier.ids, { exceptWorkflowId: workflowId })
		await reserveMintPrefixes(env, workflowId, carrier.ids, 'admission', claimToken)
	} catch (error) {
		if (error instanceof HTTPException) throw error
		if (error instanceof MintRejected || error instanceof MintIneligible || error instanceof MintReceiptUnreadable) {
			rejectMint('batch', sub, ids, error)
		}
		throw new HTTPException(503, { message: 'Mint admission unavailable' })
	}

	// Do not require Smols.Address to match the authenticated user. Minting is
	// intentionally an artist/collector action, and public smols may be minted by
	// people who did not create the original generated smol.
	await createDedupedTxWorkflow(env, workflowId, {
		type: 'batch-mint',
		xdr: body.xdr as string,
		ids,
		mintableIds: [...carrier.ids],
		sub,
		ownerSubsById: Object.fromEntries(tracks.map(({ id, creator }) => [id, creator])),
	}, claimToken)

	return c.json({
		workflowId,
		acceptedIds,
		skipped: {
			alreadyMinted,
		},
	}, 202)
})

async function batchProgress(env: Env, batch: MintBatchRow) {
	const { phase, txHash, confirmedLedger } = batch
	const progress = {
		phase: phase === 'submitting' || phase === 'unverified' || phase === 'existing' ? 'queued' : phase,
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
		// A confirmed receipt remains authoritative if metadata persistence errors.
		if (phase === 'confirmed') return progress
		if (status === 'errored' || status === 'terminated') {
			return { ...progress, phase: phase === 'queued' ? 'failed' : 'uncertain' }
		}
		if (status === 'unknown' || status === 'complete') return { ...progress, phase: 'uncertain' }
	} catch (error) {
		if (isWorkflowNotFoundError(error)) {
			// Definitive absence: the instance can never run (again), so nothing will advance this
			// non-terminal row and it must never read as pending work.
			// - `unverified`: this admission's create() was ambiguous. A v7 signer cannot sign without first
			//   moving the row to `submitting`, so a still-unverified row with no instance was never signed
			//   (creation most likely never happened): `failed`, and the client may retry.
			// - `confirmed`: the on-chain receipt stays authoritative (metadata persistence pending).
			// - `queued`, `existing`, `submitting`, `submitted`: the instance existed (or, for `existing`,
			//   may predate status tracking) and its outcome is now unobservable. A `queued` row the signer
			//   refused without writing D1 (another workflow's unresolved or unreadable receipt) reads
			//   `failed` while the errored instance exists and `uncertain` once it is gone, never `queued`.
			if (phase === 'unverified') return { ...progress, phase: 'failed' }
			if (phase === 'confirmed') return progress
			return { ...progress, phase: 'uncertain' }
		}
		if (phase === 'unverified' || phase === 'existing') return { ...progress, phase: 'uncertain' }
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

mint.post('/:id', privateNoStore, requireMintSigningEnabled, parseAuth, async (c) => {
	const { env, req } = c
	const sub = requireMintSession(c)
	const id = req.param('id')
	if (!isCanonicalMintId(id)) mintError(400, { error: 'invalid_id' })
	const body = await readMintBody(c)
	const carrier = decodeCarrierOrReject('single', sub, body.xdr, 'coin_it')
	if (carrier.ids[0] !== id) rejectMint('single', sub, [id], new MintRejected('ids_mismatch'))

	let workflowId: string
	let creator: string
	const claimToken = newMintClaimToken()
	try {
		const identity = assertMintConfig(env)
		const [track] = assertMintEligible([id], await readMintFacts(env, [id]))
		creator = track.creator
		assertUnsignedMintEnvelope(carrier, buildMintExpectation({ identity, kind: 'coin_it', sub, tracks: [track] }))
		workflowId = await mintWorkflowId(carrier, body.xdr as string)
		// Before any claim: another workflow's unresolved receipt (e.g. a pre-v7 one with no v7 lock).
		await assertNoUnresolvedMintReceipt(env, [id], { exceptWorkflowId: workflowId })
		await reserveMintPrefixes(env, workflowId, [id], 'admission', claimToken)
	} catch (error) {
		if (error instanceof HTTPException) throw error
		if (error instanceof MintRejected || error instanceof MintIneligible || error instanceof MintReceiptUnreadable) {
			rejectMint('single', sub, [id], error)
		}
		throw new HTTPException(503, { message: 'Mint admission unavailable' })
	}

	await createDedupedTxWorkflow(env, workflowId, {
		type: 'mint',
		xdr: body.xdr as string,
		entropy: id,
		sub,
		ownerSub: creator,
	}, claimToken)

	return c.json({ workflowId }, 202)
})

export default mint
