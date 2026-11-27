import {
	applyQuotaOverride,
	getUtcDayKey,
	type QuotaCommitResult,
	type QuotaOverride,
	type QuotaOverrideInput,
	type QuotaLimits,
	type QuotaProvider,
	type QuotaRefundOptions,
	type QuotaReservationRecord,
	type QuotaSnapshot,
	type UserQuotaDO,
} from '../quota-do'

export const DEFAULT_DAILY_LIMIT_CLASSIC = 10
export const DEFAULT_DAILY_LIMIT_ELEVENLABS = 5
export const DEFAULT_GLOBAL_DAILY_LIMIT_CLASSIC = 100
export const DEFAULT_GLOBAL_DAILY_LIMIT_ELEVENLABS = 50
export const DEFAULT_BURST_LIMIT_PER_MINUTE = 0

export interface QuotaExceededPayload {
	error: string
	code: 'quota_exceeded'
	provider: QuotaProvider
	limit: number
	used: number
	remaining: 0
	resetAt: string
	scope?: 'user' | 'global'
	window?: 'day' | 'minute'
}

export type CoordinatedReserveResult =
	| {
		ok: true
		idempotent: boolean
		shared: boolean
		dayKey: string
		quota: QuotaSnapshot
	}
	| {
		ok: false
		code: 'quota_exceeded'
		payload: QuotaExceededPayload
	}
	| {
		ok: false
		code: 'reservation_conflict'
		existingProvider: QuotaProvider
	}

export type CoordinatedFallbackTransitionResult =
	| {
		ok: true
		idempotent: boolean
		dayKey: string
		previousDayKey: string
		quota: QuotaSnapshot
	}
	| {
		ok: false
		code: 'quota_exceeded'
		payload: QuotaExceededPayload
	}
	| {
		ok: false
		code: 'invalid_state'
		status: string
		provider: QuotaProvider
	}

function sanitizedErrorTag(err: unknown): string {
	if (err instanceof Error && err.name) {
		return err.name
	}
	return 'UnknownError'
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw === null) {
		return fallback
	}
	const trimmed = raw.trim()
	if (!trimmed) {
		return fallback
	}
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed) || parsed < 0) {
		return fallback
	}
	return Math.floor(parsed)
}

function parseOptionalGlobalLimit(raw: string | undefined, fallback: number): number | null {
	if (raw === undefined || raw === null) {
		return fallback
	}
	const trimmed = raw.trim().toLowerCase()
	if (!trimmed) {
		return fallback
	}
	if (trimmed === 'unlimited' || trimmed === 'off' || trimmed === 'disabled') {
		return null
	}
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed) || parsed < 0) {
		return fallback
	}
	return Math.floor(parsed)
}

let cachedUserQuotaOverrides: { raw: string; entries: Map<string, Partial<QuotaLimits>> } | undefined
let warnedAboutInvalidUserQuotaOverrides = false

function warnInvalidUserQuotaOverrides(): void {
	if (warnedAboutInvalidUserQuotaOverrides) return
	warnedAboutInvalidUserQuotaOverrides = true
	console.warn('Invalid USER_QUOTA_OVERRIDES configuration. Default limits apply to invalid entries or fields.')
}

function isQuotaOverrideObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseUserQuotaOverrides(raw: string): Map<string, Partial<QuotaLimits>> {
	const entries = new Map<string, Partial<QuotaLimits>>()
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		// Malformed JSON follows the same fallback as a non-object value.
	}
	if (!isQuotaOverrideObject(parsed)) {
		warnInvalidUserQuotaOverrides()
		return entries
	}

	for (const [address, entry] of Object.entries(parsed)) {
		if (!isQuotaOverrideObject(entry)) {
			warnInvalidUserQuotaOverrides()
			continue
		}
		const overrides: Partial<QuotaLimits> = {}
		for (const key of ['classic', 'elevenlabs', 'burstPerMinute'] as const) {
			const value = entry[key]
			if (value === undefined) continue
			if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
				overrides[key] = value
			} else {
				warnInvalidUserQuotaOverrides()
			}
		}
		entries.set(address, overrides)
	}
	return entries
}

function getUserQuotaOverride(raw: string | undefined, address: string): Partial<QuotaLimits> | undefined {
	if (raw === undefined) return undefined
	if (cachedUserQuotaOverrides?.raw !== raw) {
		cachedUserQuotaOverrides = { raw, entries: parseUserQuotaOverrides(raw) }
	}
	return cachedUserQuotaOverrides.entries.get(address)
}

