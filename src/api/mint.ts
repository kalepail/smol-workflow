import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'
import { parseAuth } from '../middleware/auth'

const mint = new Hono<HonoEnv>()
const MAX_BATCH_MINT_IDS = 100
const MAX_SIGNED_XDR_LENGTH = 10000

function assertSignedXdr(value: unknown): string {
	if (!value || typeof value !== 'string') {
		throw new HTTPException(400, { message: 'Missing signed transaction' })
	}

	if (value.length > MAX_SIGNED_XDR_LENGTH) {
		throw new HTTPException(400, { message: 'Signed transaction is too large' })
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

	for (const record of smolRecords.results) {
		if (record.Mint_Token || record.Mint_Amm) {
			throw new HTTPException(409, { message: `Smol ${record.Id} already minted` })
		}
		if (!record.Address) {
			throw new HTTPException(404, { message: `Smol ${record.Id} not found` })
		}
		if (record.Address !== payload.sub) {
			throw new HTTPException(403, { message: `Smol ${record.Id} not owned by you` })
		}
	}

	await env.TX_WORKFLOW.create({
		params: {
			type: 'batch-mint',
			xdr,
			ids,
			sub: payload.sub,
		},
	})

	return c.body(null, 202)
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

	if (smolRecord.Address !== payload.sub) {
		throw new HTTPException(403, { message: 'Smol not owned by you' })
	}

	await env.TX_WORKFLOW.create({
		params: {
			type: 'mint',
			xdr,
			entropy: id,
			sub: payload.sub,
		},
	})

	return c.body(null, 202)
})

export default mint
