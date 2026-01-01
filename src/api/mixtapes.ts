import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cache } from 'hono/cache'
import type { HonoEnv, SmolKVData } from '../types'
import { parseAuth } from '../middleware/auth'
import { purgeMixtapesCache } from '../utils/cache'

const mixtapes = new Hono<HonoEnv>()

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

	if (!body.desc || typeof body.desc !== 'string') {
		throw new HTTPException(400, { message: 'Missing or invalid description' })
	}

	if (!Array.isArray(body.smols) || body.smols.length === 0) {
		throw new HTTPException(400, { message: 'Missing or invalid smols array' })
	}

	const smolsString = body.smols.join(',')

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

// Update existing mixtape (owner only)
mixtapes.put('/:id', parseAuth, async (c) => {
	const { env, req } = c
	const payload = c.get('jwtPayload')!
	const id = req.param('id')
	const body = await req.json<{
		title?: string
		desc?: string
		smols?: string[]
	}>()

	// Verify ownership
	const existing = await env.SMOL_D1.prepare(`
		SELECT "Address" FROM Mixtapes WHERE Id = ?1
	`).bind(id).first<{ Address: string }>()

	if (!existing) {
		throw new HTTPException(404, { message: 'Mixtape not found' })
	}

	if (existing.Address !== payload.sub) {
		throw new HTTPException(403, { message: 'Not authorized to edit this mixtape' })
	}

	// Build dynamic UPDATE query
	const updates: string[] = []
	const bindings: string[] = []
	let bindIndex = 1

	if (body.title && typeof body.title === 'string') {
		updates.push(`Title = ?${bindIndex++}`)
		bindings.push(body.title)
	}
	if (body.desc && typeof body.desc === 'string') {
		updates.push(`Desc = ?${bindIndex++}`)
		bindings.push(body.desc)
	}
	if (body.smols && Array.isArray(body.smols) && body.smols.length > 0) {
		updates.push(`Smols = ?${bindIndex++}`)
		bindings.push(body.smols.join(','))
	}

	if (updates.length === 0) {
		throw new HTTPException(400, { message: 'No valid fields to update' })
	}

	bindings.push(id) // For WHERE clause

	await env.SMOL_D1.prepare(`
		UPDATE Mixtapes SET ${updates.join(', ')} WHERE Id = ?${bindIndex}
	`).bind(...bindings).run()

	// Purge caches so changes are visible immediately
	c.executionCtx.waitUntil(
		purgeMixtapesCache()
	)

	return c.json({ success: true })
})

// Delete mixtape (owner only)
mixtapes.delete('/:id', parseAuth, async (c) => {
	const { env, req } = c
	const payload = c.get('jwtPayload')!
	const id = req.param('id')

	// Verify ownership
	const existing = await env.SMOL_D1.prepare(`
		SELECT "Address" FROM Mixtapes WHERE Id = ?1
	`).bind(id).first<{ Address: string }>()

	if (!existing) {
		throw new HTTPException(404, { message: 'Mixtape not found' })
	}

	if (existing.Address !== payload.sub) {
		throw new HTTPException(403, { message: 'Not authorized to delete this mixtape' })
	}

	// Delete the mixtape
	await env.SMOL_D1.prepare(`
		DELETE FROM Mixtapes WHERE Id = ?1
	`).bind(id).run()

	// Purge caches
	c.executionCtx.waitUntil(
		purgeMixtapesCache()
	)

	return c.body(null, 204)
})

// Get all mixtapes
mixtapes.get(
	'/',
	cache({
		cacheName: 'mixtapes',
		cacheControl: 'max-age=60, stale-while-revalidate=120',
	}),
	async (c) => {
		const { env } = c

		const { results } = await env.SMOL_D1.prepare(`
			SELECT Id, Title, Desc, Smols, "Address", Created_At
			FROM Mixtapes
			ORDER BY Created_At DESC
			LIMIT 100
		`).all<{
			Id: string
			Title: string
			Desc: string
			Smols: string
			Address: string
			Created_At: string
		}>()

		const mixtapes = results.map((row) => ({
			...row,
			Smols: row.Smols.split(','),
		}))

		const response = c.json(mixtapes)

		// Add cache tag
		response.headers.append('Cache-Tag', 'mixtapes')

		return response
	}
)

// Get single mixtape with expanded smol data
mixtapes.get(
	'/:id',
	cache({
		cacheName: 'mixtapes',
		cacheControl: 'max-age=60, stale-while-revalidate=120',
	}),
	async (c) => {
		const { env, req } = c
		const id = req.param('id')

		const { results } = await env.SMOL_D1.prepare(`
			SELECT 
				m.Id,
				m.Title,
				m.Desc,
				m."Address",
				m.Created_At,
				s.Id as Smol_Id,
				s.Title as Smol_Title,
				s."Address" as Smol_Address,
				s.Mint_Token,
				s.Mint_Amm,
				s.Song_1
			FROM Mixtapes m
			CROSS JOIN json_each('[' || REPLACE('"' || REPLACE(m.Smols, ',', '","') || '"', '""', '') || ']') as j
			LEFT JOIN Smols s ON s.Id = TRIM(j.value, '"')
			WHERE m.Id = ?1
		`)
			.bind(id)
			.all<{
				Id: string
				Title: string
				Desc: string
				Address: string
				Created_At: string
				Smol_Id: string | null
				Smol_Title: string | null
				Smol_Address: string | null
				Mint_Token: string | null
				Mint_Amm: string | null
				Song_1: string | null
			}>()

		if (results.length === 0) {
			throw new HTTPException(404, { message: 'Mixtape not found' })
		}

		// Fetch KV data in bulk (up to 100 keys at once)
		const smolIds = results
			.filter((row) => row.Smol_Id !== null)
			.map((row) => row.Smol_Id!)

		const kvData = await env.SMOL_KV.get<SmolKVData>(smolIds, 'json')

		const smolsWithKV = results
			.filter((row) => row.Smol_Id !== null)
			.map((row) => {
				const kv = kvData.get(row.Smol_Id!)
				return {
					Id: row.Smol_Id!,
					Title: row.Smol_Title!,
					Address: row.Smol_Address!,
					Mint_Token: row.Mint_Token,
					Mint_Amm: row.Mint_Amm,
					Song_1: row.Song_1!,
					Tags: kv?.lyrics?.style || [],
				}
			})

		// Take mixtape data from first row
		const mixtape = {
			Id: results[0].Id,
			Title: results[0].Title,
			Desc: results[0].Desc,
			Address: results[0].Address,
			Created_At: results[0].Created_At,
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
