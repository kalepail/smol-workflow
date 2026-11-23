import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'
import { optionalAuth } from '../middleware/auth'

const plays = new Hono<HonoEnv>()

export type PlayCountMode = 'server' | 'beacon'

const MUSIC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const PLAY_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const DEFAULT_PLAY_COOLDOWN_SECONDS = 30
const PLAY_ID_DEDUPE_SECONDS = 300
const DEFAULT_PLAY_RATE_LIMIT_PER_MINUTE = 30
const MAX_PLAY_BODY_BYTES = 1024
const PLAY_GATE_SHARD_COUNT = 64

export function getPlayCountMode(env: Env): PlayCountMode {
	return env.PLAY_COUNT_MODE?.trim().toLowerCase() === 'beacon' ? 'beacon' : 'server'
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback
	const parsed = Number(raw.trim())
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback
	return Math.floor(parsed)
}

async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
	const bytes = new Uint8Array(digest)
	let hex = ''
	for (let i = 0; i < 16; i++) {
		hex += bytes[i].toString(16).padStart(2, '0')
	}
	return hex
}

function resolveCallerIdentity(c: Context<HonoEnv>): string {
	const jwtSub = c.get('jwtPayload')?.sub
	if (jwtSub) {
		return `u:${jwtSub}`
	}
	const cfIp = c.req.header('cf-connecting-ip')?.trim()
	if (cfIp) {
		return `ip:${cfIp}`
	}
	const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
	if (xff) {
		return `ip:${xff}`
	}
	return 'anon'
}

function getPlayGateShardName(callerHash: string): string {
	const prefix = parseInt(callerHash.slice(0, 2), 16)
	const shard = Number.isFinite(prefix) ? prefix % PLAY_GATE_SHARD_COUNT : 0
	return `play-gate:${String(shard).padStart(2, '0')}`
}

async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
	if (!body) {
		return ''
	}
	const reader = body.getReader()
	const chunks: Uint8Array[] = []
	let totalBytes = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value || value.byteLength === 0) continue
			totalBytes += value.byteLength
			if (totalBytes > maxBytes) {
				await reader.cancel('Play beacon body exceeded max size').catch(() => {})
				throw new HTTPException(413, { message: `Play beacon body must be ${maxBytes} bytes or less` })
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}
	if (totalBytes === 0) {
		return ''
	}
	const combined = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		combined.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(combined)
}

async function extractOptionalPlayIdBounded(c: Context<HonoEnv>): Promise<string | undefined> {
	// Reject oversized declared Content-Length BEFORE reading any stream bytes or invoking any DO
	const contentLengthRaw = c.req.header('content-length')?.trim()
	if (contentLengthRaw !== undefined && contentLengthRaw !== '') {
		if (!/^\d+$/.test(contentLengthRaw) || Number(contentLengthRaw) > MAX_PLAY_BODY_BYTES) {
			throw new HTTPException(413, { message: `Play beacon body must be ${MAX_PLAY_BODY_BYTES} bytes or less` })
		}
	}

	// Enforce the 1 KiB body-size cap BEFORE returning on X-Play-Id so oversized chunked bodies
	// always return 413 consistently even when X-Play-Id is also present.
	const raw = await readBoundedText(c.req.raw.body, MAX_PLAY_BODY_BYTES)

	const headerPlayId = c.req.header('x-play-id')?.trim()
	if (headerPlayId && PLAY_ID_RE.test(headerPlayId)) {
		return headerPlayId
	}

	const contentType = (c.req.header('content-type') || '').toLowerCase()
	if (!contentType.includes('application/json') || !raw.trim()) {
		return undefined
	}

	try {
		const body = JSON.parse(raw) as { playId?: unknown; play_id?: unknown }
		const candidate = typeof body?.playId === 'string'
			? body.playId.trim()
			: typeof body?.play_id === 'string'
				? body.play_id.trim()
				: ''
		return candidate && PLAY_ID_RE.test(candidate) ? candidate : undefined
	} catch {
		return undefined
	}
}

