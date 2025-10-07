import { Hono } from 'hono'
import { cache } from 'hono/cache'
import type { HonoEnv } from '../types'
import { parseAuth } from '../middleware/auth'
import { purgeUserLikedCache } from '../utils/cache'

const likes = new Hono<HonoEnv>()

// Get user's likes
likes.get(
	'/',
	parseAuth,
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'private, max-age=20',
		vary: ['Cookie'],
	}),
	async (c) => {
		const { env } = c
		const payload = c.get('jwtPayload')!

		const { results } = await env.SMOL_D1.prepare(`
			SELECT Id FROM Likes
			WHERE "Address" = ?1
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

	if (deleteResult.meta.changes === 0) {
		await env.SMOL_D1.prepare(`INSERT INTO Likes (Id, "Address") VALUES (?1, ?2)`)
			.bind(id, payload.sub)
			.run()

		// buy token
		// await env.TX_WORKFLOW.create({
		// 	params: {
		// 		type: 'buy',
		// 		owner: payload.sub,
		// 		entropy: id,
		// 	}
		// });
	} else {
		// sell token
		// await env.TX_WORKFLOW.create({
		// 	params: {
		// 		type: 'sell',
		// 		xdr: body.xdr,
		// 		entropy: id,
		// 	}
		// });
	}

	// Purge cache for this user's liked and likes lists, plus the individual smol detail page
	// This ensures the liked button updates immediately on the smol detail page
	c.executionCtx.waitUntil(
		purgeUserLikedCache(env.CF_API_TOKEN, env.CF_ZONE_ID, payload.sub, id)
	)

	return c.body(null, 204)
})

export default likes