/** Configured per-user limits (vars), before any per-address override. */
export function getDefaultUserQuotaLimits(env: Env): QuotaLimits {
	const burstRaw = env.BURST_LIMIT_PER_MINUTE?.trim().toLowerCase()
	const burstPerMinute = !burstRaw || burstRaw === 'off' || burstRaw === 'disabled'
		? DEFAULT_BURST_LIMIT_PER_MINUTE
		: parseNonNegativeInt(burstRaw, DEFAULT_BURST_LIMIT_PER_MINUTE)
	return {
		classic: parseNonNegativeInt(env.DAILY_LIMIT_CLASSIC, DEFAULT_DAILY_LIMIT_CLASSIC),
		elevenlabs: parseNonNegativeInt(env.DAILY_LIMIT_ELEVENLABS, DEFAULT_DAILY_LIMIT_ELEVENLABS),
		...(burstPerMinute > 0 ? { burstPerMinute } : {}),
	}
}

/**
 * Defaults merged with the legacy `USER_QUOTA_OVERRIDES` secret. The user's `UserQuotaDO` replaces this
 * with its stored override row when one exists (see `QuotaOverride`), so the secret only matters for
 * addresses without a row.
 */
export function getUserQuotaLimits(env: Env, address: string): QuotaLimits {
	const overrides = getUserQuotaOverride(env.USER_QUOTA_OVERRIDES, address)
	const defaults = getDefaultUserQuotaLimits(env)
	return overrides
		? applyQuotaOverride(defaults, {
			classic: overrides.classic ?? null,
			elevenlabs: overrides.elevenlabs ?? null,
			burstPerMinute: overrides.burstPerMinute ?? null,
		})
		: defaults
}

export function getGlobalQuotaLimits(env: Env): { classic: number | null; elevenlabs: number | null } {
	return {
		classic: parseOptionalGlobalLimit(env.GLOBAL_DAILY_LIMIT_CLASSIC, DEFAULT_GLOBAL_DAILY_LIMIT_CLASSIC),
		elevenlabs: parseOptionalGlobalLimit(env.GLOBAL_DAILY_LIMIT_ELEVENLABS, DEFAULT_GLOBAL_DAILY_LIMIT_ELEVENLABS),
	}
}

function getUserQuotaStub(env: Env, address: string): DurableObjectStub<UserQuotaDO> {
	if (!env.USER_QUOTA) {
		throw new Error('USER_QUOTA Durable Object binding is not configured')
	}
	const id = env.USER_QUOTA.idFromName(`user:${address}`)
	return env.USER_QUOTA.get(id)
}

function getGlobalQuotaStub(env: Env, dayKey: string): DurableObjectStub<UserQuotaDO> {
	if (!env.USER_QUOTA) {
		throw new Error('USER_QUOTA Durable Object binding is not configured')
	}
	const id = env.USER_QUOTA.idFromName(`global:${dayKey}`)
	return env.USER_QUOTA.get(id)
}

/**
 * Per Cloudflare Durable Objects stub semantics, after an RPC disconnect error the existing
 * stub instance is permanently broken and throws on subsequent calls. Always acquire a fresh
 * stub before invoking compensation/cleanup, with one fresh-stub retry on transient disconnect.
 */
async function callWithFreshStubRetry<T>(
	getFreshStub: () => DurableObjectStub<UserQuotaDO>,
	operation: (stub: DurableObjectStub<UserQuotaDO>) => Promise<T>
): Promise<T> {
	try {
		return await operation(getFreshStub())
	} catch {
		return await operation(getFreshStub())
	}
}

function providerLabel(provider: QuotaProvider): string {
	return provider === 'elevenlabs' ? 'ElevenLabs' : 'Classic'
}

function buildQuotaExceededMessage(params: {
	provider: QuotaProvider
	limit: number
	used: number
	resetAt: string
	scope: 'user' | 'global'
	window: 'day' | 'minute'
}): string {
	const label = providerLabel(params.provider)
	if (params.window === 'minute') {
		return `Rate limit exceeded (${params.used}/${params.limit} requests per minute). Please wait until ${params.resetAt}.`
	}
	if (params.scope === 'global') {
		return `Daily platform capacity reached for ${label}. Resets at ${params.resetAt}.`
	}
	return `Daily ${label} generation limit reached (${params.used}/${params.limit}). Resets at ${params.resetAt}.`
}