/**
 * Q11 cutover-ready play-counting beacon (`POST /plays/:musicId`).
 *
 * - Bounds optional request bodies to <= 1 KiB (413 on overflow) before any JSON parsing or DO RPC.
 * - When `PLAY_COUNT_MODE === 'server'` (default while legacy smol.xyz is live):
 *   validates `musicId` and returns 202 `{ ok: true, counted: false, mode: 'server' }`
 *   with zero D1 or DO calls so new frontends can emit beacons pre-cutover without double-counting.
 * - When `PLAY_COUNT_MODE === 'beacon'`:
 *   atomically serializes per-caller deduplication (30s song cooldown + optional 300s `playId`)
 *   and minute burst rate-limiting inside a fixed 64-shard SQLite Durable Object (`play-gate:00..63`)
 *   BEFORE issuing the indexed D1 `UPDATE Smols SET Plays = Plays + 1`, so concurrent duplicates
 *   and retries produce at most one D1 increment.
 */
plays.post('/:musicId', optionalAuth, async (c) => {
	const rawMusicId = c.req.param('musicId')?.trim() || ''
	const musicId = rawMusicId.endsWith('.mp3') ? rawMusicId.slice(0, -4) : rawMusicId

	if (!musicId || !MUSIC_ID_RE.test(musicId)) {
		throw new HTTPException(400, { message: 'Invalid musicId' })
	}

	const mode = getPlayCountMode(c.env)
	const playId = await extractOptionalPlayIdBounded(c)

	if (mode !== 'beacon') {
		const res = c.json({ ok: true, counted: false, mode: 'server' }, 202)
		res.headers.set('Cache-Control', 'no-store')
		return res
	}

	if (!c.env.USER_QUOTA) {
		throw new HTTPException(503, { message: 'Play beacon admission service unavailable' })
	}

	const callerHash = await sha256Hex(resolveCallerIdentity(c))
	const songDedupeKey = await sha256Hex(`song:${callerHash}:${musicId}`)
	const playIdDedupeKey = playId ? await sha256Hex(`play:${callerHash}:${musicId}:${playId}`) : undefined
	const cooldownSeconds = parsePositiveInt(c.env.PLAY_BEACON_COOLDOWN_SECONDS, DEFAULT_PLAY_COOLDOWN_SECONDS)
	const rateLimitPerMinute = parsePositiveInt(
		c.env.PLAY_BEACON_RATE_LIMIT_PER_MINUTE,
		DEFAULT_PLAY_RATE_LIMIT_PER_MINUTE
	)

	const shardName = getPlayGateShardName(callerHash)
	const shardStub = c.env.USER_QUOTA.get(c.env.USER_QUOTA.idFromName(shardName))

	let admission
	try {
		admission = await shardStub.admitPlayBeacon({
			callerHash,
			songDedupeKey,
			playIdDedupeKey,
			cooldownSeconds,
			playIdTtlSeconds: PLAY_ID_DEDUPE_SECONDS,
			rateLimitPerMinute,
		})
	} catch {
		throw new HTTPException(503, { message: 'Unable to process play beacon right now' })
	}

	if (!admission.admitted) {
		if (admission.deduped) {
			const res = c.json({ ok: true, counted: false, deduped: true, mode: 'beacon' }, 200)
			res.headers.set('Cache-Control', 'no-store')
			return res
		}
		const res = c.json(
			{
				error: 'Too many play beacons',
				code: 'rate_limited',
				retryAfter: admission.retryAfter,
			},
			429
		)
		res.headers.set('Cache-Control', 'no-store')
		res.headers.set('Retry-After', String(admission.retryAfter))
		return res
	}

	const updateResult = await c.env.SMOL_D1.prepare(
		'UPDATE Smols SET Plays = Plays + 1 WHERE Song_1 = ?1 OR Song_2 = ?1'
	)
		.bind(musicId)
		.run()

	const changes = Number(updateResult?.meta?.changes ?? 0)
	if (changes === 0) {
		await shardStub.releasePlayBeaconDedupe({ songDedupeKey, playIdDedupeKey }).catch(() => {})
		const res = c.json({ error: 'Song not found' }, 404)
		res.headers.set('Cache-Control', 'no-store')
		return res
	}

	const res = c.json({ ok: true, counted: true, mode: 'beacon' }, 200)
	res.headers.set('Cache-Control', 'no-store')
	return res
})

export default plays
