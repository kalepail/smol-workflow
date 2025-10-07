import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cache } from 'hono/cache'
import type { HonoEnv } from '../types'
import { parseAuth, optionalAuth } from '../middleware/auth'
import {
	parsePaginationParams,
	buildCursorWhereClause,
	buildPaginationResponse,
} from '../utils/pagination'
import {
	purgeUserCreatedCache,
	purgePublicSmolsCache,
	userCacheKeyGenerator,
} from '../utils/cache'

const smols = new Hono<HonoEnv>()

interface SmolListItem {
	Id: string
	Title: string
	Song_1: string
	Mint_Token: string | null
	Mint_Amm: string | null
	Created_At: string
}

// Get all public smols
smols.get(
	'/',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=30, stale-while-revalidate=60',
	}),
	async (c) => {
		const { env, req } = c
		const { limit, cursor } = parsePaginationParams(new URL(req.url))

		const whereClause = buildCursorWhereClause(cursor, 'Public = 1')
		const bindings: any[] = []

		// Build query based on whether we have cursor bindings
		let query: string
		if (whereClause.length > 1) {
			// Has cursor bindings
			query = `
				SELECT Id, Title, Song_1, Mint_Token, Mint_Amm, Created_At
				FROM Smols
				WHERE ${whereClause[0]}
				ORDER BY Created_At DESC, Id DESC
				LIMIT ?
			`
			bindings.push(whereClause[1], whereClause[2], whereClause[3], limit)
		} else {
			// No cursor bindings
			query = `
				SELECT Id, Title, Song_1, Mint_Token, Mint_Amm, Created_At
				FROM Smols
				WHERE ${whereClause[0]}
				ORDER BY Created_At DESC, Id DESC
				LIMIT ?
			`
			bindings.push(limit)
		}

		const { results } = await env.SMOL_D1.prepare(query)
			.bind(...bindings)
			.all<SmolListItem>()

		const pagination = buildPaginationResponse(
			results,
			limit,
			(item) => item.Created_At,
			(item) => item.Id
		)

		// Remove Created_At from response items
		const smols = results.map(({ Created_At, ...rest }) => rest)

		const response = c.json({
			smols,
			pagination,
		})

		// Add cache tag for public smols list
		response.headers.append('Cache-Tag', 'public-smols')

		return response
	}
)

// Get smols created by authenticated user
smols.get(
	'/created',
	parseAuth,
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=30, stale-while-revalidate=60',
		keyGenerator: userCacheKeyGenerator, // Each user gets separate cache via sub claim
	}),
	async (c) => {
		const { env, req } = c
		const payload = c.get('jwtPayload')!
		const { limit, cursor } = parsePaginationParams(new URL(req.url))

	const whereClause = buildCursorWhereClause(cursor, 'Address = ?')
	const bindings: any[] = []

	let query: string
	if (whereClause.length > 1) {
		// Has cursor bindings
		query = `
			SELECT Id, Title, Song_1, Mint_Token, Mint_Amm, Created_At
			FROM Smols
			WHERE ${whereClause[0]}
			ORDER BY Created_At DESC, Id DESC
			LIMIT ?
		`
		bindings.push(payload.sub, whereClause[1], whereClause[2], whereClause[3], limit)
	} else {
		// No cursor bindings
		query = `
			SELECT Id, Title, Song_1, Mint_Token, Mint_Amm, Created_At
			FROM Smols
			WHERE ${whereClause[0]}
			ORDER BY Created_At DESC, Id DESC
			LIMIT ?
		`
		bindings.push(payload.sub, limit)
	}

		const { results } = await env.SMOL_D1.prepare(query)
			.bind(...bindings)
			.all<SmolListItem>()

		const pagination = buildPaginationResponse(
			results,
			limit,
			(item) => item.Created_At,
			(item) => item.Id
		)

		const smols = results.map(({ Created_At, ...rest }) => rest)

		const response = c.json({
			smols,
			pagination,
		})

		// Add cache tag for user-specific created list
		response.headers.append('Cache-Tag', `user:${payload.sub}:created`)

		return response
	}
)

