import { DurableObject } from 'cloudflare:workers'
import { MINT_ADMISSION_LEASE_MS } from './utils/mint-eligibility'

export type QuotaProvider = MusicProvider

export type QuotaReservationStatus = 'reserved' | 'committed' | 'ambiguous' | 'refunded'

export interface QuotaLimits {
	classic: number
	elevenlabs: number
	burstPerMinute?: number
}

export interface ProviderQuotaStatus {
	limit: number
	used: number
	remaining: number
	resetAt: string
}

export interface QuotaSnapshot {
	classic: ProviderQuotaStatus
	elevenlabs: ProviderQuotaStatus
}

export interface QuotaReservationRecord {
	reservationId: string
	dayKey: string
	provider: QuotaProvider
	initialProvider: QuotaProvider
	status: QuotaReservationStatus
	claimCount: number
	admitted: boolean
	generation: number
	supersededDayKey: string | null
	supersededDayKeys: string[]
	createdAtMs: number
	updatedAtMs: number
	fallbackFrom: QuotaProvider | null
	reason: string | null
}

export type QuotaReserveResult =
	| {
		ok: true
		idempotent: boolean
		shared: boolean
		claimCount: number
		admitted: boolean
		generation: number
		dayKey: string
		claimId: string
		supersededDayKey?: string
		supersededDayKeys: string[]
		reservation: QuotaReservationRecord
		quota: QuotaSnapshot
	}
	| {
		ok: false
		code: 'quota_exceeded'
		reason: 'daily_limit' | 'burst_limit'
		provider: QuotaProvider
		limit: number
		used: number
		remaining: 0
		resetAt: string
		quota: QuotaSnapshot
	}
	| {
		ok: false
		code: 'reservation_conflict'
		existingProvider: QuotaProvider
		reservation: QuotaReservationRecord
		quota: QuotaSnapshot
	}
	| {
		ok: false
		code: 'stale_day'
		existingDayKey: string
		requestedDayKey: string
		reservation: QuotaReservationRecord
		quota: QuotaSnapshot
	}

export type QuotaTransitionResult =
	| {
		ok: true
		idempotent: boolean
		previousDayKey: string
		reservation: QuotaReservationRecord
		quota: QuotaSnapshot
	}
	| {
		ok: false
		code: 'quota_exceeded'
		reason: 'daily_limit'
		provider: QuotaProvider
		limit: number
		used: number
		remaining: 0
		resetAt: string
		quota: QuotaSnapshot
	}
	| {
		ok: false
		code: 'invalid_state'
		status: QuotaReservationStatus
		provider: QuotaProvider
		quota: QuotaSnapshot
	}

export interface QuotaCommitResult {
	committed: boolean
	idempotent: boolean
	notFound?: boolean
	reason?: 'not_found' | 'already_refunded' | 'provider_mismatch'
	reservation?: QuotaReservationRecord
}

export interface QuotaRefundOptions {
	onlyIfUnshared?: boolean
}

export interface QuotaRefundResult {
	refunded: boolean
	idempotent: boolean
	reason?: 'not_found' | 'already_committed' | 'ambiguous_non_refundable' | 'shared_reservation'
	reservation?: QuotaReservationRecord
}

export interface PendingUserReleaseInput {
	userKey: string
	reservationId: string
	generation: number
	dayKey: string
	claimId: string
	rollbackUnsharedAdmitted: boolean
	reason?: string
	nowMs?: number
}

export interface QuotaReleaseClaimOptions {
	claimId?: string
	rollbackUnsharedAdmitted?: boolean
	deferredUserRelease?: PendingUserReleaseInput
}

export interface PendingReleaseDrainResult {
	drained: number
	remaining: number
	nextDelayMs: number
}

export interface QuotaReleaseClaimResult {
	released: boolean
	refunded: boolean
	remainingClaims: number
	reservation?: QuotaReservationRecord
}

export interface QuotaMarkAmbiguousResult {
	marked: boolean
	status: QuotaReservationStatus | 'not_found'
	reservation?: QuotaReservationRecord
}

export interface QuotaRevertFallbackResult {
	reverted: boolean
	reservation?: QuotaReservationRecord
}

export type PlayBeaconAdmitResult =
	| { admitted: true }
	| { admitted: false; deduped: true; rateLimited?: false }
	| { admitted: false; deduped?: false; rateLimited: true; retryAfter: number }

/**
 * Lifecycle of one 12-hex asset-code prefix reservation (`mint_prefix_locks.status`).
 *
 * - `reserved`: provisional admission claim, tagged with the acquiring admission's `claim_token` and a
 *   creation lease (`lease_until_ms`). The owning workflow has not signed. Only this state may be
 *   released, only by its exact `claim_token`, and by another admission only after the lease expires.
 *   An identical-carrier admission that joins the claim records `joined_at_ms` and renews the lease:
 *   from then on the acquiring admission can no longer release it (the joiner may already have queued
 *   the workflow), and only lease-expiry recovery after verifying the workflow absent or terminal can.
 *   Every grant or renewal of the lease bumps `lease_version`; recovery releases only the exact lease
 *   (deadline and generation) it observed before checking the workflow.
 * - `signing`: the owning workflow claimed it immediately before issuer signing. Nothing has been
 *   relayed yet. Never released.
 * - `dispatched`: the owning workflow durably marked it inside the submit step, immediately BEFORE
 *   calling the relay. From here on the transaction may be on its way to the network.
 * - `ambiguous`: a dispatch may have happened and its outcome is unresolved (a replayed submit step,
 *   a full restart that re-entered signing, or a lost relay response). Requires reconciliation.
 * - `failed`: the owning workflow reached a definite non-landing outcome (refused after claiming for
 *   signing but before dispatch, or an on-chain FAILED receipt for its own dispatch). Another
 *   workflow for the SAME smol id may take it over.
 * - `minted`: the owning workflow confirmed the mint on chain. Terminal.
 *
 * `reserved`, `signing`, `dispatched` and `ambiguous` are unresolved: no other workflow may claim the
 * prefix or the smol id. `dispatched` and `ambiguous` are never released, never taken over, never
 * re-signed (even by their owner) and never demoted by a pre-dispatch failure: only an on-chain
 * receipt (`minted`, or FAILED from `dispatched`) or an operator resolves them.
 * `signed_at_ms` is sticky: once any workflow has claimed a prefix for signing, the row (and so the
 * prefix -> smol id binding) is never deleted. A never-signed provisional row is deleted, never
 * marked `failed`, so it can never block a different smol sharing the prefix.
 */
export type MintPrefixLockStatus = 'reserved' | 'signing' | 'dispatched' | 'ambiguous' | 'failed' | 'minted'

/** A dispatch may have started: retained through every replay, restart and pre-dispatch failure. */
const DISPATCH_STARTED: ReadonlySet<string> = new Set(['dispatched', 'ambiguous'])

/** `admission` (HTTP route) writes provisional claims; `signing` (TxWorkflow) is the authoritative claim. */
export type MintPrefixClaimStage = 'admission' | 'signing'

export interface MintPrefixConflict {
	prefix: string
	id: string
	/** The smol id the prefix is bound to. */
	heldBy: string
	/** The workflow that owns the reservation. */
	workflowId: string
	status: MintPrefixLockStatus
	/** The acquiring admission's token (provisional claims only). */
	claimToken: string | null
	/** Creation lease expiry of a provisional claim (ms since epoch), else null. */
	leaseUntilMs: number | null
	/**
	 * Generation of a provisional claim's creation lease (bumped by every acquisition, takeover and
	 * join), else null. Expiry recovery must present it unchanged, with `leaseUntilMs`, to release.
	 */
	leaseVersion: number | null
	/** When the holder was first claimed for signing, else null (never signed: deletable on release). */
	signedAtMs: number | null
	/**
	 * `prefix_reserved`: another smol id. `mint_in_progress`: same smol id, other workflow, unresolved.
	 * `minted`: terminal. `dispatch_uncertain`: this workflow's own dispatch may have started, so it
	 * may never sign (or be admitted) again until reconciled.
	 */
	reason: 'prefix_reserved' | 'mint_in_progress' | 'minted' | 'dispatch_uncertain'
}

export type MintPrefixReserveResult = { ok: true } | { ok: false; conflicts: MintPrefixConflict[] }

/**
 * Result of `markMintDispatched`. `uncertain`: this workflow's dispatch already started (a replay);
 * the rows are now `ambiguous`. `not_owned`: this workflow does not hold every prefix in `signing`
 * (nothing changed, nothing may be relayed).
 */
export type MintDispatchMarkResult = { ok: true } | { ok: false; state: 'uncertain' | 'not_owned' }

/**
 * Read-only view of this workflow's current signed attempt (see `UserQuotaDO.mintAttemptState`).
 * `undispatched`: every prefix is held in `signing` (signed, never dispatched; the only state the
 * dispatch marker accepts). `dispatch_started`: an owned row is `dispatched`/`ambiguous`. `other`: no
 * v7 claim at all, only an admission reservation, another owner, or an already concluded attempt.
 */
export type MintAttemptState = 'undispatched' | 'dispatch_started' | 'other'

/**
 * `failed`: a definite pre-dispatch refusal. `failed_onchain`: a FAILED receipt for this workflow's
 * own dispatch. `ambiguous`: the relay outcome is unknown. `minted`: confirmed on chain.
 */
export type MintPrefixOutcome = 'failed' | 'failed_onchain' | 'ambiguous' | 'minted'

/**
 * What the lock store concluded for the owner's rows. `failed`: definite (nothing was dispatched). For a
 * pre-dispatch refusal it is returned only when an owned `signing` claim became `failed`, which proves
 * THIS workflow's signed attempt never dispatched. `released`: a pre-dispatch refusal that found no
 * `signing` claim (a never-signed `reserved` claim was deleted, a once-signed one became `failed`, or
 * the rows were already `failed`). It proves nothing about an earlier dispatch: a post-upgrade duplicate
 * admission can create a fresh reservation for a pre-v7 execution that already wrote `submitting` and
 * relayed. `uncertain`: a dispatch may have started; the rows are retained as `ambiguous`. `minted`:
 * already settled. `none`: this workflow owns none of the rows (it never dispatched under them).
 */
export type MintPrefixResolution = { resolved: number; state: 'failed' | 'released' | 'uncertain' | 'minted' | 'none' }

interface MintPrefixLockRow extends Record<string, SqlStorageValue> {
	prefix: string
	smol_id: string
	workflow_id: string
	status: MintPrefixLockStatus
	claim_token: string | null
	lease_until_ms: number | null
	lease_version: number
	signed_at_ms: number | null
	dispatched_at_ms: number | null
	joined_at_ms: number | null
}

const MINT_LOCK_COLUMNS =
	'prefix, smol_id, workflow_id, status, claim_token, lease_until_ms, lease_version, signed_at_ms, dispatched_at_ms, joined_at_ms'
const MINT_CLAIM_TOKEN = /^[0-9A-Za-z_-]{16,64}$/

const MINT_LOCK_ID = /^[0-9a-f]{64}$/

function mintLockPrefixes(workflowId: unknown, rawIds: unknown): Map<string, string> {
	if (typeof workflowId !== 'string' || !workflowId || !Array.isArray(rawIds)) {
		throw new Error('Invalid mint prefix reservation')
	}
	const ids = [...new Set(rawIds)]
	if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || !MINT_LOCK_ID.test(id))) {
		throw new Error('Invalid mint prefix reservation')
	}
	const prefixes = new Map<string, string>()
	for (const id of ids as string[]) {
		const prefix = id.slice(0, 12)
		if (prefixes.has(prefix)) throw new Error('Invalid mint prefix reservation')
		prefixes.set(prefix, id)
	}
	return prefixes
}

interface ReservationRow extends Record<string, SqlStorageValue> {
	reservation_id: string
	day_key: string
	provider: string
	initial_provider: string
	status: string
	claim_count: number
	admitted: number
	generation: number
	superseded_day_key: string | null
	created_at_ms: number
	updated_at_ms: number
	fallback_from: string | null
	reason: string | null
}

const BURST_WINDOW_MS = 60_000
const RETENTION_DAYS = 14
const MAX_RETENTION_MS = 30 * 86_400_000
const ALARM_RETENTION_DELAY_MS = (RETENTION_DAYS + 1) * 86_400_000
const PENDING_RELEASE_INITIAL_DELAY_MS = 1_000
const PENDING_RELEASE_MAX_DELAY_MS = 60_000
const PENDING_RELEASE_MAX_AGE_MS = 7 * 86_400_000

