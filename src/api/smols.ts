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
	purgeCacheByTags,
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

		const response = c.json({
			smols: results,
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

		const response = c.json({
			smols: results,
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

		const response = c.json({
			smols: results,
			pagination,
		})

		// Add cache tag for user-specific liked list
		response.headers.append('Cache-Tag', `user:${payload.sub}:liked`)

		return response
	}
)

// Get trending smols (by plays + views)
smols.get(
	'/trending',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=300, stale-while-revalidate=600', // Cache for 5 mins
	}),
	async (c) => {
		const { env, req } = c
		const url = new URL(req.url)

		// Optional time window: 'day', 'week', 'month', 'all' (default: week)
		const periodParam = url.searchParams.get('period') || 'week'
		const period = ['day', 'week', 'month', 'all'].includes(periodParam) ? periodParam : 'week'
		const limitParam = parseInt(url.searchParams.get('limit') || '20')
		const limit = Math.min(Math.max(isNaN(limitParam) ? 20 : limitParam, 1), 100)

		// Calculate date filter based on period
		let dateFilter = ''
		switch (period) {
			case 'day':
				dateFilter = "AND Created_At > datetime('now', '-1 day')"
				break
			case 'week':
				dateFilter = "AND Created_At > datetime('now', '-7 days')"
				break
			case 'month':
				dateFilter = "AND Created_At > datetime('now', '-30 days')"
				break
			case 'all':
			default:
				dateFilter = ''
		}

		const { results } = await env.SMOL_D1.prepare(`
			SELECT s.Id, s.Title, s.Song_1, s.Mint_Token, s.Mint_Amm, s.Created_At, 
				   s.Plays, s.Views,
				   COUNT(l.Id) as Likes,
				   (s.Plays + s.Views + COUNT(l.Id) * 10) as Score
			FROM Smols s
			LEFT JOIN Likes l ON s.Id = l.Id
			WHERE s.Public = 1 ${dateFilter}
			GROUP BY s.Id
			ORDER BY Score DESC, s.Created_At DESC
			LIMIT ?
		`)
			.bind(limit)
			.all<SmolListItem & { Plays: number; Views: number; Likes: number; Score: number }>()

		const response = c.json({
			smols: results,
			period,
		})

		// Add cache tag for trending
		response.headers.append('Cache-Tag', 'trending')

		return response
	}
)

// Get platform stats
smols.get(
	'/stats',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=300, stale-while-revalidate=600', // Cache for 5 mins
	}),
	async (c) => {
		const { env } = c

		// Get total counts
		const totals = await env.SMOL_D1.prepare(`
			SELECT 
				COUNT(*) as total_smols,
				SUM(Plays) as total_plays,
				SUM(Views) as total_views,
				COUNT(CASE WHEN Mint_Token IS NOT NULL THEN 1 END) as total_minted
			FROM Smols
			WHERE Public = 1
		`).first<{
			total_smols: number
			total_plays: number
			total_views: number
			total_minted: number
		}>()

		// Get total likes
		const likesCount = await env.SMOL_D1.prepare(`
			SELECT COUNT(*) as total_likes FROM Likes
		`).first<{ total_likes: number }>()

		// Get total unique artists
		const artistsCount = await env.SMOL_D1.prepare(`
			SELECT COUNT(DISTINCT "Address") as total_artists FROM Smols WHERE Public = 1
		`).first<{ total_artists: number }>()

		// Get counts for last 24h and 7 days
		const recentStats = await env.SMOL_D1.prepare(`
			SELECT 
				COUNT(CASE WHEN Created_At > datetime('now', '-1 day') THEN 1 END) as smols_24h,
				COUNT(CASE WHEN Created_At > datetime('now', '-7 days') THEN 1 END) as smols_7d
			FROM Smols
			WHERE Public = 1
		`).first<{ smols_24h: number; smols_7d: number }>()

		const response = c.json({
			totals: {
				smols: totals?.total_smols || 0,
				plays: totals?.total_plays || 0,
				views: totals?.total_views || 0,
				likes: likesCount?.total_likes || 0,
				minted: totals?.total_minted || 0,
				artists: artistsCount?.total_artists || 0,
			},
			recent: {
				smols_24h: recentStats?.smols_24h || 0,
				smols_7d: recentStats?.smols_7d || 0,
			},
		})

		response.headers.append('Cache-Tag', 'stats')

		return response
	}
)

// Get specific smol by ID
smols.get(
	'/:id',
	optionalAuth,
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

			// Only cache completed SMOLs (those in D1)
			response.headers.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')

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

		// Not yet in D1 → fetch from DO / workflow (in-progress SMOL)
		const doid = env.DURABLE_OBJECT.idFromString(id)
		const stub = env.DURABLE_OBJECT.get(doid)
		const instance = await new Promise<WorkflowInstance | null>(async (resolve) => {
			try {
				resolve(await env.WORKFLOW.get(id))
			} catch {
				resolve(null)
			}
		})

		const response = c.json({
			kv_do: await stub.getSteps(),
			wf: instance && (await instance.status()),
			liked,
		})

		// Don't cache in-progress SMOLs
		response.headers.set('Cache-Control', 'no-store')

		return response
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

	// Cache will be purged when the workflow completes in workflow.ts
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

	// Purge user's individual page
	c.executionCtx.waitUntil(
		purgeCacheByTags([`user:${payload.sub}:smol:${id}`])
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

	// Purge individual pages
	c.executionCtx.waitUntil(
		purgeCacheByTags([
			`user:${payload.sub}:smol:${smol_id}`,
			`smol:${smol_id}:anonymous`,
		])
	)

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
	} catch { }

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

	// Purge user's created list and individual page
	c.executionCtx.waitUntil(
		purgeCacheByTags([
			`user:${payload.sub}:created`,
			`user:${payload.sub}:smol:${id}`,
		])
	)

	return c.body(null, 204)
})

export default smols