export function buildQuotaExceededResponse(payload: QuotaExceededPayload, nowMs: number = Date.now()): Response {
	const resetMs = Date.parse(payload.resetAt)
	const retryAfterSeconds = Number.isFinite(resetMs)
		? Math.max(1, Math.ceil((resetMs - nowMs) / 1000))
		: 60

	return new Response(JSON.stringify(payload), {
		status: 429,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
			'Retry-After': String(retryAfterSeconds),
		},
	})
}

export async function getUserQuotaSnapshot(
	env: Env,
	address: string,
	nowMs?: number
): Promise<QuotaSnapshot> {
	const stub = getUserQuotaStub(env, address)
	return await stub.getQuota(getUserQuotaLimits(env, address), nowMs, getDefaultUserQuotaLimits(env))
}

export interface QuotaOverrideView {
	override: QuotaOverride | null
	limits: QuotaLimits
	source: 'durable_object' | 'legacy_secret' | 'default'
}

/** Admin: the address's stored override (if any) and the limits reserve/getQuota will apply. */
export async function inspectQuotaOverride(env: Env, address: string): Promise<QuotaOverrideView> {
	const override = await getUserQuotaStub(env, address).getQuotaOverride()
	if (override) {
		return { override, limits: applyQuotaOverride(getDefaultUserQuotaLimits(env), override), source: 'durable_object' }
	}
	const legacy = getUserQuotaOverride(env.USER_QUOTA_OVERRIDES, address) !== undefined
	return { override: null, limits: getUserQuotaLimits(env, address), source: legacy ? 'legacy_secret' : 'default' }
}

export async function setQuotaOverride(env: Env, address: string, input: QuotaOverrideInput): Promise<QuotaOverrideView> {
	await getUserQuotaStub(env, address).setQuotaOverride(input)
	return await inspectQuotaOverride(env, address)
}

export async function clearQuotaOverride(env: Env, address: string): Promise<QuotaOverrideView> {
	await getUserQuotaStub(env, address).clearQuotaOverride()
	return await inspectQuotaOverride(env, address)
}

function toGlobalLimitsForProvider(
	globalLimits: { classic: number | null; elevenlabs: number | null }
): QuotaLimits | null {
	if (globalLimits.classic === null && globalLimits.elevenlabs === null) {
		return null
	}
	return {
		classic: globalLimits.classic ?? Number.MAX_SAFE_INTEGER,
		elevenlabs: globalLimits.elevenlabs ?? Number.MAX_SAFE_INTEGER,
	}
}

/**
 * Best-effort release of ONE caller's claim (by `claimId`, so a concurrent winner sharing the same
 * reservation is never touched). `generation: null` resolves the generation from the claim row, for
 * replies lost after the DO wrote. If both fresh-stub attempts fail the unadmitted row simply ages out
 * (next-day rollover / retention prune); the user can lose at most that one slot for the day.
 */
async function releaseCallerClaim(
	getFreshStub: () => DurableObjectStub<UserQuotaDO>,
	params: {
		reservationId: string
		generation: number | null
		dayKey: string | null
		claimId: string
		reason: string
		nowMs: number
		rollbackUnsharedAdmitted?: boolean
	}
): Promise<void> {
	try {
		await callWithFreshStubRetry(getFreshStub, (stub) => stub.releaseClaim(
			params.reservationId,
			params.generation,
			params.dayKey,
			params.reason,
			params.nowMs,
			{ claimId: params.claimId, rollbackUnsharedAdmitted: Boolean(params.rollbackUnsharedAdmitted) }
		))
	} catch (err) {
		console.warn('Quota claim release RPC failed:', params.reason, sanitizedErrorTag(err))
	}
}

function quotaExceeded(
	result: { provider: QuotaProvider; limit: number; used: number; resetAt: string },
	scope: 'user' | 'global',
	window: 'day' | 'minute'
): { ok: false; code: 'quota_exceeded'; payload: QuotaExceededPayload } {
	return {
		ok: false,
		code: 'quota_exceeded',
		payload: {
			error: buildQuotaExceededMessage({ ...result, scope, window }),
			code: 'quota_exceeded',
			provider: result.provider,
			limit: result.limit,
			used: result.used,
			remaining: 0,
			resetAt: result.resetAt,
			scope,
			window,
		},
	}
}

