import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'
import { requireAdmin } from '../middleware/auth'
import { privateNoStore, readJsonBody } from '../utils/http'
import { parsePaginationParams } from '../utils/pagination'
import {
	getSearchBackfillCronStatus,
	getSearchBackfillPage,
	listSearchDlq,
	queueSearchIndexingBatchById,
	queueSearchIndexingById,
	reconcileSearchIndexingBatchById,
	replaySearchDlq,
	searchPublicSmols,
	searchSimilarSmols,
} from '../utils/search'

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

// Admin responses (including 401/404 from requireAdmin) are never cached.
search.use('/admin/*', privateNoStore, requireAdmin)

search.get('/', async (c) => {
	const url = new URL(c.req.url)
	const results = await searchPublicSmols(c.env, {
		query: url.searchParams.get('q') ?? '',
		limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
		instrumental: parseBooleanParam(url.searchParams.get('instrumental')),
	})

	c.header('Cache-Control', 'no-store')
	return c.json(results)
})

search.get('/:id/similar', async (c) => {
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
	const ok = await queueSearchIndexingById(c.env, c.req.param('id'))
	if (!ok) {
		return c.body(null, 404)
	}

	return c.json({ ok: true })
})

search.get('/admin/backfill/status', async (c) => {
	return c.json(await getSearchBackfillCronStatus(c.env))
})

search.post('/admin/backfill', async (c) => {
	const url = new URL(c.req.url)
	const { limit, cursor } = parsePaginationParams(url)
	const force = parseBooleanParam(url.searchParams.get('force')) === true
	const page = await getSearchBackfillPage(c.env, { limit, cursor })
	const batch = await queueSearchIndexingBatchById(c.env, page.rows.map(({ Id }) => Id), { force })

	return c.json({
		queued: batch.queuedIds.length,
		skipped: batch.skipped,
		pagination: page.pagination,
	})
})

search.post('/admin/reconcile', async (c) => {
	const url = new URL(c.req.url)
	const { limit, cursor } = parsePaginationParams(url)
	const page = await getSearchBackfillPage(c.env, { limit, cursor })
	const reconcile = await reconcileSearchIndexingBatchById(c.env, page.rows.map(({ Id }) => Id))

	return c.json({
		ready: reconcile.readyIds.length,
		requeued: reconcile.requeuedIds.length,
		skipped: reconcile.skipped,
		pagination: page.pagination,
	})
})

search.get('/admin/dlq', async (c) => {
	return c.json(await listSearchDlq(c.env, c.req.query('cursor') || undefined))
})

search.post('/admin/dlq/replay', async (c) => {
	const { keys } = await readJsonBody(c)
	if (!Array.isArray(keys) || keys.length === 0 || keys.length > 100 || !keys.every((key) => typeof key === 'string')) {
		throw new HTTPException(400, { message: 'keys must be 1-100 DLQ record keys' })
	}
	return c.json(await replaySearchDlq(c.env, keys))
})

export default search