// Get smols liked by authenticated user
smols.get(
	'/liked',
	parseAuth,
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=30, stale-while-revalidate=60',
		keyGenerator: userCacheKeyGenerator, // Each user gets separate cache via sub claim
	}),
	async (c) => {
		const { env, req } = c
		const payload = c.get('jwtPayload')!
		const { limit, cursor } = parsePaginationParams(new URL(req.url))

	const whereClause = buildCursorWhereClause(cursor, 'l."Address" = ?', 's.')
	const bindings: any[] = []

	let query: string
	if (whereClause.length > 1) {
		// Has cursor bindings
		query = `
			SELECT s.Id, s.Title, s.Song_1, s.Mint_Token, s.Mint_Amm, s.Created_At
			FROM Smols s
			INNER JOIN Likes l ON s.Id = l.Id
			WHERE ${whereClause[0]}
			ORDER BY s.Created_At DESC, s.Id DESC
			LIMIT ?
		`
		bindings.push(payload.sub, whereClause[1], whereClause[2], whereClause[3], limit)
	} else {
		// No cursor bindings
		query = `
			SELECT s.Id, s.Title, s.Song_1, s.Mint_Token, s.Mint_Amm, s.Created_At
			FROM Smols s
			INNER JOIN Likes l ON s.Id = l.Id
			WHERE ${whereClause[0]}
			ORDER BY s.Created_At DESC, s.Id DESC
			LIMIT ?
		`
		bindings.push(payload.sub, limit)
	}

	const { results } = await env.SMOL_D1.prepare(query)
		.bind(...bindings)
		.all<SmolListItem>()

		const pagination = buildPaginationResponse(
			results,
			limit,
			(item) => item.Created_At,
			(item) => item.Id
		)

		const smols = results.map(({ Created_At, ...rest }) => rest)

		const response = c.json({
			smols,
			pagination,
		})

		// Add cache tag for user-specific liked list
		response.headers.append('Cache-Tag', `user:${payload.sub}:liked`)

		return response
	}
)

// Get specific smol by ID
smols.get(
	'/:id',
	optionalAuth,
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=30, stale-while-revalidate=60',
		keyGenerator: userCacheKeyGenerator, // Vary by user sub - response includes user-specific 'liked' field
	}),
	async (c) => {
		const { env, req, executionCtx } = c
		const id = req.param('id')

		// Determine if requester has liked the smol (if authenticated)
		const payload = c.get('jwtPayload')
		let liked = false
		if (payload?.sub) {
			const likedRow = await env.SMOL_D1.prepare(
				`SELECT 1 FROM Likes WHERE Id = ?1 AND "Address" = ?2`
			)
				.bind(id, payload.sub)
				.first()

			liked = !!likedRow
		}

		const smol_d1 = await env.SMOL_D1.prepare(`SELECT * FROM Smols WHERE Id = ?1`)
			.bind(id)
			.first()

		if (smol_d1) {
			const smol_kv = await env.SMOL_KV.get(id, 'json')

			// Increment views non-blockingly
			executionCtx.waitUntil(
				env.SMOL_D1.prepare('UPDATE Smols SET Views = Views + 1 WHERE Id = ?')
					.bind(id)
					.run()
			)

			const response = c.json({
				kv_do: smol_kv,
				d1: smol_d1,
				liked,
			})

			// Add cache tags for individual smol
			// Use user-specific tag if authenticated, so we only purge that user's cache entry
			if (payload?.sub) {
				response.headers.append('Cache-Tag', `user:${payload.sub}:smol:${id}`)
			} else {
				// Unauthenticated views share a cache entry
				response.headers.append('Cache-Tag', `smol:${id}:anonymous`)
			}

			return response
		}

		// Not yet in D1 → fetch from DO / workflow
		const doid = env.DURABLE_OBJECT.idFromString(id)
		const stub = env.DURABLE_OBJECT.get(doid)
		const instance = await new Promise<WorkflowInstance | null>(async (resolve) => {
			try {
				resolve(await env.WORKFLOW.get(id))
			} catch {
				resolve(null)
			}
		})

		return c.json({
			kv_do: await stub.getSteps(),
			wf: instance && (await instance.status()),
			liked,
		})
	}
)

