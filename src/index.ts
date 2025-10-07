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

export const app = new Hono<HonoEnv>()

// Global CORS middleware
app.use(
	'*',
	cors({
		origin: (origin) => origin ?? '*',
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
app.route('/', smols)

// 404 handler
app.notFound((c) => {
	return c.body(null, 404)
})

// Export handler
const handler = {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>

export { Workflow, TxWorkflow, SmolDurableObject, SmolState, handler as default }
