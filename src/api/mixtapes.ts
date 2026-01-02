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

	// Store as JSON string for better type safety than CSV
	const smolsString = JSON.stringify(body.smols)

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
		bindings.push(JSON.stringify(body.smols))
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

		const mixtapes = results.map((row) => {
			let parsedSmols: string[] = []
			try {
				// Try JSON parse first (new format)
				parsedSmols = JSON.parse(row.Smols)
			} catch {
				// Fallback to split (old format)
				parsedSmols = row.Smols.split(',')
			}
			return {
				...row,
				Smols: parsedSmols,
			}
		})

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

		// 1. Fetch Mixtape details
		const mixtape = await env.SMOL_D1.prepare(`
			SELECT Id, Title, Desc, "Address", Created_At, Smols
			FROM Mixtapes
			WHERE Id = ?1
		`).bind(id).first<{
			Id: string
			Title: string
			Desc: string
			Address: string
			Created_At: string
			Smols: string
		}>()

		if (!mixtape) {
			throw new HTTPException(404, { message: 'Mixtape not found' })
		}

		// 2. Parse Smols IDs (handle both JSON and CSV for backward compat)
		let smolIds: string[] = []
		try {
			smolIds = JSON.parse(mixtape.Smols)
		} catch {
			smolIds = mixtape.Smols.split(',')
		}

		if (smolIds.length === 0) {
			return c.json({
				...mixtape,
				Smols: []
			})
		}

		// 3. Fetch details for these Smols
		// Dynamically build placeholders for IN clause
		const placeholders = smolIds.map((_, i) => `?${i + 1}`).join(',')
		const smolDetails = await env.SMOL_D1.prepare(`
			SELECT 
				Id, Title, "Address", Mint_Token, Mint_Amm, Song_1
			FROM Smols
			WHERE Id IN (${placeholders})
		`)
			.bind(...smolIds)
			.all<{
				Id: string
				Title: string
				Address: string
				Mint_Token: string | null
				Mint_Amm: string | null
				Song_1: string
			}>()

		const foundSmols = smolDetails.results;

		// 4. Fetch KV data for styles/tags
		const kvData = await env.SMOL_KV.get<SmolKVData>(smolIds, 'json')

		// 5. Combine data, preserving order of IDs in the mixtape
		const smolsCombined = smolIds.map(id => {
			const details = foundSmols.find(s => s.Id === id)
			if (!details) return null // access control or deleted?

			const kv = kvData.get(id)
			return {
				Id: details.Id,
				Title: details.Title,
				Address: details.Address,
				Mint_Token: details.Mint_Token,
				Mint_Amm: details.Mint_Amm,
				Song_1: details.Song_1,
				Tags: kv?.lyrics?.style || [],
			}
		}).filter(s => s !== null)

		const response = c.json({
			Id: mixtape.Id,
			Title: mixtape.Title,
			Desc: mixtape.Desc,
			Address: mixtape.Address,
			Created_At: mixtape.Created_At,
			Smols: smolsCombined,
		})

		// Add cache tag for individual mixtape
		response.headers.append('Cache-Tag', 'mixtapes')
		response.headers.append('Cache-Tag', `mixtape:${id}`)

		return response
	}
)

export default mixtapes