export function getUtcDayKey(nowMs: number = Date.now()): string {
	return new Date(nowMs).toISOString().slice(0, 10)
}

export function getUtcDayResetAt(dayKey: string): string {
	const [year, month, day] = dayKey.split('-').map(Number)
	return new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0)).toISOString()
}

function parseSupersededDayKeys(raw: string | null | undefined, excludeDayKey?: string): string[] {
	if (!raw) {
		return []
	}
	const trimmed = raw.trim()
	if (!trimmed) {
		return []
	}
	let candidates: string[]
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed)
			candidates = Array.isArray(parsed)
				? parsed.filter((v): v is string => typeof v === 'string')
				: []
		} catch {
			candidates = []
		}
	} else {
		candidates = [trimmed]
	}

	const unique = new Set<string>()
	for (const entry of candidates) {
		const normalized = entry.trim()
		if (normalized && normalized !== excludeDayKey) {
			unique.add(normalized)
		}
	}
	return Array.from(unique).sort()
}

function serializeSupersededDayKeys(days: string[]): string | null {
	const unique = Array.from(new Set(days.map((d) => d.trim()).filter(Boolean))).sort()
	if (unique.length === 0) {
		return null
	}
	return JSON.stringify(unique)
}

function toRecord(row: ReservationRow): QuotaReservationRecord {
	const supersededDayKeys = parseSupersededDayKeys(row.superseded_day_key, row.day_key)
	return {
		reservationId: row.reservation_id,
		dayKey: row.day_key,
		provider: row.provider as QuotaProvider,
		initialProvider: row.initial_provider as QuotaProvider,
		status: row.status as QuotaReservationStatus,
		claimCount: Number(row.claim_count ?? 1),
		admitted: Number(row.admitted ?? 0) === 1,
		generation: Number(row.generation ?? 1),
		supersededDayKey: supersededDayKeys[0] ?? null,
		supersededDayKeys,
		createdAtMs: Number(row.created_at_ms),
		updatedAtMs: Number(row.updated_at_ms),
		fallbackFrom: row.fallback_from ? (row.fallback_from as QuotaProvider) : null,
		reason: row.reason ?? null,
	}
}

function normalizeLimit(value: number): number {
	if (!Number.isFinite(value)) {
		return 0
	}
	return Math.max(0, Math.floor(value))
}

function limitForProvider(limits: QuotaLimits, provider: QuotaProvider): number {
	return normalizeLimit(provider === 'elevenlabs' ? limits.elevenlabs : limits.classic)
}

/**
 * SQLite-backed Durable Object for:
 * - Per-user generation quotas (`user:<address>`)
 * - Daily global soft circuit-breaker buckets (`global:YYYY-MM-DD`)
 * - Sharded per-caller atomic play beacon dedupe & rate admission (`play-gate:<00..63>`)
 *
 * Accounting invariants:
 * - Rows in status `'reserved' | 'committed' | 'ambiguous'` count against daily and burst limits.
 * - Rows in status `'refunded'` do not count against limits and can NEVER be revived by `commit()`.
 * - `commit()` strictly enforces provider equality and non-refunded status preconditions.
 * - `refund()` ONLY transitions `'reserved' -> 'refunded'` (never `'committed'` or `'ambiguous'`,
 *   and refuses shared reservations when `onlyIfUnshared: true`).
 * - `transitionFallback()` atomically enforces the target provider's cap and is used ONLY for
 *   confirmed pre-charge rejections; already-accepted/billed attempts remain retained on their
 *   original UTC day while fallback reserves ElevenLabs independently.
 * - Scheduled `alarm()` automatically prunes expired rows in inactive daily global buckets and shards.
 */