/**
 * Reserve quota for a new generation, fresh retry, or independent fallback.
 * 1. Per-user UTC-day + optional per-minute burst guard (fail-closed).
 * 2. Daily global soft circuit breaker `global:YYYY-MM-DD`: an explicit denial releases this caller's
 *    user claim and returns 429; an RPC error fails open.
 * 3. Confirms the user admission (writes `admitted`, keeping rows rollback-compatible).
 */
export async function reserveGenerationQuota(
	env: Env,
	params: {
		address: string
		reservationId: string
		provider: QuotaProvider
		nowMs?: number
	}
): Promise<CoordinatedReserveResult> {
	const nowMs = params.nowMs ?? Date.now()
	const claimId = crypto.randomUUID()
	const userLimits = getUserQuotaLimits(env, params.address)
	const userDefaults = getDefaultUserQuotaLimits(env)
	const globalLimits = toGlobalLimitsForProvider(getGlobalQuotaLimits(env))
	const freshUserStub = () => getUserQuotaStub(env, params.address)
	const userStub = freshUserStub()
	const release = { reservationId: params.reservationId, claimId, nowMs }

	let userResult: Awaited<ReturnType<typeof userStub.reserve>>
	try {
		userResult = await userStub.reserve(params.reservationId, params.provider, userLimits, nowMs, undefined, claimId, userDefaults)
	} catch (err) {
		// The reply may have been lost after the DO wrote: release strictly by this caller's claimId.
		await releaseCallerClaim(freshUserStub, { ...release, generation: null, dayKey: null, reason: 'user_reserve_rpc_failed' })
		throw err
	}

	if (!userResult.ok) {
		if (userResult.code === 'stale_day') {
			throw new Error('Stale day quota reservation rejected; please retry')
		}
		if (userResult.code === 'reservation_conflict') {
			return { ok: false, code: 'reservation_conflict', existingProvider: userResult.existingProvider }
		}
		return quotaExceeded(userResult, 'user', userResult.reason === 'burst_limit' ? 'minute' : 'day')
	}

	const dayKey = userResult.dayKey
	const userGeneration = userResult.generation
	const supersededDayKeys = Array.isArray(userResult.supersededDayKeys)
		? userResult.supersededDayKeys.filter((d) => Boolean(d) && d !== dayKey)
		: userResult.supersededDayKey && userResult.supersededDayKey !== dayKey
			? [userResult.supersededDayKey]
			: []

	// A rolled-forward reservation releases its earlier day's global slot; each day is cleared from the
	// user row only after that refund succeeds, so a failure is retried on the next reserve.
	if (globalLimits) {
		for (const oldDayKey of supersededDayKeys) {
			try {
				await callWithFreshStubRetry(
					() => getGlobalQuotaStub(env, oldDayKey),
					(stub) => stub.refund(params.reservationId, 'superseded_by_next_day_rollover', nowMs)
				)
				await callWithFreshStubRetry(
					freshUserStub,
					(stub) => stub.clearSupersededDay(params.reservationId, oldDayKey, nowMs)
				).catch(() => {})
			} catch (err) {
				console.warn('Superseded global daily quota cleanup RPC failed:', sanitizedErrorTag(err))
			}
		}
	}

	// undefined: no global write attempted; null: global RPC threw (a write may still have landed).
	let globalGeneration: number | null | undefined
	if (globalLimits) {
		let globalResult: Awaited<ReturnType<typeof userStub.reserve>> | undefined
		try {
			globalResult = await getGlobalQuotaStub(env, dayKey).reserve(
				params.reservationId,
				params.provider,
				globalLimits,
				nowMs,
				dayKey,
				claimId
			)
		} catch (err) {
			globalGeneration = null
			console.warn('Global daily quota circuit breaker RPC unavailable (soft fallback):', sanitizedErrorTag(err))
		}
		if (globalResult && !globalResult.ok) {
			await releaseCallerClaim(freshUserStub, { ...release, generation: userGeneration, dayKey, reason: 'global_reserve_denied' })
			if (globalResult.code === 'stale_day') {
				throw new Error('Stale day global quota reservation rejected; please retry')
			}
			if (globalResult.code === 'reservation_conflict') {
				return { ok: false, code: 'reservation_conflict', existingProvider: globalResult.existingProvider }
			}
			return quotaExceeded(globalResult, 'global', 'day')
		}
		if (globalResult?.ok) {
			globalGeneration = globalResult.generation
		}
	}

	const releaseAdmission = async (reason: string, rollbackUnsharedAdmitted: boolean) => {
		await releaseCallerClaim(freshUserStub, { ...release, generation: userGeneration, dayKey, reason, rollbackUnsharedAdmitted })
		if (globalGeneration !== undefined) {
			await releaseCallerClaim(() => getGlobalQuotaStub(env, dayKey), { ...release, generation: globalGeneration, dayKey, reason })
		}
	}

	let userConfirmed: boolean
	try {
		userConfirmed = await userStub.confirmAdmission(params.reservationId, userGeneration, dayKey, nowMs, claimId)
	} catch (err) {
		await releaseAdmission('user_confirm_rpc_failed', true)
		throw err
	}
	if (!userConfirmed) {
		await releaseAdmission('user_confirm_rejected', false)
		throw new Error('User quota admission confirmation rejected (superseded or released)')
	}

	if (typeof globalGeneration === 'number') {
		const generation = globalGeneration
		await callWithFreshStubRetry(
			() => getGlobalQuotaStub(env, dayKey),
			(stub) => stub.confirmAdmission(params.reservationId, generation, dayKey, nowMs, claimId)
		).catch(() => {})
	}

	return {
		ok: true,
		idempotent: userResult.idempotent,
		shared: userResult.shared,
		dayKey,
		quota: userResult.quota,
	}
}

