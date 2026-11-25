import { Hono, type Context } from 'hono'
import { isWorkflowAlreadyExistsError, isWorkflowNotFoundError } from '../utils/workflow-errors'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv } from '../types'
import { parseAuth, optionalAuth, requireAdmin } from '../middleware/auth'
import { parsePaginationParams, buildCursorWhereClause, paginate } from '../utils/pagination'
import { purgeCacheByTags } from '../utils/cache'
import { artistSmolsCacheTag, playlistCacheTags } from '../utils/cache-tags'
import { privateNoStore, readJsonBody, runBackground } from '../utils/http'
import { publicCache } from '../utils/public-cache'
import { assertNoUnresolvedMintReceipt, MintIneligible } from '../utils/mint-eligibility'
import { isDurableObjectId } from '../utils/durable-object-id'
import { queueSearchDeletionById } from '../utils/search'
import { requireOwnedVisibilityToggle, syncSearchVisibilityAfterToggle } from '../utils/search-visibility'
import { isNsfwBlocked, normalizeNsfwResult } from '../ai/nsfw'
import { isContentPolicyMessage } from '../ai/aisonggenerator'
import {
	classifyRetryAdmission,
	DEFAULT_MUSIC_PROVIDER,
	isValidMusicProvider,
	resolveRetryTargetProvider,
} from '../utils/songs'
import {
	buildQuotaExceededResponse,
	refundGenerationQuota,
	reserveGenerationQuota,
} from '../utils/quota'

const smols = new Hono<HonoEnv>()
// Keep these in sync with smol-fe generation controls and provider payload limits.
const MAX_LYRICAL_PROMPT_LENGTH = 2280
const MAX_INSTRUMENTAL_PROMPT_LENGTH = 380
const CURRENT_WORKFLOW_VERSION = 2

interface SmolListItem {
	Id: string
	Title: string
	Song_1: string
	Mint_Token: string | null
	Mint_Amm: string | null
	Created_At: string
	Public: number
}

interface SmolD1Record {
	Id: string
	Title?: string
	Song_1?: string
	Song_2?: string | null
	Public: number
	Address: string | null
	Mint_Token?: string | null
	Mint_Amm?: string | null
	Requested_Provider?: string | null
	Actual_Provider?: string | null
	[key: string]: unknown
}

interface SmolFailure {
	code: 'content_policy' | 'generation_timeout' | 'provider_unavailable' | 'generation_failed' | 'terminated'
	title: string
	message: string
	retryable: boolean
	suggestAlternate?: boolean
}

const SAME_PROVIDER_DEAD = new Set([
	'provider_misconfigured',
	'provider_auth_error',
	'provider_quota_exceeded',
	'credits_exhausted',
])
const CONFIG_ERROR_RE = /\b(?:provider_misconfigured|not configured|missing\s+[A-Z0-9_]+|BYOK)\b/i
const SAFE_WORKFLOW_ERROR_NAMES = new Set(['Error', 'NonRetryableError', 'WorkflowFatalError'])

function sanitizeWorkflowStatusForDetail(wfStatus: InstanceStatus | null | undefined) {
	if (!wfStatus) {
		return wfStatus
	}
	const rawName = wfStatus.error?.name?.trim()
	const safeName = rawName && SAFE_WORKFLOW_ERROR_NAMES.has(rawName) ? rawName : 'Error'
	return {
		status: wfStatus.status,
		...(wfStatus.error ? { error: { name: safeName } } : {}),
	}
}

