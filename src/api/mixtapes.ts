import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cache } from 'hono/cache'
import type { HonoEnv, SmolKVData } from '../types'
import { parseAuth } from '../middleware/auth'
import { purgeMixtapesCache } from '../utils/cache'

const mixtapes = new Hono<HonoEnv>()
const MAX_MIXTAPE_TITLE_LENGTH = 120
const MAX_MIXTAPE_DESC_LENGTH = 1000
const MAX_MIXTAPE_SMOLS = 100

interface MixtapeRow {
	Id: string
	Title: string
	Desc: string
	Smols: string
	Address: string
	Created_At: string
}

interface MixtapeSmolRow {
	Id: string
	Title: string
	Address: string
	Mint_Token: string | null
	Mint_Amm: string | null
	Song_1: string
	Public: number
}

function parseStoredSmolIds(smols: string): string[] {
	return smols.split(',').map((id) => id.trim()).filter(Boolean)
}

function parseRequestedSmolIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new HTTPException(400, { message: 'Missing or invalid smols array' })
	}

	if (value.length > MAX_MIXTAPE_SMOLS) {
		throw new HTTPException(400, { message: `Max ${MAX_MIXTAPE_SMOLS} smols per mixtape` })
	}

	const ids = value.map((id) => {
		if (typeof id !== 'string' || !id.trim() || id.includes(',') || id.includes('"')) {
			throw new HTTPException(400, { message: 'Invalid smol id in mixtape' })
		}

		return id.trim()
	})

	if (new Set(ids).size !== ids.length) {
		throw new HTTPException(400, { message: 'Duplicate smol ids are not allowed' })
	}

	return ids
}

function assertStringLength(value: string, fieldName: string, maxLength: number) {
	if (value.length > maxLength) {
		throw new HTTPException(400, { message: `${fieldName} must be ${maxLength} characters or less` })
	}
}

async function loadPublicSmolRows(env: Env, ids: string[]): Promise<Map<string, MixtapeSmolRow>> {
	const uniqueIds = [...new Set(ids)].filter(Boolean)
	const rows = new Map<string, MixtapeSmolRow>()
	const batches: string[][] = []

	for (let index = 0; index < uniqueIds.length; index += MAX_MIXTAPE_SMOLS) {
		batches.push(uniqueIds.slice(index, index + MAX_MIXTAPE_SMOLS))
	}

	const results = await Promise.all(batches.map((batch) => {
		const placeholders = batch.map(() => '?').join(',')
		return env.SMOL_D1.prepare(`
				SELECT Id, Title, "Address" as Address, Mint_Token, Mint_Amm, Song_1, Public
				FROM Smols
				WHERE Public = 1 AND Id IN (${placeholders})
			`)
			.bind(...batch)
			.all<MixtapeSmolRow>()
	}))

	for (const result of results) {
		for (const row of result.results) {
			rows.set(row.Id, row)
		}
	}

	return rows
}

// Create new mixtape
mixtapes.post('/', parseAuth, async (c) => {
	const { env, req } = c
	const payload = c.get('jwtPayload')!
	const body = await req.json<{
		title: string
		desc: string
		smols: string[]
	}>()

	if (!body.title || typeof body.title !== 'string') {
		throw new HTTPException(400, { message: 'Missing or invalid title' })
	}
	assertStringLength(body.title, 'Title', MAX_MIXTAPE_TITLE_LENGTH)

	if (!body.desc || typeof body.desc !== 'string') {
		throw new HTTPException(400, { message: 'Missing or invalid description' })
	}
	assertStringLength(body.desc, 'Description', MAX_MIXTAPE_DESC_LENGTH)

	const smolIds = parseRequestedSmolIds(body.smols)
	const publicSmolRows = await loadPublicSmolRows(env, smolIds)
	if (publicSmolRows.size !== smolIds.length) {
		throw new HTTPException(400, { message: 'Mixtapes can only include public smols' })
	}

	const smolsString = smolIds.join(',')

	const result = await env.SMOL_D1.prepare(`
		INSERT INTO Mixtapes (Title, Desc, Smols, "Address")
		VALUES (?1, ?2, ?3, ?4)
		RETURNING Id
	`)
		.bind(body.title, body.desc, smolsString, payload.sub)
		.first<{ Id: string }>()

	// Purge global mixtapes cache so user sees their new mixtape immediately
	c.executionCtx.waitUntil(
		purgeMixtapesCache()
	)

	return c.json({ id: result!.Id }, 201)
})

// Get all mixtapes
mixtapes.get(
	'/',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=60, stale-while-revalidate=120',
	}),
	async (c) => {
		const { env } = c

		const { results } = await env.SMOL_D1.prepare(`
			SELECT Id, Title, Desc, Smols, "Address", Created_At
			FROM Mixtapes
			ORDER BY Created_At DESC
			LIMIT 100
		`).all<MixtapeRow>()

		const allSmolIds = results.flatMap((mixtape) => parseStoredSmolIds(mixtape.Smols))
		const publicSmolRows = await loadPublicSmolRows(env, allSmolIds)

		const mixtapes = results.map((mixtape) => ({
			...mixtape,
			Smols: parseStoredSmolIds(mixtape.Smols).filter((id) => publicSmolRows.has(id)),
		}))

		const response = c.json(mixtapes)

		// Add cache tag for mixtapes list
		response.headers.append('Cache-Tag', 'mixtapes')

		return response
	}
)

// Get single mixtape by ID
mixtapes.get(
	'/:id',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=60, stale-while-revalidate=120',
	}),
	async (c) => {
		const { env } = c
		const id = c.req.param('id')

		const mixtapeRow = await env.SMOL_D1.prepare(`
			SELECT Id, Title, Desc, Smols, "Address", Created_At
			FROM Mixtapes
			WHERE Id = ?1
		`)
			.bind(id)
			.first<MixtapeRow>()

		if (!mixtapeRow) {
			throw new HTTPException(404, { message: 'Mixtape not found' })
		}

		const smolIds = parseStoredSmolIds(mixtapeRow.Smols)
		const publicSmolRows = await loadPublicSmolRows(env, smolIds)
		const smolRows = smolIds.map((smolId) => publicSmolRows.get(smolId)).filter((row): row is MixtapeSmolRow => Boolean(row))

		// Fetch KV data in bulk (up to 100 keys at once)
		const publicSmolIds = smolRows.map((row) => row.Id)

		const kvData = publicSmolIds.length > 0
			? await env.SMOL_KV.get<SmolKVData>(publicSmolIds, 'json')
			: new Map<string, SmolKVData | null>()

		const smolsWithKV = smolRows
			.map((row) => {
				const kv = kvData.get(row.Id)
				return {
					Id: row.Id,
					Title: row.Title,
					Address: row.Address,
					Mint_Token: row.Mint_Token,
					Mint_Amm: row.Mint_Amm,
					Song_1: row.Song_1,
					Public: row.Public,
					Tags: kv?.lyrics?.style || [],
				}
			})

		// Take mixtape data from first row
		const mixtape = {
			Id: mixtapeRow.Id,
			Title: mixtapeRow.Title,
			Desc: mixtapeRow.Desc,
			Address: mixtapeRow.Address,
			Created_At: mixtapeRow.Created_At,
			Smols: smolsWithKV,
		}

		const response = c.json(mixtape)

		// Add cache tag for individual mixtape
		response.headers.append('Cache-Tag', 'mixtapes')
		response.headers.append('Cache-Tag', `mixtape:${id}`)

		return response
	}
)

export default mixtapes