export class UserQuotaDO extends DurableObject<Env> {
	private sql: SqlStorage

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.sql = ctx.storage.sql
		if (typeof ctx.blockConcurrencyWhile === 'function') {
			void ctx.blockConcurrencyWhile(async () => {
				this.migrate()
			})
		} else {
			this.migrate()
		}
	}

	private migrate(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
				id INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`)

		const current = this.sql
			.exec<{ version: number }>(`SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations`)
			.one()

		let version = Number(current.version)

		if (version < 1) {
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(`
					CREATE TABLE IF NOT EXISTS quota_reservations (
						reservation_id TEXT PRIMARY KEY,
						day_key TEXT NOT NULL,
						provider TEXT NOT NULL CHECK(provider IN ('aisonggenerator', 'elevenlabs')),
						initial_provider TEXT NOT NULL CHECK(initial_provider IN ('aisonggenerator', 'elevenlabs')),
						status TEXT NOT NULL CHECK(status IN ('reserved', 'committed', 'ambiguous', 'refunded')),
						claim_count INTEGER NOT NULL DEFAULT 1,
						admitted INTEGER NOT NULL DEFAULT 0,
						generation INTEGER NOT NULL DEFAULT 1,
						superseded_day_key TEXT,
						created_at_ms INTEGER NOT NULL,
						updated_at_ms INTEGER NOT NULL,
						fallback_from TEXT CHECK(fallback_from IS NULL OR fallback_from IN ('aisonggenerator', 'elevenlabs')),
						reason TEXT
					)
				`)
				this.sql.exec(`
					CREATE INDEX IF NOT EXISTS idx_quota_res_day_provider_status
					ON quota_reservations (day_key, provider, status)
				`)
				this.sql.exec(`
					CREATE INDEX IF NOT EXISTS idx_quota_res_created
					ON quota_reservations (created_at_ms)
				`)
				this.sql.exec(`INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1)`)
			})
			version = 1
		}

		if (version < 2) {
			this.ctx.storage.transactionSync(() => {
				const cols = this.sql.exec<{ name: string }>(`PRAGMA table_info('quota_reservations')`).toArray()
				if (!cols.some((col) => col.name === 'claim_count')) {
					this.sql.exec(`ALTER TABLE quota_reservations ADD COLUMN claim_count INTEGER NOT NULL DEFAULT 1`)
				}
				this.sql.exec(`
					CREATE TABLE IF NOT EXISTS play_beacon_dedupe (
						dedupe_key TEXT PRIMARY KEY,
						expires_at_ms INTEGER NOT NULL
					)
				`)
				this.sql.exec(`
					CREATE INDEX IF NOT EXISTS idx_play_beacon_dedupe_exp
					ON play_beacon_dedupe (expires_at_ms)
				`)
				this.sql.exec(`
					CREATE TABLE IF NOT EXISTS play_beacon_rate (
						bucket_key TEXT PRIMARY KEY,
						count INTEGER NOT NULL,
						expires_at_ms INTEGER NOT NULL
					)
				`)
				this.sql.exec(`
					CREATE INDEX IF NOT EXISTS idx_play_beacon_rate_exp
					ON play_beacon_rate (expires_at_ms)
				`)
				this.sql.exec(`INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (2)`)
			})
			version = 2
		}

		if (version < 3) {
			this.ctx.storage.transactionSync(() => {
				// Incremental migration for persisted v1/v2 DO SQLite databases lacking admitted/generation
				const cols = this.sql.exec<{ name: string }>(`PRAGMA table_info('quota_reservations')`).toArray()
				if (!cols.some((col) => col.name === 'claim_count')) {
					this.sql.exec(`ALTER TABLE quota_reservations ADD COLUMN claim_count INTEGER NOT NULL DEFAULT 1`)
				}
				if (!cols.some((col) => col.name === 'admitted')) {
					this.sql.exec(`ALTER TABLE quota_reservations ADD COLUMN admitted INTEGER NOT NULL DEFAULT 0`)
					this.sql.exec(
						`UPDATE quota_reservations SET admitted = 1 WHERE status IN ('committed', 'ambiguous')`
					)
				}
				if (!cols.some((col) => col.name === 'generation')) {
					this.sql.exec(`ALTER TABLE quota_reservations ADD COLUMN generation INTEGER NOT NULL DEFAULT 1`)
				}
				this.sql.exec(`INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (3)`)
			})
			version = 3
		}

		if (version < 4) {
			this.ctx.storage.transactionSync(() => {
				// Incremental migration for persisted v2/v3 DO SQLite databases lacking superseded_day_key
				const cols = this.sql.exec<{ name: string }>(`PRAGMA table_info('quota_reservations')`).toArray()
				if (!cols.some((col) => col.name === 'superseded_day_key')) {
					this.sql.exec(`ALTER TABLE quota_reservations ADD COLUMN superseded_day_key TEXT`)
				}
				this.sql.exec(`INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (4)`)
			})
			version = 4
		}

		if (version < 5) {
			this.ctx.storage.transactionSync(() => {
				// Per-caller idempotent claim ledger + durable deferred user-release outbox
				this.sql.exec(`
					CREATE TABLE IF NOT EXISTS quota_reservation_claims (
						reservation_id TEXT NOT NULL,
						generation INTEGER NOT NULL,
						claim_id TEXT NOT NULL,
						state TEXT NOT NULL CHECK(state IN ('pending', 'admitted', 'released')),
						updated_at_ms INTEGER NOT NULL,
						PRIMARY KEY (reservation_id, generation, claim_id)
					)
				`)
				this.sql.exec(`
					CREATE INDEX IF NOT EXISTS idx_quota_claims_res_gen_state
					ON quota_reservation_claims (reservation_id, generation, state)
				`)
				this.sql.exec(`
					CREATE TABLE IF NOT EXISTS pending_user_releases (
						id TEXT PRIMARY KEY,
						user_key TEXT NOT NULL,
						reservation_id TEXT NOT NULL,
						generation INTEGER NOT NULL,
						day_key TEXT NOT NULL,
						claim_id TEXT NOT NULL,
						rollback_unshared_admitted INTEGER NOT NULL DEFAULT 0,
						reason TEXT,
						created_at_ms INTEGER NOT NULL,
						attempts INTEGER NOT NULL DEFAULT 0,
						next_retry_at_ms INTEGER NOT NULL DEFAULT 0
					)
				`)
				this.sql.exec(`
					CREATE INDEX IF NOT EXISTS idx_pending_user_releases_created
					ON pending_user_releases (created_at_ms)
				`)
				this.sql.exec(`INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (5)`)
			})
			version = 5
		}

		if (version < 6) {
			this.ctx.storage.transactionSync(() => {
				// Incremental migration for persisted v2..v5 DO SQLite databases lacking per-row retry backoff
				const cols = this.sql.exec<{ name: string }>(`PRAGMA table_info('pending_user_releases')`).toArray()
				if (!cols.some((col) => col.name === 'next_retry_at_ms')) {
					this.sql.exec(`ALTER TABLE pending_user_releases ADD COLUMN next_retry_at_ms INTEGER NOT NULL DEFAULT 0`)
				}
				this.sql.exec(`
					CREATE INDEX IF NOT EXISTS idx_pending_user_releases_due
					ON pending_user_releases (next_retry_at_ms, attempts, created_at_ms)
				`)
				this.sql.exec(`INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (6)`)
			})
			version = 6
		}

		if (version < 7) {
			this.ctx.storage.transactionSync(() => {
				// Mint asset-code prefix locks. Only the singleton `mint-prefix-locks` object writes rows;
				// every other quota object just carries the empty table.
				// One row per prefix; the prefix is the smol id's first 12 hex, so one row per smol id too.
				// No deployed object has ever run v7 (WF-0 ships it), so its definition is final here. The
				// CHECKs pin the lifecycle invariants: a provisional row carries its admission token; any
				// row past `reserved` was claimed for signing; a dispatched or ambiguous row records when
				// dispatch started; `failed` is only ever a once-signed row (a never-signed provisional
				// row is deleted instead, so it can never block another smol sharing the prefix); and only
				// a provisional row records that an identical-carrier admission joined it. `lease_version` is
				// a per-row generation bumped whenever a creation lease is granted or renewed, so lease-expiry
				// recovery can only release the exact lease it observed.
				this.sql.exec(`
					CREATE TABLE IF NOT EXISTS mint_prefix_locks (
						prefix TEXT PRIMARY KEY CHECK(length(prefix) = 12),
						smol_id TEXT NOT NULL UNIQUE CHECK(length(smol_id) = 64 AND substr(smol_id, 1, 12) = prefix),
						workflow_id TEXT NOT NULL CHECK(length(workflow_id) > 0),
						status TEXT NOT NULL
							CHECK(status IN ('reserved', 'signing', 'dispatched', 'ambiguous', 'failed', 'minted')),
						claim_token TEXT,
						lease_until_ms INTEGER,
						lease_version INTEGER NOT NULL DEFAULT 0 CHECK(lease_version >= 0),
						reserved_at_ms INTEGER NOT NULL,
						signed_at_ms INTEGER,
						dispatched_at_ms INTEGER,
						joined_at_ms INTEGER,
						updated_at_ms INTEGER NOT NULL,
						CHECK(status <> 'reserved' OR claim_token IS NOT NULL),
						CHECK(status = 'reserved' OR joined_at_ms IS NULL),
						CHECK(status = 'reserved' OR signed_at_ms IS NOT NULL),
						CHECK(status NOT IN ('dispatched', 'ambiguous') OR dispatched_at_ms IS NOT NULL)
					)
				`)
				this.sql.exec(`INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (7)`)
			})
			version = 7
		}
	}

	private async scheduleCleanupAlarm(targetMs: number): Promise<void> {
		if (typeof this.ctx.storage.getAlarm !== 'function' || typeof this.ctx.storage.setAlarm !== 'function') {
			return
		}
		try {
			const existing = await this.ctx.storage.getAlarm()
			if (existing === null || existing > targetMs) {
				await this.ctx.storage.setAlarm(targetMs)
			}
		} catch {
			// Alarm scheduling is best-effort housekeeping
		}
	}

	private getReservationRow(reservationId: string): ReservationRow | null {
		const rows = this.sql
			.exec<ReservationRow>(
				`SELECT reservation_id, day_key, provider, initial_provider, status, claim_count, admitted, generation, superseded_day_key, created_at_ms, updated_at_ms, fallback_from, reason
				 FROM quota_reservations
				 WHERE reservation_id = ?`,
				reservationId
			)
			.toArray()
		return rows[0] ?? null
	}

	private getDailyUsageCounts(dayKey: string): { classic: number; elevenlabs: number } {
		const rows = this.sql
			.exec<{ provider: string; cnt: number }>(
				`SELECT provider, COUNT(*) AS cnt
				 FROM quota_reservations
				 WHERE day_key = ? AND status IN ('reserved', 'committed', 'ambiguous')
				 GROUP BY provider`,
				dayKey
			)
			.toArray()

		let classic = 0
		let elevenlabs = 0
		for (const row of rows) {
			if (row.provider === 'aisonggenerator') {
				classic = Number(row.cnt)
			} else if (row.provider === 'elevenlabs') {
				elevenlabs = Number(row.cnt)
			}
		}
		return { classic, elevenlabs }
	}

	private buildSnapshot(dayKey: string, limits: QuotaLimits): QuotaSnapshot {
		const counts = this.getDailyUsageCounts(dayKey)
		const classicLimit = normalizeLimit(limits.classic)
		const elevenLabsLimit = normalizeLimit(limits.elevenlabs)
		const resetAt = getUtcDayResetAt(dayKey)

		return {
			classic: {
				limit: classicLimit,
				used: counts.classic,
				remaining: Math.max(0, classicLimit - counts.classic),
				resetAt,
			},
			elevenlabs: {
				limit: elevenLabsLimit,
				used: counts.elevenlabs,
				remaining: Math.max(0, elevenLabsLimit - counts.elevenlabs),
				resetAt,
			},
		}
	}

	private pruneOldRows(nowMs: number): void {
		const cutoffDayKey = getUtcDayKey(nowMs - RETENTION_DAYS * 86_400_000)
		const hardCutoffMs = nowMs - MAX_RETENTION_MS
		this.sql.exec(
			`DELETE FROM quota_reservations
			 WHERE (day_key < ? AND status IN ('committed', 'refunded'))
			    OR created_at_ms < ?`,
			cutoffDayKey,
			hardCutoffMs
		)
		this.sql.exec(
			`DELETE FROM quota_reservation_claims
			 WHERE reservation_id NOT IN (SELECT reservation_id FROM quota_reservations)`
		)
		this.sql.exec(
			`DELETE FROM pending_user_releases WHERE created_at_ms < ?`,
			nowMs - PENDING_RELEASE_MAX_AGE_MS
		)
		this.sql.exec(`DELETE FROM play_beacon_dedupe WHERE expires_at_ms <= ?`, nowMs)
		this.sql.exec(`DELETE FROM play_beacon_rate WHERE expires_at_ms <= ?`, nowMs)
	}

	private insertPendingUserReleaseTx(job: PendingUserReleaseInput, nowMs: number): boolean {
		const userKey = job.userKey?.trim()
		const reservationId = job.reservationId?.trim()
		const dayKey = job.dayKey?.trim() ?? ''
		const claimId = job.claimId?.trim()
		// generation === 0 is permitted for lost reserve() replies where generation is resolved by unique claimId
		if (!userKey || !reservationId || !claimId || !Number.isInteger(job.generation) || job.generation < 0) {
			return false
		}
		if (job.generation > 0 && !dayKey) {
			return false
		}
		const id = `${userKey}:${reservationId}:${job.generation}:${claimId}`
		const createdAtMs = job.nowMs ?? nowMs
		this.sql.exec(
			`INSERT INTO pending_user_releases (
				id, user_key, reservation_id, generation, day_key, claim_id,
				rollback_unshared_admitted, reason, created_at_ms, attempts, next_retry_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
			ON CONFLICT(id) DO UPDATE SET
				rollback_unshared_admitted = MAX(rollback_unshared_admitted, excluded.rollback_unshared_admitted),
				reason = COALESCE(excluded.reason, reason),
				next_retry_at_ms = MIN(next_retry_at_ms, excluded.next_retry_at_ms)`,
			id,
			userKey,
			reservationId,
			job.generation,
			dayKey,
			claimId,
			job.rollbackUnsharedAdmitted ? 1 : 0,
			job.reason ?? null,
			createdAtMs
		)
		return true
	}

	private hasPendingUserReleases(nowMs: number): boolean {
		return this.sql
			.exec<{ one: number }>(
				`SELECT 1 AS one FROM pending_user_releases WHERE next_retry_at_ms <= ? LIMIT 1`,
				nowMs
			)
			.toArray().length > 0
	}

	async getPendingUserReleaseCount(): Promise<number> {
		return Number(
			this.sql.exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM pending_user_releases`).one().cnt
		)
	}

	async enqueuePendingUserRelease(job: PendingUserReleaseInput): Promise<boolean> {
		const nowMs = job.nowMs ?? Date.now()
		const enqueued = this.ctx.storage.transactionSync(() => this.insertPendingUserReleaseTx(job, nowMs))
		if (enqueued) {
			await this.scheduleCleanupAlarm(nowMs + PENDING_RELEASE_INITIAL_DELAY_MS)
		}
		return enqueued
	}

	/**
	 * Drain durable deferred release outbox entries (for either `user:<address>` or `global:<dayKey>`)
	 * by selecting due rows fairly (`next_retry_at_ms <= nowMs` ordered by due time, attempts, age),
	 * replaying idempotent `releaseClaim(..., { claimId })` against a fresh stub, and backing off
	 * failed rows individually so unreachable targets never starve healthy ones.
	 */
	async drainPendingUserReleases(nowMs: number = Date.now()): Promise<PendingReleaseDrainResult> {
		const rows = this.sql
			.exec<{
				id: string
				user_key: string
				reservation_id: string
				generation: number
				day_key: string
				claim_id: string
				rollback_unshared_admitted: number
				reason: string | null
				attempts: number
			}>(
				`SELECT id, user_key, reservation_id, generation, day_key, claim_id,
				        rollback_unshared_admitted, reason, attempts
				 FROM pending_user_releases
				 WHERE next_retry_at_ms <= ?
				 ORDER BY next_retry_at_ms ASC, attempts ASC, created_at_ms ASC
				 LIMIT 50`,
				nowMs
			)
			.toArray()

		const quotaBinding = this.env?.USER_QUOTA
		if (!quotaBinding) {
			const totalRemaining = this.sql
				.exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM pending_user_releases`)
				.one().cnt
			return {
				drained: 0,
				remaining: Number(totalRemaining ?? 0),
				nextDelayMs: Number(totalRemaining ?? 0) > 0 ? PENDING_RELEASE_INITIAL_DELAY_MS : 0,
			}
		}

		let drained = 0

		for (const row of rows) {
			try {
				const targetGeneration = Number(row.generation) > 0 ? Number(row.generation) : null
				const targetDayKey = row.day_key?.trim() || null
				const targetId = quotaBinding.idFromName(row.user_key)
				const isSelf = Boolean(
					this.ctx.id
					&& (
						(typeof targetId.equals === 'function' && targetId.equals(this.ctx.id))
						|| (typeof this.ctx.id.equals === 'function' && this.ctx.id.equals(targetId))
						|| String(targetId) === String(this.ctx.id)
					)
				)
				if (isSelf) {
					await this.releaseClaim(
						row.reservation_id,
						targetGeneration,
						targetDayKey,
						row.reason ?? 'deferred_user_release',
						nowMs,
						{
							claimId: row.claim_id,
							rollbackUnsharedAdmitted: Number(row.rollback_unshared_admitted) === 1,
						}
					)
				} else {
					const freshTargetStub = quotaBinding.get(targetId)
					await freshTargetStub.releaseClaim(
						row.reservation_id,
						targetGeneration,
						targetDayKey,
						row.reason ?? 'deferred_user_release',
						nowMs,
						{
							claimId: row.claim_id,
							rollbackUnsharedAdmitted: Number(row.rollback_unshared_admitted) === 1,
						}
					)
				}
				this.ctx.storage.transactionSync(() => {
					this.sql.exec(`DELETE FROM pending_user_releases WHERE id = ?`, row.id)
				})
				drained++
			} catch {
				const nextAttempts = Number(row.attempts ?? 0) + 1
				const backoffMs = Math.min(
					PENDING_RELEASE_MAX_DELAY_MS,
					PENDING_RELEASE_INITIAL_DELAY_MS * Math.pow(2, Math.min(6, nextAttempts - 1))
				)
				const nextRetryAtMs = nowMs + backoffMs
				this.ctx.storage.transactionSync(() => {
					this.sql.exec(
						`UPDATE pending_user_releases
						 SET attempts = ?,
						     next_retry_at_ms = ?
						 WHERE id = ?`,
						nextAttempts,
						nextRetryAtMs,
						row.id
					)
				})
			}
		}

		const remainingStats = this.sql
			.exec<{ cnt: number; earliest_retry: number | null }>(
				`SELECT COUNT(*) AS cnt, MIN(next_retry_at_ms) AS earliest_retry
				 FROM pending_user_releases`
			)
			.one()
		const remaining = Number(remainingStats.cnt ?? 0)
		const earliestRetry = remainingStats.earliest_retry !== null ? Number(remainingStats.earliest_retry) : null
		const nextDelayMs = remaining > 0
			? Math.max(
				PENDING_RELEASE_INITIAL_DELAY_MS,
				earliestRetry !== null ? Math.max(0, earliestRetry - nowMs + 50) : PENDING_RELEASE_INITIAL_DELAY_MS
			)
			: 0
		if (remaining > 0) {
			await this.scheduleCleanupAlarm(nowMs + nextDelayMs)
		}
		return { drained, remaining, nextDelayMs }
	}

	async alarm(): Promise<void> {
		const nowMs = Date.now()
		const drainResult = await this.drainPendingUserReleases(nowMs)

		const nextTarget = this.ctx.storage.transactionSync((): number | null => {
			this.pruneOldRows(nowMs)

			const resCount = Number(
				this.sql.exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM quota_reservations`).one().cnt
			)
			const playExpRow = this.sql
				.exec<{ next_exp: number | null }>(
					`SELECT MIN(exp) AS next_exp FROM (
						SELECT MIN(expires_at_ms) AS exp FROM play_beacon_dedupe
						UNION ALL
						SELECT MIN(expires_at_ms) AS exp FROM play_beacon_rate
					)`
				)
				.one()

			const nextPlayExp = playExpRow.next_exp !== null ? Number(playExpRow.next_exp) + 5_000 : null
			const nextResSweep = resCount > 0 ? nowMs + ALARM_RETENTION_DELAY_MS : null

			if (nextPlayExp !== null && nextResSweep !== null) {
				return Math.min(nextPlayExp, nextResSweep)
			}
			return nextPlayExp ?? nextResSweep
		})

		const pendingTarget = drainResult.remaining > 0 ? nowMs + drainResult.nextDelayMs : null
		const finalTarget = pendingTarget !== null && nextTarget !== null
			? Math.min(pendingTarget, nextTarget)
			: pendingTarget ?? nextTarget

		if (finalTarget !== null && typeof this.ctx.storage.setAlarm === 'function') {
			const minDelay = pendingTarget !== null ? PENDING_RELEASE_INITIAL_DELAY_MS : 5_000
			await this.ctx.storage.setAlarm(Math.max(nowMs + minDelay, finalTarget))
		}
	}

	async getQuota(limits: QuotaLimits, nowMs: number = Date.now()): Promise<QuotaSnapshot> {
		if (this.hasPendingUserReleases(nowMs)) {
			await this.drainPendingUserReleases(nowMs).catch(() => {})
		}
		const dayKey = getUtcDayKey(nowMs)
		return this.buildSnapshot(dayKey, limits)
	}

	async getReservation(reservationId: string): Promise<QuotaReservationRecord | null> {
		const row = this.getReservationRow(reservationId)
		return row ? toRecord(row) : null
	}

	private recordClaimTx(
		reservationId: string,
		generation: number,
		claimId: string,
		existingClaimCount: number,
		existingAdmitted: boolean,
		nowMs: number
	): number {
		// Backfill synthetic legacy claim rows if upgrading an in-flight pre-v5 reservation
		const existingRows = Number(
			this.sql
				.exec<{ cnt: number }>(
					`SELECT COUNT(*) AS cnt FROM quota_reservation_claims WHERE reservation_id = ? AND generation = ?`,
					reservationId,
					generation
				)
				.one().cnt
		)
		if (existingRows === 0 && existingClaimCount > 0) {
			const legacyState = existingAdmitted ? 'admitted' : 'pending'
			for (let i = 0; i < existingClaimCount; i++) {
				this.sql.exec(
					`INSERT OR IGNORE INTO quota_reservation_claims (
						reservation_id, generation, claim_id, state, updated_at_ms
					) VALUES (?, ?, ?, ?, ?)`,
					reservationId,
					generation,
					`legacy:${reservationId}:${generation}:${i}`,
					legacyState,
					nowMs
				)
			}
		}

		this.sql.exec(
			`INSERT INTO quota_reservation_claims (
				reservation_id, generation, claim_id, state, updated_at_ms
			) VALUES (?, ?, ?, 'pending', ?)
			ON CONFLICT(reservation_id, generation, claim_id) DO NOTHING`,
			reservationId,
			generation,
			claimId,
			nowMs
		)

		return Number(
			this.sql
				.exec<{ cnt: number }>(
					`SELECT COUNT(*) AS cnt
					 FROM quota_reservation_claims
					 WHERE reservation_id = ? AND generation = ? AND state != 'released'`,
					reservationId,
					generation
				)
				.one().cnt
		)
	}

	async reserve(
		reservationId: string,
		provider: QuotaProvider,
		limits: QuotaLimits,
		nowMs: number = Date.now(),
		bucketDayKey?: string,
		claimId?: string
	): Promise<QuotaReserveResult> {
		const id = reservationId.trim()
		if (!id) {
			throw new Error('reservationId must be a non-empty string')
		}
		const effectiveClaimId = claimId?.trim() || crypto.randomUUID()

		if (this.hasPendingUserReleases(nowMs)) {
			await this.drainPendingUserReleases(nowMs).catch(() => {})
		}

		const result = this.ctx.storage.transactionSync((): QuotaReserveResult => {
			// When a caller passes `bucketDayKey` (e.g. global:YYYY-MM-DD), enforce and store
			// against that EXACT day key so the DO object name and SQL day_key can never diverge.
			const dayKey = bucketDayKey?.trim() || getUtcDayKey(nowMs)
			const existing = this.getReservationRow(id)

			// Forward-only UTC day guard: NEVER allow a delayed prior-day reserve RPC (YYYY-MM-DD < existing.day_key)
			// to displace, roll backward, or mutate a newer day's reservation row!
			if (existing && dayKey < existing.day_key) {
				const record = toRecord(existing)
				return {
					ok: false,
					code: 'stale_day',
					existingDayKey: record.dayKey,
					requestedDayKey: dayKey,
					reservation: record,
					quota: this.buildSnapshot(record.dayKey, limits),
				}
			}

			if (existing && existing.status !== 'refunded') {
				const record = toRecord(existing)
				if (record.provider !== provider) {
					return {
						ok: false,
						code: 'reservation_conflict',
						existingProvider: record.provider,
						reservation: record,
						quota: this.buildSnapshot(dayKey, limits),
					}
				}

				// Forward-only rollover: if an unadmitted stale reservation from an EARLIER UTC day
				// (strict ISO dayKey > record.dayKey) is recovered today, roll it forward cleanly to
				// today's UTC day (subject to today's burst & daily limits) and DURABLY persist
				// `superseded_day_key` until global cleanup is acknowledged via `clearSupersededDay()`.
				if (record.status === 'reserved' && !record.admitted && dayKey > record.dayKey) {
					const burstLimit = normalizeLimit(limits.burstPerMinute ?? 0)
					if (burstLimit > 0) {
						const windowStart = nowMs - BURST_WINDOW_MS
						const burstRow = this.sql
							.exec<{ cnt: number; oldest: number | null }>(
								`SELECT COUNT(*) AS cnt, MIN(created_at_ms) AS oldest
								 FROM quota_reservations
								 WHERE created_at_ms >= ? AND status IN ('reserved', 'committed', 'ambiguous')`,
								windowStart
							)
							.one()
						const burstUsed = Number(burstRow.cnt)
						if (burstUsed >= burstLimit) {
							const oldestMs = burstRow.oldest !== null ? Number(burstRow.oldest) : nowMs
							const burstResetAt = new Date(oldestMs + BURST_WINDOW_MS).toISOString()
							return {
								ok: false,
								code: 'quota_exceeded',
								reason: 'burst_limit',
								provider,
								limit: burstLimit,
								used: burstUsed,
								remaining: 0,
								resetAt: burstResetAt,
								quota: this.buildSnapshot(dayKey, limits),
							}
						}
					}

					const counts = this.getDailyUsageCounts(dayKey)
					const used = provider === 'elevenlabs' ? counts.elevenlabs : counts.classic
					const limit = limitForProvider(limits, provider)
					if (used >= limit) {
						return {
							ok: false,
							code: 'quota_exceeded',
							reason: 'daily_limit',
							provider,
							limit,
							used,
							remaining: 0,
							resetAt: getUtcDayResetAt(dayKey),
							quota: this.buildSnapshot(dayKey, limits),
						}
					}

					const nextSupersededDays = parseSupersededDayKeys(existing.superseded_day_key, dayKey)
					if (!nextSupersededDays.includes(record.dayKey)) {
						nextSupersededDays.push(record.dayKey)
						nextSupersededDays.sort()
					}
					const serializedSuperseded = serializeSupersededDayKeys(nextSupersededDays)
					const nextGeneration = record.generation + 1
					this.sql.exec(
						`UPDATE quota_reservations
						 SET day_key = ?,
						     claim_count = 1,
						     admitted = 0,
						     generation = ?,
						     superseded_day_key = ?,
						     created_at_ms = ?,
						     updated_at_ms = ?
						 WHERE reservation_id = ? AND status = 'reserved' AND admitted = 0`,
						dayKey,
						nextGeneration,
						serializedSuperseded,
						nowMs,
						nowMs,
						id
					)
					this.recordClaimTx(id, nextGeneration, effectiveClaimId, 0, false, nowMs)
					const rolled = toRecord(this.getReservationRow(id)!)
					return {
						ok: true,
						idempotent: false,
						shared: false,
						claimCount: 1,
						admitted: false,
						generation: rolled.generation,
						dayKey: rolled.dayKey,
						claimId: effectiveClaimId,
						...(rolled.supersededDayKey ? { supersededDayKey: rolled.supersededDayKey } : {}),
						supersededDayKeys: rolled.supersededDayKeys,
						reservation: rolled,
						quota: this.buildSnapshot(dayKey, limits),
					}
				}

				// Record per-caller claim idempotently so replaying reserve or release never corrupts another caller's claim
				if (existing.status === 'reserved') {
					const activeClaims = this.recordClaimTx(
						id,
						record.generation,
						effectiveClaimId,
						record.claimCount,
						record.admitted,
						nowMs
					)
					this.sql.exec(
						`UPDATE quota_reservations
						 SET claim_count = ?,
						     updated_at_ms = ?
						 WHERE reservation_id = ? AND status = 'reserved'`,
						Math.max(1, activeClaims),
						nowMs,
						id
					)
				}
				const updated = this.getReservationRow(id)!
				const updatedRecord = toRecord(updated)
				return {
					ok: true,
					idempotent: true,
					shared: true,
					claimCount: updatedRecord.claimCount,
					admitted: updatedRecord.admitted,
					generation: updatedRecord.generation,
					dayKey: updatedRecord.dayKey,
					claimId: effectiveClaimId,
					...(updatedRecord.supersededDayKey ? { supersededDayKey: updatedRecord.supersededDayKey } : {}),
					supersededDayKeys: updatedRecord.supersededDayKeys,
					reservation: updatedRecord,
					quota: this.buildSnapshot(dayKey, limits),
				}
			}

			// Optional per-minute burst guard
			const burstLimit = normalizeLimit(limits.burstPerMinute ?? 0)
			if (burstLimit > 0) {
				const windowStart = nowMs - BURST_WINDOW_MS
				const burstRow = this.sql
					.exec<{ cnt: number; oldest: number | null }>(
						`SELECT COUNT(*) AS cnt, MIN(created_at_ms) AS oldest
						 FROM quota_reservations
						 WHERE created_at_ms >= ? AND status IN ('reserved', 'committed', 'ambiguous')`,
						windowStart
					)
					.one()
				const burstUsed = Number(burstRow.cnt)
				if (burstUsed >= burstLimit) {
					const oldestMs = burstRow.oldest !== null ? Number(burstRow.oldest) : nowMs
					const burstResetAt = new Date(oldestMs + BURST_WINDOW_MS).toISOString()
					return {
						ok: false,
						code: 'quota_exceeded',
						reason: 'burst_limit',
						provider,
						limit: burstLimit,
						used: burstUsed,
						remaining: 0,
						resetAt: burstResetAt,
						quota: this.buildSnapshot(dayKey, limits),
					}
				}
			}

			// Daily UTC-day limit check
			const counts = this.getDailyUsageCounts(dayKey)
			const used = provider === 'elevenlabs' ? counts.elevenlabs : counts.classic
			const limit = limitForProvider(limits, provider)
			if (used >= limit) {
				return {
					ok: false,
					code: 'quota_exceeded',
					reason: 'daily_limit',
					provider,
					limit,
					used,
					remaining: 0,
					resetAt: getUtcDayResetAt(dayKey),
					quota: this.buildSnapshot(dayKey, limits),
				}
			}

			let createdGeneration = 1
			if (existing && existing.status === 'refunded') {
				createdGeneration = Number(existing.generation ?? 1) + 1
				this.sql.exec(
					`UPDATE quota_reservations
					 SET day_key = ?,
					     provider = ?,
					     initial_provider = ?,
					     status = 'reserved',
					     claim_count = 1,
					     admitted = 0,
					     generation = ?,
					     created_at_ms = ?,
					     updated_at_ms = ?,
					     fallback_from = NULL,
					     reason = NULL
					 WHERE reservation_id = ? AND status = 'refunded'`,
					dayKey,
					provider,
					provider,
					createdGeneration,
					nowMs,
					nowMs,
					id
				)
			} else {
				this.sql.exec(
					`INSERT INTO quota_reservations (
						reservation_id, day_key, provider, initial_provider, status,
						claim_count, admitted, generation, created_at_ms, updated_at_ms, fallback_from, reason
					) VALUES (?, ?, ?, ?, 'reserved', 1, 0, 1, ?, ?, NULL, NULL)`,
					id,
					dayKey,
					provider,
					provider,
					nowMs,
					nowMs
				)
			}

			this.recordClaimTx(id, createdGeneration, effectiveClaimId, 0, false, nowMs)
			this.pruneOldRows(nowMs)

			const created = toRecord(this.getReservationRow(id)!)
			return {
				ok: true,
				idempotent: false,
				shared: false,
				claimCount: 1,
				admitted: false,
				generation: created.generation,
				dayKey: created.dayKey,
				claimId: effectiveClaimId,
				...(created.supersededDayKey ? { supersededDayKey: created.supersededDayKey } : {}),
				supersededDayKeys: created.supersededDayKeys,
				reservation: created,
				quota: this.buildSnapshot(dayKey, limits),
			}
		})

		if (result.ok) {
			await this.scheduleCleanupAlarm(nowMs + ALARM_RETENTION_DELAY_MS)
		}

		return result
	}

	/**
	 * Acknowledge that cleanup of `global:<supersededDayKey>` has completed, removing ONLY that
	 * acknowledged day from the durable superseded list while preserving any other unacknowledged days.
	 */
	async clearSupersededDay(
		reservationId: string,
		supersededDayKey: string,
		nowMs: number = Date.now()
	): Promise<boolean> {
		const id = reservationId.trim()
		const oldDayKey = supersededDayKey?.trim()
		if (!id || !oldDayKey) {
			return false
		}
		return this.ctx.storage.transactionSync((): boolean => {
			const existing = this.getReservationRow(id)
			if (!existing || !existing.superseded_day_key) {
				return false
			}
			const currentDays = parseSupersededDayKeys(existing.superseded_day_key)
			if (!currentDays.includes(oldDayKey)) {
				return false
			}
			const remainingDays = currentDays.filter((d) => d !== oldDayKey)
			const nextSerialized = serializeSupersededDayKeys(remainingDays)
			this.sql.exec(
				`UPDATE quota_reservations
				 SET superseded_day_key = ?,
				     updated_at_ms = ?
				 WHERE reservation_id = ?`,
				nextSerialized,
				nowMs,
				id
			)
			return true
		})
	}

	/**
	 * Persist admission confirmation strictly bound to `(expectedGeneration, expectedDayKey)`
	 * and (when provided) the caller's unique `claimId`.
	 * Returns `false` if the row was refunded, missing, superseded, or if this `claimId` was already released.
	 */
	async confirmAdmission(
		reservationId: string,
		expectedGeneration: number,
		expectedDayKey: string,
		nowMs: number = Date.now(),
		claimId?: string
	): Promise<boolean> {
		const id = reservationId.trim()
		const dayKey = expectedDayKey?.trim()
		const cid = claimId?.trim() || undefined
		if (!id || !dayKey || !Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
			return false
		}
		return this.ctx.storage.transactionSync((): boolean => {
			const existing = this.getReservationRow(id)
			if (!existing || existing.status === 'refunded') {
				return false
			}
			if (Number(existing.generation ?? 1) !== expectedGeneration || existing.day_key !== dayKey) {
				return false
			}
			// Already-settled terminal paid states ('committed' | 'ambiguous'):
			// A replaying caller received an idempotent reserve() match without mutating quota_reservation_claims;
			// treat matching (generation, dayKey) settled reservations as already confirmed while preserving their
			// terminal paid state on both ledgers.
			if (existing.status === 'committed' || existing.status === 'ambiguous') {
				return true
			}
			if (cid) {
				const claimRows = this.sql
					.exec<{ state: string }>(
						`SELECT state FROM quota_reservation_claims
						 WHERE reservation_id = ? AND generation = ? AND claim_id = ?`,
						id,
						expectedGeneration,
						cid
					)
					.toArray()
				if (claimRows.length > 0) {
					if (claimRows[0].state === 'released') {
						return false
					}
					if (claimRows[0].state !== 'admitted') {
						this.sql.exec(
							`UPDATE quota_reservation_claims
							 SET state = 'admitted', updated_at_ms = ?
							 WHERE reservation_id = ? AND generation = ? AND claim_id = ?`,
							nowMs,
							id,
							expectedGeneration,
							cid
						)
					}
				} else {
					const anyClaims = Number(
						this.sql
							.exec<{ cnt: number }>(
								`SELECT COUNT(*) AS cnt FROM quota_reservation_claims
								 WHERE reservation_id = ? AND generation = ?`,
								id,
								expectedGeneration
							)
							.one().cnt
					)
					if (anyClaims > 0) {
						return false
					}
					this.sql.exec(
						`INSERT INTO quota_reservation_claims (
							reservation_id, generation, claim_id, state, updated_at_ms
						) VALUES (?, ?, ?, 'admitted', ?)`,
						id,
						expectedGeneration,
						cid,
						nowMs
					)
				}
			}
			if (Number(existing.admitted ?? 0) === 1) {
				return true
			}
			this.sql.exec(
				`UPDATE quota_reservations
				 SET admitted = 1,
				     updated_at_ms = ?
				 WHERE reservation_id = ?
				   AND status != 'refunded'
				   AND generation = ?
				   AND day_key = ?`,
				nowMs,
				id,
				expectedGeneration,
				dayKey
			)
			return true
		})
	}

	/**
	 * Idempotently release a single caller's claim bound to `(expectedGeneration, expectedDayKey, claimId)`.
	 * - When `options?.claimId` is supplied, releasing the same `claimId` multiple times (e.g. after a lost RPC reply)
	 *   is a strict NO-OP in SQLite and can NEVER consume a concurrent winner's claim!
	 * - When `expectedGeneration` is `null` or `0` (because `reserve()` threw after writing and never returned its
	 *   generation), requires `options.claimId` and resolves `(generation, dayKey)` strictly from that exact caller's
	 *   `(reservation_id, claim_id)` row in `quota_reservation_claims`.
	 * - Optionally persists a `deferredUserRelease` outbox entry in the SAME SQLite transaction and schedules `alarm()`.
	 */
	async releaseClaim(
		reservationId: string,
		expectedGeneration: number | null,
		expectedDayKey: string | null,
		reason?: string,
		nowMs: number = Date.now(),
		options?: QuotaReleaseClaimOptions
	): Promise<QuotaReleaseClaimResult> {
		const id = reservationId.trim()
		const explicitDayKey = expectedDayKey?.trim() || null
		const cid = options?.claimId?.trim() || undefined
		const deferredJob = options?.deferredUserRelease
		const hasExplicitGen = expectedGeneration !== null && Number.isInteger(expectedGeneration) && expectedGeneration >= 1
		const resolveByClaimId = !hasExplicitGen && (expectedGeneration === null || expectedGeneration === 0) && Boolean(cid)

		if (!id || (!hasExplicitGen && !resolveByClaimId) || (hasExplicitGen && !explicitDayKey)) {
			if (deferredJob) {
				const enqueued = this.ctx.storage.transactionSync(() => this.insertPendingUserReleaseTx(deferredJob, nowMs))
				if (enqueued) {
					await this.scheduleCleanupAlarm(nowMs + PENDING_RELEASE_INITIAL_DELAY_MS)
				}
			}
			return { released: false, refunded: false, remainingClaims: 0 }
		}

		let enqueuedDeferred = false
		const result = this.ctx.storage.transactionSync((): QuotaReleaseClaimResult => {
			if (deferredJob) {
				enqueuedDeferred = this.insertPendingUserReleaseTx(deferredJob, nowMs)
			}

			const existing = this.getReservationRow(id)
			if (!existing) {
				return { released: false, refunded: false, remainingClaims: 0 }
			}
			const record = toRecord(existing)

			let resolvedGen: number
			let resolvedDayKey: string
			if (hasExplicitGen) {
				resolvedGen = expectedGeneration!
				resolvedDayKey = explicitDayKey!
			} else {
				const lookupRows = this.sql
					.exec<{ generation: number }>(
						`SELECT generation FROM quota_reservation_claims
						 WHERE reservation_id = ? AND claim_id = ?
						 ORDER BY generation DESC
						 LIMIT 1`,
						id,
						cid!
					)
					.toArray()
				if (lookupRows.length === 0) {
					return { released: false, refunded: false, remainingClaims: record.claimCount, reservation: record }
				}
				resolvedGen = Number(lookupRows[0].generation)
				resolvedDayKey = explicitDayKey ?? record.dayKey
			}

			if (record.generation !== resolvedGen || record.dayKey !== resolvedDayKey) {
				return { released: false, refunded: false, remainingClaims: record.claimCount, reservation: record }
			}
			if (record.status === 'refunded') {
				if (cid) {
					this.sql.exec(
						`UPDATE quota_reservation_claims
						 SET state = 'released', updated_at_ms = ?
						 WHERE reservation_id = ? AND generation = ? AND claim_id = ? AND state != 'released'`,
						nowMs,
						id,
						resolvedGen,
						cid
					)
				}
				return { released: true, refunded: true, remainingClaims: 0, reservation: record }
			}
			if (record.status !== 'reserved') {
				return { released: false, refunded: false, remainingClaims: record.claimCount, reservation: record }
			}

			if (cid) {
				const claimRows = this.sql
					.exec<{ state: string }>(
						`SELECT state FROM quota_reservation_claims
						 WHERE reservation_id = ? AND generation = ? AND claim_id = ?`,
						id,
						resolvedGen,
						cid
					)
					.toArray()

				if (claimRows.length === 0) {
					// Unknown claimId for this generation -> strict no-op
					return { released: false, refunded: false, remainingClaims: record.claimCount, reservation: record }
				}
				const claimState = claimRows[0].state
				if (claimState === 'released') {
					// Replayed release after a lost reply -> strict idempotent NO-OP (never touches concurrent winner!)
					return { released: true, refunded: false, remainingClaims: record.claimCount, reservation: record }
				}
				if (claimState === 'admitted' && !options?.rollbackUnsharedAdmitted) {
					return { released: false, refunded: false, remainingClaims: record.claimCount, reservation: record }
				}

				this.sql.exec(
					`UPDATE quota_reservation_claims
					 SET state = 'released', updated_at_ms = ?
					 WHERE reservation_id = ? AND generation = ? AND claim_id = ?`,
					nowMs,
					id,
					resolvedGen,
					cid
				)

				const activeSummary = this.sql
					.exec<{ total: number; admitted_cnt: number | null }>(
						`SELECT COUNT(*) AS total,
						        SUM(CASE WHEN state = 'admitted' THEN 1 ELSE 0 END) AS admitted_cnt
						 FROM quota_reservation_claims
						 WHERE reservation_id = ? AND generation = ? AND state != 'released'`,
						id,
						resolvedGen
					)
					.one()

				const remainingActive = Number(activeSummary.total ?? 0)
				const remainingAdmitted = Number(activeSummary.admitted_cnt ?? 0)

				if (remainingActive === 0) {
					const canRefund = !record.admitted || Boolean(options?.rollbackUnsharedAdmitted)
					if (canRefund) {
						this.sql.exec(
							`UPDATE quota_reservations
							 SET claim_count = 0,
							     admitted = 0,
							     status = 'refunded',
							     reason = COALESCE(?, reason),
							     updated_at_ms = ?
							 WHERE reservation_id = ?
							   AND status = 'reserved'
							   AND generation = ?
							   AND day_key = ?`,
							reason ?? null,
							nowMs,
							id,
							resolvedGen,
							resolvedDayKey
						)
						const updated = this.getReservationRow(id)!
						return {
							released: true,
							refunded: true,
							remainingClaims: 0,
							reservation: toRecord(updated),
						}
					}
				}

				const nextAdmitted = remainingAdmitted > 0
					? 1
					: (record.admitted && claimState !== 'admitted' ? 1 : 0)
				this.sql.exec(
					`UPDATE quota_reservations
					 SET claim_count = ?,
					     admitted = ?,
					     updated_at_ms = ?
					 WHERE reservation_id = ?
					   AND status = 'reserved'
					   AND generation = ?
					   AND day_key = ?`,
					Math.max(nextAdmitted ? 1 : 0, remainingActive),
					nextAdmitted,
					nowMs,
					id,
					resolvedGen,
					resolvedDayKey
				)
				const updated = this.getReservationRow(id)!
				const updatedRecord = toRecord(updated)
				return {
					released: true,
					refunded: false,
					remainingClaims: updatedRecord.claimCount,
					reservation: updatedRecord,
				}
			}

			// Fallback counter-based path for callers that do not supply a claimId
			const nextClaims = Math.max(0, record.claimCount - 1)
			const canRefundFinalClaim = nextClaims === 0 && (!record.admitted || Boolean(options?.rollbackUnsharedAdmitted))
			if (canRefundFinalClaim) {
				this.sql.exec(
					`UPDATE quota_reservations
					 SET claim_count = 0,
					     admitted = 0,
					     status = 'refunded',
					     reason = COALESCE(?, reason),
					     updated_at_ms = ?
					 WHERE reservation_id = ?
					   AND status = 'reserved'
					   AND generation = ?
					   AND day_key = ?`,
					reason ?? null,
					nowMs,
					id,
					resolvedGen,
					resolvedDayKey
				)
				const updated = this.getReservationRow(id)!
				return {
					released: true,
					refunded: true,
					remainingClaims: 0,
					reservation: toRecord(updated),
				}
			}

			this.sql.exec(
				`UPDATE quota_reservations
				 SET claim_count = ?,
				     updated_at_ms = ?
				 WHERE reservation_id = ?
				   AND status = 'reserved'
				   AND generation = ?
				   AND day_key = ?`,
				Math.max(record.admitted ? 1 : 0, nextClaims),
				nowMs,
				id,
				resolvedGen,
				resolvedDayKey
			)
			const updated = this.getReservationRow(id)!
			const updatedRecord = toRecord(updated)
			return {
				released: true,
				refunded: false,
				remainingClaims: updatedRecord.claimCount,
				reservation: updatedRecord,
			}
		})

		if (enqueuedDeferred) {
			await this.scheduleCleanupAlarm(nowMs + PENDING_RELEASE_INITIAL_DELAY_MS)
		}

		return result
	}

	async commit(
		reservationId: string,
		actualProvider?: QuotaProvider,
		nowMs: number = Date.now()
	): Promise<QuotaCommitResult> {
		const id = reservationId.trim()
		if (!id) {
			return { committed: false, idempotent: false, notFound: true, reason: 'not_found' }
		}

		return this.ctx.storage.transactionSync((): QuotaCommitResult => {
			const existing = this.getReservationRow(id)
			if (!existing) {
				return { committed: false, idempotent: false, notFound: true, reason: 'not_found' }
			}

			const record = toRecord(existing)

			// Strict precondition: NEVER revive a refunded row
			if (record.status === 'refunded') {
				return {
					committed: false,
					idempotent: false,
					reason: 'already_refunded',
					reservation: record,
				}
			}

			// Strict precondition: NEVER silently change provider on commit without cap checks
			if (actualProvider && record.provider !== actualProvider) {
				return {
					committed: false,
					idempotent: false,
					reason: 'provider_mismatch',
					reservation: record,
				}
			}

			if (record.status === 'committed') {
				return {
					committed: true,
					idempotent: true,
					reservation: record,
				}
			}

			this.sql.exec(
				`UPDATE quota_reservations
				 SET status = 'committed',
				     admitted = 1,
				     updated_at_ms = ?
				 WHERE reservation_id = ?
				   AND status IN ('reserved', 'ambiguous')
				   AND provider = ?`,
				nowMs,
				id,
				record.provider
			)

			const updated = this.getReservationRow(id)!
			return {
				committed: true,
				idempotent: false,
				reservation: toRecord(updated),
			}
		})
	}

	async settle(
		reservationId: string,
		actualProvider?: QuotaProvider,
		nowMs: number = Date.now()
	): Promise<QuotaCommitResult> {
		return this.commit(reservationId, actualProvider, nowMs)
	}

	/**
	 * Atomically transfer an unbilled `'reserved'` reservation from `fromProvider` to `toProvider`,
	 * strictly enforcing `toProvider`'s daily cap. Use ONLY after confirmed pre-charge rejection;
	 * already-accepted/billed attempts must retain their original row and reserve fallback independently.
	 */
	async transitionFallback(
		reservationId: string,
		fromProvider: QuotaProvider,
		toProvider: QuotaProvider,
		limits: QuotaLimits,
		nowMs: number = Date.now(),
		bucketDayKey?: string
	): Promise<QuotaTransitionResult> {
		const id = reservationId.trim()
		if (!id) {
			throw new Error('reservationId must be a non-empty string')
		}

		const result = this.ctx.storage.transactionSync((): QuotaTransitionResult => {
			const targetDayKey = bucketDayKey?.trim() || getUtcDayKey(nowMs)
			const existing = this.getReservationRow(id)

			if (existing) {
				const record = toRecord(existing)
				if (record.provider === toProvider && record.status !== 'refunded') {
					return {
						ok: true,
						idempotent: true,
						previousDayKey: record.dayKey,
						reservation: record,
						quota: this.buildSnapshot(targetDayKey, limits),
					}
				}

				if (record.status !== 'reserved' || record.provider !== fromProvider) {
					return {
						ok: false,
						code: 'invalid_state',
						status: record.status,
						provider: record.provider,
						quota: this.buildSnapshot(targetDayKey, limits),
					}
				}

				const counts = this.getDailyUsageCounts(targetDayKey)
				const toUsed = toProvider === 'elevenlabs' ? counts.elevenlabs : counts.classic
				const toLimit = limitForProvider(limits, toProvider)
				if (toUsed >= toLimit) {
					return {
						ok: false,
						code: 'quota_exceeded',
						reason: 'daily_limit',
						provider: toProvider,
						limit: toLimit,
						used: toUsed,
						remaining: 0,
						resetAt: getUtcDayResetAt(targetDayKey),
						quota: this.buildSnapshot(targetDayKey, limits),
					}
				}

				this.sql.exec(
					`UPDATE quota_reservations
					 SET provider = ?,
					     fallback_from = ?,
					     day_key = ?,
					     admitted = 1,
					     updated_at_ms = ?
					 WHERE reservation_id = ? AND status = 'reserved'`,
					toProvider,
					fromProvider,
					targetDayKey,
					nowMs,
					id
				)

				const updated = this.getReservationRow(id)!
				return {
					ok: true,
					idempotent: false,
					previousDayKey: record.dayKey,
					reservation: toRecord(updated),
					quota: this.buildSnapshot(targetDayKey, limits),
				}
			}

			// Legacy in-flight workflows created before Wave 5 deploy still enforce target provider cap
			const counts = this.getDailyUsageCounts(targetDayKey)
			const toUsed = toProvider === 'elevenlabs' ? counts.elevenlabs : counts.classic
			const toLimit = limitForProvider(limits, toProvider)
			if (toUsed >= toLimit) {
				return {
					ok: false,
					code: 'quota_exceeded',
					reason: 'daily_limit',
					provider: toProvider,
					limit: toLimit,
					used: toUsed,
					remaining: 0,
					resetAt: getUtcDayResetAt(targetDayKey),
					quota: this.buildSnapshot(targetDayKey, limits),
				}
			}

			this.sql.exec(
				`INSERT INTO quota_reservations (
					reservation_id, day_key, provider, initial_provider, status,
					claim_count, admitted, created_at_ms, updated_at_ms, fallback_from, reason
				) VALUES (?, ?, ?, ?, 'reserved', 1, 1, ?, ?, ?, 'fallback_without_prior_reservation')`,
				id,
				targetDayKey,
				toProvider,
				fromProvider,
				nowMs,
				nowMs,
				fromProvider
			)

			const created = this.getReservationRow(id)!
			return {
				ok: true,
				idempotent: false,
				previousDayKey: targetDayKey,
				reservation: toRecord(created),
				quota: this.buildSnapshot(targetDayKey, limits),
			}
		})

		if (result.ok) {
			await this.scheduleCleanupAlarm(nowMs + ALARM_RETENTION_DELAY_MS)
		}

		return result
	}

	async revertFallback(
		reservationId: string,
		originalProvider: QuotaProvider,
		originalDayKey?: string,
		markNonRefundable: boolean = false,
		reason?: string,
		nowMs: number = Date.now()
	): Promise<QuotaRevertFallbackResult> {
		const id = reservationId.trim()
		if (!id) {
			return { reverted: false }
		}

		return this.ctx.storage.transactionSync((): QuotaRevertFallbackResult => {
			const existing = this.getReservationRow(id)
			if (!existing || existing.status !== 'reserved') {
				return {
					reverted: false,
					...(existing ? { reservation: toRecord(existing) } : {}),
				}
			}

			const nextStatus: QuotaReservationStatus = markNonRefundable ? 'ambiguous' : 'reserved'
			const nextDayKey = originalDayKey?.trim() || existing.day_key

			this.sql.exec(
				`UPDATE quota_reservations
				 SET provider = ?,
				     day_key = ?,
				     status = ?,
				     fallback_from = NULL,
				     reason = COALESCE(?, reason),
				     updated_at_ms = ?
				 WHERE reservation_id = ? AND status = 'reserved'`,
				originalProvider,
				nextDayKey,
				nextStatus,
				reason ?? null,
				nowMs,
				id
			)

			const updated = this.getReservationRow(id)!
			return {
				reverted: true,
				reservation: toRecord(updated),
			}
		})
	}

	async markAmbiguous(
		reservationId: string,
		reason?: string,
		nowMs: number = Date.now()
	): Promise<QuotaMarkAmbiguousResult> {
		const id = reservationId.trim()
		if (!id) {
			return { marked: false, status: 'not_found' }
		}

		return this.ctx.storage.transactionSync((): QuotaMarkAmbiguousResult => {
			const existing = this.getReservationRow(id)
			if (!existing) {
				return { marked: false, status: 'not_found' }
			}

			if (existing.status === 'committed' || existing.status === 'ambiguous') {
				return {
					marked: true,
					status: existing.status as QuotaReservationStatus,
					reservation: toRecord(existing),
				}
			}

			if (existing.status === 'refunded') {
				return {
					marked: false,
					status: 'refunded',
					reservation: toRecord(existing),
				}
			}

			this.sql.exec(
				`UPDATE quota_reservations
				 SET status = 'ambiguous',
				     admitted = 1,
				     reason = COALESCE(?, reason),
				     updated_at_ms = ?
				 WHERE reservation_id = ? AND status = 'reserved'`,
				reason ?? null,
				nowMs,
				id
			)

			const updated = this.getReservationRow(id)!
			return {
				marked: true,
				status: 'ambiguous',
				reservation: toRecord(updated),
			}
		})
	}

	async refund(
		reservationId: string,
		reason?: string,
		nowMs: number = Date.now(),
		options?: QuotaRefundOptions
	): Promise<QuotaRefundResult> {
		const id = reservationId.trim()
		if (!id) {
			return { refunded: false, idempotent: false, reason: 'not_found' }
		}

		return this.ctx.storage.transactionSync((): QuotaRefundResult => {
			const existing = this.getReservationRow(id)
			if (!existing) {
				return { refunded: false, idempotent: false, reason: 'not_found' }
			}

			if (existing.status === 'refunded') {
				return {
					refunded: true,
					idempotent: true,
					reservation: toRecord(existing),
				}
			}

			if (existing.status === 'committed') {
				return {
					refunded: false,
					idempotent: false,
					reason: 'already_committed',
					reservation: toRecord(existing),
				}
			}

			if (existing.status === 'ambiguous') {
				return {
					refunded: false,
					idempotent: false,
					reason: 'ambiguous_non_refundable',
					reservation: toRecord(existing),
				}
			}

			if (options?.onlyIfUnshared && Number(existing.claim_count ?? 1) > 1) {
				return {
					refunded: false,
					idempotent: false,
					reason: 'shared_reservation',
					reservation: toRecord(existing),
				}
			}

			this.sql.exec(
				`UPDATE quota_reservations
				 SET status = 'refunded',
				     reason = COALESCE(?, reason),
				     updated_at_ms = ?
				 WHERE reservation_id = ? AND status = 'reserved'`,
				reason ?? null,
				nowMs,
				id
			)

			const updated = this.getReservationRow(id)!
			return {
				refunded: true,
				idempotent: false,
				reservation: toRecord(updated),
			}
		})
	}

	/**
	 * Atomically serialize play beacon deduplication and per-caller minute rate admission
	 * inside SQLite `transactionSync` so concurrent duplicate beacons produce at most one D1 increment.
	 */
	async admitPlayBeacon(params: {
		callerHash: string
		songDedupeKey: string
		playIdDedupeKey?: string
		cooldownSeconds: number
		playIdTtlSeconds: number
		rateLimitPerMinute: number
		nowMs?: number
	}): Promise<PlayBeaconAdmitResult> {
		const nowMs = params.nowMs ?? Date.now()
		const cooldownMs = Math.max(1, Math.floor(params.cooldownSeconds)) * 1000
		const playIdTtlMs = Math.max(1, Math.floor(params.playIdTtlSeconds)) * 1000
		const rateLimit = Math.max(1, Math.floor(params.rateLimitPerMinute))

		const result = this.ctx.storage.transactionSync((): PlayBeaconAdmitResult => {
			this.sql.exec(`DELETE FROM play_beacon_dedupe WHERE expires_at_ms <= ?`, nowMs)
			this.sql.exec(`DELETE FROM play_beacon_rate WHERE expires_at_ms <= ?`, nowMs)

			const songHit = this.sql
				.exec<{ expires_at_ms: number }>(
					`SELECT expires_at_ms FROM play_beacon_dedupe WHERE dedupe_key = ? AND expires_at_ms > ?`,
					params.songDedupeKey,
					nowMs
				)
				.toArray()
			if (songHit.length > 0) {
				return { admitted: false, deduped: true }
			}

			if (params.playIdDedupeKey) {
				const playIdHit = this.sql
					.exec<{ expires_at_ms: number }>(
						`SELECT expires_at_ms FROM play_beacon_dedupe WHERE dedupe_key = ? AND expires_at_ms > ?`,
						params.playIdDedupeKey,
						nowMs
					)
					.toArray()
				if (playIdHit.length > 0) {
					return { admitted: false, deduped: true }
				}
			}

			const minuteBucket = Math.floor(nowMs / BURST_WINDOW_MS)
			const bucketEndMs = (minuteBucket + 1) * BURST_WINDOW_MS
			const retryAfter = Math.max(1, Math.ceil((bucketEndMs - nowMs) / 1000))
			const bucketKey = `${params.callerHash}:${minuteBucket}`

			const rateRows = this.sql
				.exec<{ count: number }>(
					`SELECT count FROM play_beacon_rate WHERE bucket_key = ? AND expires_at_ms > ?`,
					bucketKey,
					nowMs
				)
				.toArray()
			const currentCount = rateRows[0] ? Number(rateRows[0].count) : 0
			if (currentCount >= rateLimit) {
				return { admitted: false, rateLimited: true, retryAfter }
			}

			this.sql.exec(
				`INSERT INTO play_beacon_rate (bucket_key, count, expires_at_ms)
				 VALUES (?, ?, ?)
				 ON CONFLICT(bucket_key) DO UPDATE SET
				   count = excluded.count,
				   expires_at_ms = excluded.expires_at_ms`,
				bucketKey,
				currentCount + 1,
				bucketEndMs
			)

			// Commit dedupe markers atomically BEFORE D1 write so overlapping duplicates are blocked immediately
			this.sql.exec(
				`INSERT OR REPLACE INTO play_beacon_dedupe (dedupe_key, expires_at_ms) VALUES (?, ?)`,
				params.songDedupeKey,
				nowMs + cooldownMs
			)
			if (params.playIdDedupeKey) {
				this.sql.exec(
					`INSERT OR REPLACE INTO play_beacon_dedupe (dedupe_key, expires_at_ms) VALUES (?, ?)`,
					params.playIdDedupeKey,
					nowMs + playIdTtlMs
				)
			}

			return { admitted: true }
		})

		if (result.admitted) {
			const sweepDelayMs = Math.max(cooldownMs, params.playIdDedupeKey ? playIdTtlMs : 0, BURST_WINDOW_MS) + 5_000
			await this.scheduleCleanupAlarm(nowMs + sweepDelayMs)
		}

		return result
	}

	/** All rows for these prefixes, in prefix order of the request. */
	private mintLockRows(prefixes: Map<string, string>): Array<{ prefix: string; id: string; held?: MintPrefixLockRow }> {
		return [...prefixes].map(([prefix, id]) => ({
			prefix,
			id,
			held: this.sql
				.exec<MintPrefixLockRow>(`SELECT ${MINT_LOCK_COLUMNS} FROM mint_prefix_locks WHERE prefix = ?`, prefix)
				.toArray()[0],
		}))
	}

	/**
	 * Retain every row this workflow owns for these prefixes as `ambiguous` (never `failed`, never
	 * released). Used whenever a dispatch may already have started. Returns how many rows changed,
	 * counted from the rows read in the same transaction.
	 */
	private retainMintLocksAsAmbiguous(workflowId: string, prefixes: Map<string, string>, nowMs: number): number {
		const owned = this.mintLockRows(prefixes).filter(({ id, held }) => held?.smol_id === id && held.workflow_id === workflowId)
		let retained = 0
		for (const { prefix, id, held } of owned) {
			if (held!.status === 'minted' || held!.status === 'ambiguous') continue
			this.sql.exec(
				`UPDATE mint_prefix_locks SET status = 'ambiguous', signed_at_ms = coalesce(signed_at_ms, ?),
				   dispatched_at_ms = coalesce(dispatched_at_ms, ?), claim_token = NULL, lease_until_ms = NULL, joined_at_ms = NULL,
				   updated_at_ms = ?
				 WHERE prefix = ? AND smol_id = ? AND workflow_id = ? AND status NOT IN ('minted', 'ambiguous')`,
				nowMs, nowMs, nowMs, prefix, id, workflowId
			)
			retained += 1
		}
		return retained
	}

	/**
	 * Atomically claim each smol id's 12-hex asset-code prefix (`substr(Id, 1, 12)`) for one workflow.
	 *
	 * The factory reuses an existing SAC for a repeated asset code and mints another 10M to the
	 * caller, so two different ids sharing a prefix must never both receive an issuer signature. The
	 * prefix -> smol id binding is permanent once anything could have been signed. On top of that, only
	 * one workflow may own a smol id while its outcome is unresolved, so two carriers for the same
	 * song can never both be signed and relayed before D1 records settlement:
	 *
	 * - free prefix: inserted for this workflow (`reserved` with the admission's `claimToken` and a
	 *   creation lease at admission, `signing` at signing).
	 * - another smol id holds it: `prefix_reserved`, always.
	 * - same smol id, same workflow: identical-carrier admissions join the owner's claim (they never
	 *   acquire it, so their token cannot release it). Joining a provisional claim records
	 *   `joined_at_ms` and renews its creation lease, so neither the acquiring admission's cleanup nor
	 *   a competing admission's recovery can drop a claim whose workflow the joiner may be queueing.
	 *   The signing stage moves `reserved`
	 *   or `failed` to `signing`. Once dispatch may have started (`dispatched`, `ambiguous`) the owner
	 *   may never sign again (`dispatch_uncertain`; a `dispatched` row becomes `ambiguous`), and a new
	 *   admission is refused for an `ambiguous` row.
	 * - same smol id, other workflow: `failed` may be taken over; `minted` is terminal; every other
	 *   status is unresolved and refused (`mint_in_progress`). The workflow id is never overwritten.
	 *
	 * All-or-nothing inside one SQLite transaction on a single object, so it is linearizable across
	 * concurrent requests and isolates. No D1 migration is required.
	 */
	async reserveMintPrefixes(params: {
		workflowId: string
		ids: string[]
		stage: MintPrefixClaimStage
		/** Required at admission: identifies the acquiring admission for its own cleanup. */
		claimToken?: string
		nowMs?: number
	}): Promise<MintPrefixReserveResult> {
		const nowMs = params.nowMs ?? Date.now()
		const { workflowId, stage } = params
		if (stage !== 'admission' && stage !== 'signing') throw new Error('Invalid mint prefix reservation')
		const claimToken = stage === 'admission' ? params.claimToken : null
		if (stage === 'admission' && (typeof claimToken !== 'string' || !MINT_CLAIM_TOKEN.test(claimToken))) {
			throw new Error('Invalid mint prefix reservation')
		}
		const prefixes = mintLockPrefixes(workflowId, params.ids)

		return this.ctx.storage.transactionSync((): MintPrefixReserveResult => {
			const conflicts: MintPrefixConflict[] = []
			const writes: Array<{ prefix: string; id: string; held?: MintPrefixLockRow }> = []
			for (const { prefix, id, held } of this.mintLockRows(prefixes)) {
				if (!held) {
					writes.push({ prefix, id })
					continue
				}
				const conflict = (reason: MintPrefixConflict['reason']) => conflicts.push({
					prefix, id, heldBy: held.smol_id, workflowId: held.workflow_id, status: held.status,
					claimToken: held.claim_token, leaseUntilMs: held.lease_until_ms,
					leaseVersion: held.status === 'reserved' ? held.lease_version : null, signedAtMs: held.signed_at_ms, reason,
				})
				if (held.smol_id !== id) conflict('prefix_reserved')
				else if (held.status === 'minted') conflict('minted')
				else if (held.workflow_id === workflowId) {
					if (held.status === 'reserved' || held.status === 'signing' || held.status === 'failed') writes.push({ prefix, id, held })
					else if (held.status === 'dispatched' && stage === 'admission') writes.push({ prefix, id, held })
					else if (DISPATCH_STARTED.has(held.status)) conflict('dispatch_uncertain')
					else conflict('mint_in_progress')
				} else if (held.status === 'failed') writes.push({ prefix, id, held })
				else conflict('mint_in_progress')
			}
			if (conflicts.length) {
				// The owner's own dispatch may have started: it is retained as ambiguous, durably, by the
				// same transaction that refuses the re-sign.
				if (stage === 'signing' && conflicts.some(({ reason }) => reason === 'dispatch_uncertain')) {
					this.retainMintLocksAsAmbiguous(workflowId, prefixes, nowMs)
				}
				return { ok: false, conflicts }
			}
			const claimed: MintPrefixLockStatus = stage === 'signing' ? 'signing' : 'reserved'
			const signedAt = stage === 'signing' ? nowMs : null
			const leaseUntil = stage === 'admission' ? nowMs + MINT_ADMISSION_LEASE_MS : null
			const leaseVersion = stage === 'admission' ? 1 : 0
			for (const { prefix, id, held } of writes) {
				if (!held) {
					this.sql.exec(
						`INSERT INTO mint_prefix_locks (prefix, smol_id, workflow_id, status, claim_token, lease_until_ms, lease_version,
						   reserved_at_ms, signed_at_ms, dispatched_at_ms, joined_at_ms, updated_at_ms)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
						prefix, id, workflowId, claimed, claimToken, leaseUntil, leaseVersion, nowMs, signedAt, nowMs
					)
				} else if (held.workflow_id !== workflowId) {
					// Takeover of a definitely failed reservation for the same smol id.
					this.sql.exec(
						`UPDATE mint_prefix_locks SET workflow_id = ?, status = ?, claim_token = ?, lease_until_ms = ?,
						   lease_version = lease_version + 1, reserved_at_ms = ?, signed_at_ms = coalesce(signed_at_ms, ?), dispatched_at_ms = NULL, joined_at_ms = NULL,
						   updated_at_ms = ?
						 WHERE prefix = ? AND smol_id = ? AND workflow_id = ? AND status = 'failed'`,
						workflowId, claimed, claimToken, leaseUntil, nowMs, signedAt, nowMs, prefix, id, held.workflow_id
					)
				} else if (stage === 'signing' && held.status !== 'signing') {
					// The owner's signing claim, from `reserved` or (after a definite failure) `failed`.
					this.sql.exec(
						`UPDATE mint_prefix_locks SET status = 'signing', signed_at_ms = coalesce(signed_at_ms, ?),
						   claim_token = NULL, lease_until_ms = NULL, dispatched_at_ms = NULL, joined_at_ms = NULL, updated_at_ms = ?
						 WHERE prefix = ? AND smol_id = ? AND workflow_id = ? AND status IN ('reserved', 'failed')`,
						nowMs, nowMs, prefix, id, workflowId
					)
				} else if (stage === 'admission' && held.status === 'reserved' && held.claim_token !== claimToken) {
					// An identical-carrier admission joins the provisional claim. It may queue the workflow
					// itself, so the acquirer may no longer release it, and the creation lease is renewed
					// so lease-expiry recovery cannot reclaim it while the joiner is still creating. The lease
					// generation is bumped too: a recovery that observed the earlier lease (and checked the
					// owner's workflow status before this join) can never release it, even after the renewed
					// lease has also run out; it must observe the new lease and the workflow afresh.
					this.sql.exec(
						`UPDATE mint_prefix_locks SET joined_at_ms = coalesce(joined_at_ms, ?),
						   lease_until_ms = max(coalesce(lease_until_ms, 0), ?), lease_version = lease_version + 1, updated_at_ms = ?
						 WHERE prefix = ? AND smol_id = ? AND workflow_id = ? AND status = 'reserved'`,
						nowMs, leaseUntil, nowMs, prefix, id, workflowId
					)
				}
			}
			return { ok: true }
		})
	}

	/**
	 * Drop the provisional (`reserved`) claims that ONE admission acquired, identified by its exact
	 * `claimToken`. Call ONLY on a definite pre-sign failure: that admission proved its workflow absent
	 * and no identical-carrier admission ever joined the claim (a joiner may have queued it), or
	 * (`expiredLeaseOnly`) a competing admission found the owner absent or terminal before signing
	 * after the creation lease ran out. A row in any other status, owned by another workflow, carrying
	 * another token, joined (without `expiredLeaseOnly`), or (with `expiredLeaseOnly`) still inside its
	 * creation lease is never touched.
	 *
	 * Expiry recovery (`expiredLeaseOnly`) must also present, for every id, the lease it observed
	 * (`observedLeases`: `leaseUntilMs` and `leaseVersion` exactly as the conflict reported them). Its
	 * workflow-status check is only evidence about THAT lease: if a join renewed the lease since (a new
	 * generation), the row is not released, even once the renewed lease has expired too, and the
	 * caller must observe the new lease and the workflow status again before it may reclaim.
	 *
	 * A prefix that was never claimed for signing is deleted; one that ever was (an earlier, failed
	 * workflow) goes back to `failed`, so its smol id binding survives. Safe even if the workflow does
	 * exist after all: its signing-stage claim re-checks ownership atomically.
	 */
	async releaseMintPrefixes(params: {
		workflowId: string
		ids: string[]
		claimToken: string
		expiredLeaseOnly?: boolean
		/** Required with `expiredLeaseOnly`: the lease observed for each id (see `MintPrefixConflict`). */
		observedLeases?: Array<{ id: string; leaseUntilMs: number | null; leaseVersion: number }>
		nowMs?: number
	}): Promise<{ released: number }> {
		const nowMs = params.nowMs ?? Date.now()
		const prefixes = mintLockPrefixes(params.workflowId, params.ids)
		if (typeof params.claimToken !== 'string' || !MINT_CLAIM_TOKEN.test(params.claimToken)) {
			throw new Error('Invalid mint prefix release')
		}
		const expired = params.expiredLeaseOnly === true
		const observed = new Map<string, { leaseUntilMs: number | null; leaseVersion: number }>()
		if (expired) {
			for (const lease of Array.isArray(params.observedLeases) ? params.observedLeases : []) {
				const { id, leaseUntilMs, leaseVersion } = lease ?? {}
				if (typeof id !== 'string' || observed.has(id)
					|| !(leaseUntilMs === null || Number.isSafeInteger(leaseUntilMs))
					|| !Number.isSafeInteger(leaseVersion) || leaseVersion < 0) {
					throw new Error('Invalid mint prefix release')
				}
				observed.set(id, { leaseUntilMs, leaseVersion })
			}
			if ([...prefixes.values()].some((id) => !observed.has(id))) throw new Error('Invalid mint prefix release')
		}
		return this.ctx.storage.transactionSync(() => {
			let released = 0
			for (const [prefix, id] of prefixes) {
				const base = `prefix = ? AND smol_id = ? AND workflow_id = ? AND status = 'reserved' AND claim_token = ?`
				const where = expired
					? `${base} AND (lease_until_ms IS NULL OR lease_until_ms <= ?) AND lease_until_ms IS ? AND lease_version = ?`
					: `${base} AND joined_at_ms IS NULL`
				const lease = observed.get(id)
				const args: SqlStorageValue[] = [prefix, id, params.workflowId, params.claimToken]
				if (expired) args.push(nowMs, lease!.leaseUntilMs, lease!.leaseVersion)
				const held = this.sql
					.exec<{ signed_at_ms: number | null }>(`SELECT signed_at_ms FROM mint_prefix_locks WHERE ${where}`, ...args)
					.toArray()[0]
				if (!held) continue
				if (held.signed_at_ms === null) {
					this.sql.exec(`DELETE FROM mint_prefix_locks WHERE ${where}`, ...args)
				} else {
					this.sql.exec(
						`UPDATE mint_prefix_locks SET status = 'failed', claim_token = NULL, lease_until_ms = NULL, joined_at_ms = NULL,
						   updated_at_ms = ?
						 WHERE ${where}`,
						nowMs, ...args
					)
				}
				released += 1
			}
			return { released }
		})
	}

	/**
	 * The durable, owner-checked dispatch marker. The submit step calls this immediately BEFORE the
	 * relay, and only after the kill switch and the versioned signing checkpoint have passed. It moves
	 * every prefix from this workflow's `signing` claim to `dispatched`, all or nothing:
	 *
	 * - all owned and `signing`: marked `dispatched`; the caller may relay exactly once.
	 * - any owned row already `dispatched`/`ambiguous`: this is a replay of a submit whose dispatch may
	 *   have started. Every owned row is retained as `ambiguous`; the caller must not relay.
	 * - anything else (missing, another owner, `reserved`, `failed`, `minted`): `not_owned`, unchanged.
	 */
	async markMintDispatched(params: { workflowId: string; ids: string[]; nowMs?: number }): Promise<MintDispatchMarkResult> {
		const nowMs = params.nowMs ?? Date.now()
		const prefixes = mintLockPrefixes(params.workflowId, params.ids)
		return this.ctx.storage.transactionSync((): MintDispatchMarkResult => {
			const rows = this.mintLockRows(prefixes)
			const owned = rows.filter(({ id, held }) => held?.smol_id === id && held.workflow_id === params.workflowId)
			if (owned.some(({ held }) => DISPATCH_STARTED.has(held!.status))) {
				this.retainMintLocksAsAmbiguous(params.workflowId, prefixes, nowMs)
				return { ok: false, state: 'uncertain' }
			}
			if (owned.length !== rows.length || owned.some(({ held }) => held!.status !== 'signing')) {
				return { ok: false, state: 'not_owned' }
			}
			for (const { prefix, id } of owned) {
				this.sql.exec(
					`UPDATE mint_prefix_locks SET status = 'dispatched', dispatched_at_ms = ?, updated_at_ms = ?
					 WHERE prefix = ? AND smol_id = ? AND workflow_id = ? AND status = 'signing'`,
					nowMs, nowMs, prefix, id, params.workflowId
				)
			}
			return { ok: true }
		})
	}

	/**
	 * Read-only: `undispatched` only when this workflow holds EVERY prefix in `signing`, i.e. it has
	 * signed an attempt that has not been dispatched. `signing` is entered only by the signing claim made
	 * right before a fresh signature and left by the dispatch marker (or a settlement). `dispatch_started`
	 * when any owned row is `dispatched`/`ambiguous`. Anything else (`failed`, `minted`, a `reserved`
	 * admission claim, missing rows, another owner) is `other`: no attempt this workflow can still
	 * dispatch, and no dispatch the lock store knows of.
	 */
	async mintAttemptState(params: { workflowId: string; ids: string[] }): Promise<MintAttemptState> {
		const rows = this.mintLockRows(mintLockPrefixes(params.workflowId, params.ids))
		const owned = rows.filter(({ id, held }) => held?.smol_id === id && held.workflow_id === params.workflowId)
		if (owned.some(({ held }) => DISPATCH_STARTED.has(held!.status))) return 'dispatch_started'
		return owned.length === rows.length && owned.every(({ held }) => held!.status === 'signing') ? 'undispatched' : 'other'
	}

	/**
	 * Record the owning workflow's outcome on its rows. Owner-guarded; `minted` is never downgraded,
	 * and a row whose dispatch may have started is never demoted by a pre-dispatch failure.
	 *
	 * - `failed` (a definite refusal before dispatch): if any owned row is `dispatched`/`ambiguous`,
	 *   every owned row is retained as `ambiguous` and the state is `uncertain`. Otherwise a never-signed
	 *   `reserved` row is deleted (freeing the prefix for any smol), and a once-signed `reserved` or
	 *   `signing` row becomes `failed` (same-smol takeover allowed, binding kept). The state is `failed`
	 *   only if an owned `signing` claim became `failed` (this workflow's signed attempt never
	 *   dispatched); otherwise it is `released`, which proves nothing about an earlier attempt.
	 * - `failed_onchain` (a FAILED receipt for this workflow's own dispatch): `signing`/`dispatched` ->
	 *   `failed`. An `ambiguous` row is left for reconciliation.
	 * - `ambiguous` (the relay outcome is unknown): `dispatched` -> `ambiguous`.
	 * - `minted` (confirmed on chain): every owned row -> `minted`.
	 */
	async resolveMintPrefixes(params: {
		workflowId: string
		ids: string[]
		outcome: MintPrefixOutcome
		nowMs?: number
	}): Promise<MintPrefixResolution> {
		const nowMs = params.nowMs ?? Date.now()
		const { workflowId, outcome } = params
		if (!['failed', 'failed_onchain', 'ambiguous', 'minted'].includes(outcome)) throw new Error('Invalid mint prefix outcome')
		const prefixes = mintLockPrefixes(workflowId, params.ids)
		return this.ctx.storage.transactionSync((): MintPrefixResolution => {
			const owned = this.mintLockRows(prefixes).filter(({ id, held }) => held?.smol_id === id && held.workflow_id === workflowId)
			if (!owned.length) return { resolved: 0, state: 'none' }
			// Counted from the rows read in this transaction (single writer, so they are current).
			const update = (status: MintPrefixLockStatus, from: (row: MintPrefixLockRow) => boolean) => {
				let resolved = 0
				for (const { prefix, id, held } of owned) {
					if (!from(held!)) continue
					this.sql.exec(
						`UPDATE mint_prefix_locks SET status = ?, signed_at_ms = coalesce(signed_at_ms, ?), claim_token = NULL,
						   lease_until_ms = NULL, joined_at_ms = NULL, updated_at_ms = ?
						 WHERE prefix = ? AND smol_id = ? AND workflow_id = ? AND status = ?`,
						status, nowMs, nowMs, prefix, id, workflowId, held!.status
					)
					resolved += 1
				}
				return resolved
			}
			const statuses = owned.map(({ held }) => held!.status)
			if (outcome === 'minted') {
				return { resolved: update('minted', ({ status }) => status !== 'minted'), state: 'minted' }
			}
			if (outcome === 'ambiguous') {
				const resolved = update('ambiguous', ({ status }) => status === 'dispatched')
				return { resolved, state: statuses.every((status) => status === 'minted') ? 'minted' : 'uncertain' }
			}
			if (outcome === 'failed_onchain') {
				const resolved = update('failed', ({ status }) => status === 'signing' || status === 'dispatched')
				const state = statuses.some((status) => status === 'ambiguous') ? 'uncertain'
					: statuses.every((status) => status === 'minted') ? 'minted' : 'failed'
				return { resolved, state }
			}
			// A definite pre-dispatch refusal, unless this workflow's dispatch may have started.
			if (statuses.some((status) => DISPATCH_STARTED.has(status))) {
				return { resolved: this.retainMintLocksAsAmbiguous(workflowId, prefixes, nowMs), state: 'uncertain' }
			}
			if (statuses.some((status) => status === 'minted')) return { resolved: 0, state: 'minted' }
			// Only an owned `signing` claim ties this refusal to a signed, never-dispatched attempt. A
			// `reserved` claim (even one re-reserved after an earlier signing) belongs to an admission.
			const signedAttempt = statuses.some((status) => status === 'signing')
			let resolved = 0
			for (const { prefix, id, held } of owned) {
				if (held!.status !== 'reserved' || held!.signed_at_ms !== null) continue
				// Never signed, never dispatched: release it outright, so it never blocks another smol.
				this.sql.exec(
					`DELETE FROM mint_prefix_locks
					 WHERE prefix = ? AND smol_id = ? AND workflow_id = ? AND status = 'reserved' AND signed_at_ms IS NULL`,
					prefix, id, workflowId
				)
				resolved += 1
			}
			resolved += update('failed', ({ status, signed_at_ms }) => status === 'signing' || (status === 'reserved' && signed_at_ms !== null))
			return { resolved, state: signedAttempt ? 'failed' : 'released' }
		})
	}

	/**
	 * Release dedupe markers ONLY after confirmed D1 404 (`changes === 0`), while preserving the rate counter.
	 */
	async releasePlayBeaconDedupe(params: {
		songDedupeKey: string
		playIdDedupeKey?: string
	}): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`DELETE FROM play_beacon_dedupe WHERE dedupe_key = ?`, params.songDedupeKey)
			if (params.playIdDedupeKey) {
				this.sql.exec(`DELETE FROM play_beacon_dedupe WHERE dedupe_key = ?`, params.playIdDedupeKey)
			}
		})
	}
}
