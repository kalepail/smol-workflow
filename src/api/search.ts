import { Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'
import { buildCursorWhereClause, buildPaginationResponse, parsePaginationParams } from '../utils/pagination'
import { queueSearchIndexingBatchById, queueSearchIndexingById, searchPublicSmols, searchSimilarSmols } from '../utils/search'
import { optionalAuth } from '../middleware/auth'

const search = new Hono<HonoEnv>()

function parseBooleanParam(value: string | null): boolean | undefined {
	if (value === null) {
		return undefined
	}

	if (value === 'true') {
		return true
	}

	if (value === 'false') {
		return false
	}

	return undefined
}

function assertAdminSecret(c: Context<HonoEnv>) {
	const token = c.req.header('x-admin-secret')
	if (!token || token !== c.env.SECRET) {
		throw new HTTPException(401, { message: 'Unauthorized' })
	}
}

search.get('/', optionalAuth, async (c) => {
	const url = new URL(c.req.url)
	const results = await searchPublicSmols(c.env, {
		query: url.searchParams.get('q') ?? '',
		limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
		instrumental: parseBooleanParam(url.searchParams.get('instrumental')),
	})

	c.header('Cache-Control', 'no-store')
	return c.json(results)
})

search.get('/:id/similar', optionalAuth, async (c) => {
	const url = new URL(c.req.url)
	const results = await searchSimilarSmols(c.env, {
		id: c.req.param('id'),
		refine: url.searchParams.get('refine') ?? undefined,
		limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
	})

	c.header('Cache-Control', 'no-store')
	return c.json(results)
})

search.post('/admin/reindex/:id', async (c) => {
	assertAdminSecret(c)

	const ok = await queueSearchIndexingById(c.env, c.req.param('id'))
	if (!ok) {
		return c.body(null, 404)
	}

	c.header('Cache-Control', 'no-store')
	return c.json({ ok: true })
})

search.post('/admin/backfill', async (c) => {
	assertAdminSecret(c)

	const url = new URL(c.req.url)
	const { limit, cursor } = parsePaginationParams(url)
	const effectiveLimit = Math.min(limit, 100)
	const whereClause = buildCursorWhereClause(cursor, 'Public = 1')
	const bindings: unknown[] = []

	let query = `
		SELECT Id, Created_At
		FROM Smols
		WHERE ${whereClause[0]}
		ORDER BY Created_At DESC, Id DESC
		LIMIT ?
	`

	if (whereClause.length > 1) {
		bindings.push(whereClause[1], whereClause[2], whereClause[3])
	}

	bindings.push(effectiveLimit)

	const { results } = await c.env.SMOL_D1.prepare(query)
		.bind(...bindings)
		.all<{ Id: string; Created_At: string }>()

	const queuedIds = await queueSearchIndexingBatchById(c.env, results.map(({ Id }) => Id))
	const pagination = buildPaginationResponse(
		results,
		effectiveLimit,
		(item) => item.Created_At,
		(item) => item.Id
	)

	c.header('Cache-Control', 'no-store')
	return c.json({
		queued: queuedIds.length,
		pagination,
	})
})

export default search
