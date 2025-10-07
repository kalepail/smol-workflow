import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cache } from 'hono/cache'
import type { HonoEnv } from '../types'
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

	// Purge mixtapes cache
	c.executionCtx.waitUntil(
		purgeMixtapesCache(env.CF_API_TOKEN, env.CF_ZONE_ID)
	)

	return c.json({ id: result!.Id }, 201)
})

// Get all mixtapes
mixtapes.get(
	'/',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=60, stale-while-revalidate=120',
		vary: ['Cookie'],
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

		const mixtapes = results.map((mixtape) => ({
			...mixtape,
			Smols: mixtape.Smols.split(','),
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
		vary: ['Cookie'],
	}),
	async (c) => {
		const { env } = c
		const id = c.req.param('id')

		const mixtape = await env.SMOL_D1.prepare(`
			SELECT Id, Title, Desc, Smols, "Address", Created_At
			FROM Mixtapes
			WHERE Id = ?1
		`)
			.bind(id)
			.first<{
				Id: string
				Title: string
				Desc: string
				Smols: string
				Address: string
				Created_At: string
			}>()

		if (!mixtape) {
			throw new HTTPException(404, { message: 'Mixtape not found' })
		}

		const response = c.json({
			...mixtape,
			Smols: mixtape.Smols.split(','),
		})

		// Add cache tag for individual mixtape
		response.headers.append('Cache-Tag', 'mixtapes')
		response.headers.append('Cache-Tag', `mixtape:${id}`)

		return response
	}
)

export default mixtapes
