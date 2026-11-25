import type { Context, Next } from 'hono'
import type { HonoEnv } from '../types'
import { allowedCorsOrigin } from './cors'
import { runBackground } from './http'

/** Browser and edge both get 30 s; Cache-Tag purges evict the edge copy early. */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=30, s-maxage=30, stale-while-revalidate=60'

function edgeCache(): Cache | undefined {
	return typeof caches === 'undefined' ? undefined : (caches as unknown as { default?: Cache }).default
}

/** One shared copy serves every origin, so it must not carry the first requester's CORS headers. */
export function stripOriginSpecificHeaders(headers: Headers): Headers {
	const clean = new Headers(headers)
	for (const name of [...clean.keys()]) {
		if (name.startsWith('access-control-')) clean.delete(name)
	}
	clean.delete('Vary')
	return clean
}

/**
 * Origin-neutral public list cache on `caches.default`. The key is the request URL alone (no Origin,
 * Cookie or Authorization: these routes never read them). A hit is re-wrapped with mutable headers so
 * the global `cors()` middleware applies the requester's own CORS headers on the way out. Requests
 * from unlisted origins bypass the cache, and only `200 GET` responses are stored.
 */
export async function publicCache(c: Context<HonoEnv, string>, next: Next) {
	const cache = edgeCache()
	const origin = c.req.header('Origin')
	const isListedOrigin = !origin || allowedCorsOrigin(origin, c.env.ALLOW_LOCALHOST_ORIGINS === 'true') !== null
	if (!cache || !isListedOrigin) return next()

	const key = new Request(c.req.url, { method: 'GET' })
	const hit = await cache.match(key)
	if (hit) {
		return new Response(hit.body, { status: hit.status, headers: stripOriginSpecificHeaders(hit.headers) })
	}

	await next()
	if (c.res.status !== 200 || c.req.method !== 'GET') return
	c.res.headers.set('Cache-Control', PUBLIC_CACHE_CONTROL)
	const copy = new Response(c.res.clone().body, { status: 200, headers: stripOriginSpecificHeaders(c.res.headers) })
	runBackground(c, cache.put(key, copy))
}
