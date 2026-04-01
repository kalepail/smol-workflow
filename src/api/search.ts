import { Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'
import { parsePaginationParams } from '../utils/pagination'
import { getSearchBackfillCronStatus, getSearchBackfillPage, queueSearchIndexingBatchById, queueSearchIndexingById, reconcileSearchIndexingBatchById, searchPublicSmols, searchSimilarSmols } from '../utils/search'
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

search.get('/admin/backfill/status', async (c) => {
	assertAdminSecret(c)

	c.header('Cache-Control', 'no-store')
	return c.json(await getSearchBackfillCronStatus(c.env))
})

search.post('/admin/backfill', async (c) => {
	assertAdminSecret(c)

	const url = new URL(c.req.url)
	const { limit, cursor } = parsePaginationParams(url)
	const force = parseBooleanParam(url.searchParams.get('force')) === true
	const page = await getSearchBackfillPage(c.env, { limit, cursor })
	const batch = await queueSearchIndexingBatchById(c.env, page.rows.map(({ Id }) => Id), { force })

	c.header('Cache-Control', 'no-store')
	return c.json({
		queued: batch.queuedIds.length,
		skipped: batch.skipped,
		pagination: page.pagination,
	})
})

search.post('/admin/reconcile', async (c) => {
	assertAdminSecret(c)

	const url = new URL(c.req.url)
	const { limit, cursor } = parsePaginationParams(url)
	const page = await getSearchBackfillPage(c.env, { limit, cursor })
	const reconcile = await reconcileSearchIndexingBatchById(c.env, page.rows.map(({ Id }) => Id))

	c.header('Cache-Control', 'no-store')
	return c.json({
		ready: reconcile.readyIds.length,
		requeued: reconcile.requeuedIds.length,
		skipped: reconcile.skipped,
		pagination: page.pagination,
	})
})

export default search
