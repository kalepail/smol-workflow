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
import { artistSmolsCacheTag } from '../utils/cache-tags'
import { isDurableObjectId } from '../utils/durable-object-id'
import { queueSearchDeletionById } from '../utils/search'
import { requireOwnedVisibilityToggle, syncSearchVisibilityAfterToggle } from '../utils/search-visibility'

const smols = new Hono<HonoEnv>()
// Keep these in sync with smol-fe generation controls and provider payload limits.
const MAX_LYRICAL_PROMPT_LENGTH = 2280
const MAX_INSTRUMENTAL_PROMPT_LENGTH = 380

interface SmolListItem {
	Id: string
	Title: string
	Song_1: string
	Mint_Token: string | null
	Mint_Amm: string | null
	Created_At: string
}

interface SmolD1Record {
	Id: string
	Public: number
	Address: string | null
	[key: string]: unknown
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
		cacheControl: 'private, max-age=30',
		keyGenerator: userCacheKeyGenerator, // Each user gets separate cache via sub claim
	}),
	async (c) => {
		const { env, req } = c
		const payload = c.get('jwtPayload')!
		const { limit, cursor } = parsePaginationParams(new URL(req.url))

	const whereClause = buildCursorWhereClause(cursor, '"Address" = ?')
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
		cacheControl: 'private, max-age=30',
		keyGenerator: userCacheKeyGenerator, // Each user gets separate cache via sub claim
	}),
	async (c) => {
		const { env, req } = c
		const payload = c.get('jwtPayload')!
		const { limit, cursor } = parsePaginationParams(new URL(req.url))

	const whereClause = buildCursorWhereClause(cursor, 'l."Address" = ? AND s.Public = 1', 's.')
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

// Get specific smol by ID
smols.get(
	'/:id',
	optionalAuth,
	async (c) => {
		const { env, req, executionCtx } = c
		const id = req.param('id')

		const payload = c.get('jwtPayload')
		let liked = false

		const smol_d1 = await env.SMOL_D1.prepare(`SELECT * FROM Smols WHERE Id = ?1`)
			.bind(id)
			.first<SmolD1Record>()

		if (smol_d1) {
			if (smol_d1.Public !== 1 && smol_d1.Address !== payload?.sub) {
				throw new HTTPException(404, { message: 'Smol not found' })
			}

			if (payload?.sub) {
				const likedRow = await env.SMOL_D1.prepare(
					`SELECT 1 FROM Likes WHERE Id = ?1 AND "Address" = ?2`
				)
					.bind(id, payload.sub)
					.first()

				liked = !!likedRow
			}

			const smol_kv: any = await env.SMOL_KV.get(id, 'json')

			// Increment views non-blockingly
			executionCtx.waitUntil(
				env.SMOL_D1.prepare('UPDATE Smols SET Views = Views + 1 WHERE Id = ?')
					.bind(id)
					.run()
			)

			// Replace image_base64 with boolean marker (interfaces use this to know when image is ready)
			const { image_base64, ...rest } = smol_kv || {}
			const kv_do = { ...rest, image: !!image_base64 }

			const response = c.json({
				kv_do,
				d1: smol_d1,
				liked,
			})

			if (smol_d1.Public !== 1) {
				response.headers.set('Cache-Control', 'no-store')
			} else if (payload?.sub) {
				response.headers.set('Cache-Control', 'private, max-age=30')
			} else {
				response.headers.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
			}

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
			if (!isDurableObjectId(id)) {
				throw new HTTPException(404, { message: 'Smol not found' })
			}

			const doid = env.DURABLE_OBJECT.idFromString(id)
			const stub = env.DURABLE_OBJECT.get(doid)
			const instance = await new Promise<WorkflowInstance | null>(async (resolve) => {
			try {
				resolve(await env.WORKFLOW.get(id))
			} catch {
				resolve(null)
			}
		})

		const steps = (await stub.getSteps()) as any || {}

		if (!payload?.sub || steps?.payload?.address !== payload.sub) {
			throw new HTTPException(404, { message: 'Smol not found' })
		}

		// Replace image_base64 with boolean marker (interfaces use this to know when image is ready)
		const { image_base64, ...rest } = steps
		const kv_do = { ...rest, image: !!image_base64 }

		const response = c.json({
			kv_do,
			wf: instance && (await instance.status()),
			liked,
		})

		// Don't cache in-progress SMOLs
		response.headers.set('Cache-Control', 'no-store')

		return response
	}
)

// Create new smol
smols.post('/', parseAuth, async (c) => {
	const { env, req } = c
	const payload = c.get('jwtPayload')!
	const body: {
		prompt: string
		public?: boolean
		instrumental?: boolean
		playlist?: string
	} = await req.json()

	if (!body.prompt || typeof body.prompt !== 'string') {
		throw new HTTPException(400, { message: 'Missing prompt' })
	}

	const isInstrumental = body.instrumental ?? false
	const maxPromptLength = isInstrumental ? MAX_INSTRUMENTAL_PROMPT_LENGTH : MAX_LYRICAL_PROMPT_LENGTH

	if (body.prompt.length > maxPromptLength) {
		throw new HTTPException(400, { message: `Prompt must be ${maxPromptLength} characters or less` })
	}

	const instanceId = env.DURABLE_OBJECT.newUniqueId().toString()
	const instance = await env.WORKFLOW.create({
		id: instanceId,
		params: {
			address: payload.sub,
			prompt: body.prompt,
			public: body.public ?? true,
			instrumental: isInstrumental,
			playlist: body.playlist,
		},
	})

	console.log('Workflow started', instanceId, await instance.status())

	// Cache will be purged when the workflow completes in workflow.ts
	return c.text(instanceId)
})

// Retry smol creation
smols.post('/retry/:id', parseAuth, async (c) => {
	const { env, req } = c

	const id = req.param('id')

	const smol = await env.SMOL_D1.prepare(`
		SELECT Id
		FROM Smols
		WHERE Id = ?1
	`)
		.bind(id)
		.first<{ Id: string }>()

	if (!smol) {
		throw new HTTPException(404, { message: 'Smol not found' })
	}

	const instanceId = env.DURABLE_OBJECT.newUniqueId().toString()
	const instance = await env.WORKFLOW.create({
		id: instanceId,
		params: {
			retry_id: id,
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

	const smolRecord = await env.SMOL_D1.prepare(`
		SELECT Public
		FROM Smols
		WHERE Id = ?1 AND "Address" = ?2
	`)
		.bind(id, payload.sub)
		.first<{ Public: number }>()

	if (!smolRecord) {
		throw new HTTPException(404, { message: 'Smol not found or not owned by you' })
	}

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

	const updated = await env.SMOL_D1.prepare(`
		SELECT Public
		FROM Smols
		WHERE Id = ?1 AND "Address" = ?2
	`)
		.bind(id, payload.sub)
		.first<{ Public: number }>()

	const visibleUpdate = requireOwnedVisibilityToggle(updated)

	c.executionCtx.waitUntil((async () => {
		try {
			await syncSearchVisibilityAfterToggle(env, id, visibleUpdate)
		} catch (error) {
			console.error(JSON.stringify({
				event: 'search_sync_failed',
				operation: 'visibility_toggle',
				smolId: id,
				intendedVisibility: visibleUpdate.Public === 1 ? 'public' : 'private',
				error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
			}))
		}
	})())

	// Purge user's individual page
	c.executionCtx.waitUntil(
		purgeCacheByTags([
			artistSmolsCacheTag(payload.sub),
			'public-smols',
			'mixtapes',
			`user:${payload.sub}:created`,
			`user:${payload.sub}:smol:${id}`,
			`smol:${id}:anonymous`,
			`smol:${id}:media`,
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

	// Purge individual pages
	c.executionCtx.waitUntil(
		purgeCacheByTags([
			`user:${payload.sub}:smol:${smol_id}`,
			`smol:${smol_id}:anonymous`,
		])
	)

	return c.body(null, 204)
})

// Admin bulk delete (gated behind SECRET token, skips minted/public)
smols.delete('/admin/bulk', parseAuth, async (c) => {
	if (!c.get('isAdmin')) {
		throw new HTTPException(403, { message: 'Admin access required' })
	}

	const { env } = c
	const { ids, allowPublic }: { ids: string[]; allowPublic?: boolean } = await c.req.json()

	if (!Array.isArray(ids) || ids.length === 0) {
		throw new HTTPException(400, { message: 'Missing ids array' })
	}

	if (ids.length > 100) {
		throw new HTTPException(400, { message: 'Max 100 ids per request' })
	}

	let deleted = 0
	const skipped: string[] = []

	for (const id of ids) {
		const smol = await env.SMOL_D1.prepare(`SELECT Id, Mint_Token, Public, Address FROM Smols WHERE Id = ?1`)
			.bind(id)
			.first<{ Id: string; Mint_Token: string | null; Public: number; Address: string }>()

		if (!smol) {
			skipped.push(id)
			continue
		}

		if (smol.Mint_Token) {
			skipped.push(id)
			continue
		}

		if (smol.Public && !allowPublic) {
			skipped.push(id)
			continue
		}

		const likeRows = await env.SMOL_D1.prepare(`SELECT "Address" as Address FROM Likes WHERE Id = ?1`)
			.bind(id)
			.all<{ Address: string }>()
		await env.SMOL_D1.prepare(`DELETE FROM Likes WHERE Id = ?1`).bind(id).run()
		await env.SMOL_D1.prepare(`DELETE FROM Smols WHERE Id = ?1`).bind(id).run()

		const smolKv: any = await env.SMOL_KV.get(id, 'json')

		try {
			if (isDurableObjectId(id)) {
				const doid = env.DURABLE_OBJECT.idFromString(id)
				const stub = env.DURABLE_OBJECT.get(doid)
				await stub.setToFlush()
			}
		} catch {}

		await env.SMOL_KV.delete(id)
		await env.SMOL_BUCKET.delete(`${id}.png`)

		if (smolKv?.songs) {
			for (const song of smolKv.songs) {
				await env.SMOL_BUCKET.delete(`${song.music_id}.mp3`)
			}
		}

		c.executionCtx.waitUntil(
			queueSearchDeletionById(env, id).catch(() => {})
		)

		// Purge caches for this smol's owner
		c.executionCtx.waitUntil(
			purgeCacheByTags([
				artistSmolsCacheTag(smol.Address),
				'public-smols',
				'mixtapes',
				`user:${smol.Address}:created`,
				`user:${smol.Address}:smol:${id}`,
				`smol:${id}:anonymous`,
				`smol:${id}:media`,
				...((likeRows.results || []).flatMap((like) => [
					`user:${like.Address}:liked`,
					`user:${like.Address}:likes`,
				])),
			])
		)

		deleted++
	}

	return c.json({ deleted, skipped: skipped.length, total: ids.length })
})

// Delete smol
smols.delete('/:id', parseAuth, async (c) => {
	const { env, req } = c
	const id = req.param('id')
	const payload = c.get('jwtPayload')!

	const ownedSmol = await env.SMOL_D1.prepare(`
		SELECT Id
		FROM Smols
		WHERE Id = ?1 AND "Address" = ?2
	`)
		.bind(id, payload.sub)
		.first<{ Id: string }>()

	if (!ownedSmol) {
		throw new HTTPException(404, { message: 'Smol not found or not owned by you' })
	}

	const likeRows = await env.SMOL_D1.prepare(`SELECT "Address" as Address FROM Likes WHERE Id = ?1`)
		.bind(id)
		.all<{ Address: string }>()

	const smol: any = await env.SMOL_KV.get(id, 'json')

	await env.SMOL_D1.prepare(`DELETE FROM Likes WHERE Id = ?1`).bind(id).run()
	await env.SMOL_D1.prepare(`DELETE FROM Smols WHERE Id = ?1 AND "Address" = ?2`)
		.bind(id, payload.sub)
		.run()

	try {
		if (isDurableObjectId(id)) {
			const doid = env.DURABLE_OBJECT.idFromString(id)
			const stub = env.DURABLE_OBJECT.get(doid)
			await stub.setToFlush()
		}
	} catch {}

	await env.SMOL_KV.delete(id)
	await env.SMOL_BUCKET.delete(`${id}.png`)

	if (smol) {
		for (let song of smol.songs) {
			await env.SMOL_BUCKET.delete(`${song.music_id}.mp3`)
		}
	}

	c.executionCtx.waitUntil(
		queueSearchDeletionById(env, id).catch((error) => {
			console.error(JSON.stringify({
				event: 'search_sync_failed',
				operation: 'deletion',
				smolId: id,
				error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
			}))
		})
	)

	// Purge user's created list and individual page
	c.executionCtx.waitUntil(
		purgeCacheByTags([
			artistSmolsCacheTag(payload.sub),
			'public-smols',
			'mixtapes',
			`user:${payload.sub}:created`,
			`user:${payload.sub}:smol:${id}`,
			`smol:${id}:anonymous`,
			`smol:${id}:media`,
			...((likeRows.results || []).flatMap((like) => [
				`user:${like.Address}:liked`,
				`user:${like.Address}:likes`,
			])),
		])
	)

	return c.body(null, 204)
})

export default smols
