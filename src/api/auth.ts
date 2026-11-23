import { type Context, Hono, type Next } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { sign } from 'hono/jwt'
import { setCookie } from 'hono/cookie'
import { StrKey } from '@stellar/stellar-sdk/minimal'
import type { HonoEnv } from '../types'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import {
	assertContractUndeployed,
	derivePasskeyKitContractId,
	normalizeBase64UrlId,
	verifyRegistration,
	verifyAuthentication,
	type Protocol,
} from '../passkey'

const auth = new Hono<HonoEnv>()

function withNoStore(response: Response): Response {
	const headers = new Headers(response.headers)
	headers.set('Cache-Control', 'no-store')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

async function enforceAuthNoStore(c: Context<HonoEnv>, next: Next) {
	try {
		await next()
	} catch (err) {
		if (err instanceof HTTPException) {
			c.res = withNoStore(err.getResponse())
			return
		}
		throw err
	}

	if (c.res) {
		c.res = withNoStore(c.res)
	}
}

auth.use('/login', enforceAuthNoStore)
auth.use('/logout', enforceAuthNoStore)

function isResponseLike(value: unknown): value is RegistrationResponseJSON | AuthenticationResponseJSON {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

auth.post('/login', async (c) => {
	const { env, req } = c
	let parsedBody: unknown
	try {
		parsedBody = await req.json()
	} catch {
		throw new HTTPException(400, { message: 'Invalid JSON body' })
	}
	if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
		throw new HTTPException(400, { message: 'Invalid JSON body' })
	}
	const body = parsedBody as Record<string, unknown>

	const host = req.header('origin') ?? req.header('referer')
	const { type, keyId, contractId, response, network, protocol } = body as {
		type?: unknown
		keyId?: unknown
		contractId?: unknown
		response?: unknown
		network?: unknown
		protocol?: Protocol
	}

	let { username } = body as { username?: unknown }

	if (!host) {
		throw new HTTPException(400, { message: 'Missing origin and referer' })
	}

	if (network !== undefined && network !== 'mainnet') {
		throw new HTTPException(400, { message: 'Only mainnet login is supported' })
	}

	const allowLocalhost = env.ALLOW_LOCALHOST_ORIGINS === 'true'
	let verifiedKeyId: string
	let verifiedContractId: string

	switch (type) {
		case 'create': {
			if (
				typeof keyId !== 'string'
				|| !keyId
				|| typeof contractId !== 'string'
				|| !contractId
				|| !StrKey.isValidContract(contractId)
				|| !isResponseLike(response)
			) {
				throw new HTTPException(400, { message: 'Missing or invalid registration fields' })
			}
			if (typeof username !== 'string') {
				throw new HTTPException(400, { message: 'Missing username' })
			}

			const normalizedKeyId = normalizeBase64UrlId(keyId)
			const normalizedResponseId = normalizeBase64UrlId(response.id)
			if (!normalizedKeyId || !normalizedResponseId || !normalizedKeyId.buffer.equals(normalizedResponseId.buffer)) {
				throw new HTTPException(400, { message: 'Passkey credential ID mismatch' })
			}

			const expectedContractId = derivePasskeyKitContractId(normalizedKeyId.buffer)
			if (contractId !== expectedContractId) {
				throw new HTTPException(403, { message: 'Contract ID does not match passkey credential' })
			}

			await verifyRegistration(host, response as RegistrationResponseJSON, {
				allowLocalhost,
				expectedKeyId: normalizedKeyId.canonical,
			})

			const existingUser = await env.SMOL_D1.prepare(`SELECT 1 FROM Users WHERE "Address" = ?1 LIMIT 1`)
				.bind(contractId)
				.first()
			if (existingUser) {
				throw new HTTPException(409, { message: 'Account already exists; please sign in instead' })
			}

			await assertContractUndeployed(contractId, env.KALE_WORKER)

			try {
				await env.SMOL_D1.prepare(`INSERT INTO Users ("Address", Username) VALUES (?1, ?2)`)
					.bind(contractId, username)
					.run()
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				if (/UNIQUE constraint failed/i.test(message)) {
					throw new HTTPException(409, { message: 'Account already exists; please sign in instead' })
				}
				throw err
			}

			verifiedKeyId = keyId
			verifiedContractId = contractId
			break
		}
		case 'connect': {
			if (
				typeof keyId !== 'string'
				|| !keyId
				|| typeof contractId !== 'string'
				|| !contractId
				|| !StrKey.isValidContract(contractId)
				|| !isResponseLike(response)
			) {
				throw new HTTPException(400, { message: 'Missing required login fields' })
			}
			await verifyAuthentication(
				host,
				keyId,
				contractId,
				response as AuthenticationResponseJSON,
				env.RPC_URL,
				protocol,
				env.KALE_WORKER,
				{ allowLocalhost },
			)
			const user = await env.SMOL_D1.prepare(`SELECT Username FROM Users WHERE "Address" = ?1`)
				.bind(contractId)
				.first()
			username = user?.Username ?? 'Smol'
			verifiedKeyId = keyId
			verifiedContractId = contractId
			break
		}
		default:
			throw new HTTPException(400, { message: 'Invalid type' })
	}

	const payload = {
		sub: verifiedContractId,
		key: verifiedKeyId,
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

	c.header('Cache-Control', 'no-store')
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

	c.header('Cache-Control', 'no-store')
	return c.body(null, 204)
})

export default auth
