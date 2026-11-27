import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { SmolDurableObject, SmolState } from './do'
import { UserQuotaDO } from './quota-do'
import { Workflow } from './workflow'
import { TxWorkflow } from './tx-workflow'
import type { HonoEnv } from './types'

// Import route modules
import auth from './api/auth'
import smols from './api/smols'
import likes from './api/likes'
import playlists from './api/playlists'
import mixtapes from './api/mixtapes'
import mint from './api/mint'
import chain from './api/chain'
import { image, song, video } from './api/media'
import search from './api/search'
import artists from './api/artists'
import quota from './api/quota'
import plays from './api/plays'
import { processSearchQueue, processSearchDLQ, runSearchBackfillCron } from './utils/search'
import { allowedCorsOrigin } from './utils/cors'
import { pruneExpiredMintBatchStatus } from './utils/mint-status-prune'

export const app = new Hono<HonoEnv>()

// Cache-Tag labels the copies stored with cache.put (they keep their own headers) so tag purges can
// evict them; it is never sent to clients. Registered first, so it runs after every other middleware.
app.use('*', async (c, next) => {
	await next()
	if (!c.res.headers.has('Cache-Tag')) return
	try {
		c.res.headers.delete('Cache-Tag')
	} catch {
		const headers = new Headers(c.res.headers)
		headers.delete('Cache-Tag')
		const clean = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers })
		c.res = undefined // Hono would otherwise merge the old headers back into the replacement
		c.res = clean
	}
})

// Global CORS middleware
app.use(
	'*',
	cors({
		origin: (origin, c) => allowedCorsOrigin(origin, c.env?.ALLOW_LOCALHOST_ORIGINS === 'true'),
		credentials: true,
		exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'ETag', 'Retry-After'],
	})
)

// Mount route modules
app.route('/', auth)
app.route('/likes', likes)
app.route('/playlist', playlists)
app.route('/mixtapes', mixtapes)
app.route('/mint', mint)
app.route('/chain', chain)
app.route('/song', song)
app.route('/image', image)
app.route('/video', video)
app.route('/search', search)
app.route('/artists', artists)
app.route('/quota', quota)
app.route('/plays', plays)
app.route('/', smols)

// 404 handler
app.notFound((c) => {
	return c.body(null, 404)
})

// HTTPExceptions keep their status and body; anything else is an opaque, never-cached 500.
app.onError((err, c) => {
	if (err instanceof HTTPException) return err.getResponse()
	console.error('Unhandled request error:', c.req.method, c.req.path, err)
	return c.json({ error: 'internal_error' }, 500, { 'Cache-Control': 'no-store' })
})

// Export handler
const handler = {
	fetch: app.fetch,
	queue: (batch, env, ctx) => {
		if (batch.queue === 'smol-search-queue-dlq') {
			return processSearchDLQ(batch as MessageBatch<SearchQueueMessage>, env, ctx)
		}
		return processSearchQueue(batch as MessageBatch<SearchQueueMessage>, env, ctx)
	},
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(runSearchBackfillCron(env))
		ctx.waitUntil(pruneExpiredMintBatchStatus(env).catch((error) => {
			console.warn('Mint status pruning failed:', error instanceof Error ? error.name : 'UnknownError')
		}))
	},
} satisfies ExportedHandler<Env>

export { Workflow, TxWorkflow, SmolDurableObject, SmolState, UserQuotaDO, handler as default }
