import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { sign } from 'hono/jwt'
import { setCookie } from 'hono/cookie'
import type { HonoEnv } from '../types'

const auth = new Hono<HonoEnv>()

auth.post('/login', async (c) => {
	const { env, req } = c
	const body = await req.json()
	const host = req.header('origin') ?? req.header('referer')
	const { type, response, keyId, contractId } = body

	let { username } = body

	if (!host) {
		throw new HTTPException(400, { message: 'Missing origin and referer' })
	}

	switch (type) {
		case 'create':
			// await verifyRegistration(host, response)
			await env.SMOL_D1.prepare(`INSERT INTO Users ("Address", Username) VALUES (?1, ?2)`)
				.bind(contractId, username)
				.run()
			break
		case 'connect':
			// await verifyAuthentication(host, keyId, contractId, response)
			const user = await env.SMOL_D1.prepare(`SELECT Username FROM Users WHERE "Address" = ?1`)
				.bind(contractId)
				.first()
			username = user?.Username ?? 'Smol'
			break
		default:
			throw new HTTPException(400, { message: 'Invalid type' })
	}

	const payload = {
		sub: contractId,
		key: keyId,
		usr: username,
		exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30, // Token expires in 30 days
	}
	const token = await sign(payload, env.SECRET)

	setCookie(c, 'smol_token', token, {
		path: '/',
		secure: true,
		sameSite: 'Lax',
		maxAge: 60 * 60 * 24 * 30,
		domain: '.smol.xyz',
	})

	return c.text(token)
})

auth.post('/logout', async (c) => {
	setCookie(c, 'smol_token', 'noop', {
		path: '/',
		secure: true,
		sameSite: 'Lax',
		maxAge: 0,
		domain: '.smol.xyz',
	})

	return c.body(null, 204)
})

export default auth