/**
 * Atomically transfer an UNBILLED in-flight reservation after confirmed pre-charge rejection
 * (e.g. AISG submit rejected before billing -> ElevenLabs fallback), strictly enforcing
 * the target provider's per-user AND daily global limits.
 *
 * Handles EVERY explicit negative global response (`quota_exceeded`, `invalid_state`,
 * `reservation_conflict`) and reverts a newly transitioned user reservation on disagreement.
 */
export async function transitionFallbackQuota(
	env: Env,
	params: {
		address: string
		reservationId: string
		fromProvider: QuotaProvider
		toProvider: QuotaProvider
		previousDayKey?: string
		nowMs?: number
	}
): Promise<CoordinatedFallbackTransitionResult> {
	const nowMs = params.nowMs ?? Date.now()
	const userLimits = getUserQuotaLimits(env, params.address)
	const userStub = getUserQuotaStub(env, params.address)
	const userResult = await userStub.transitionFallback(
		params.reservationId,
		params.fromProvider,
		params.toProvider,
		userLimits,
		nowMs,
		undefined,
		getDefaultUserQuotaLimits(env)
	)

	if (!userResult.ok) {
		if (userResult.code === 'invalid_state') {
			return {
				ok: false,
				code: 'invalid_state',
				status: userResult.status,
				provider: userResult.provider,
			}
		}
		return quotaExceeded(userResult, 'user', 'day')
	}

	const newDayKey = userResult.reservation.dayKey
	const previousDayKey = params.previousDayKey || userResult.previousDayKey
	const globalLimits = toGlobalLimitsForProvider(getGlobalQuotaLimits(env))
	if (globalLimits) {
		try {
			const globalStub = getGlobalQuotaStub(env, newDayKey)
			const globalResult = previousDayKey === newDayKey
				? await globalStub.transitionFallback(
					params.reservationId,
					params.fromProvider,
					params.toProvider,
					globalLimits,
					nowMs,
					newDayKey
				)
				: await globalStub.reserve(params.reservationId, params.toProvider, globalLimits, nowMs, newDayKey)

			if (!globalResult.ok) {
				if (!userResult.idempotent) {
					await callWithFreshStubRetry(
						() => getUserQuotaStub(env, params.address),
						(freshUserStub) => freshUserStub.revertFallback(
							params.reservationId,
							params.fromProvider,
							previousDayKey,
							false,
							'global_fallback_denied',
							nowMs
						)
					).catch(() => {})
				}

				if (globalResult.code === 'quota_exceeded') {
					return quotaExceeded(globalResult, 'global', 'day')
				}

				if (globalResult.code === 'stale_day') {
					return {
						ok: false,
						code: 'invalid_state',
						status: 'stale_day',
						provider: params.toProvider,
					}
				}

				if (globalResult.code === 'reservation_conflict') {
					return {
						ok: false,
						code: 'invalid_state',
						status: 'reservation_conflict',
						provider: globalResult.existingProvider,
					}
				}

				return {
					ok: false,
					code: 'invalid_state',
					status: globalResult.status,
					provider: globalResult.provider,
				}
			}

			// Confirmed pre-charge rejection crossed UTC midnight: release the unbilled previous-day global slot
			if (previousDayKey && previousDayKey !== newDayKey) {
				const oldGlobalStub = getGlobalQuotaStub(env, previousDayKey)
				await oldGlobalStub.refund(params.reservationId, 'moved_to_next_day_fallback', nowMs).catch(() => {})
			}
		} catch (err) {
			console.warn('Global daily quota fallback RPC unavailable (soft fallback):', sanitizedErrorTag(err))
		}
	}

	return {
		ok: true,
		idempotent: userResult.idempotent,
		dayKey: newDayKey,
		previousDayKey,
		quota: userResult.quota,
	}
}