// GET /:id exposes an allowlist of workflow state: what smol-fe renders, never vendor internals
// (provider task/workspace IDs, raw upstream errors, credits, base64 images, quota/retry plumbing).
const PAYLOAD_FIELDS = ['address', 'prompt', 'instrumental', 'public', 'playlist', 'provider']
const LYRICS_FIELDS = ['title', 'style', 'lyrics']
const SONG_FIELDS = ['music_id', 'status', 'audio', 'duration', 'service', 'provider']
const PROVIDER_FIELDS = ['requested_provider', 'active_provider', 'actual_provider', 'fallback_from']
const NSFW_CODE = /^S(?:[1-9]|1[0-4])$/
const REASON_CODE = /^[a-z0-9_]{1,64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function pickFields(source: unknown, keys: readonly string[]): Record<string, unknown> {
	const picked: Record<string, unknown> = {}
	if (!isRecord(source)) return picked
	for (const key of keys) {
		if (source[key] !== undefined) picked[key] = source[key]
	}
	return picked
}

/** Provider names plus a fallback reason only when it is a plain code (never upstream text). */
function pickProviderFields(source: unknown): Record<string, unknown> {
	const picked = pickFields(source, PROVIDER_FIELDS)
	const reason = isRecord(source) ? source.fallback_reason : undefined
	if (typeof reason === 'string' && REASON_CODE.test(reason)) picked.fallback_reason = reason
	return picked
}

/** Llama Guard verdict with only the S1-S14 category codes (no diagnostic words). */
function sanitizeNsfw(raw: unknown) {
	const { safe, categories, unknown } = normalizeNsfwResult(raw)
	return { safe, categories: categories.filter((code) => NSFW_CODE.test(code)), ...(unknown ? { unknown } : {}) }
}

function sanitizeKvDoForDetail(raw: Record<string, any> | null | undefined, failure?: SmolFailure) {
	const steps: Record<string, any> = raw ?? {}
	return {
		...pickFields(steps, ['description', 'duration']),
		...pickProviderFields(steps),
		...(isRecord(steps.payload) ? { payload: pickFields(steps.payload, PAYLOAD_FIELDS) } : {}),
		...(isRecord(steps.generation_meta) ? { generation_meta: pickProviderFields(steps.generation_meta) } : {}),
		...(isRecord(steps.lyrics) ? { lyrics: pickFields(steps.lyrics, LYRICS_FIELDS) } : {}),
		...(steps.nsfw != null ? { nsfw: sanitizeNsfw(steps.nsfw) } : {}),
		...(Array.isArray(steps.songs)
			? { songs: steps.songs.filter(isRecord).map((song) => pickFields(song, SONG_FIELDS)) }
			: {}),
		image: Boolean(steps.image_base64 || steps.image),
		...(failure ? { failure } : {}),
	}
}

function normalizeD1DetailRow(row: SmolD1Record): SmolD1Record {
	return {
		...row,
		Song_2: row.Song_2 || null,
	}
}

export function getSmolFailure(steps: any, wfStatus?: InstanceStatus | null): SmolFailure | undefined {
	const failedSong = Array.isArray(steps?.songs)
		? steps.songs.find((song: any) => typeof song?.status === 'number' && song.status < 0)
		: undefined
	const attemptErrorCode = typeof steps?.provider_attempt?.error_code === 'string'
		? steps.provider_attempt.error_code
		: undefined
	const attemptDead = attemptErrorCode !== undefined && SAME_PROVIDER_DEAD.has(attemptErrorCode)

	if (failedSong) {
		const rawTrimmed = typeof failedSong.error_message === 'string' && failedSong.error_message.trim()
			? failedSong.error_message.trim()
			: undefined
		const dead = attemptDead || (rawTrimmed !== undefined && CONFIG_ERROR_RE.test(rawTrimmed))

		if (failedSong.status === -1 || attemptErrorCode === 'content_policy' || isContentPolicyMessage(rawTrimmed)) {
			return {
				code: 'content_policy',
				title: 'Song provider rejected this generation',
				message: 'One generated song was rejected by the song provider content policy. Try again with a less sensitive prompt or lyrics.',
				retryable: false,
			}
		}

		if (dead) {
			return {
				code: failedSong.status === -3 ? 'provider_unavailable' : 'generation_failed',
				title: 'This model is temporarily unavailable',
				message: 'This song model is temporarily unavailable. Try again later or switch to another model.',
				retryable: false,
				suggestAlternate: true,
			}
		}

		switch (failedSong.status) {
			case -2:
				return {
					code: 'generation_timeout',
					title: 'Song generation timed out',
					message: 'The song provider did not finish this generation in time. Retrying usually fixes this.',
					retryable: true,
				}
			case -3:
				return {
					code: 'provider_unavailable',
					title: 'Song provider is temporarily unavailable',
					message: 'The song provider reported a temporary issue. Retrying later is the best next step.',
					retryable: true,
				}
			default:
				return {
					code: 'generation_failed',
					title: 'Song generation failed',
					message: 'The song provider could not complete this generation. Try again or adjust the prompt.',
					retryable: true,
				}
		}
	}

	if (wfStatus?.status === 'terminated') {
		return {
			code: 'terminated',
			title: 'Generation was stopped',
			message: 'This generation was stopped before it could finish.',
			retryable: true,
		}
	}

	if (wfStatus?.status === 'errored') {
		if (attemptDead) {
			return {
				code: 'generation_failed',
				title: 'This model is temporarily unavailable',
				message: 'This song model is temporarily unavailable. Try again later or switch to another model.',
				retryable: false,
				suggestAlternate: true,
			}
		}
		return {
			code: 'generation_failed',
			title: 'Generation failed',
			message: 'This generation failed before it could finish. Retrying may recover it.',
			retryable: true,
		}
	}
}

async function loadRetryableSmolState(
	env: Env,
	id: string,
	options: { strictDo?: boolean } = {}
): Promise<{
	steps: WorkflowSteps | null
	source: 'do' | 'kv' | null
	doError?: boolean
}> {
	let retrySteps: WorkflowSteps | null | undefined
	let doError = false

	if (isDurableObjectId(id)) {
		try {
			const doid = env.DURABLE_OBJECT.idFromString(id)
			const stub = env.DURABLE_OBJECT.get(doid)
			retrySteps = await stub.getSteps() as WorkflowSteps
			if (retrySteps?.payload?.address && retrySteps?.payload?.prompt) {
				return { steps: retrySteps, source: 'do' }
			}
		} catch (err) {
			if (options.strictDo) {
				throw err
			}
			doError = true
			retrySteps = undefined
		}
	}

	const kvSteps = await env.SMOL_KV.get(id, 'json') as WorkflowSteps | null
	if (kvSteps?.payload?.address && kvSteps?.payload?.prompt) {
		return { steps: kvSteps, source: 'kv' }
	}

	return { steps: null, source: null, doError }
}

/**
 * Check whether a smol is already published in D1.
 * Fails closed: D1 read errors propagate rather than being treated as "unpublished".
 */
async function getPublishedSmolRow(env: Env, id: string): Promise<SmolD1Record | null> {
	return await env.SMOL_D1.prepare(
		`SELECT Id, Song_1, Song_2, Mint_Token, Mint_Amm FROM Smols WHERE Id = ?1`
	)
		.bind(id)
		.first<SmolD1Record>()
}

export { isWorkflowAlreadyExistsError, isWorkflowNotFoundError } from '../utils/workflow-errors'

async function inspectWorkflowInstanceState(
	env: Env,
	instanceId: string
): Promise<'active' | 'complete' | 'terminal' | 'missing' | 'unknown'> {
	try {
		const instance = await env.WORKFLOW.get(instanceId)
		const status = await instance.status()
		if (status.status === 'complete') {
			return 'complete'
		}
		if (status.status === 'errored' || status.status === 'terminated') {
			return 'terminal'
		}
		if (
			status.status === 'queued'
			|| status.status === 'running'
			|| status.status === 'paused'
			|| status.status === 'waiting'
			|| status.status === 'waitingForPause'
		) {
			return 'active'
		}
		// Explicitly propagate Cloudflare Workflows' 'unknown' (or unrecognized) status as indeterminate
		return 'unknown'
	} catch (err) {
		if (isWorkflowNotFoundError(err)) {
			return 'missing'
		}
		throw err
	}
}

async function getPlaylistTitlesForSmol(env: Env, smolId: string): Promise<string[]> {
	try {
		const res = await env.SMOL_D1.prepare(`SELECT Title FROM Playlists WHERE Id = ?1`)
			.bind(smolId)
			.all<{ Title: string }>()
		return (res.results ?? []).map((r) => r.Title).filter(Boolean)
	} catch {
		return []
	}
}

/**
 * Check if any remaining row in D1 Smols references `musicId`.
 * Fails closed: returns 'unknown' on D1 errors so callers PRESERVE the R2 MP3
 * instead of risking deletion of a shared track.
 */
async function checkSongReferenceStatus(env: Env, musicId: string): Promise<'referenced' | 'unreferenced' | 'unknown'> {
	try {
		const row = await env.SMOL_D1.prepare(
			`SELECT 1 FROM Smols WHERE Song_1 = ?1 OR Song_2 = ?1 LIMIT 1`
		)
			.bind(musicId)
			.first()
		return row ? 'referenced' : 'unreferenced'
	} catch (error) {
		console.warn('Song reference lookup failed; preserving R2 object for later cleanup:', musicId, error instanceof Error ? error.message : String(error))
		return 'unknown'
	}
}

/** One `LIMIT + 1` page of smol list items from `from` (aliased `s`), newest first. */
async function listSmols(c: Context<HonoEnv>, from: string, conditions: string, bindings: unknown[]) {
	const { limit, cursor } = parsePaginationParams(new URL(c.req.url))
	const [where, ...cursorBindings] = buildCursorWhereClause(cursor, conditions, 's.')
	const { results } = await c.env.SMOL_D1.prepare(`
		SELECT s.Id, s.Title, s.Song_1, s.Mint_Token, s.Mint_Amm, s.Created_At, s.Public
		FROM ${from}
		WHERE ${where}
		ORDER BY s.Created_At DESC, s.Id DESC
		LIMIT ?
	`).bind(...bindings, ...cursorBindings, limit + 1).all<SmolListItem>()
	const { items, pagination } = paginate(results, limit)
	return { smols: items, pagination }
}

// Get all public smols
smols.get('/', publicCache, async (c) => {
	const response = c.json(await listSmols(c, 'Smols s', 's.Public = 1', []))
	response.headers.append('Cache-Tag', 'public-smols')
	return response
})

const MAX_CREATED_QUERY_LENGTH = 100

/**
 * `LIKE ? ESCAPE '\'` pattern matching `query` literally anywhere in `LOWER(Title)`. Only ASCII is
 * folded, mirroring SQLite/D1 `LOWER()` (no ICU), so non-ASCII titles still match themselves.
 */
function titleContainsPattern(query: string): string {
	const folded = query.replace(/[A-Z]+/g, (run) => run.toLowerCase())
	return `%${folded.replace(/[\\%_]/g, '\\$&')}%`
}

// Get smols created by authenticated user (never shared-cached). Optional `q` filters by title,
// case-insensitively, before cursor pagination; ownership stays the first condition.
smols.get('/created', privateNoStore, parseAuth, async (c) => {
	const sub = c.get('jwtPayload')!.sub
	const q = (c.req.query('q') ?? '').trim()
	if (!q) {
		return c.json(await listSmols(c, 'Smols s', 's."Address" = ?', [sub]))
	}
	if (q.length > MAX_CREATED_QUERY_LENGTH) {
		return c.json({ error: 'Query too long' }, 400)
	}
	const conditions = `s."Address" = ? AND LOWER(s.Title) LIKE ? ESCAPE '\\'`
	return c.json(await listSmols(c, 'Smols s', conditions, [sub, titleContainsPattern(q)]))
})

// Get smols liked by authenticated user (never shared-cached)
smols.get('/liked', privateNoStore, parseAuth, async (c) => {
	const from = 'Smols s INNER JOIN Likes l ON s.Id = l.Id'
	return c.json(await listSmols(c, from, 'l."Address" = ?', [c.get('jwtPayload')!.sub]))
})

// Get specific smol by ID
smols.get(
	'/:id',
	optionalAuth,
	async (c) => {
		const { env, req } = c
		const id = req.param('id')

		const payload = c.get('jwtPayload')
		let liked = false

		const smol_d1 = await env.SMOL_D1.prepare(`SELECT * FROM Smols WHERE Id = ?1`)
			.bind(id)
			.first<SmolD1Record>()

		if (smol_d1) {
			if (payload?.sub) {
				const likedRow = await env.SMOL_D1.prepare(
					`SELECT 1 FROM Likes WHERE Id = ?1 AND "Address" = ?2`
				)
					.bind(id, payload.sub)
					.first()

				liked = !!likedRow
			}

			let smol_kv: Record<string, any> | null = await env.SMOL_KV.get(id, 'json')

			// Allow for KV propagation lag immediately after publish by consulting completed DO state
			if (!smol_kv && isDurableObjectId(id)) {
				try {
					const doid = env.DURABLE_OBJECT.idFromString(id)
					const stub = env.DURABLE_OBJECT.get(doid)
					const doSteps = (await stub.getSteps()) as Record<string, any>
					if (doSteps && Object.keys(doSteps).length > 0) {
						smol_kv = doSteps
					}
				} catch {
					// Keep null fallback
				}
			}

			// Increment views non-blockingly
			runBackground(
				c,
				env.SMOL_D1.prepare('UPDATE Smols SET Views = Views + 1 WHERE Id = ?')
					.bind(id)
					.run()
			)

			const kv_do = sanitizeKvDoForDetail(smol_kv)

			const response = c.json({
				kv_do,
				d1: normalizeD1DetailRow(smol_d1),
				liked,
			})

			if (payload?.sub) {
				response.headers.set('Cache-Control', 'private, max-age=30')
				response.headers.append('Cache-Tag', `user:${payload.sub}:smol:${id}`)
			} else {
				response.headers.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
				response.headers.append('Cache-Tag', `smol:${id}:anonymous`)
			}

			return response
		}

		// Not yet in D1 -> fetch from DO / workflow (in-progress SMOL)
		if (!isDurableObjectId(id)) {
			throw new HTTPException(404, { message: 'Smol not found' })
		}

		const doid = env.DURABLE_OBJECT.idFromString(id)
		const stub = env.DURABLE_OBJECT.get(doid)
		const instance = await new Promise<WorkflowInstance | null>(async (resolve) => {
			try {
				resolve(await env.WORKFLOW.get(id))
			} catch {
				resolve(null)
			}
		})

		const steps = (await stub.getSteps()) as Record<string, any> || {}
		const wfStatus = instance && (await instance.status())

		if (!payload?.sub || steps?.payload?.address !== payload.sub) {
			throw new HTTPException(404, { message: 'Smol not found' })
		}

		const failure = getSmolFailure(steps, wfStatus)
		const kv_do = sanitizeKvDoForDetail(steps, failure)

		const response = c.json({
			kv_do,
			wf: sanitizeWorkflowStatusForDetail(wfStatus),
			liked,
		})

		response.headers.set('Cache-Control', 'no-store')

		return response
	}
)

// Create new smol
smols.post('/', parseAuth, async (c) => {
	const { env, req } = c
	const payload = c.get('jwtPayload')
	if (!payload?.sub) {
		throw new HTTPException(401, { message: 'User authentication required' })
	}
	let body: {
		prompt?: unknown
		public?: unknown
		instrumental?: unknown
		playlist?: unknown
		provider?: unknown
	}
	try {
		body = await req.json()
	} catch {
		throw new HTTPException(400, { message: 'Invalid JSON body' })
	}

	if (!body?.prompt || typeof body.prompt !== 'string') {
		throw new HTTPException(400, { message: 'Missing prompt' })
	}

	if (body.provider !== undefined && body.provider !== null && !isValidMusicProvider(body.provider)) {
		throw new HTTPException(400, { message: "Invalid provider. Must be 'aisonggenerator' or 'elevenlabs'" })
	}

	const provider: MusicProvider = isValidMusicProvider(body.provider)
		? body.provider
		: DEFAULT_MUSIC_PROVIDER

	const isInstrumental = body.instrumental === true
	const maxPromptLength = isInstrumental ? MAX_INSTRUMENTAL_PROMPT_LENGTH : MAX_LYRICAL_PROMPT_LENGTH

	if (body.prompt.length > maxPromptLength) {
		throw new HTTPException(400, { message: `Prompt must be ${maxPromptLength} characters or less` })
	}

	const normalizedPlaylist = typeof body.playlist === 'string' && body.playlist.trim()
		? body.playlist.trim()
		: undefined

	const instanceId = env.DURABLE_OBJECT.newUniqueId().toString()

	// Enforce per-user UTC-day quota (+ optional burst guard & soft daily global circuit breaker)
	let reserveResult: Awaited<ReturnType<typeof reserveGenerationQuota>>
	try {
		reserveResult = await reserveGenerationQuota(env, {
			address: payload.sub,
			reservationId: instanceId,
			provider,
		})
	} catch {
		throw new HTTPException(503, { message: 'Unable to verify generation quota right now; please try again' })
	}

	if (!reserveResult.ok) {
		if (reserveResult.code === 'quota_exceeded') {
			return buildQuotaExceededResponse(reserveResult.payload)
		}
		throw new HTTPException(409, { message: 'Generation quota conflict; please try again' })
	}

	const workflowParams: WorkflowParams = {
		address: payload.sub,
		prompt: body.prompt,
		public: typeof body.public === 'boolean' ? body.public : true,
		instrumental: isInstrumental,
		...(normalizedPlaylist ? { playlist: normalizedPlaylist } : {}),
		provider,
		quota_reservation_id: instanceId,
		quota_day_key: reserveResult.dayKey,
		quota_provider: provider,
		quota_reuse_only: false,
		workflow_version: CURRENT_WORKFLOW_VERSION,
	}

	const doid = env.DURABLE_OBJECT.idFromString(instanceId)
	const stub = env.DURABLE_OBJECT.get(doid)

	const doStub = stub as unknown as {
		saveSteps?: (entries: Record<string, unknown>) => Promise<void>
		saveStep: (step: string, data: unknown) => Promise<void>
	}
	const generationMeta: GenerationMeta = {
		requested_provider: provider,
		actual_provider: null,
	}

	try {
		if (typeof doStub.saveSteps === 'function') {
			await doStub.saveSteps({
				payload: {
					address: workflowParams.address,
					prompt: workflowParams.prompt,
					public: workflowParams.public,
					instrumental: workflowParams.instrumental,
					...(workflowParams.playlist ? { playlist: workflowParams.playlist } : {}),
					provider: workflowParams.provider,
					workflow_version: workflowParams.workflow_version,
				},
				requested_provider: provider,
				active_provider: provider,
				actual_provider: null,
				generation_meta: generationMeta,
				quota_reservation_id: instanceId,
				quota_day_key: reserveResult.dayKey,
				quota_provider: provider,
			})
		} else {
			await doStub.saveStep('payload', workflowParams)
		}
	} catch (err) {
		// WORKFLOW.create was never called -> confirmed unstarted, safe to refund unshared reservation
		await refundGenerationQuota(env, {
			address: payload.sub,
			reservationId: instanceId,
			dayKey: reserveResult.dayKey,
			reason: 'do_seed_failed',
			options: { onlyIfUnshared: true },
		}).catch(() => {})
		throw err
	}

	let instance: WorkflowInstance | null = null
	try {
		instance = await env.WORKFLOW.create({
			id: instanceId,
			params: workflowParams,
		})
	} catch (err) {
		if (!isWorkflowAlreadyExistsError(err)) {
			// Reconcile uncertain creation outcome BEFORE refunding:
			// - 'active' | 'complete' -> confirmed accepted, return 200 and keep reservation
			// - 'missing' (recognized instance-specific absence error) -> confirmed unstarted, refund and rethrow
			// - 'unknown' | 'terminal' | lookup error -> indeterminate/unconfirmed: preserve quota and return 503!
			if (typeof env.WORKFLOW?.get === 'function') {
				let state: 'active' | 'complete' | 'terminal' | 'missing' | 'unknown'
				try {
					state = await inspectWorkflowInstanceState(env, instanceId)
				} catch {
					throw new HTTPException(503, {
						message: 'Unable to confirm workflow creation status; please refresh before retrying',
					})
				}

				if (state === 'active' || state === 'complete') {
					console.log('Workflow started (reconciled after create error)', { instanceId, status: state })
					return c.text(instanceId)
				}

				if (state === 'missing') {
					await refundGenerationQuota(env, {
						address: payload.sub,
						reservationId: instanceId,
						dayKey: reserveResult.dayKey,
						reason: 'workflow_create_confirmed_missing',
						options: { onlyIfUnshared: true },
					}).catch(() => {})
					throw err
				}

				throw new HTTPException(503, {
					message: 'Workflow creation status is indeterminate; please refresh before retrying',
				})
			}

			throw new HTTPException(503, {
				message: 'Unable to confirm workflow creation status; please refresh before retrying',
			})
		}
	}

	// Read status purely for observability; NEVER refund or fail an accepted Workflow if status() throws
	let wfStatusText = 'running'
	if (instance) {
		try {
			const wfStatus = await instance.status()
			wfStatusText = wfStatus.status
		} catch {
			wfStatusText = 'unknown'
		}
	}
	console.log('Workflow started', { instanceId, status: wfStatusText })

	return c.text(instanceId)
})

// Retry smol creation (caller-independent for empty-body retries; protects published smols and
// carries attempt state across the retry chain). A provider override can buy a paid call on the
// creator's quota, so it requires the owner's session.
smols.post('/retry/:id', optionalAuth, async (c) => {
	const { env, req } = c
	const id = req.param('id')

	// Parse optional JSON body safely (existing callers send empty POST)
	let overrideProvider: MusicProvider | undefined
	const rawBodyText = await req.text().catch(() => '')
	if (rawBodyText.trim()) {
		let body: { provider?: unknown; override_provider?: unknown }
		try {
			body = JSON.parse(rawBodyText)
		} catch {
			throw new HTTPException(400, { message: 'Invalid JSON body' })
		}
		const requestedOverride = body?.override_provider ?? body?.provider
		if (requestedOverride !== undefined && requestedOverride !== null) {
			if (!isValidMusicProvider(requestedOverride)) {
				throw new HTTPException(400, { message: "Invalid provider. Must be 'aisonggenerator' or 'elevenlabs'" })
			}
			overrideProvider = requestedOverride
		}
	}

	const callerSub = c.get('jwtPayload')?.sub
	if (overrideProvider && !callerSub) {
		throw new HTTPException(401, { message: 'Authentication required to retry with a different provider' })
	}

	// Protect EVERY existing published smol unconditionally (regardless of override_provider).
	// Fail closed if D1 read fails.
	let publishedRow: SmolD1Record | null
	try {
		publishedRow = await getPublishedSmolRow(env, id)
	} catch {
		throw new HTTPException(503, { message: 'Unable to verify smol publication status; please retry shortly' })
	}

	if (publishedRow) {
		if (overrideProvider) {
			throw new HTTPException(409, { message: 'Published smols cannot be retried with a different provider' })
		}
		return c.text(id)
	}

	const initialLoad = await loadRetryableSmolState(env, id)
	if (!initialLoad.steps?.payload?.address || !initialLoad.steps?.payload?.prompt) {
		if (initialLoad.doError) {
			throw new HTTPException(503, { message: 'Unable to read smol retry state right now; please try again' })
		}
		throw new HTTPException(404, { message: 'Smol not found' })
	}

	if (overrideProvider && callerSub !== initialLoad.steps.payload.address) {
		throw new HTTPException(403, { message: 'Only the creator can retry with a different provider' })
	}

	// Verify the source workflow itself is terminal (or missing/expired) BEFORE claiming a successor.
	// Active source work returns the existing ID immediately so a retry can never fork a running job
	// or retire its assets while it is still executing. Fail closed (503) on indeterminate errors.
	if (typeof env.WORKFLOW?.get === 'function') {
		let sourceState: 'active' | 'complete' | 'terminal' | 'missing' | 'unknown'
		try {
			sourceState = await inspectWorkflowInstanceState(env, id)
		} catch {
			throw new HTTPException(503, { message: 'Unable to verify source workflow status; please try again' })
		}

		if (sourceState === 'unknown') {
			throw new HTTPException(503, { message: 'Source workflow status is currently indeterminate; please try again' })
		}

		if (sourceState === 'complete') {
			if (overrideProvider) {
				throw new HTTPException(409, { message: 'Completed smols cannot be retried with a different provider' })
			}
			return c.text(id)
		}

		if (sourceState === 'active') {
			return c.text(id)
		}
	}

	let effectiveRetryId = id
	let retrySteps: WorkflowSteps = initialLoad.steps
	const storedRootId = typeof initialLoad.steps.retry_chain_root_id === 'string'
		&& isDurableObjectId(initialLoad.steps.retry_chain_root_id)
		? initialLoad.steps.retry_chain_root_id
		: undefined
	const chainRootId = storedRootId ?? id

	type RetryCoordinatorStub = {
		getRetryReservation?: () => Promise<RetryReservation | null>
		inspectRetrySuccessorState?: () => Promise<RetrySuccessorInspection>
		claimRetrySuccessor?: (
			candidate: string,
			predecessorId?: string
		) => Promise<{ successorId: string; predecessorId?: string; isNew: boolean }>
		replaceRetrySuccessor?: (
			prev: string,
			candidate: string,
			predecessorId?: string
		) => Promise<{ successorId: string; predecessorId?: string; isNew: boolean }>
		saveStep?: (step: string, data: unknown, options?: { persistMedia?: boolean }) => Promise<void>
	}

	async function loadAuthoritativePredecessor(predecessorId: string): Promise<
		| { kind: 'published'; id: string }
		| { kind: 'steps'; steps: WorkflowSteps }
	> {
		let publishedPred: SmolD1Record | null
		try {
			publishedPred = await getPublishedSmolRow(env, predecessorId)
		} catch {
			throw new HTTPException(503, { message: 'Unable to verify predecessor publication status; please retry shortly' })
		}
		if (publishedPred) {
			return { kind: 'published', id: predecessorId }
		}

		let loadedSteps: WorkflowSteps | null
		try {
			const loaded = await loadRetryableSmolState(env, predecessorId, { strictDo: true })
			loadedSteps = loaded.steps
		} catch {
			throw new HTTPException(503, { message: 'Unable to read authoritative retry predecessor state; please try again' })
		}
		if (!loadedSteps?.payload?.address || !loadedSteps?.payload?.prompt) {
			throw new HTTPException(503, { message: 'Authoritative retry predecessor state is unavailable; refusing to discard previous attempt' })
		}
		return { kind: 'steps', steps: loadedSteps }
	}

	// Coordinate ALL retries in a chain (A -> B -> C -> ...) on a single chain root DO,
	// follow any pre-existing forward pointers on legacy/staged nodes, and persist the
	// authoritative predecessor ID with every reservation so crash recovery restores its paid state.
	let targetInstanceId = env.DURABLE_OBJECT.newUniqueId().toString()
	let skipSuccessorSeed = false
	let useSeededOverride = false
	let recoveredSeededProvider: MusicProvider | undefined
	let recoveredSeededOverride: MusicProvider | undefined
	let recoveredOwnerAddress: string | undefined
	let recoveredQuotaNeedsReservation: boolean | undefined
	let recoveredQuotaProvider: MusicProvider | undefined
	let recoveredQuotaReservationId: string | undefined
	let recoveredQuotaDayKey: string | undefined
	if (isDurableObjectId(chainRootId)) {
		const MAX_RETRY_CHAIN_HOPS = 32
		let coordinatorId = chainRootId
		const visitedSuccessors = new Set<string>()
		let resolved = false

		for (let hop = 0; hop < MAX_RETRY_CHAIN_HOPS; hop++) {
			const coordDoid = env.DURABLE_OBJECT.idFromString(coordinatorId)
			const coordStub = env.DURABLE_OBJECT.get(coordDoid) as unknown as RetryCoordinatorStub

			if (typeof coordStub.claimRetrySuccessor !== 'function') {
				resolved = true
				break
			}

			let claimed: { successorId: string; predecessorId?: string; isNew: boolean }
			try {
				claimed = await coordStub.claimRetrySuccessor(targetInstanceId, effectiveRetryId)
			} catch {
				throw new HTTPException(503, { message: 'Unable to coordinate retry right now; please try again' })
			}

			if (claimed.isNew) {
				targetInstanceId = claimed.successorId
				resolved = true
				break
			}

			const existingSuccessorId = claimed.successorId
			const reservationPredecessorId = claimed.predecessorId || coordinatorId

			if (!existingSuccessorId || visitedSuccessors.has(existingSuccessorId)) {
				throw new HTTPException(503, { message: 'Unable to resolve retry chain safely; please try again' })
			}
			visitedSuccessors.add(existingSuccessorId)

			// Protect already-published successors even if their workflow instance aged out
			let publishedSuccessor: SmolD1Record | null
			try {
				publishedSuccessor = await getPublishedSmolRow(env, existingSuccessorId)
			} catch {
				throw new HTTPException(503, { message: 'Unable to verify successor publication status; please retry shortly' })
			}
			if (publishedSuccessor) {
				if (overrideProvider) {
					throw new HTTPException(409, { message: 'Published smols cannot be retried with a different provider' })
				}
				return c.text(existingSuccessorId)
			}

			let existingState: 'active' | 'complete' | 'terminal' | 'missing' | 'unknown'
			try {
				existingState = await inspectWorkflowInstanceState(env, existingSuccessorId)
			} catch {
				throw new HTTPException(503, { message: 'Unable to inspect existing retry status; please try again' })
			}

			if (existingState === 'unknown') {
				throw new HTTPException(503, { message: 'Existing retry workflow status is indeterminate; please try again' })
			}

			if (existingState === 'complete') {
				if (overrideProvider) {
					throw new HTTPException(409, { message: 'Published smols cannot be retried with a different provider' })
				}
				return c.text(existingSuccessorId)
			}

			if (existingState === 'active') {
				return c.text(existingSuccessorId)
			}

			if (existingState === 'missing') {
				// Distinguish a genuinely unstarted reservation (crashed before WORKFLOW.create)
				// from an EXPIRED Workflow instance whose Durable Object survived with prior execution
				// or payment state (e.g. an ambiguous ElevenLabs claim). NEVER overwrite an executed DO!
				let successorInspection: RetrySuccessorInspection = { state: 'empty' }
				if (isDurableObjectId(existingSuccessorId)) {
					const succDoid = env.DURABLE_OBJECT.idFromString(existingSuccessorId)
					const succStub = env.DURABLE_OBJECT.get(succDoid) as unknown as RetryCoordinatorStub
					if (typeof succStub.inspectRetrySuccessorState === 'function') {
						try {
							successorInspection = await succStub.inspectRetrySuccessorState()
						} catch {
							throw new HTTPException(503, { message: 'Unable to inspect reserved successor state; please try again' })
						}
					}
				}

				if (successorInspection.state === 'empty') {
					// Genuinely unstarted reservation (crashed before seeding): recover under the exact
					// reserved ID and restore the reservation's authoritative predecessor state.
					targetInstanceId = existingSuccessorId
					if (reservationPredecessorId !== effectiveRetryId) {
						const pred = await loadAuthoritativePredecessor(reservationPredecessorId)
						if (pred.kind === 'published') {
							if (overrideProvider) {
								throw new HTTPException(409, { message: 'Published smols cannot be retried with a different provider' })
							}
							return c.text(pred.id)
						}
						effectiveRetryId = reservationPredecessorId
						retrySteps = pred.steps
					}
					resolved = true
					break
				}

				if (successorInspection.state === 'seeded_unstarted') {
					// Crashed after atomic seeding, before WORKFLOW.create: DO is already seeded and
					// never executed — create the workflow directly without touching or overwriting the DO!
					targetInstanceId = existingSuccessorId
					effectiveRetryId = successorInspection.retrySourceId || reservationPredecessorId
					recoveredSeededProvider = successorInspection.provider
					recoveredSeededOverride = successorInspection.overrideProvider
					recoveredOwnerAddress = successorInspection.ownerAddress
					recoveredQuotaNeedsReservation = successorInspection.quotaNeedsReservation
					recoveredQuotaProvider = successorInspection.quotaProvider
					recoveredQuotaReservationId = successorInspection.quotaReservationId
					recoveredQuotaDayKey = successorInspection.quotaDayKey
					skipSuccessorSeed = true
					useSeededOverride = true
					resolved = true
					break
				}

				// successorInspection.state === 'executed':
				// Previous execution is evident on existingSuccessorId while its Workflow record expired
				// (instance.not_found). Preserve existingSuccessorId's DO untouched and fall through to the
				// terminal branch below to reconcile from existingSuccessorId itself (or fail closed 503).
			}

			// existingState === 'terminal' (or expired Workflow whose DO shows prior execution):
			// First check whether the terminal successor itself already has a forward reservation
			// (e.g. legacy/staged chain A -> B where B was retried first without retry_chain_root_id).
			if (isDurableObjectId(existingSuccessorId) && existingSuccessorId !== coordinatorId) {
				const childDoid = env.DURABLE_OBJECT.idFromString(existingSuccessorId)
				const childStub = env.DURABLE_OBJECT.get(childDoid) as unknown as RetryCoordinatorStub
				if (typeof childStub.getRetryReservation === 'function') {
					let childReservation: RetryReservation | null
					try {
						childReservation = await childStub.getRetryReservation()
					} catch {
						throw new HTTPException(503, { message: 'Unable to inspect successor retry chain; please try again' })
					}
					if (childReservation?.successorId && childReservation.successorId !== existingSuccessorId) {
						coordinatorId = existingSuccessorId
						continue
					}
				}
			}

			// Require authoritative terminal successor state BEFORE replacing its claim.
			// Never silently fall back to an older ancestor if the successor's DO/KV is unreadable.
			const loadedTerminal = await loadAuthoritativePredecessor(existingSuccessorId)
			if (loadedTerminal.kind === 'published') {
				if (overrideProvider) {
					throw new HTTPException(409, { message: 'Published smols cannot be retried with a different provider' })
				}
				return c.text(loadedTerminal.id)
			}
			effectiveRetryId = existingSuccessorId
			retrySteps = loadedTerminal.steps

			const nextCandidateId = env.DURABLE_OBJECT.newUniqueId().toString()

			// If the terminal successor lacked retry_chain_root_id (legacy/staged node), atomically
			// bind it to this replacement so a concurrent/subsequent POST /retry/<existingSuccessorId>
			// converges on the exact same successor instead of forking the chain.
			const childHasRoot = typeof loadedTerminal.steps.retry_chain_root_id === 'string'
				&& isDurableObjectId(loadedTerminal.steps.retry_chain_root_id)
			if (!childHasRoot && isDurableObjectId(existingSuccessorId) && existingSuccessorId !== coordinatorId) {
				const childDoid = env.DURABLE_OBJECT.idFromString(existingSuccessorId)
				const childStub = env.DURABLE_OBJECT.get(childDoid) as unknown as RetryCoordinatorStub
				if (typeof childStub.claimRetrySuccessor === 'function') {
					let childClaim: { successorId: string; predecessorId?: string; isNew: boolean }
					try {
						childClaim = await childStub.claimRetrySuccessor(nextCandidateId, existingSuccessorId)
					} catch {
						throw new HTTPException(503, { message: 'Unable to coordinate successor retry chain; please try again' })
					}
					if (!childClaim.isNew) {
						coordinatorId = existingSuccessorId
						continue
					}
				}
				if (typeof childStub.saveStep === 'function') {
					await childStub.saveStep('retry_chain_root_id', chainRootId, { persistMedia: false }).catch(() => {})
				}
			}

			if (typeof coordStub.replaceRetrySuccessor === 'function') {
				let replaced: { successorId: string; predecessorId?: string; isNew: boolean }
				try {
					replaced = await coordStub.replaceRetrySuccessor(
						existingSuccessorId,
						nextCandidateId,
						existingSuccessorId
					)
				} catch {
					throw new HTTPException(503, { message: 'Unable to coordinate retry replacement; please try again' })
				}
				if (!replaced.isNew) {
					// Another caller concurrently replaced existingSuccessorId on coordinatorId:
					// re-inspect the winning reservation on the next iteration.
					continue
				}
				targetInstanceId = replaced.successorId
				resolved = true
				break
			}

			targetInstanceId = nextCandidateId
			resolved = true
			break
		}

		if (!resolved) {
			throw new HTTPException(503, { message: 'Retry chain exceeded maximum resolution depth; please try again' })
		}
	}

	const originalProvider = isValidMusicProvider(retrySteps.payload!.provider)
		? retrySteps.payload!.provider
		: isValidMusicProvider(retrySteps.requested_provider)
			? retrySteps.requested_provider
			: DEFAULT_MUSIC_PROVIDER
	const effectiveProvider = overrideProvider ?? originalProvider
	const effectiveActiveProvider: MusicProvider = overrideProvider
		?? (isValidMusicProvider(retrySteps.active_provider) ? retrySteps.active_provider : effectiveProvider)
	const ownerAddress = recoveredOwnerAddress || retrySteps.payload!.address!

	const { retry_id: _oldRetryId, override_provider: _oldOverride, ...cleanOriginalPayload } = retrySteps.payload!
	const seededPayload: WorkflowParams = {
		...cleanOriginalPayload,
		address: retrySteps.payload!.address,
		prompt: retrySteps.payload!.prompt,
		public: retrySteps.payload!.public ?? true,
		instrumental: retrySteps.payload!.instrumental ?? false,
		provider: effectiveProvider,
		workflow_version: CURRENT_WORKFLOW_VERSION,
	}

	let quotaReservationId: string | undefined
	let quotaDayKey: string | undefined
	let quotaProvider: MusicProvider | undefined
	let quotaReuseOnly = false
	let didNewlyReserveQuota = false

	async function canSafelyRefundUnstartedRetry(reservationId: string): Promise<boolean> {
		if (!didNewlyReserveQuota || reservationId !== targetInstanceId) {
			return false
		}
		if (typeof env.WORKFLOW?.get === 'function') {
			try {
				const wfState = await inspectWorkflowInstanceState(env, targetInstanceId)
				if (wfState !== 'missing') {
					return false
				}
			} catch {
				return false
			}
		}
		if (isDurableObjectId(targetInstanceId)) {
			try {
				const succDoid = env.DURABLE_OBJECT.idFromString(targetInstanceId)
				const succStub = env.DURABLE_OBJECT.get(succDoid) as unknown as RetryCoordinatorStub
				if (typeof succStub.inspectRetrySuccessorState === 'function') {
					const insp = await succStub.inspectRetrySuccessorState()
					if (insp.state === 'executed') {
						return false
					}
				}
			} catch {
				return false
			}
		}
		return true
	}

	// Conditionally and atomically initialize the new DO BEFORE WORKFLOW.create ONLY if it is empty.
	// Never overwrite a DO that already contains prior execution/payment state!
	if (!skipSuccessorSeed) {
		let admissionPlan: Awaited<ReturnType<typeof classifyRetryAdmission>>
		try {
			admissionPlan = await classifyRetryAdmission(
				env,
				effectiveRetryId,
				retrySteps,
				overrideProvider
			)
		} catch {
			throw new HTTPException(503, { message: 'Unable to verify existing audio artifact; please try again' })
		}

		const reusesExistingAttempt = admissionPlan.kind === 'reuse'
		const retryTargetProvider = admissionPlan.kind === 'fresh'
			? admissionPlan.targetProvider
			: resolveRetryTargetProvider(retrySteps, overrideProvider)

		if (!reusesExistingAttempt) {
			// Fresh paid call will be made -> enforce creator quota BEFORE seeding DO & creating workflow!
			// If denied (429), targetInstanceId remains empty so future retries can recover cleanly.
			let reserveResult: Awaited<ReturnType<typeof reserveGenerationQuota>>
			try {
				reserveResult = await reserveGenerationQuota(env, {
					address: ownerAddress,
					reservationId: targetInstanceId,
					provider: retryTargetProvider,
				})
			} catch {
				throw new HTTPException(503, { message: 'Unable to verify generation quota right now; please try again' })
			}

			if (!reserveResult.ok) {
				if (reserveResult.code === 'quota_exceeded') {
					return buildQuotaExceededResponse(reserveResult.payload)
				}
				throw new HTTPException(409, {
					message: 'A concurrent retry already reserved this generation with a different model; please refresh',
				})
			}

			quotaReservationId = targetInstanceId
			quotaDayKey = reserveResult.dayKey
			quotaProvider = retryTargetProvider
			quotaReuseOnly = false
			didNewlyReserveQuota = !reserveResult.idempotent
		} else {
			// Reusing/reconciling already-paid or pending attempt -> DO NOT double-charge quota!
			quotaReservationId = retrySteps.quota_reservation_id
			quotaDayKey = retrySteps.quota_day_key
			quotaProvider = retrySteps.quota_provider
			quotaReuseOnly = true
		}

		const newDoid = env.DURABLE_OBJECT.idFromString(targetInstanceId)
		const newStub = env.DURABLE_OBJECT.get(newDoid) as unknown as {
			seedRetrySuccessorIfEmpty?: (entries: Record<string, unknown>) => Promise<{
				seeded: boolean
				inspection: RetrySuccessorInspection
			}>
			saveSteps?: (entries: Record<string, unknown>) => Promise<void>
			saveStep: (step: string, data: unknown) => Promise<void>
		}
		const generationMeta: GenerationMeta = {
			requested_provider: effectiveProvider,
			actual_provider: null,
			...(!overrideProvider && retrySteps.fallback_from ? { fallback_from: retrySteps.fallback_from } : {}),
			...(!overrideProvider && retrySteps.fallback_reason ? { fallback_reason: retrySteps.fallback_reason } : {}),
		}
		const seededEntries: Record<string, unknown> = {
			payload: seededPayload,
			requested_provider: effectiveProvider,
			active_provider: effectiveActiveProvider,
			actual_provider: null,
			generation_meta: generationMeta,
			retry_chain_root_id: chainRootId,
			retry_source_id: effectiveRetryId,
			quota_needs_reservation: !reusesExistingAttempt,
			quota_reuse_only: reusesExistingAttempt,
			...(!reusesExistingAttempt ? { quota_provider: retryTargetProvider } : quotaProvider ? { quota_provider: quotaProvider } : {}),
			...(quotaReservationId ? { quota_reservation_id: quotaReservationId } : {}),
			...(quotaDayKey ? { quota_day_key: quotaDayKey } : {}),
			...(overrideProvider ? { retry_override_provider: overrideProvider } : {}),
			...(!overrideProvider && retrySteps.fallback_from ? { fallback_from: retrySteps.fallback_from } : {}),
			...(!overrideProvider && retrySteps.fallback_reason ? { fallback_reason: retrySteps.fallback_reason } : {}),
			...(retrySteps.provider_attempt ? { provider_attempt: retrySteps.provider_attempt } : {}),
			...(retrySteps.song_ids ? { song_ids: retrySteps.song_ids } : {}),
			...(!overrideProvider && retrySteps.songs ? { songs: retrySteps.songs } : {}),
		}

		let seedSucceeded = false
		try {
			if (typeof newStub.seedRetrySuccessorIfEmpty === 'function') {
				const seedResult = await newStub.seedRetrySuccessorIfEmpty(seededEntries)
				if (!seedResult.seeded) {
					if (seedResult.inspection.state === 'executed') {
						// NEVER refund targetInstanceId when a concurrent winner has already executed it!
						if (typeof env.WORKFLOW?.get === 'function') {
							try {
								const wfState = await inspectWorkflowInstanceState(env, targetInstanceId)
								if (wfState === 'active' || wfState === 'complete') {
									return c.text(targetInstanceId)
								}
							} catch {
								// Fall through to 503 without refunding
							}
						}
						throw new HTTPException(503, {
							message: 'Reserved retry successor already has prior execution state; refusing to overwrite',
						})
					}
					// Concurrent caller already seeded this unstarted reservation; adopt the winning seed
					// (including when its overrideProvider is absent!)
					if (seedResult.inspection.retrySourceId) {
						effectiveRetryId = seedResult.inspection.retrySourceId
					}
					recoveredSeededProvider = seedResult.inspection.provider
					recoveredSeededOverride = seedResult.inspection.overrideProvider
					useSeededOverride = true
					if (
						didNewlyReserveQuota
						&& seedResult.inspection.quotaNeedsReservation === false
						&& seedResult.inspection.quotaReservationId !== targetInstanceId
						&& await canSafelyRefundUnstartedRetry(targetInstanceId)
					) {
						await refundGenerationQuota(env, {
							address: ownerAddress,
							reservationId: targetInstanceId,
							dayKey: quotaDayKey,
							reason: 'concurrent_seed_reused_attempt',
							options: { onlyIfUnshared: true },
						}).catch(() => {})
						didNewlyReserveQuota = false
					}
					if (seedResult.inspection.quotaNeedsReservation === false) {
						quotaReuseOnly = true
					}
					if (seedResult.inspection.quotaProvider !== undefined) {
						quotaProvider = seedResult.inspection.quotaProvider
					}
					if (seedResult.inspection.quotaReservationId !== undefined) {
						quotaReservationId = seedResult.inspection.quotaReservationId
					}
					if (seedResult.inspection.quotaDayKey !== undefined) {
						quotaDayKey = seedResult.inspection.quotaDayKey
					}
				}
				seedSucceeded = true
			} else if (typeof newStub.saveSteps === 'function') {
				await newStub.saveSteps(seededEntries)
				seedSucceeded = true
			} else {
				await newStub.saveStep('payload', seededPayload)
				seedSucceeded = true
			}
		} catch (err) {
			if (!seedSucceeded && !(err instanceof HTTPException) && await canSafelyRefundUnstartedRetry(targetInstanceId)) {
				await refundGenerationQuota(env, {
					address: ownerAddress,
					reservationId: targetInstanceId,
					dayKey: quotaDayKey,
					reason: 'retry_seed_failed',
					options: { onlyIfUnshared: true },
				}).catch(() => {})
			}
			throw err
		}
	} else {
		// Crash recovery of a seeded_unstarted successor:
		// For pre-Wave-5 seeds missing `quota_needs_reservation`, load and classify the authoritative
		// predecessor with the saved override BEFORE deciding whether a fresh reservation is required!
		let needsReservation = recoveredQuotaNeedsReservation
		let targetReserveProvider = recoveredQuotaProvider

		if (needsReservation === undefined) {
			const pred = await loadAuthoritativePredecessor(effectiveRetryId)
			if (pred.kind === 'published') {
				if (recoveredSeededOverride) {
					throw new HTTPException(409, { message: 'Published smols cannot be retried with a different provider' })
				}
				return c.text(pred.id)
			}
			retrySteps = pred.steps
			let legacyPlan: Awaited<ReturnType<typeof classifyRetryAdmission>>
			try {
				legacyPlan = await classifyRetryAdmission(env, effectiveRetryId, pred.steps, recoveredSeededOverride)
			} catch {
				throw new HTTPException(503, { message: 'Unable to verify existing audio artifact; please try again' })
			}
			if (legacyPlan.kind === 'fresh') {
				needsReservation = true
				targetReserveProvider = legacyPlan.targetProvider
			} else {
				needsReservation = false
			}
		}

		if (needsReservation === true) {
			const recoveredProvider = targetReserveProvider
				?? recoveredSeededProvider
				?? resolveRetryTargetProvider(retrySteps, recoveredSeededOverride)
			let reserveResult: Awaited<ReturnType<typeof reserveGenerationQuota>>
			try {
				reserveResult = await reserveGenerationQuota(env, {
					address: ownerAddress,
					reservationId: targetInstanceId,
					provider: recoveredProvider,
				})
			} catch {
				throw new HTTPException(503, { message: 'Unable to verify generation quota right now; please try again' })
			}

			if (!reserveResult.ok) {
				if (reserveResult.code === 'quota_exceeded') {
					return buildQuotaExceededResponse(reserveResult.payload)
				}
				throw new HTTPException(409, {
					message: 'A concurrent retry already reserved this generation with a different model; please refresh',
				})
			}

			quotaReservationId = targetInstanceId
			quotaDayKey = reserveResult.dayKey
			quotaProvider = recoveredProvider
			quotaReuseOnly = false
			didNewlyReserveQuota = !reserveResult.idempotent
		} else {
			quotaReservationId = recoveredQuotaReservationId ?? retrySteps.quota_reservation_id
			quotaDayKey = recoveredQuotaDayKey ?? retrySteps.quota_day_key
			quotaProvider = recoveredQuotaProvider ?? retrySteps.quota_provider
			quotaReuseOnly = true
		}
	}

	const finalProvider = recoveredSeededProvider ?? effectiveProvider
	const finalOverride = useSeededOverride ? recoveredSeededOverride : overrideProvider
	const workflowParams: WorkflowParams = {
		retry_id: effectiveRetryId,
		provider: finalProvider,
		...(finalOverride ? { override_provider: finalOverride } : {}),
		...(quotaReservationId ? { quota_reservation_id: quotaReservationId } : {}),
		...(quotaDayKey ? { quota_day_key: quotaDayKey } : {}),
		...(quotaProvider ? { quota_provider: quotaProvider } : {}),
		quota_reuse_only: quotaReuseOnly,
		workflow_version: CURRENT_WORKFLOW_VERSION,
	}

	let createdInstance: WorkflowInstance | null = null
	try {
		createdInstance = await env.WORKFLOW.create({
			id: targetInstanceId,
			params: workflowParams,
		})
	} catch (err) {
		if (!isWorkflowAlreadyExistsError(err)) {
			// Reconcile uncertain creation before refunding:
			// - 'active' | 'complete' -> confirmed accepted, return 200 and keep reservation
			// - 'missing' (recognized instance-specific error) + DO unexecuted + unshared -> refund and rethrow
			// - 'unknown' | 'terminal' | lookup error -> preserve quota and return 503!
			if (typeof env.WORKFLOW?.get === 'function') {
				let state: 'active' | 'complete' | 'terminal' | 'missing' | 'unknown'
				try {
					state = await inspectWorkflowInstanceState(env, targetInstanceId)
				} catch {
					throw new HTTPException(503, {
						message: 'Unable to confirm retry workflow creation status; please refresh before retrying',
					})
				}

				if (state === 'active' || state === 'complete') {
					console.log('Workflow restarted (reconciled after create error)', { instanceId: targetInstanceId, status: state })
					return c.text(targetInstanceId)
				}

				if (state !== 'missing') {
					throw new HTTPException(503, {
						message: 'Retry workflow creation status is indeterminate; please refresh before retrying',
					})
				}
			} else {
				throw new HTTPException(503, {
					message: 'Unable to confirm retry workflow creation status; please refresh before retrying',
				})
			}

			if (await canSafelyRefundUnstartedRetry(targetInstanceId)) {
				await refundGenerationQuota(env, {
					address: ownerAddress,
					reservationId: targetInstanceId,
					dayKey: quotaDayKey,
					reason: 'retry_workflow_create_confirmed_missing',
					options: { onlyIfUnshared: true },
				}).catch(() => {})
			}
			throw err
		}
	}

	// Read status purely for observability; NEVER refund or fail an accepted Workflow if status() throws
	let wfStatusValue = 'running'
	if (createdInstance) {
		try {
			const status = await createdInstance.status()
			wfStatusValue = status.status
		} catch {
			wfStatusValue = 'unknown'
		}
	}

	console.log('Workflow restarted', { instanceId: targetInstanceId, status: wfStatusValue })

	return c.text(targetInstanceId)
})

function isMintedSmolRecord(record: { Mint_Token?: string | null; Mint_Amm?: string | null }): boolean {
	return Boolean(record.Mint_Token?.trim() || record.Mint_Amm?.trim())
}

// Toggle public/private
smols.put('/:id', parseAuth, async (c) => {
	const { env, req } = c
	const id = req.param('id')
	const payload = c.get('jwtPayload')!

	const smolRecord = await env.SMOL_D1.prepare(`
		SELECT Public, Mint_Token, Mint_Amm
		FROM Smols
		WHERE Id = ?1 AND "Address" = ?2
	`)
		.bind(id, payload.sub)
		.first<{ Public: number; Mint_Token?: string | null; Mint_Amm?: string | null }>()

	if (!smolRecord) {
		throw new HTTPException(404, { message: 'Smol not found or not owned by you' })
	}

	// Allow hiding unminted songs (Public 1 -> 0), even if KV/classifier data is missing or unsafe.
	// Block hiding minted songs (on-chain collectibles must remain public).
	// Require authoritative KV + unambiguous safe classification ONLY when publishing (0 -> 1).
	const currentPublic = smolRecord.Public === 1 ? 1 : 0
	const targetPublic = currentPublic === 1 ? 0 : 1

	if (targetPublic === 0 && isMintedSmolRecord(smolRecord)) {
		throw new HTTPException(409, { message: 'Minted songs must remain public' })
	}

	if (targetPublic === 1) {
		const smol_kv: any = await env.SMOL_KV.get(id, 'json')
		if (!smol_kv || isNsfwBlocked(smol_kv.nsfw)) {
			throw new HTTPException(400, { message: 'Cannot make an unsafe or unclassified smol public' })
		}
	}

	// Write the validated target visibility with compare-and-set against the value read so
	// concurrent hide requests can NEVER double-toggle an unsafe smol back to Public = 1,
	// and a concurrent mint racing with hide can NEVER hide a newly minted song.
	const updateSql = targetPublic === 0
		? `
		UPDATE Smols
		SET Public = ?1
		WHERE Id = ?2 AND "Address" = ?3 AND Public = ?4
			AND (Mint_Token IS NULL OR TRIM(Mint_Token) = '')
			AND (Mint_Amm IS NULL OR TRIM(Mint_Amm) = '')
	`
		: `
		UPDATE Smols
		SET Public = ?1
		WHERE Id = ?2 AND "Address" = ?3 AND Public = ?4
	`

	await env.SMOL_D1.prepare(updateSql)
		.bind(targetPublic, id, payload.sub, currentPublic)
		.run()

	const updated = await env.SMOL_D1.prepare(`
		SELECT Public, Mint_Token, Mint_Amm
		FROM Smols
		WHERE Id = ?1 AND "Address" = ?2
	`)
		.bind(id, payload.sub)
		.first<{ Public: number; Mint_Token?: string | null; Mint_Amm?: string | null }>()

	const visibleUpdate = requireOwnedVisibilityToggle(updated)
	if (targetPublic === 0 && visibleUpdate.Public === 1 && updated && isMintedSmolRecord(updated)) {
		throw new HTTPException(409, { message: 'Minted songs must remain public' })
	}
	const playlistTags = await playlistCacheTags(await getPlaylistTitlesForSmol(env, id))

	runBackground(
		c,
		syncSearchVisibilityAfterToggle(env, id, visibleUpdate).catch((error) => {
			console.error(JSON.stringify({
				event: 'search_sync_failed',
				operation: 'visibility_toggle',
				smolId: id,
				intendedVisibility: visibleUpdate.Public === 1 ? 'public' : 'private',
				error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
			}))
		})
	)

	runBackground(
		c,
		purgeCacheByTags([
			artistSmolsCacheTag(payload.sub),
			'public-smols',
			'mixtapes',
			`user:${payload.sub}:created`,
			`user:${payload.sub}:smol:${id}`,
			`smol:${id}:anonymous`,
			`smol:${id}:media`,
			...playlistTags,
		])
	)

	return c.body(null, 204)
})

// Swap songs (guarded against empty/NULL Song_2 for 1-track Smols)
smols.put('/:smol_id/:song_id', parseAuth, async (c) => {
	const { env, req } = c
	const smol_id = req.param('smol_id')
	const song_id = req.param('song_id')?.trim()
	const payload = c.get('jwtPayload')!

	if (!song_id) {
		throw new HTTPException(400, { message: 'Missing song_id' })
	}

	const result = await env.SMOL_D1.prepare(`
		UPDATE Smols SET
			Song_1 = Song_2,
			Song_2 = Song_1
		WHERE Id = ?1
		AND Song_2 = ?2
		AND Song_2 IS NOT NULL
		AND Song_2 != ''
		AND "Address" = ?3
	`)
		.bind(smol_id, song_id, payload.sub)
		.run()

	if (result.meta.changes === 0) {
		throw new HTTPException(404, { message: 'No record found or no update needed' })
	}

	const playlistTags = await playlistCacheTags(await getPlaylistTitlesForSmol(env, smol_id))

	runBackground(
		c,
		purgeCacheByTags([
			`user:${payload.sub}:smol:${smol_id}`,
			`smol:${smol_id}:anonymous`,
			'public-smols',
			artistSmolsCacheTag(payload.sub),
			`user:${payload.sub}:created`,
			'mixtapes',
			...playlistTags,
		])
	)

	return c.body(null, 204)
})

interface DeletableSmol {
	Id: string
	Address: string
	Public: number
	Song_1: string | null
	Song_2: string | null
	Mint_Token: string | null
	Mint_Amm: string | null
}

function readDeletableSmol(env: Env, id: string): Promise<DeletableSmol | null> {
	return env.SMOL_D1.prepare(`
		SELECT Id, "Address", Public, Song_1, Song_2, Mint_Token, Mint_Amm FROM Smols WHERE Id = ?1
	`).bind(id).first<DeletableSmol>()
}

/** 409 while an unresolved mint receipt covers the song (or its asset prefix); 503 if unreadable. */
async function assertNotMinting(env: Env, id: string): Promise<void> {
	try {
		await assertNoUnresolvedMintReceipt(env, [id])
	} catch (error) {
		if (error instanceof MintIneligible) throw new HTTPException(409, { message: 'Smol has a mint in progress' })
		throw new HTTPException(503, { message: 'Unable to verify mint status; please retry shortly' })
	}
}

/**
 * Deletes the smol's Likes, Playlists and Smols rows in ONE D1 batch, guarded on the row still being
 * unminted (plus `extraGuard`). Likes and Playlists are deleted only while the same guard holds, so a
 * mint (or ownership/visibility change) racing the request deletes nothing. Returns the cache tags to
 * purge, or null when the guard failed. Storage cleanup afterwards is best-effort.
 */
async function deleteSmolGuarded(env: Env, smol: DeletableSmol, extraGuard = '', extraBindings: unknown[] = []) {
	// An admitted mint's receipt (song id or 12-hex prefix) blocks the delete in the same atomic batch. The
	// signer re-checks every target row after recording `submitting`, so whichever commits first wins.
	const guard = `Id = ?1 AND Mint_Token IS NULL AND Mint_Amm IS NULL${extraGuard} AND NOT EXISTS (SELECT 1 FROM MintBatchStatus
		WHERE Phase IN ('existing', 'queued', 'submitting', 'submitted', 'confirmed') AND instr(Ids, '"' || substr(?1, 1, 12)) > 0)`
	const statement = (sql: string) => env.SMOL_D1.prepare(sql).bind(smol.Id, ...extraBindings)
	const [likes, playlistTags, steps] = await Promise.all([
		env.SMOL_D1.prepare(`SELECT "Address" as Address FROM Likes WHERE Id = ?1`).bind(smol.Id).all<{ Address: string }>(),
		getPlaylistTitlesForSmol(env, smol.Id).then(playlistCacheTags),
		env.SMOL_KV.get<WorkflowSteps>(smol.Id, 'json').catch(() => null),
	])
	const results = await env.SMOL_D1.batch([
		statement(`DELETE FROM Likes WHERE Id = ?1 AND EXISTS (SELECT 1 FROM Smols WHERE ${guard})`),
		statement(`DELETE FROM Playlists WHERE Id = ?1 AND EXISTS (SELECT 1 FROM Smols WHERE ${guard})`),
		statement(`DELETE FROM Smols WHERE ${guard}`),
	])
	if (results[2].meta.changes === 0) return null

	const musicIds = [...new Set([smol.Song_1, smol.Song_2, ...(steps?.songs ?? []).map((song) => song?.music_id)]
		.filter((musicId): musicId is string => typeof musicId === 'string' && musicId.length > 0))]
	const cleanup = await Promise.allSettled([
		(async () => {
			if (isDurableObjectId(smol.Id)) await env.DURABLE_OBJECT.get(env.DURABLE_OBJECT.idFromString(smol.Id)).setToFlush()
		})(),
		env.SMOL_KV.delete(smol.Id),
		env.SMOL_BUCKET.delete(`${smol.Id}.png`),
		queueSearchDeletionById(env, smol.Id),
		// A retry or swap can share an MP3: delete it only once no remaining Smols row references it.
		...musicIds.map(async (musicId) => {
			if (await checkSongReferenceStatus(env, musicId) === 'unreferenced') await env.SMOL_BUCKET.delete(`${musicId}.mp3`)
		}),
	])
	for (const outcome of cleanup) {
		if (outcome.status === 'rejected') console.warn('Smol deletion cleanup failed:', smol.Id, outcome.reason)
	}

	return [
		artistSmolsCacheTag(smol.Address),
		'public-smols',
		'mixtapes',
		`user:${smol.Address}:created`,
		`user:${smol.Address}:smol:${smol.Id}`,
		`smol:${smol.Id}:anonymous`,
		`smol:${smol.Id}:media`,
		...musicIds.map((musicId) => `song:${musicId}:media`),
		...playlistTags,
		...likes.results.flatMap(({ Address }) => [`user:${Address}:liked`, `user:${Address}:likes`]),
	]
}

// Admin bulk delete (gated behind dedicated ADMIN_SECRET; skips minted, minting and, unless allowPublic, public)
smols.delete('/admin/bulk', requireAdmin, async (c) => {
	const { env } = c
	const body = await readJsonBody(c)
	const { ids } = body
	const allowPublic = Boolean(body.allowPublic)
	if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
		throw new HTTPException(400, { message: 'Missing ids array' })
	}
	if (ids.length > 100) {
		throw new HTTPException(400, { message: 'Max 100 ids per request' })
	}

	let deleted = 0
	const purgeTags = new Set<string>()
	for (const id of new Set<string>(ids)) {
		const smol = await readDeletableSmol(env, id)
		if (!smol || smol.Mint_Token != null || smol.Mint_Amm != null || (smol.Public && !allowPublic)) continue
		try {
			await assertNotMinting(env, id)
		} catch (error) {
			if (error instanceof HTTPException && error.status === 409) continue
			throw error
		}
		const tags = await deleteSmolGuarded(env, smol, allowPublic ? '' : ' AND Public = 0')
		if (!tags) continue
		for (const tag of tags) purgeTags.add(tag)
		deleted += 1
	}

	if (purgeTags.size > 0) runBackground(c, purgeCacheByTags([...purgeTags]))
	return c.json({ deleted, skipped: ids.length - deleted, total: ids.length })
})

// Delete smol (owner only; minted songs and songs with an unresolved mint are 409)
smols.delete('/:id', parseAuth, async (c) => {
	const { env } = c
	const id = c.req.param('id')
	const sub = c.get('jwtPayload')!.sub

	const smol = await readDeletableSmol(env, id)
	if (!smol || smol.Address !== sub) {
		throw new HTTPException(404, { message: 'Smol not found or not owned by you' })
	}
	if (smol.Mint_Token != null || smol.Mint_Amm != null) {
		throw new HTTPException(409, { message: 'Minted smols cannot be deleted' })
	}
	await assertNotMinting(env, id)

	const tags = await deleteSmolGuarded(env, smol, ' AND "Address" = ?2', [sub])
	if (!tags) {
		// The guard (mint columns, owner, open mint receipt) failed at the batch; nothing was deleted.
		const current = await readDeletableSmol(env, id)
		if (!current || current.Address !== sub) throw new HTTPException(404, { message: 'Smol not found or not owned by you' })
		throw new HTTPException(409, { message: 'Smol is minted or has a mint in progress' })
	}

	runBackground(c, purgeCacheByTags(tags))
	return c.body(null, 204)
})

export default smols
