import { Hono } from 'hono'
import { cache } from 'hono/cache'
import type { HonoEnv } from '../types'
import { parseAuth } from '../middleware/auth'

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

		return c.json(likeIds)
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

	return c.body(null, 204)
})

export default likes
