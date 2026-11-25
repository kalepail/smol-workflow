import {
	getUtcDayKey,
	type PendingUserReleaseInput,
	type QuotaCommitResult,
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

export function getUserQuotaLimits(env: Env, address: string): QuotaLimits {
	const overrides = getUserQuotaOverride(env.USER_QUOTA_OVERRIDES, address)
	const burstRaw = env.BURST_LIMIT_PER_MINUTE?.trim().toLowerCase()
	const defaultBurstPerMinute = !burstRaw || burstRaw === 'off' || burstRaw === 'disabled'
		? DEFAULT_BURST_LIMIT_PER_MINUTE
		: parseNonNegativeInt(burstRaw, DEFAULT_BURST_LIMIT_PER_MINUTE)
	const burstPerMinute = overrides?.burstPerMinute ?? defaultBurstPerMinute

	return {
		classic: overrides?.classic ?? parseNonNegativeInt(env.DAILY_LIMIT_CLASSIC, DEFAULT_DAILY_LIMIT_CLASSIC),
		elevenlabs: overrides?.elevenlabs ?? parseNonNegativeInt(env.DAILY_LIMIT_ELEVENLABS, DEFAULT_DAILY_LIMIT_ELEVENLABS),
		...(burstPerMinute > 0 ? { burstPerMinute } : {}),
	}
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
	return await stub.getQuota(getUserQuotaLimits(env, address), nowMs)
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

async function reconcileFailedAdmission(
	env: Env,
	params: {
		address: string
		reservationId: string
		userGeneration: number
		dayKey: string
		claimId: string
		rollbackUnsharedAdmitted: boolean
		reason: string
		nowMs: number
		globalReserveAttempted: boolean
		reservedGlobalGeneration?: number
	}
): Promise<void> {
	const userKey = `user:${params.address}`
	const globalKey = `global:${params.dayKey}`

	let userReleased = false
	try {
		await callWithFreshStubRetry(
			() => getUserQuotaStub(env, params.address),
			(freshUserStub) => freshUserStub.releaseClaim(
				params.reservationId,
				params.userGeneration,
				params.dayKey,
				params.reason,
				params.nowMs,
				{
					claimId: params.claimId,
					rollbackUnsharedAdmitted: params.rollbackUnsharedAdmitted,
				}
			)
		)
		userReleased = true
	} catch {
		userReleased = false
	}

	const buildDeferredUserJob = (): PendingUserReleaseInput => ({
		userKey,
		reservationId: params.reservationId,
		generation: params.userGeneration,
		dayKey: params.dayKey,
		claimId: params.claimId,
		rollbackUnsharedAdmitted: params.rollbackUnsharedAdmitted,
		reason: params.reason,
		nowMs: params.nowMs,
	})

	const buildDeferredGlobalJob = (): PendingUserReleaseInput => ({
		userKey: globalKey,
		reservationId: params.reservationId,
		generation: params.reservedGlobalGeneration ?? 0,
		dayKey: params.dayKey,
		claimId: params.claimId,
		rollbackUnsharedAdmitted: false,
		reason: params.reason,
		nowMs: params.nowMs,
	})

	let globalReleased = !params.globalReserveAttempted
	let userDeferredOnGlobal = false

	if (params.globalReserveAttempted) {
		try {
			await callWithFreshStubRetry(
				() => getGlobalQuotaStub(env, params.dayKey),
				(freshGlobalStub) => freshGlobalStub.releaseClaim(
					params.reservationId,
					params.reservedGlobalGeneration ?? null,
					params.dayKey,
					params.reason,
					params.nowMs,
					{
						claimId: params.claimId,
						...(!userReleased ? { deferredUserRelease: buildDeferredUserJob() } : {}),
					}
				)
			)
			globalReleased = true
			if (!userReleased) {
				userDeferredOnGlobal = true
			}
		} catch {
			globalReleased = false
		}
	} else if (!userReleased) {
		try {
			await callWithFreshStubRetry(
				() => getGlobalQuotaStub(env, params.dayKey),
				(freshGlobalStub) => freshGlobalStub.enqueuePendingUserRelease(buildDeferredUserJob())
			)
			userDeferredOnGlobal = true
		} catch {
			userDeferredOnGlobal = false
		}
	}

	// If global release failed, persist deferred global release onto the reachable user DO.
	// If userReleased is ALSO still false (overlapping release failures on BOTH DOs!), NEVER drop
	// the pending user release: release it atomically alongside the deferred global job (or enqueue BOTH)!
	if (!globalReleased) {
		if (!userReleased) {
			try {
				await callWithFreshStubRetry(
					() => getUserQuotaStub(env, params.address),
					(freshUserStub) => freshUserStub.releaseClaim(
						params.reservationId,
						params.userGeneration,
						params.dayKey,
						params.reason,
						params.nowMs,
						{
							claimId: params.claimId,
							rollbackUnsharedAdmitted: params.rollbackUnsharedAdmitted,
							deferredUserRelease: buildDeferredGlobalJob(),
						}
					)
				)
				userReleased = true
			} catch {
				await callWithFreshStubRetry(
					() => getUserQuotaStub(env, params.address),
					async (freshUserStub) => {
						await freshUserStub.enqueuePendingUserRelease(buildDeferredGlobalJob())
						await freshUserStub.enqueuePendingUserRelease(buildDeferredUserJob())
					}
				).catch(() => {})
			}
		} else {
			await callWithFreshStubRetry(
				() => getUserQuotaStub(env, params.address),
				(freshUserStub) => freshUserStub.enqueuePendingUserRelease(buildDeferredGlobalJob())
			).catch(() => {})
		}
	}

	// Final safety net if user release is still neither completed nor durably queued on global
	if (!userReleased && !userDeferredOnGlobal) {
		let persistedOnGlobal = false
		try {
			await callWithFreshStubRetry(
				() => getGlobalQuotaStub(env, params.dayKey),
				(freshGlobalStub) => freshGlobalStub.enqueuePendingUserRelease(buildDeferredUserJob())
			)
			persistedOnGlobal = true
		} catch {
			persistedOnGlobal = false
		}
		if (!persistedOnGlobal) {
			await callWithFreshStubRetry(
				() => getUserQuotaStub(env, params.address),
				(freshUserStub) => freshUserStub.enqueuePendingUserRelease(buildDeferredUserJob())
			).catch(() => {})
		}
	}
}

/**
 * Atomically reserve quota for a new generation, fresh retry, or independent fallback.
 * 1. Enforces per-user UTC-day + optional per-minute burst guard (fail-closed).
 * 2. Enforces daily global soft circuit-breaker bucket `global:YYYY-MM-DD`.
 *    Handles EVERY explicit negative global response (`quota_exceeded` AND `reservation_conflict`),
 *    compensating an unshared newly-created user reservation before returning the rejection.
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
	const initialDayKey = getUtcDayKey(nowMs)
	const claimId = crypto.randomUUID()
	const userKey = `user:${params.address}`
	const userLimits = getUserQuotaLimits(env, params.address)
	const globalLimits = toGlobalLimitsForProvider(getGlobalQuotaLimits(env))
	const userStub = getUserQuotaStub(env, params.address)

	let userResult: Awaited<ReturnType<typeof userStub.reserve>>
	try {
		userResult = await userStub.reserve(
			params.reservationId,
			params.provider,
			userLimits,
			nowMs,
			undefined,
			claimId
		)
	} catch (err) {
		// Initial reserve() reply may have been lost AFTER writing to storage!
		// Reconcile strictly by this caller's unique `claimId` via a fresh stub (never touching another caller's claim).
		let userReleased = false
		try {
			await callWithFreshStubRetry(
				() => getUserQuotaStub(env, params.address),
				(freshUserStub) => freshUserStub.releaseClaim(
					params.reservationId,
					null,
					null,
					'user_reserve_rpc_failed',
					nowMs,
					{ claimId }
				)
			)
			userReleased = true
		} catch {
			userReleased = false
		}
		if (!userReleased) {
			const deferredUserJob: PendingUserReleaseInput = {
				userKey,
				reservationId: params.reservationId,
				generation: 0,
				dayKey: '',
				claimId,
				rollbackUnsharedAdmitted: false,
				reason: 'user_reserve_rpc_failed',
				nowMs,
			}
			// Persist deferred claim-ID release onto `global:<initialDayKey>` independently of whether
			// daily global caps are enabled or `off`. If global enqueue also fails, fall back to a
			// fresh user DO stub (direct releaseClaim, or self-enqueued outbox if releaseClaim rejects).
			let persistedOnGlobal = false
			try {
				await callWithFreshStubRetry(
					() => getGlobalQuotaStub(env, initialDayKey),
					(freshGlobalStub) => freshGlobalStub.enqueuePendingUserRelease(deferredUserJob)
				)
				persistedOnGlobal = true
			} catch {
				persistedOnGlobal = false
			}
			if (!persistedOnGlobal) {
				try {
					await callWithFreshStubRetry(
						() => getUserQuotaStub(env, params.address),
						(freshUserStub) => freshUserStub.releaseClaim(
							params.reservationId,
							null,
							null,
							'user_reserve_rpc_failed',
							nowMs,
							{ claimId }
						)
					)
				} catch {
					await callWithFreshStubRetry(
						() => getUserQuotaStub(env, params.address),
						(freshUserStub) => freshUserStub.enqueuePendingUserRelease(deferredUserJob)
					).catch(() => {})
				}
			}
		}
		throw err
	}

	if (!userResult.ok) {
		if (userResult.code === 'stale_day') {
			throw new Error('Stale day quota reservation rejected; please retry')
		}
		if (userResult.code === 'reservation_conflict') {
			return {
				ok: false,
				code: 'reservation_conflict',
				existingProvider: userResult.existingProvider,
			}
		}
		const window = userResult.reason === 'burst_limit' ? 'minute' : 'day'
		return {
			ok: false,
			code: 'quota_exceeded',
			payload: {
				error: buildQuotaExceededMessage({
					provider: userResult.provider,
					limit: userResult.limit,
					used: userResult.used,
					resetAt: userResult.resetAt,
					scope: 'user',
					window,
				}),
				code: 'quota_exceeded',
				provider: userResult.provider,
				limit: userResult.limit,
				used: userResult.used,
				remaining: 0,
				resetAt: userResult.resetAt,
				scope: 'user',
				window,
			},
		}
	}

	const dayKey = userResult.dayKey
	const userGeneration = userResult.generation
	const supersededDayKeys = Array.isArray(userResult.supersededDayKeys)
		? userResult.supersededDayKeys.filter((d) => Boolean(d) && d !== dayKey)
		: userResult.supersededDayKey && userResult.supersededDayKey !== dayKey
			? [userResult.supersededDayKey]
			: []

	// Reconcile EVERY durably persisted superseded global bucket BEFORE reserving today's bucket,
	// clearing each day individually ONLY after its refund against `global:<oldDayKey>` succeeds!
	if (globalLimits && supersededDayKeys.length > 0) {
		for (const oldDayKey of supersededDayKeys) {
			try {
				await callWithFreshStubRetry(
					() => getGlobalQuotaStub(env, oldDayKey),
					(supersededGlobalStub) => supersededGlobalStub.refund(
						params.reservationId,
						'superseded_by_next_day_rollover',
						nowMs
					)
				)
				await callWithFreshStubRetry(
					() => getUserQuotaStub(env, params.address),
					(freshUserStub) => freshUserStub.clearSupersededDay(params.reservationId, oldDayKey, nowMs)
				).catch(() => {})
			} catch (err) {
				console.warn('Superseded global daily quota cleanup RPC failed:', sanitizedErrorTag(err))
			}
		}
	}

	let globalReserveAttempted = false
	let reservedGlobalGeneration: number | undefined

	if (globalLimits) {
		try {
			// Always pass `dayKey` explicitly as `bucketDayKey` and caller's unique `claimId` so
			// `global:<dayKey>` DO name, SQL `day_key`, and per-caller claim idempotency all match.
			const globalStub = getGlobalQuotaStub(env, dayKey)
			globalReserveAttempted = true
			const globalResult = await globalStub.reserve(
				params.reservationId,
				params.provider,
				globalLimits,
				nowMs,
				dayKey,
				claimId
			)
			if (!globalResult.ok) {
				globalReserveAttempted = false
				// Per-caller idempotent claim release via fresh stub; if both fresh-stub attempts disconnect,
				// persist a durable deferred release on the reachable global DO so its alarm drains it once reachable.
				let userReleaseSucceeded = false
				try {
					await callWithFreshStubRetry(
						() => getUserQuotaStub(env, params.address),
						(freshUserStub) => freshUserStub.releaseClaim(
							params.reservationId,
							userGeneration,
							dayKey,
							'global_reserve_denied',
							nowMs,
							{ claimId }
						)
					)
					userReleaseSucceeded = true
				} catch {
					userReleaseSucceeded = false
				}
				if (!userReleaseSucceeded) {
					await callWithFreshStubRetry(
						() => getGlobalQuotaStub(env, dayKey),
						(freshGlobalStub) => freshGlobalStub.enqueuePendingUserRelease({
							userKey,
							reservationId: params.reservationId,
							generation: userGeneration,
							dayKey,
							claimId,
							rollbackUnsharedAdmitted: false,
							reason: 'global_reserve_denied',
							nowMs,
						})
					).catch(() => {})
				}
				if (globalResult.code === 'stale_day') {
					throw new Error('Stale day global quota reservation rejected; please retry')
				}
				if (globalResult.code === 'reservation_conflict') {
					return {
						ok: false,
						code: 'reservation_conflict',
						existingProvider: globalResult.existingProvider,
					}
				}
				return {
					ok: false,
					code: 'quota_exceeded',
					payload: {
						error: buildQuotaExceededMessage({
							provider: globalResult.provider,
							limit: globalResult.limit,
							used: globalResult.used,
							resetAt: globalResult.resetAt,
							scope: 'global',
							window: 'day',
						}),
						code: 'quota_exceeded',
						provider: globalResult.provider,
						limit: globalResult.limit,
						used: globalResult.used,
						remaining: 0,
						resetAt: globalResult.resetAt,
						scope: 'global',
						window: 'day',
					},
				}
			}
			reservedGlobalGeneration = globalResult.generation
		} catch (err) {
			if (err instanceof Error && err.message.startsWith('Stale day ')) {
				throw err
			}
			// Soft global circuit breaker: keep `globalReserveAttempted = true` so if admission fails
			// below, any global write whose reply was lost is still released strictly by `claimId`!
			console.warn('Global daily quota circuit breaker RPC unavailable (soft fallback):', sanitizedErrorTag(err))
		}
	}

	// REQUIRE user confirmation bound to `(userGeneration, dayKey, claimId)` to succeed before returning ok!
	// If confirmation throws or returns false, reconcile BOTH user and global claims symmetrically via fresh
	// stubs and durable outboxes (including unknown-generation lost global reserve replies resolved by `claimId`!).
	let userConfirmed = false
	try {
		userConfirmed = await userStub.confirmAdmission(params.reservationId, userGeneration, dayKey, nowMs, claimId)
	} catch (err) {
		await reconcileFailedAdmission(env, {
			address: params.address,
			reservationId: params.reservationId,
			userGeneration,
			dayKey,
			claimId,
			rollbackUnsharedAdmitted: true,
			reason: 'user_confirm_rpc_failed',
			nowMs,
			globalReserveAttempted,
			reservedGlobalGeneration,
		})
		throw err
	}

	if (!userConfirmed) {
		await reconcileFailedAdmission(env, {
			address: params.address,
			reservationId: params.reservationId,
			userGeneration,
			dayKey,
			claimId,
			rollbackUnsharedAdmitted: false,
			reason: 'user_confirm_rejected',
			nowMs,
			globalReserveAttempted,
			reservedGlobalGeneration,
		})
		throw new Error('User quota admission confirmation rejected (superseded or released)')
	}

	if (reservedGlobalGeneration !== undefined) {
		await callWithFreshStubRetry(
			() => getGlobalQuotaStub(env, dayKey),
			(freshGlobalStub) => freshGlobalStub.confirmAdmission(
				params.reservationId,
				reservedGlobalGeneration!,
				dayKey,
				nowMs,
				claimId
			)
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
		nowMs
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
		return {
			ok: false,
			code: 'quota_exceeded',
			payload: {
				error: buildQuotaExceededMessage({
					provider: userResult.provider,
					limit: userResult.limit,
					used: userResult.used,
					resetAt: userResult.resetAt,
					scope: 'user',
					window: 'day',
				}),
				code: 'quota_exceeded',
				provider: userResult.provider,
				limit: userResult.limit,
				used: userResult.used,
				remaining: 0,
				resetAt: userResult.resetAt,
				scope: 'user',
				window: 'day',
			},
		}
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
					return {
						ok: false,
						code: 'quota_exceeded',
						payload: {
							error: buildQuotaExceededMessage({
								provider: globalResult.provider,
								limit: globalResult.limit,
								used: globalResult.used,
								resetAt: globalResult.resetAt,
								scope: 'global',
								window: 'day',
							}),
							code: 'quota_exceeded',
							provider: globalResult.provider,
							limit: globalResult.limit,
							used: globalResult.used,
							remaining: 0,
							resetAt: globalResult.resetAt,
							scope: 'global',
							window: 'day',
						},
					}
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
