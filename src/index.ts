import { Hono } from 'hono'
import { cors } from 'hono/cors'
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
import media from './api/media'
import search from './api/search'
import artists from './api/artists'
import quota from './api/quota'
import plays from './api/plays'
import { processSearchQueue, processSearchDLQ, runSearchBackfillCron } from './utils/search'

export const app = new Hono<HonoEnv>()

export const ALLOWED_CORS_ORIGINS = new Set([
	'https://smol.xyz',
	'https://next.smol.xyz',
	'https://noot.smol.xyz',
])

const DEV_CORS_ORIGINS = new Set([
	'http://localhost:3000',
	'http://localhost:5173',
	'http://127.0.0.1:3000',
	'http://127.0.0.1:5173',
])

export function allowedCorsOrigin(origin: string, allowLocalhost = false): string | null {
	if (!origin) {
		return null
	}

	if (ALLOWED_CORS_ORIGINS.has(origin)) {
		return origin
	}

	if (allowLocalhost && DEV_CORS_ORIGINS.has(origin)) {
		return origin
	}

	return null
}

// Global CORS middleware
app.use(
	'*',
	cors({
		origin: (origin, c) => allowedCorsOrigin(origin, c.env?.ALLOW_LOCALHOST_ORIGINS === 'true'),
		credentials: true,
		exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'ETag', 'Retry-After'],
	})
)

// Note: ETag middleware removed for cached endpoints
// The cache() middleware already handles caching efficiently
// ETags would be redundant since cache hits return the stored response
// without recalculating hashes or checking If-None-Match headers

// Mount route modules
app.route('/', auth)
app.route('/likes', likes)
app.route('/playlist', playlists)
app.route('/mixtapes', mixtapes)
app.route('/mint', mint)
app.route('/chain', chain)
app.route('/song', media)
app.route('/image', media)
app.route('/search', search)
app.route('/artists', artists)
app.route('/quota', quota)
app.route('/plays', plays)
app.route('/', smols)

// 404 handler
app.notFound((c) => {
	return c.body(null, 404)
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
