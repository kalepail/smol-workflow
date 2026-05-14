import { Hono } from 'hono'
import { cache } from 'hono/cache'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'
import { parseAuth } from '../middleware/auth'
import { purgeUserLikedCache, userCacheKeyGenerator } from '../utils/cache'

const likes = new Hono<HonoEnv>()

// Get user's likes
likes.get(
	'/',
	parseAuth,
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'private, max-age=20',
		keyGenerator: userCacheKeyGenerator, // Each user gets separate cache via sub claim
	}),
	async (c) => {
		const { env } = c
		const payload = c.get('jwtPayload')!

		const { results } = await env.SMOL_D1.prepare(`
			SELECT l.Id
			FROM Likes l
			INNER JOIN Smols s ON s.Id = l.Id
			WHERE l."Address" = ?1 AND s.Public = 1
		`)
			.bind(payload.sub)
			.all()

		const likeIds = results.map((like: any) => like.Id)

		const response = c.json(likeIds)

		// Add cache tag for user-specific likes list
		response.headers.append('Cache-Tag', `user:${payload.sub}:likes`)

		return response
	}
)

// Toggle like
likes.put('/:id', parseAuth, async (c) => {
	const { env, req } = c
	const id = req.param('id')
	const payload = c.get('jwtPayload')!

	const deleteResult = await env.SMOL_D1.prepare(
		`DELETE FROM Likes WHERE Id = ?1 AND "Address" = ?2`
	)
		.bind(id, payload.sub)
		.run()

	if (deleteResult.meta.changes > 0) {
		c.executionCtx.waitUntil(
			purgeUserLikedCache(payload.sub, id)
		)
		return c.body(null, 204)
	}

	const smol = await env.SMOL_D1.prepare(
		`SELECT 1 FROM Smols WHERE Id = ?1 AND Public = 1`
	)
		.bind(id)
		.first()

	if (!smol) {
		throw new HTTPException(404, { message: 'Smol not found or not public' })
	}

	await env.SMOL_D1.prepare(`INSERT OR IGNORE INTO Likes (Id, "Address") VALUES (?1, ?2)`)
		.bind(id, payload.sub)
		.run()

	// Purge cache for this user's liked and likes lists, plus the individual smol detail page
	// This ensures the liked button updates immediately on the smol detail page
	c.executionCtx.waitUntil(
		purgeUserLikedCache(payload.sub, id)
	)

	return c.body(null, 204)
})

export default likes
