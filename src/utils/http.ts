import type { Context, Next } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'

export const PRIVATE_HEADERS = {
	'Cache-Control': 'private, no-store',
	'CDN-Cache-Control': 'no-store',
	Vary: 'Cookie, Authorization',
} as const

/**
 * Private, never-shared cache policy on EVERY response, including the 400/401/403 that auth
 * middleware throws. Mount it before `parseAuth` / `requireAdmin`.
 */
export async function privateNoStore(c: Context<HonoEnv, string>, next: Next) {
	await next()
	for (const [name, value] of Object.entries(PRIVATE_HEADERS)) c.res.headers.set(name, value)
}

/** A JSON object body, or 400. */
export async function readJsonBody(c: Context<HonoEnv>): Promise<Record<string, unknown>> {
	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		throw new HTTPException(400, { message: 'Invalid JSON body' })
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new HTTPException(400, { message: 'Invalid JSON body' })
	}
	return body as Record<string, unknown>
}

/** Best-effort work after the response; runs inline-detached when there is no execution context. */
export function runBackground(c: Context<HonoEnv>, task: Promise<unknown>): void {
	const safeTask = task.catch((err) => {
		console.warn('Background task failed:', err)
	})
	try {
		c.executionCtx.waitUntil(safeTask)
	} catch {
		void safeTask
	}
}
