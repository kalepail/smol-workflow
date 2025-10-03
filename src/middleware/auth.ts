import { Context, Next } from 'hono'
import { verify } from 'hono/jwt'
import { getCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'

/**
 * Required authentication middleware
 * Throws 401 if no valid token is found
 */
export async function parseAuth(c: Context<HonoEnv>, next: Next) {
	const authHeader = c.req.header('Authorization')

	if (authHeader) {
		const token = authHeader.split(' ')[1]

		if (token === c.env.SECRET) {
			// Admin token
		} else if (token) {
			c.set('jwtPayload', await verify(token, c.env.SECRET))
		} else {
			throw new HTTPException(401, { message: 'Invalid "Authorization" header' })
		}
	} else {
		const token = getCookie(c, 'smol_token')

		if (token) {
			c.set('jwtPayload', await verify(token, c.env.SECRET))
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
			c.set('jwtPayload', await verify(token, c.env.SECRET))
		} catch {
			/* ignore invalid */
		}
	}

	return next()
}
