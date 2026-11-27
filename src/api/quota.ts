import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { StrKey } from '@stellar/stellar-sdk/base'
import type { HonoEnv } from '../types'
import { parseAuth, requireAdmin } from '../middleware/auth'
import { privateNoStore, readJsonBody } from '../utils/http'
import { clearQuotaOverride, getUserQuotaSnapshot, inspectQuotaOverride, setQuotaOverride } from '../utils/quota'

const quota = new Hono<HonoEnv>()

// Authenticated per-user quota status for Classic (aisonggenerator) and ElevenLabs
quota.get('/', parseAuth, async (c) => {
	const payload = c.get('jwtPayload')
	if (!payload?.sub) {
		throw new HTTPException(401, { message: 'User authentication required' })
	}

	let snapshot
	try {
		snapshot = await getUserQuotaSnapshot(c.env, payload.sub)
	} catch {
		throw new HTTPException(503, { message: 'Unable to load generation quota right now' })
	}

	const response = c.json(snapshot)
	response.headers.set('Cache-Control', 'no-store')
	return response
})

/** Mounted at `/admin`: per-address quota overrides stored in the user's `UserQuotaDO`. */
export const quotaAdmin = new Hono<HonoEnv>()

const OVERRIDE_FIELDS = ['classic', 'elevenlabs', 'burstPerMinute'] as const

function overrideField(body: Record<string, unknown>, key: typeof OVERRIDE_FIELDS[number]): number | null {
	const value = body[key]
	if (value === undefined || value === null) return null
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
		throw new HTTPException(400, { message: `${key} must be a non-negative integer or null` })
	}
	return value
}

/**
 * `{ address, action?: 'inspect' | 'set' | 'clear', classic?, elevenlabs?, burstPerMinute? }`.
 * `set` replaces the whole override (an omitted or null field uses the configured default; 0 blocks
 * that provider, or disables the burst guard). `clear` deletes it, so the legacy USER_QUOTA_OVERRIDES
 * secret applies again. The address is never logged.
 */
quotaAdmin.post('/quota-override', privateNoStore, requireAdmin, async (c) => {
	const body = await readJsonBody(c)
	const address = typeof body.address === 'string' ? body.address.trim() : ''
	if (!StrKey.isValidContract(address) && !StrKey.isValidEd25519PublicKey(address)) {
		throw new HTTPException(400, { message: 'address must be a Stellar contract or account address' })
	}
	const action = body.action ?? 'inspect'
	if (action !== 'inspect' && action !== 'set' && action !== 'clear') {
		throw new HTTPException(400, { message: "action must be 'inspect', 'set' or 'clear'" })
	}
	const input = {
		classic: overrideField(body, 'classic'),
		elevenlabs: overrideField(body, 'elevenlabs'),
		burstPerMinute: overrideField(body, 'burstPerMinute'),
	}
	if (action === 'set' && OVERRIDE_FIELDS.every((key) => input[key] === null)) {
		throw new HTTPException(400, { message: 'set needs at least one of classic, elevenlabs, burstPerMinute (use clear to remove)' })
	}

	try {
		const view = action === 'set'
			? await setQuotaOverride(c.env, address, input)
			: action === 'clear'
				? await clearQuotaOverride(c.env, address)
				: await inspectQuotaOverride(c.env, address)
		return c.json(view)
	} catch {
		throw new HTTPException(503, { message: 'Quota override storage unavailable' })
	}
})

export default quota
