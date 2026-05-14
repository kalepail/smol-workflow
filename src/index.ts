import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { etag } from 'hono/etag'
import { SmolDurableObject, SmolState } from './do'
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
import media from './api/media'
import search from './api/search'
import artists from './api/artists'
import { processSearchQueue, processSearchDLQ, runSearchBackfillCron } from './utils/search'

export const app = new Hono<HonoEnv>()

const DEV_CORS_ORIGINS = new Set([
	'http://localhost:3000',
	'http://localhost:5173',
	'http://127.0.0.1:3000',
	'http://127.0.0.1:5173',
])

function allowedCorsOrigin(origin: string): string | null {
	if (!origin) {
		return null
	}

	try {
		const url = new URL(origin)
		const isSmolOrigin = url.protocol === 'https:' && (url.hostname === 'smol.xyz' || url.hostname.endsWith('.smol.xyz'))

		if (isSmolOrigin || DEV_CORS_ORIGINS.has(origin)) {
			return origin
		}
	} catch {
		return null
	}

	return null
}

// Global CORS middleware
app.use(
	'*',
	cors({
		origin: (origin) => allowedCorsOrigin(origin),
		credentials: true,
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
app.route('/song', media)
app.route('/image', media)
app.route('/search', search)
app.route('/artists', artists)
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

export { Workflow, TxWorkflow, SmolDurableObject, SmolState, handler as default }