// Create new smol
smols.post('/', async (c) => {
	const { env, req } = c
	const body: {
		address: string
		prompt: string
		public?: boolean
		instrumental?: boolean
		playlist?: string
	} = await req.json()

	if (!body.address) {
		throw new HTTPException(400, { message: 'Missing address' })
	}

	if (!body.prompt) {
		throw new HTTPException(400, { message: 'Missing prompt' })
	}

	const instanceId = env.DURABLE_OBJECT.newUniqueId().toString()
	const instance = await env.WORKFLOW.create({
		id: instanceId,
		params: {
			address: body.address,
			prompt: body.prompt,
			public: body.public ?? true,
			instrumental: body.instrumental ?? false,
			playlist: body.playlist,
		},
	})

	console.log('Workflow started', instanceId, await instance.status())

	// Purge cache for this user's created list and public smols list
	c.executionCtx.waitUntil(
		Promise.all([
			purgeUserCreatedCache(env.CF_API_TOKEN, env.CF_ZONE_ID, body.address),
			body.public !== false ? purgePublicSmolsCache(env.CF_API_TOKEN, env.CF_ZONE_ID) : Promise.resolve(true),
		])
	)

	return c.text(instanceId)
})

// Retry smol creation
smols.post('/retry/:id', async (c) => {
	const { env, req } = c
	const body: {
		address: string
	} = await req.json()

	if (!body.address) {
		throw new HTTPException(400, { message: 'Missing address' })
	}

	const id = req.param('id')
	const instanceId = env.DURABLE_OBJECT.newUniqueId().toString()
	const instance = await env.WORKFLOW.create({
		id: instanceId,
		params: {
			retry_id: id,
			address: body.address,
		},
	})

	console.log('Workflow restarted', instanceId, await instance.status())

	return c.text(instanceId)
})

// Toggle public/private
smols.put('/:id', parseAuth, async (c) => {
	const { env, req } = c
	const id = req.param('id')
	const payload = c.get('jwtPayload')!

	const smol_kv: any = await env.SMOL_KV.get(id, 'json')

	if (!smol_kv) {
		throw new HTTPException(404, { message: 'Smol not found' })
	}

	if (typeof smol_kv.nsfw !== 'string' && smol_kv.nsfw?.safe === false) {
		throw new HTTPException(400, { message: 'Cannot change visibility of a NSFW smol' })
	}

	await env.SMOL_D1.prepare(`
		UPDATE Smols SET
			Public = CASE WHEN Public = 1 THEN 0 ELSE 1 END
		WHERE Id = ?1 AND "Address" = ?2
	`)
		.bind(id, payload.sub)
		.run()

	// Purge cache for this user's created list and public smols list (toggling visibility affects both)
	c.executionCtx.waitUntil(
		Promise.all([
			purgeUserCreatedCache(env.CF_API_TOKEN, env.CF_ZONE_ID, payload.sub),
			purgePublicSmolsCache(env.CF_API_TOKEN, env.CF_ZONE_ID),
		])
	)

	return c.body(null, 204)
})

// Swap songs
smols.put('/:smol_id/:song_id', parseAuth, async (c) => {
	const { env, req } = c
	const smol_id = req.param('smol_id')
	const song_id = req.param('song_id')
	const payload = c.get('jwtPayload')!

	const result = await env.SMOL_D1.prepare(`
		UPDATE Smols SET
			Song_1 = Song_2,
			Song_2 = Song_1
		WHERE Id = ?1
		AND Song_2 = ?2
		AND Address = ?3
	`)
		.bind(smol_id, song_id, payload.sub)
		.run()

	if (result.meta.changes === 0) {
		throw new HTTPException(404, { message: 'No record found or no update needed' })
	}

	return c.body(null, 204)
})

// Delete smol
smols.delete('/:id', parseAuth, async (c) => {
	const { env, req } = c
	const id = req.param('id')
	const smol: any = await env.SMOL_KV.get(id, 'json')

	try {
		const doid = env.DURABLE_OBJECT.idFromString(id)
		const stub = env.DURABLE_OBJECT.get(doid)
		await stub.setToFlush()
	} catch {}

	const payload = c.get('jwtPayload')!

	await env.SMOL_KV.delete(id)
	await env.SMOL_D1.prepare(`
		DELETE FROM Smols
		WHERE Id = ?1
	`)
		.bind(id)
		.run()
	await env.SMOL_BUCKET.delete(`${id}.png`)

	if (smol) {
		for (let song of smol.songs) {
			await env.SMOL_BUCKET.delete(`${song.music_id}.mp3`)
		}
	}

	// Purge cache for this user's created list and public smols list
	c.executionCtx.waitUntil(
		Promise.all([
			purgeUserCreatedCache(env.CF_API_TOKEN, env.CF_ZONE_ID, payload.sub),
			purgePublicSmolsCache(env.CF_API_TOKEN, env.CF_ZONE_ID),
		])
	)

	return c.body(null, 204)
})

export default smols