/**
 * Read a reservation's authoritative state from the user's quota DO (null when absent or unavailable).
 * Used to verify a carried reservation still holds a counted slot before a paid replay relies on it.
 */
export async function getGenerationQuotaReservation(
	env: Env,
	params: { address: string; reservationId: string }
): Promise<QuotaReservationRecord | null> {
	if (!env.USER_QUOTA || !params.address || !params.reservationId) {
		return null
	}
	return await getUserQuotaStub(env, params.address).getReservation(params.reservationId)
}

export async function commitGenerationQuota(
	env: Env,
	params: {
		address: string
		reservationId: string
		actualProvider: QuotaProvider
		dayKey?: string
		nowMs?: number
	}
): Promise<QuotaCommitResult | null> {
	if (!env.USER_QUOTA || !params.address || !params.reservationId) {
		return null
	}
	const nowMs = params.nowMs ?? Date.now()
	const userStub = getUserQuotaStub(env, params.address)
	const result = await userStub.commit(params.reservationId, params.actualProvider, nowMs)

	const globalDayKey = params.dayKey || result.reservation?.dayKey || getUtcDayKey(nowMs)
	if (result.committed && toGlobalLimitsForProvider(getGlobalQuotaLimits(env))) {
		try {
			const globalStub = getGlobalQuotaStub(env, globalDayKey)
			await globalStub.commit(params.reservationId, params.actualProvider, nowMs)
		} catch (err) {
			console.warn('Global daily quota commit RPC failed:', sanitizedErrorTag(err))
		}
	}
	return result
}

export async function markAmbiguousGenerationQuota(
	env: Env,
	params: {
		address: string
		reservationId: string
		dayKey?: string
		reason?: string
		nowMs?: number
	}
): Promise<void> {
	if (!env.USER_QUOTA || !params.address || !params.reservationId) {
		return
	}
	const nowMs = params.nowMs ?? Date.now()
	const userStub = getUserQuotaStub(env, params.address)
	const result = await userStub.markAmbiguous(params.reservationId, params.reason, nowMs)

	const globalDayKey = params.dayKey || result.reservation?.dayKey || getUtcDayKey(nowMs)
	if (toGlobalLimitsForProvider(getGlobalQuotaLimits(env))) {
		try {
			const globalStub = getGlobalQuotaStub(env, globalDayKey)
			await globalStub.markAmbiguous(params.reservationId, params.reason, nowMs)
		} catch (err) {
			console.warn('Global daily quota markAmbiguous RPC failed:', sanitizedErrorTag(err))
		}
	}
}

export async function refundGenerationQuota(
	env: Env,
	params: {
		address: string
		reservationId: string
		dayKey?: string
		reason?: string
		nowMs?: number
		options?: QuotaRefundOptions
	}
): Promise<boolean> {
	if (!env.USER_QUOTA || !params.address || !params.reservationId) {
		return false
	}
	const nowMs = params.nowMs ?? Date.now()
	const userStub = getUserQuotaStub(env, params.address)
	const result = await userStub.refund(params.reservationId, params.reason, nowMs, params.options)

	const globalDayKey = params.dayKey || result.reservation?.dayKey || getUtcDayKey(nowMs)
	if (result.refunded && toGlobalLimitsForProvider(getGlobalQuotaLimits(env))) {
		try {
			const globalStub = getGlobalQuotaStub(env, globalDayKey)
			await globalStub.refund(params.reservationId, params.reason, nowMs, params.options)
		} catch (err) {
			console.warn('Global daily quota refund RPC failed:', sanitizedErrorTag(err))
		}
	}
	return result.refunded
}
