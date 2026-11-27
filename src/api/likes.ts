import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'
import { parseAuth } from '../middleware/auth'
import { privateNoStore } from '../utils/http'

const likes = new Hono<HonoEnv>()

// Get user's likes (never shared-cached)
likes.get('/', privateNoStore, parseAuth, async (c) => {
	const { results } = await c.env.SMOL_D1.prepare(`
		SELECT l.Id
		FROM Likes l
		INNER JOIN Smols s ON s.Id = l.Id
		WHERE l."Address" = ?1
	`)
		.bind(c.get('jwtPayload')!.sub)
		.all<{ Id: string }>()

	return c.json(results.map((like) => like.Id))
})

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

	// Like state is only ever served from private/no-store responses, so there is no shared cache to purge.
	if (deleteResult.meta.changes > 0) {
		return c.body(null, 204)
	}

	const smol = await env.SMOL_D1.prepare(
		`SELECT 1 FROM Smols WHERE Id = ?1`
	)
		.bind(id)
		.first()

	if (!smol) {
		throw new HTTPException(404, { message: 'Smol not found' })
	}

	await env.SMOL_D1.prepare(`INSERT OR IGNORE INTO Likes (Id, "Address") VALUES (?1, ?2)`)
		.bind(id, payload.sub)
		.run()

	return c.body(null, 204)
})

export default likes
