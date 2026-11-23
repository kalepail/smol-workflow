import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'
import { parseAuth } from '../middleware/auth'
import { getUserQuotaSnapshot } from '../utils/quota'

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

export default quota
