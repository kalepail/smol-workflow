import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { xdr as stellarXdr } from '@stellar/stellar-sdk/minimal'
import type { HonoEnv } from '../types'
import { parseAuth } from '../middleware/auth'

const mint = new Hono<HonoEnv>()
const MAX_BATCH_MINT_IDS = 100
// Current Mainnet Soroban contract_bandwidth_v0.tx_max_size_bytes.
// Verified with `stellar network settings` on 2026-05-14; update if validators
// change network transaction bandwidth limits.
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

mint.post('/', parseAuth, async (c) => {
	const { env, req } = c
	const payload = c.get('jwtPayload')!
	const body = await req.json() as { xdr?: string; ids?: string[] }
	const xdr = assertSignedXdr(body?.xdr)
	const ids = assertMintIds(body?.ids)

	const smolRecords = await env.SMOL_D1.prepare(
		`SELECT Id, Title, Address, Mint_Token, Mint_Amm FROM Smols WHERE Id IN (${ids.map(() => '?').join(', ')})`
	)
		.bind(...ids)
		.all<{
			Id: string
			Title: string
			Address: string | null
			Mint_Token: string | null
			Mint_Amm: string | null
		}>()

	if (!smolRecords.results || smolRecords.results.length === 0) {
		throw new HTTPException(404, { message: 'No smols found' })
	}

	if (smolRecords.results.length !== ids.length) {
		throw new HTTPException(404, { message: 'Some smols not found' })
	}

	const recordsById = new Map(smolRecords.results.map((record) => [record.Id, record]))
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
			acceptedIds: [],
			skipped: {
				alreadyMinted: alreadyMintedIds,
			},
		})
	}

	// Do not require Smols.Address to match the authenticated user. Minting is
	// intentionally an artist/collector action, and public smols may be minted by
	// people who did not create the original generated smol.
	await env.TX_WORKFLOW.create({
		params: {
			type: 'batch-mint',
			xdr,
			ids,
			mintableIds,
			sub: payload.sub,
			ownerSubsById,
		},
	})

	return c.json({
		acceptedIds: mintableIds,
		skipped: {
			alreadyMinted: alreadyMintedIds,
		},
	}, 202)
})

mint.post('/:id', parseAuth, async (c) => {
	const { env, req } = c
	const payload = c.get('jwtPayload')!
	const id = req.param('id')
	const body = await req.json() as { xdr?: string }
	const xdr = assertSignedXdr(body?.xdr)

	if (!id) {
		throw new HTTPException(400, { message: 'Missing smol id' })
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

	// Do not require Smols.Address to match the authenticated user. Minting is
	// intentionally an artist/collector action, and public smols may be minted by
	// people who did not create the original generated smol.
	await env.TX_WORKFLOW.create({
		params: {
			type: 'mint',
			xdr,
			entropy: id,
			sub: payload.sub,
			ownerSub: smolRecord.Address,
		},
	})

	return c.body(null, 202)
})

export default mint
