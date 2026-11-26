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

export const app = new Hono<HonoEnv>()

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
	},
} satisfies ExportedHandler<Env>

export { Workflow, TxWorkflow, SmolDurableObject, SmolState, UserQuotaDO, handler as default }
