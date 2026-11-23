import { Context, Next } from 'hono'
import { verify } from 'hono/jwt'
import { getCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'

async function verifyJwtOrThrow(token: string, secret: string) {
	try {
		return await verify(token, secret, 'HS256')
	} catch {
		throw new HTTPException(401, { message: 'Invalid token' })
	}
}

function extractAdminSecret(c: Context<HonoEnv>): string | null {
	const headerSecret = c.req.header('x-admin-secret')
	if (headerSecret && headerSecret.trim().length > 0) {
		return headerSecret.trim()
	}

	const authHeader = c.req.header('Authorization')
	if (authHeader) {
		const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
		if (match && match[1].trim().length > 0) {
			return match[1].trim()
		}
	}

	return null
}

async function timingSafeSecretEqual(provided: string, expected: string): Promise<boolean> {
	const encoder = new TextEncoder()
	const [providedDigest, expectedDigest] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(provided)),
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
	])

	const subtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean
	}
	if (typeof subtle.timingSafeEqual === 'function') {
		return subtle.timingSafeEqual(providedDigest, expectedDigest)
	}

	// Constant-time fallback for non-Workers test runtimes (e.g. Node)
	const a = new Uint8Array(providedDigest)
	const b = new Uint8Array(expectedDigest)
	let diff = 0
	for (let i = 0; i < a.length; i += 1) {
		diff |= a[i] ^ b[i]
	}
	return diff === 0
}

/**
 * Required admin authentication middleware.
 * Fails closed with 404 when ADMIN_SECRET is unset, blank, or identical to the JWT signing SECRET.
 * Validates x-admin-secret or Authorization: Bearer <token> against ADMIN_SECRET
 * using SHA-256 + timing-safe comparison. Never accepts the JWT signing SECRET.
 */
export async function requireAdmin(c: Context<HonoEnv>, next: Next) {
	const expectedSecret = c.env.ADMIN_SECRET?.trim()
	if (!expectedSecret) {
		throw new HTTPException(404, { message: 'Not Found' })
	}

	const signingSecret = c.env.SECRET?.trim()
	if (signingSecret && (await timingSafeSecretEqual(expectedSecret, signingSecret))) {
		throw new HTTPException(404, { message: 'Not Found' })
	}

	const providedSecret = extractAdminSecret(c)
	if (!providedSecret || !(await timingSafeSecretEqual(providedSecret, expectedSecret))) {
		throw new HTTPException(401, { message: 'Unauthorized' })
	}

	return next()
}

/**
 * Required authentication middleware
 * Throws 401 if no valid user JWT is found
 */
export async function parseAuth(c: Context<HonoEnv>, next: Next) {
	const authHeader = c.req.header('Authorization')

	if (authHeader) {
		const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
		const token = match?.[1]?.trim()

		if (token) {
			c.set('jwtPayload', await verifyJwtOrThrow(token, c.env.SECRET))
		} else {
			throw new HTTPException(401, { message: 'Invalid "Authorization" header' })
		}
	} else {
		const token = getCookie(c, 'smol_token')

		if (token) {
			c.set('jwtPayload', await verifyJwtOrThrow(token, c.env.SECRET))
		} else {
			throw new HTTPException(401, { message: 'Invalid "Cookie" token' })
		}
	}

	return next()
}

/**
 * Optional authentication middleware
 * Sets jwtPayload if token present but does not throw on missing/invalid tokens
 */
export async function optionalAuth(c: Context<HonoEnv>, next: Next) {
	const authHeader = c.req.header('Authorization')
	let token: string | undefined

	if (authHeader && authHeader.startsWith('Bearer ')) {
		token = authHeader.split(' ')[1]
	} else {
		token = getCookie(c, 'smol_token')
	}

	if (token) {
		try {
			c.set('jwtPayload', await verify(token, c.env.SECRET, 'HS256'))
		} catch {
			/* ignore invalid */
		}
	}

	return next()
}
