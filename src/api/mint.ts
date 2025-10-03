import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'
import { parseAuth } from '../middleware/auth'

const mint = new Hono<HonoEnv>()

mint.post('/', parseAuth, async (c) => {
	const { env, req } = c
	const body = await req.json() as { xdr?: string; ids?: string[] }

	if (!body?.xdr || typeof body.xdr !== 'string') {
		throw new HTTPException(400, { message: 'Missing signed transaction' })
	}

	if (!body?.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
		throw new HTTPException(400, { message: 'Missing or invalid ids array' })
	}

	const smolRecords = await env.SMOL_D1.prepare(
		`SELECT Id, Title, Address, Mint_Token, Mint_Amm FROM Smols WHERE Id IN (${body.ids.map(() => '?').join(', ')})`
	)
		.bind(...body.ids)
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

	if (smolRecords.results.length !== body.ids.length) {
		throw new HTTPException(404, { message: 'Some smols not found' })
	}

	for (const record of smolRecords.results) {
		if (record.Mint_Token || record.Mint_Amm) {
			throw new HTTPException(409, { message: `Smol ${record.Id} already minted` })
		}
		if (!record.Address) {
			throw new HTTPException(404, { message: `Smol ${record.Id} not found` })
		}
	}

	await env.TX_WORKFLOW.create({
		params: {
			type: 'batch-mint',
			xdr: body.xdr,
			ids: body.ids,
		},
	})

	return c.body(null, 202)
})

mint.post('/:id', parseAuth, async (c) => {
	const { env, req } = c
	const id = req.param('id')
	const body = await req.json() as { xdr?: string }

	if (!id) {
		throw new HTTPException(400, { message: 'Missing smol id' })
	}

	if (!body?.xdr || typeof body.xdr !== 'string') {
		throw new HTTPException(400, { message: 'Missing signed transaction' })
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

	await env.TX_WORKFLOW.create({
		params: {
			type: 'mint',
			xdr: body.xdr,
			entropy: id,
		},
	})

	return c.body(null, 202)
})

export default mint
