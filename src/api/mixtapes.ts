import { Hono, type Context, type Next } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoEnv, SmolKVData } from '../types'
import { parseAuth } from '../middleware/auth'
import { purgeMixtapeCache } from '../utils/cache'
import {
	borderlineTrigger,
	classifyOwnerMixtapes,
	dedupeOrdered,
	findBorderlinePair,
	normalizeMixtapeText,
	pairFingerprint,
	strongerOf,
	type MixtapeCandidate,
	type MixtapeDecision,
	type SemanticDuplicateVerdict,
} from '../utils/mixtape-visibility'
import { adjudicateMixtapePair, MIXTAPE_DEDUPE_MODEL_SELECTOR, MIXTAPE_DEDUPE_PROMPT_VERSION } from '../ai/mixtape-dedupe'

const mixtapes = new Hono<HonoEnv>()
const MAX_MIXTAPE_TITLE_LENGTH = 120
const MAX_MIXTAPE_DESC_LENGTH = 1000
const MAX_MIXTAPE_SMOLS = 100
const MAX_PUBLIC_LIST = 100
const D1_IN_CHUNK_SIZE = 90
const IDEMPOTENT_RETRY_WINDOW = '-15 minutes'
const MAX_COHORT_ATTEMPTS = 3
const DRAFT_ID = '__draft__'

// v2 namespace: entries written by the pre-lifecycle worker (unfiltered, URL-keyed) are never read.
const PUBLIC_CACHE_NAME = 'smol-workflow-mixtapes-v2'
// Browsers must revalidate synchronously on every use (no stale-while-revalidate window).
const BROWSER_CACHE_CONTROL = 'public, max-age=0, must-revalidate'
// Edge policy lives only in CDN-Cache-Control and on the epoch-keyed Worker Cache API copy.
const CDN_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=120'
const EDGE_COPY_CACHE_CONTROL = 'public, max-age=60, s-maxage=60'
const EPOCH_PARAM = '__mx_epoch'
const BUMP_EPOCH_SQL = 'UPDATE MixtapeState SET Epoch = Epoch + 1 WHERE Id = 1'
/** Rolls the whole batch back (CHECK Epoch >= 0) when the immediately preceding statement changed nothing. */
const ABORT_IF_PREVIOUS_MISSED_SQL = 'UPDATE MixtapeState SET Epoch = -1 WHERE Id = 1 AND changes() = 0'
/** Rolls the whole batch back when anything mixtape-related committed since the epoch was captured. */
const ABORT_IF_EPOCH_MOVED_SQL = 'UPDATE MixtapeState SET Epoch = -1 WHERE Id = 1 AND Epoch != ?1'
const PRIVATE_HEADERS = {
	'Cache-Control': 'private, no-store',
	'CDN-Cache-Control': 'no-store',
	Vary: 'Cookie, Authorization',
} as const

interface MixtapeRow {
	Id: string
	Title: string
	Desc: string
	Smols: string
	Address: string
	Created_At: string
	Updated_At: string | null
	Deleted_At: string | null
	Visibility: 'public' | 'owner' | 'deleted'
	Hidden_Reason: string | null
	Related_Mixtape_Id: string | null
	Uniqueness_Score: number | null
	Ai_Verdict: string | null
	Revision: number
}

interface MixtapeSmolRow {
	Id: string
	Title: string
	Address: string
	Mint_Token: string | null
	Mint_Amm: string | null
	Song_1: string
	Public: number
}

/**
 * Compact persisted clef-flash receipt (`Mixtapes.Ai_Verdict`). `pair`/`revs` are aligned and
 * sorted by Id; `fp` is the SHA-256 input fingerprint (resolved public tracks + normalized text).
 * Duplicate receipts live on the hidden row, and only when the disposition was actually applied.
 */
interface AiVerdictReceipt {
	v: 1
	pv: number
	model: string
	pair: [string, string]
	revs: [number, number]
	fp: string
	p?: number
	dup?: boolean
	applied?: boolean
	rel?: string | null
	keep?: string | null
	hidden?: string | null
	fallback?: string
	ms: number
	at: string
}

const MIXTAPE_SELECT = `
	SELECT Id, Title, Desc, Smols, "Address" AS Address, Created_At, Updated_At, Deleted_At,
		Visibility, Hidden_Reason, Related_Mixtape_Id, Uniqueness_Score, Ai_Verdict, Revision
	FROM Mixtapes`

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

function parseStoredSmolIds(smols: string): string[] {
	return dedupeOrdered(smols.split(','))
}

function parseRequestedSmolIds(value: unknown, options: { allowEmpty?: boolean } = {}): string[] {
	if (!Array.isArray(value) || (value.length === 0 && !options.allowEmpty)) {
		throw new HTTPException(400, { message: 'Missing or invalid smols array' })
	}

	if (value.length > MAX_MIXTAPE_SMOLS) {
		throw new HTTPException(400, { message: `Max ${MAX_MIXTAPE_SMOLS} smols per mixtape` })
	}

	const ids = value.map((id) => {
		if (typeof id !== 'string' || !id.trim() || id.includes(',') || id.includes('"')) {
			throw new HTTPException(400, { message: 'Invalid smol id in mixtape' })
		}

		return id.trim()
	})

	if (new Set(ids).size !== ids.length) {
		throw new HTTPException(400, { message: 'Duplicate smol ids are not allowed' })
	}

	return ids
}

function parseTitle(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new HTTPException(400, { message: 'Missing or invalid title' })
	}
	if (value.length > MAX_MIXTAPE_TITLE_LENGTH) {
		throw new HTTPException(400, { message: `Title must be ${MAX_MIXTAPE_TITLE_LENGTH} characters or less` })
	}
	return value
}

/** B-26: description is optional; omitted/null/empty all store ''. */
function parseDesc(value: unknown): string {
	if (value === undefined || value === null) return ''
	if (typeof value !== 'string') {
		throw new HTTPException(400, { message: 'Invalid description' })
	}
	if (value.length > MAX_MIXTAPE_DESC_LENGTH) {
		throw new HTTPException(400, { message: `Description must be ${MAX_MIXTAPE_DESC_LENGTH} characters or less` })
	}
	return value
}

function parseExpectedRevision(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw new HTTPException(400, { message: 'expectedRevision must be a positive integer' })
	}
	return value
}

async function readJsonBody(c: Context<HonoEnv>): Promise<Record<string, unknown>> {
	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		throw new HTTPException(400, { message: 'Invalid JSON body' })
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new HTTPException(400, { message: 'Invalid JSON body' })
	}
	return body as Record<string, unknown>
}

/** Owner routes require a verified user subject (the generic admin token has none). */
function requireOwnerSub(c: Context<HonoEnv>): string {
	const sub = c.get('jwtPayload')?.sub
	if (!sub) {
		throw new HTTPException(401, { message: 'User session required' })
	}
	return sub
}

// ---------------------------------------------------------------------------
// D1 access
// ---------------------------------------------------------------------------

async function loadPublicSmolRows(env: Env, ids: string[]): Promise<Map<string, MixtapeSmolRow>> {
	const uniqueIds = [...new Set(ids)].filter(Boolean)
	const rows = new Map<string, MixtapeSmolRow>()
	const batches: string[][] = []

	for (let index = 0; index < uniqueIds.length; index += D1_IN_CHUNK_SIZE) {
		batches.push(uniqueIds.slice(index, index + D1_IN_CHUNK_SIZE))
	}

	const results = await Promise.all(batches.map((batch) => {
		const placeholders = batch.map(() => '?').join(',')
		return env.SMOL_D1.prepare(`
				SELECT Id, Title, "Address" as Address, Mint_Token, Mint_Amm, Song_1, Public
				FROM Smols
				WHERE Public = 1 AND Id IN (${placeholders})
			`)
			.bind(...batch)
			.all<MixtapeSmolRow>()
	}))

	for (const result of results) {
		for (const row of result.results) {
			rows.set(row.Id, row)
		}
	}

	return rows
}

async function loadMixtapeRow(env: Env, id: string): Promise<MixtapeRow | null> {
	return await env.SMOL_D1.prepare(`${MIXTAPE_SELECT} WHERE Id = ?1`).bind(id).first<MixtapeRow>()
}

async function loadOwnerRows(env: Env, address: string): Promise<MixtapeRow[]> {
	const { results } = await env.SMOL_D1.prepare(`
		${MIXTAPE_SELECT}
		WHERE "Address" = ?1 AND Deleted_At IS NULL AND Visibility != 'deleted'
		ORDER BY Created_At DESC, Id DESC
	`).bind(address).all<MixtapeRow>()
	return results
}

function newMixtapeId(): string {
	const bytes = new Uint8Array(8)
	crypto.getRandomValues(bytes)
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 identity of an exact retry: owner, ordered smols, normalized title & description. */
async function retryKey(address: string, smols: string, title: string, desc: string): Promise<string> {
	const payload = JSON.stringify([address, smols, normalizeMixtapeText(title), normalizeMixtapeText(desc)])
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A guarded batch aborted on purpose (CHECK on MixtapeState.Epoch): retry or 409, never 500. */
function isGuardAbort(error: unknown): boolean {
	return error instanceof Error && /CHECK constraint failed/i.test(error.message) && /Epoch/.test(error.message)
}

async function readEpoch(env: Env): Promise<number> {
	const state = await env.SMOL_D1.prepare('SELECT Epoch FROM MixtapeState WHERE Id = 1').first<{ Epoch: number }>()
	return state?.Epoch ?? 0
}

// ---------------------------------------------------------------------------
// Public cache: epoch-versioned keys
// ---------------------------------------------------------------------------

/**
 * Edge cache key = canonical URL + the committed `MixtapeState.Epoch`. The epoch is read
 * BEFORE the handler queries D1, so a slow in-flight GET can only ever fill the key of the
 * epoch it started under; any later mutation (or song privacy flip, via trigger) moves every
 * reader to a fresh key. Client-supplied epoch params are stripped.
 */
async function publicCacheKey(c: Context<HonoEnv>): Promise<string> {
	const url = new URL(c.req.url)
	url.searchParams.delete(EPOCH_PARAM)
	url.searchParams.sort()
	url.searchParams.set(EPOCH_PARAM, String(await readEpoch(c.env)))
	return url.toString()
}

function withBrowserPolicy(response: Response): Response {
	const out = new Response(response.body, response)
	out.headers.set('Cache-Control', BROWSER_CACHE_CONTROL)
	out.headers.set('CDN-Cache-Control', CDN_CACHE_CONTROL)
	return out
}

/**
 * Public read cache. The Worker Cache API copy (v2 namespace, epoch-versioned key) carries the
 * edge TTL; every 200 that reaches a browser carries `max-age=0, must-revalidate`, so a
 * rename, delete or song privacy change is never served stale from a browser cache. Non-200s
 * are `no-store` everywhere (browser and CDN).
 */
const publicCache = () => async (c: Context<HonoEnv>, next: Next) => {
	const edge = typeof caches === 'undefined' ? null : await caches.open(PUBLIC_CACHE_NAME)
	const key = edge ? await publicCacheKey(c) : ''
	const hit = edge ? await edge.match(key) : undefined
	if (hit) return withBrowserPolicy(hit)

	await next()
	if (c.res.status !== 200) {
		// 404s (deleted / merged / unknown) and errors must never be shared: an Undo or restore
		// has to be visible immediately, and these responses carry no purgeable cache tag.
		c.res.headers.set('Cache-Control', 'no-store')
		c.res.headers.set('CDN-Cache-Control', 'no-store')
		return
	}
	if (edge) {
		const copy = new Response(c.res.clone().body, c.res)
		copy.headers.set('Cache-Control', EDGE_COPY_CACHE_CONTROL)
		c.executionCtx.waitUntil(edge.put(key, copy))
	}
	c.res.headers.set('Cache-Control', BROWSER_CACHE_CONTROL)
	c.res.headers.set('CDN-Cache-Control', CDN_CACHE_CONTROL)
}

/** Private, never-shared cache policy on EVERY response (incl. 400/401/403 thrown before handlers). */
async function privateNoStore(c: Context<HonoEnv>, next: Next) {
	await next()
	for (const [name, value] of Object.entries(PRIVATE_HEADERS)) c.res.headers.set(name, value)
}

// ---------------------------------------------------------------------------
// Derivation (Tier 1 + validated persisted Tier 2 verdicts). Zero inference.
// ---------------------------------------------------------------------------

function toCandidate(row: MixtapeRow, publicSmols: ReadonlyMap<string, unknown>): MixtapeCandidate {
	const stored = parseStoredSmolIds(row.Smols)
	return {
		id: row.Id,
		address: row.Address,
		title: row.Title,
		desc: row.Desc ?? '',
		createdAt: row.Created_At,
		storedTracks: stored,
		publicTracks: stored.filter((id) => publicSmols.has(id)),
	}
}

function parseReceipt(raw: string | null): AiVerdictReceipt | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as AiVerdictReceipt
		return parsed && parsed.v === 1 && Array.isArray(parsed.pair) && Array.isArray(parsed.revs) ? parsed : null
	} catch {
		return null
	}
}

function pairKey(a: string, b: string): [string, string] {
	return a < b ? [a, b] : [b, a]
}

function samePair(receipt: AiVerdictReceipt | null, pair: readonly [string, string]): boolean {
	return Boolean(receipt && receipt.pair[0] === pair[0] && receipt.pair[1] === pair[1])
}

/** A real (non-fallback) clef-flash adjudication of exactly this pair and input fingerprint. */
function adjudicates(receipt: AiVerdictReceipt | null, pair: readonly [string, string], fp: string): boolean {
	return samePair(receipt, pair) && receipt!.fp === fp && !receipt!.fallback && typeof receipt!.p === 'number'
}

function receiptRevisionsCurrent(receipt: AiVerdictReceipt, revisions: ReadonlyMap<string, number>): boolean {
	return revisions.get(receipt.pair[0]) === receipt.revs[0] && revisions.get(receipt.pair[1]) === receipt.revs[1]
}

/**
 * Duplicate verdicts that are still trustworthy: same prompt version, both mixtapes at the
 * judged revisions, the pair STILL in the borderline band, and the SHA-256 fingerprint of the
 * resolved public inputs unchanged (a song flipping private invalidates it immediately).
 */
async function collectVerdicts(
	rows: MixtapeRow[],
	candidates: MixtapeCandidate[],
	receiptOf: (row: MixtapeRow) => AiVerdictReceipt | null,
): Promise<SemanticDuplicateVerdict[]> {
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
	const revisions = new Map(rows.map((row) => [row.Id, row.Revision]))
	const verdicts: SemanticDuplicateVerdict[] = []
	for (const row of rows) {
		const receipt = receiptOf(row)
		if (!receipt?.dup || receipt.hidden !== row.Id || !receipt.keep || receipt.fallback || typeof receipt.p !== 'number') continue
		if (receipt.pv !== MIXTAPE_DEDUPE_PROMPT_VERSION || !receiptRevisionsCurrent(receipt, revisions)) continue
		const hidden = byId.get(receipt.hidden)
		const keeper = byId.get(receipt.keep)
		if (!hidden || !keeper || !borderlineTrigger(hidden, keeper)) continue
		if (receipt.fp !== await pairFingerprint(hidden, keeper)) continue
		verdicts.push({ hiddenId: hidden.id, keeperId: keeper.id, pDuplicate: receipt.p })
	}
	return verdicts
}

async function deriveDecisions(rows: MixtapeRow[], publicSmols: ReadonlyMap<string, unknown>) {
	const candidates = rows.map((row) => toCandidate(row, publicSmols))
	const verdicts = await collectVerdicts(rows, candidates, (row) => parseReceipt(row.Ai_Verdict))
	return { candidates, decisions: classifyOwnerMixtapes(candidates, verdicts) }
}

// ---------------------------------------------------------------------------
// Write-time cohort re-evaluation (Tier 1 + optional top-1 borderline Tier 2)
// ---------------------------------------------------------------------------

interface CohortResult {
	rows: MixtapeRow[]
	decisions: Map<string, MixtapeDecision>
	publicSmols: Map<string, MixtapeSmolRow>
	changedIds: string[]
	/** True when the derived state was written, or verified already current, at a stable epoch. */
	committed: boolean
	/** True when the create claim this evaluation ran under was taken over: nothing was written. */
	superseded?: boolean
}

/** The create/recovery attempt an evaluation runs under (POST /mixtapes only). */
interface ActiveClaim {
	key: string
	mixtapeId: string
	token: string
}

const CLAIM_ACTIVE_SQL = `EXISTS (
	SELECT 1 FROM MixtapeRetryClaim
	WHERE Retry_Key = ?1 AND Mixtape_Id = ?2 AND Attempt_Token = ?3 AND Finalized = 0
)`

async function claimStillActive(env: Env, claim: ActiveClaim): Promise<boolean> {
	const row = await env.SMOL_D1.prepare(`SELECT ${CLAIM_ACTIVE_SQL} AS active`).bind(claim.key, claim.mixtapeId, claim.token).first<{ active: number }>()
	return row?.active === 1
}

/**
 * Consistent read of one owner's cohort. The epoch is captured BEFORE the rows, so any commit
 * that lands after (or during) this read is detected by the write guard below.
 */
async function loadCohortSnapshot(env: Env, address: string) {
	const epoch = await readEpoch(env)
	const rows = await loadOwnerRows(env, address)
	const publicSmols = await loadPublicSmolRows(env, rows.flatMap((row) => parseStoredSmolIds(row.Smols)))
	return { epoch, rows, publicSmols }
}

/**
 * Re-derive and persist the owner's whole cohort with compare-and-swap semantics. The batch
 * first aborts if `MixtapeState.Epoch` moved since the snapshot (any mixtape write, derived
 * write or song privacy flip bumps it). Every derived UPDATE then requires the row's exact
 * snapshot (Revision, Visibility, Hidden_Reason, Related_Mixtape_Id, Uniqueness_Score,
 * Ai_Verdict) and is followed by an abort-if-missed statement, so the batch commits entirely
 * or not at all. On abort the cohort is re-read and re-derived without new inference. A fresh
 * AI receipt survives a retry only if its host row's verdict is untouched, its revisions are
 * current and its input fingerprint still matches; a late/older call can never overwrite a
 * committed verdict. If retries run out, the committed state is re-read and returned.
 */
async function reevaluateOwnerCohort(
	env: Env,
	address: string,
	options: { subjectId?: string; allowAi: boolean; claim?: ActiveClaim },
): Promise<CohortResult> {
	const claim = options.claim
	// Lost ownership of the create claim: report the committed state, write nothing, infer nothing.
	const superseded = async (): Promise<CohortResult> => {
		const { rows, publicSmols } = await loadCohortSnapshot(env, address)
		const { decisions } = await deriveDecisions(rows, publicSmols)
		return { rows, decisions, publicSmols, changedIds: [], committed: false, superseded: true }
	}
	// `captured` = both pair participants' Ai_Verdict as read before inference.
	let fresh: { hostId: string; receipt: AiVerdictReceipt; captured: Map<string, string | null> } | null = null

	for (let attempt = 0; attempt < MAX_COHORT_ATTEMPTS; attempt += 1) {
		const { epoch, rows, publicSmols } = await loadCohortSnapshot(env, address)
		const candidates = rows.map((row) => toCandidate(row, publicSmols))
		const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
		const revisions = new Map(rows.map((row) => [row.Id, row.Revision]))

		let freshUsable = false
		if (fresh) {
			const { receipt, captured } = fresh
			const host = rows.find((row) => row.Id === fresh!.hostId)
			const [x, y] = receipt.pair.map((id) => byId.get(id))
			// Discard a late result if EITHER participant now holds a different adjudication of this
			// exact (pair, fingerprint) than when we read it: an intervening request already decided.
			const intervened = receipt.pair.some((id) => {
				const current = rows.find((row) => row.Id === id)?.Ai_Verdict ?? null
				return current !== captured.get(id) && adjudicates(parseReceipt(current), receipt.pair, receipt.fp)
			})
			freshUsable = Boolean(host && x && y)
				&& !intervened
				&& host!.Ai_Verdict === captured.get(host!.Id)
				&& receiptRevisionsCurrent(receipt, revisions)
				&& receipt.fp === await pairFingerprint(x!, y!)
		}
		const receiptOf = (row: MixtapeRow) => (freshUsable && fresh?.hostId === row.Id ? fresh.receipt : parseReceipt(row.Ai_Verdict))
		const verdicts = await collectVerdicts(rows, candidates, receiptOf)
		let decisions = classifyOwnerMixtapes(candidates, verdicts)

		const subjectId = options.subjectId
		if (attempt === 0 && options.allowAi && subjectId && decisions.get(subjectId)?.visibility === 'public') {
			const pair = findBorderlinePair(candidates, decisions, subjectId)
			if (pair) {
				const ids = pairKey(pair.a.id, pair.b.id)
				const base = {
					v: 1 as const,
					pv: MIXTAPE_DEDUPE_PROMPT_VERSION,
					pair: ids,
					revs: [revisions.get(ids[0])!, revisions.get(ids[1])!] as [number, number],
					fp: await pairFingerprint(pair.a, pair.b),
					at: new Date().toISOString(),
				}
				const baseVerdictOf = (id: string) => rows.find((row) => row.Id === id)?.Ai_Verdict ?? null
				const captured = new Map(ids.map((id) => [id, baseVerdictOf(id)]))
				// Same inputs already adjudicated at these revisions (on either row)? Honor it, no inference.
				const existing = ids
					.map((id) => parseReceipt(baseVerdictOf(id)))
					.find((receipt) => adjudicates(receipt, ids, base.fp) && receiptRevisionsCurrent(receipt!, revisions))
				const titles = new Map([...publicSmols.values()].map((smol) => [smol.Id, smol.Title]))
				// An expired creator/recovery must never spend inference or act on its result.
				if (!existing && claim && !await claimStillActive(env, claim)) return await superseded()
				const verdict = existing
					? { ok: false as const, reason: 'disabled' as const, latencyMs: 0 }
					: await adjudicateMixtapePair(env, pair.a, pair.b, titles)
				if (verdict.ok) {
					const keeper = strongerOf(pair.a, pair.b)
					const hidden = keeper.id === pair.a.id ? pair.b : pair.a
					const receipt: AiVerdictReceipt = {
						...base,
						model: verdict.verdict.model,
						p: Math.round(verdict.verdict.pDuplicate * 10_000) / 10_000,
						dup: verdict.verdict.isDuplicate,
						rel: verdict.verdict.relation,
						keep: null,
						hidden: null,
						ms: verdict.verdict.latencyMs,
					}
					fresh = { hostId: subjectId, receipt, captured }
					if (verdict.verdict.isDuplicate) {
						const trial = classifyOwnerMixtapes(candidates, [...verdicts, { hiddenId: hidden.id, keeperId: keeper.id, pDuplicate: receipt.p! }])
						const applied = trial.get(hidden.id)?.hiddenReason === 'semantic_duplicate' && trial.get(hidden.id)?.relatedId === keeper.id
						receipt.applied = applied
						if (applied) {
							receipt.keep = keeper.id
							receipt.hidden = hidden.id
							fresh = { hostId: hidden.id, receipt, captured }
							decisions = trial
						}
					}
				} else if (verdict.reason !== 'disabled') {
					fresh = {
						hostId: subjectId,
						receipt: { ...base, model: MIXTAPE_DEDUPE_MODEL_SELECTOR, fallback: verdict.reason, ms: verdict.latencyMs },
						captured,
					}
				}
				freshUsable = fresh !== null
			}
		}

		const statements: D1PreparedStatement[] = [env.SMOL_D1.prepare(ABORT_IF_EPOCH_MOVED_SQL).bind(epoch)]
		if (claim) {
			// The derived writes commit only while this exact attempt still owns the in-progress claim.
			statements.push(env.SMOL_D1.prepare(`UPDATE MixtapeState SET Epoch = -1 WHERE Id = 1 AND NOT ${CLAIM_ACTIVE_SQL}`).bind(claim.key, claim.mixtapeId, claim.token))
		}
		const changedIds: string[] = []
		const nextRows = rows.map((row) => {
			const decision = decisions.get(row.Id)!
			let aiVerdict = row.Ai_Verdict
			if (freshUsable && fresh) {
				if (fresh.hostId === row.Id) aiVerdict = JSON.stringify(fresh.receipt)
				// Never leave a second, possibly contradictory receipt for the same pair on the other row.
				else if (fresh.receipt.pair.includes(row.Id) && samePair(parseReceipt(row.Ai_Verdict), fresh.receipt.pair)) aiVerdict = null
			}
			const changed = row.Visibility !== decision.visibility
				|| row.Hidden_Reason !== decision.hiddenReason
				|| row.Related_Mixtape_Id !== decision.relatedId
				|| row.Uniqueness_Score !== decision.uniquenessScore
				|| row.Ai_Verdict !== aiVerdict
			if (!changed) return row
			changedIds.push(row.Id)
			statements.push(
				env.SMOL_D1.prepare(`
					UPDATE Mixtapes
					SET Visibility = ?1, Hidden_Reason = ?2, Related_Mixtape_Id = ?3, Uniqueness_Score = ?4, Ai_Verdict = ?5
					WHERE Id = ?6 AND "Address" = ?7 AND Revision = ?8 AND Deleted_At IS NULL
						AND Visibility IS ?9 AND Hidden_Reason IS ?10 AND Related_Mixtape_Id IS ?11
						AND Uniqueness_Score IS ?12 AND Ai_Verdict IS ?13
				`).bind(
					decision.visibility, decision.hiddenReason, decision.relatedId, decision.uniquenessScore, aiVerdict,
					row.Id, address, row.Revision,
					row.Visibility, row.Hidden_Reason, row.Related_Mixtape_Id, row.Uniqueness_Score, row.Ai_Verdict,
				),
				env.SMOL_D1.prepare(ABORT_IF_PREVIOUS_MISSED_SQL),
			)
			return {
				...row,
				Visibility: decision.visibility,
				Hidden_Reason: decision.hiddenReason,
				Related_Mixtape_Id: decision.relatedId,
				Uniqueness_Score: decision.uniquenessScore,
				Ai_Verdict: aiVerdict,
			}
		})

		const result: CohortResult = { rows: nextRows, decisions, publicSmols, changedIds, committed: true }
		if (!changedIds.length) {
			if (await readEpoch(env) === epoch) return result // still exactly the committed state
			continue
		}
		try {
			await env.SMOL_D1.batch([...statements, env.SMOL_D1.prepare(BUMP_EPOCH_SQL)])
			return result
		} catch (error) {
			if (!isGuardAbort(error)) throw error
			if (claim && !await claimStillActive(env, claim)) return await superseded()
			console.warn('mixtape_cohort_cas_retry', { address, attempt })
		}
	}

	// Still contended: nothing from this request was written. Return what is actually committed,
	// flagged as NOT committed so callers never treat it as a finished classification.
	const { rows, publicSmols } = await loadCohortSnapshot(env, address)
	const { decisions } = await deriveDecisions(rows, publicSmols)
	return { rows, decisions, publicSmols, changedIds: [], committed: false }
}

function ownerView(row: MixtapeRow, decision: MixtapeDecision | undefined, publicSmols: ReadonlyMap<string, unknown>) {
	const stored = parseStoredSmolIds(row.Smols)
	const publicIds = stored.filter((id) => publicSmols.has(id))
	return {
		Id: row.Id,
		Title: row.Title,
		Desc: row.Desc ?? '',
		Address: row.Address,
		Created_At: row.Created_At,
		Updated_At: row.Updated_At ?? row.Created_At,
		Smols: publicIds,
		Visibility: decision?.visibility ?? row.Visibility,
		Hidden_Reason: decision ? decision.hiddenReason : row.Hidden_Reason,
		Related_Mixtape_Id: decision ? decision.relatedId : row.Related_Mixtape_Id,
		Related_Mixtape_Title: decision?.relatedTitle ?? null,
		Uniqueness_Score: decision ? decision.uniquenessScore : row.Uniqueness_Score,
		Advice: decision?.advice ?? null,
		Revision: row.Revision,
		Stored_Track_Count: stored.length,
		Public_Track_Count: publicIds.length,
	}
}

function writeReceipt(row: MixtapeRow, decision: MixtapeDecision) {
	return {
		id: row.Id,
		visibility: decision.visibility,
		hiddenReason: decision.hiddenReason,
		relatedMixtapeId: decision.relatedId,
		relatedMixtapeTitle: decision.relatedTitle,
		advice: decision.advice,
		uniquenessScore: decision.uniquenessScore,
		revision: row.Revision,
		updatedAt: row.Updated_At ?? row.Created_At,
	}
}

/**
 * The subject's row and decision from a post-commit cohort snapshot, or null when an owner
 * concurrently deleted it after our write committed (an expected race, never a 500).
 */
function cohortView(cohort: CohortResult, id: string) {
	const row = cohort.rows.find((r) => r.Id === id)
	const decision = cohort.decisions.get(id)
	if (!row || !decision) return null
	return { row, decision, view: ownerView(row, decision, cohort.publicSmols) }
}

function concurrentDelete(c: Context<HonoEnv>, id: string, error = 'Mixtape was deleted concurrently after update') {
	return privateJson(c, { error, code: 'concurrent_delete', id }, 409)
}

/** Load a live mixtape for an owner mutation: 404 when missing/deleted, 403 when not the owner. */
async function loadOwnedLiveRow(env: Env, id: string, sub: string): Promise<MixtapeRow> {
	return assertOwnedLive(await loadMixtapeRow(env, id), sub)
}

function assertOwnedLive(row: MixtapeRow | null | undefined, sub: string): MixtapeRow {
	if (!row || row.Deleted_At || row.Visibility === 'deleted') {
		throw new HTTPException(404, { message: 'Mixtape not found' })
	}
	if (row.Address !== sub) {
		throw new HTTPException(403, { message: 'Only the mixtape owner can change it' })
	}
	return row
}

function privateJson(c: Context<HonoEnv>, body: unknown, status: 200 | 201 | 404 | 409 = 200) {
	return c.json(body, status, { ...PRIVATE_HEADERS })
}

function purge(c: Context<HonoEnv>, ids: Iterable<string>) {
	c.executionCtx.waitUntil(purgeMixtapeCache([...new Set(ids)]))
}

/**
 * Run the post-commit cohort re-evaluation and ALWAYS purge afterwards — even when the
 * re-evaluation throws — because the mutation itself is already committed.
 */
async function afterCommit<T>(c: Context<HonoEnv>, ids: string[], work: (purgeIds: Set<string>) => Promise<T>): Promise<T> {
	const purgeIds = new Set(ids)
	try {
		return await work(purgeIds)
	} finally {
		purge(c, purgeIds)
	}
}

async function revisionConflict(c: Context<HonoEnv>, id: string, address: string) {
	const rows = await loadOwnerRows(c.env, address)
	const publicSmols = await loadPublicSmolRows(c.env, rows.flatMap((row) => parseStoredSmolIds(row.Smols)))
	const { decisions } = await deriveDecisions(rows, publicSmols)
	const current = rows.find((row) => row.Id === id)
	return privateJson(c, {
		error: 'This mixtape was changed somewhere else. Review the latest version and try again.',
		code: 'revision_conflict',
		current: current ? ownerView(current, decisions.get(id), publicSmols) : null,
	}, 409)
}

// ---------------------------------------------------------------------------
// Routes — literal paths are registered BEFORE /:id
// ---------------------------------------------------------------------------

// Owner surfaces never enter a shared cache, whatever the status (auth/validation errors included).
mixtapes.use('/mine', privateNoStore)
mixtapes.use('*', async (c, next) => (c.req.method === 'GET' || c.req.method === 'HEAD' ? next() : privateNoStore(c, next)))

// Public listing: only non-deleted, Tier-1-public mixtapes, re-derived from live Smols.Public on
// every (cache-miss) request so legacy/unclassified rows or songs made private never leak.
mixtapes.get('/', publicCache(), async (c) => {
	const { env } = c

	const { results } = await env.SMOL_D1.prepare(`
		${MIXTAPE_SELECT}
		WHERE Deleted_At IS NULL AND Visibility != 'deleted'
		ORDER BY Created_At DESC, Id DESC
	`).all<MixtapeRow>()

	const publicSmols = await loadPublicSmolRows(env, results.flatMap((row) => parseStoredSmolIds(row.Smols)))
	const { decisions } = await deriveDecisions(results, publicSmols)

	const list = results
		.filter((row) => decisions.get(row.Id)?.visibility === 'public')
		.slice(0, MAX_PUBLIC_LIST)
		.map((row) => ({
			Id: row.Id,
			Title: row.Title,
			Desc: row.Desc ?? '',
			Smols: parseStoredSmolIds(row.Smols).filter((id) => publicSmols.has(id)),
			Address: row.Address,
			Created_At: row.Created_At,
			Updated_At: row.Updated_At ?? row.Created_At,
		}))

	const response = c.json(list)
	response.headers.append('Cache-Tag', 'mixtapes')
	return response
})

// Owner listing: every non-deleted mixtape of the caller, including hidden ones, with coaching.
mixtapes.get('/mine', parseAuth, async (c) => {
	const sub = requireOwnerSub(c)
	const rows = await loadOwnerRows(c.env, sub)
	const publicSmols = await loadPublicSmolRows(c.env, rows.flatMap((row) => parseStoredSmolIds(row.Smols)))
	const { decisions } = await deriveDecisions(rows, publicSmols)
	return privateJson(c, rows.map((row) => ownerView(row, decisions.get(row.Id), publicSmols)))
})

// Pre-publish / pre-edit preview. Tier 1 ONLY: zero inference, zero writes, zero purges.
mixtapes.post('/check-uniqueness', parseAuth, async (c) => {
	const sub = requireOwnerSub(c)
	const body = await readJsonBody(c)
	const editId = body.id === undefined || body.id === null ? null : String(body.id)

	const rows = await loadOwnerRows(c.env, sub)
	const existing = editId ? rows.find((row) => row.Id === editId) : undefined
	if (editId && !existing) {
		const row = await loadMixtapeRow(c.env, editId)
		const foreign = Boolean(row && !row.Deleted_At && row.Address !== sub)
		throw new HTTPException(foreign ? 403 : 404, { message: foreign ? 'Only the mixtape owner can check it' : 'Mixtape not found' })
	}

	// Live coaching preview: the draft may not have a title yet.
	if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
		throw new HTTPException(400, { message: 'Missing or invalid title' })
	}
	const title = typeof body.title === 'string' ? body.title.slice(0, MAX_MIXTAPE_TITLE_LENGTH) : existing?.Title ?? ''
	const desc = body.desc === undefined && existing ? existing.Desc : parseDesc(body.desc)
	const smols = body.smols === undefined && existing
		? parseStoredSmolIds(existing.Smols)
		: parseRequestedSmolIds(body.smols, { allowEmpty: true })

	const draft: MixtapeRow = existing
		? { ...existing, Title: title, Desc: desc, Smols: smols.join(','), Revision: existing.Revision + 1, Ai_Verdict: null }
		: {
			Id: DRAFT_ID,
			Title: title,
			Desc: desc,
			Smols: smols.join(','),
			Address: sub,
			Created_At: new Date().toISOString().slice(0, 19).replace('T', ' '),
			Updated_At: null,
			Deleted_At: null,
			Visibility: 'public',
			Hidden_Reason: null,
			Related_Mixtape_Id: null,
			Uniqueness_Score: null,
			Ai_Verdict: null,
			Revision: 1,
		}
	const draftId = draft.Id
	const hypothetical = [...rows.filter((row) => row.Id !== draftId), draft]

	const publicSmols = await loadPublicSmolRows(c.env, hypothetical.flatMap((row) => parseStoredSmolIds(row.Smols)))
	const before = (await deriveDecisions(rows, publicSmols)).decisions
	const { candidates, decisions } = await deriveDecisions(hypothetical, publicSmols)
	const decision = decisions.get(draftId)!
	const titleOf = (id: string | null) => (id ? hypothetical.find((row) => row.Id === id)?.Title ?? null : null)
	const borderline = decision.visibility === 'public' ? findBorderlinePair(candidates, decisions, draftId) : null
	const borderlinePeer = borderline ? (borderline.a.id === draftId ? borderline.b : borderline.a) : null

	const impacts = rows
		.filter((row) => row.Id !== draftId)
		.map((row) => ({ row, prev: before.get(row.Id), next: decisions.get(row.Id) }))
		.filter(({ prev, next }) => prev?.visibility !== next?.visibility || prev?.hiddenReason !== next?.hiddenReason)
		.map(({ row, next }) => ({
			id: row.Id,
			title: row.Title,
			visibility: next?.visibility ?? 'public',
			hiddenReason: next?.hiddenReason ?? null,
		}))

	return privateJson(c, {
		willBeListed: decision.visibility === 'public',
		visibility: decision.visibility,
		hiddenReason: decision.hiddenReason,
		matchedMixtape: decision.relatedId ? { id: decision.relatedId, title: titleOf(decision.relatedId) } : null,
		advice: decision.advice,
		uniquenessScore: decision.uniquenessScore,
		isBorderline: Boolean(borderline),
		borderlineMixtape: borderlinePeer ? { id: borderlinePeer.id, title: borderlinePeer.title } : null,
		impacts,
	})
})

const REPLAY_POLL_MS = 40
const REPLAY_WAIT_MS = 2000
const MAX_CREATE_ATTEMPTS = 3
const CLAIM_IN_PROGRESS = 0
const CLAIM_FINALIZED = 1
const CLAIM_FAILED = 2
/** An in-progress claim older than this is considered abandoned and may be recovered. */
const CLAIM_STALE_AFTER = '-30 seconds'

type ClaimWait =
	| { state: 'finalized' | 'recoverable'; mixtapeId: string }
	| { state: 'pending' | 'gone' }

/**
 * Wait (briefly) until the winning create has committed its cohort classification, so a
 * concurrent replay reports the same final visibility as the winner's 201. Never reports
 * success for an unfinished or failed classification.
 */
async function awaitClaim(env: Env, key: string): Promise<ClaimWait> {
	const deadline = Date.now() + REPLAY_WAIT_MS
	for (;;) {
		const claim = await env.SMOL_D1.prepare(`
			SELECT Mixtape_Id, Finalized, Created_At <= datetime('now', '${CLAIM_STALE_AFTER}') AS Stale
			FROM MixtapeRetryClaim WHERE Retry_Key = ?1
		`).bind(key).first<{ Mixtape_Id: string; Finalized: number; Stale: number }>()
		if (!claim) return { state: 'gone' }
		if (claim.Finalized === CLAIM_FINALIZED) return { state: 'finalized', mixtapeId: claim.Mixtape_Id }
		if (claim.Finalized === CLAIM_FAILED || claim.Stale) return { state: 'recoverable', mixtapeId: claim.Mixtape_Id }
		if (Date.now() >= deadline) return { state: 'pending' }
		await new Promise((resolve) => setTimeout(resolve, REPLAY_POLL_MS))
	}
}

/**
 * Record the outcome of THIS ownership attempt. Only the attempt holding the current token, while
 * the claim is still in progress, can flip it: an expired holder can never overwrite a recovery.
 */
async function markClaim(env: Env, key: string, mixtapeId: string, token: string, state: typeof CLAIM_FINALIZED | typeof CLAIM_FAILED): Promise<boolean> {
	const result = await env.SMOL_D1.prepare(`
		UPDATE MixtapeRetryClaim SET Finalized = ?4
		WHERE Retry_Key = ?1 AND Mixtape_Id = ?2 AND Attempt_Token = ?3 AND Finalized = ${CLAIM_IN_PROGRESS}
	`).bind(key, mixtapeId, token, state).run()
	return result.meta?.changes === 1
}

interface ClaimedClassification {
	cohort: CohortResult
	outcome: 'finalized' | 'not_committed' | 'superseded' | 'conflict'
}

/**
 * Answer for a claim this request no longer owns (a recovery took it over): the CURRENT committed
 * decision once that claim is finalized, otherwise the retryable pending response. Never the
 * superseded attempt's own, possibly stale, classification.
 */
async function currentClaimResponse(c: Context<HonoEnv>, sub: string, key: string, mixtapeId: string, status: 200 | 201): Promise<Response | null> {
	const claim = await c.env.SMOL_D1.prepare('SELECT Finalized FROM MixtapeRetryClaim WHERE Retry_Key = ?1 AND Mixtape_Id = ?2')
		.bind(key, mixtapeId).first<{ Finalized: number }>()
	if (claim && claim.Finalized !== CLAIM_FINALIZED) return createPending(c)
	// Same rule as every replay: one snapshot row, live, with this exact normalized content.
	// Deleted, edited away, or claim replaced → null (caller re-enters create or answers 409).
	const { rows, publicSmols } = await loadCohortSnapshot(c.env, sub)
	const row = rows.find((candidate) => candidate.Id === mixtapeId)
	if (!claim || !row || await rowRetryKey(row) !== key) return null
	const decision = (await deriveDecisions(rows, publicSmols)).decisions.get(mixtapeId)!
	return privateJson(c, { ...writeReceipt(row, decision), deduplicated: status === 200 }, status)
}

function createConflict(c: Context<HonoEnv>, id?: string) {
	return privateJson(c, { error: 'This mixtape was changed or removed while it was being created; review it and try again', code: 'create_conflict', ...(id ? { id } : {}) }, 409)
}

/**
 * Classify a claimed create (Tier 1 + borderline Tier 2) and flip its claim to FINALIZED only once
 * that classification has actually committed (or was verified current). If every guarded write
 * attempt rolled back, or classification throws, the claim becomes FAILED so a replay can recover
 * the same row; `committed: false` tells the caller to answer with a retryable 503.
 */
async function classifyClaimedCreate(env: Env, sub: string, key: string, mixtapeId: string, token: string): Promise<ClaimedClassification> {
	try {
		const cohort = await reevaluateOwnerCohort(env, sub, { subjectId: mixtapeId, allowAi: true, claim: { key, mixtapeId, token } })
		if (cohort.superseded) return { cohort, outcome: 'superseded' }
		// The owner may have deleted or edited the row while this classification ran: only a row
		// that still has exactly the requested content (same snapshot) may be finalized/reported.
		const row = cohort.rows.find((candidate) => candidate.Id === mixtapeId)
		if (!row || await rowRetryKey(row) !== key) {
			// Owned conflict (we still held the claim and released it as FAILED) vs lost ownership.
			const owned = await markClaim(env, key, mixtapeId, token, CLAIM_FAILED)
			return { cohort, outcome: owned ? 'conflict' : 'superseded' }
		}
		const owned = await markClaim(env, key, mixtapeId, token, cohort.committed ? CLAIM_FINALIZED : CLAIM_FAILED)
		// A recovery took this claim over meanwhile: our classification is no longer authoritative.
		return { cohort, outcome: !owned ? 'superseded' : cohort.committed ? 'finalized' : 'not_committed' }
	} catch (error) {
		await markClaim(env, key, mixtapeId, token, CLAIM_FAILED).catch((markError) => console.warn('mixtape_retry_mark_failed', markError))
		throw error
	}
}

/** Retry identity of a live row's CURRENT content (owner, ordered smols, normalized title & desc). */
function rowRetryKey(row: MixtapeRow): Promise<string> {
	return retryKey(row.Address, row.Smols, row.Title, row.Desc ?? '')
}

function createPending(c: Context<HonoEnv>) {
	return c.json(
		{ error: 'Mixtape creation is still finishing; please retry', code: 'create_pending' },
		503,
		{ ...PRIVATE_HEADERS, 'Retry-After': '1' },
	)
}

// Create new mixtape
mixtapes.post('/', parseAuth, async (c) => {
	const { env } = c
	const sub = requireOwnerSub(c)
	const body = await readJsonBody(c)

	const title = parseTitle(body.title)
	const desc = parseDesc(body.desc)
	const smolIds = parseRequestedSmolIds(body.smols)
	const publicSmolRows = await loadPublicSmolRows(env, smolIds)
	if (publicSmolRows.size !== smolIds.length) {
		throw new HTTPException(400, { message: 'Mixtapes can only include public smols' })
	}
	const smolsString = smolIds.join(',')

	// Idempotent exact retry (double-tap / flaky network / simultaneous POSTs) within 15 minutes.
	// Claim the normalized retry identity and insert the row in ONE batch: whoever holds the claim
	// owns the only row, so no provisional duplicate row is ever created or visible.
	const key = await retryKey(sub, smolsString, title, desc)
	let conflictId: string | undefined
	for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
		// A claim stands while its mixtape is live, inside the window and its CURRENT content still
		// has this retry identity (a no-op PATCH keeps the protection; a real edit releases it).
		const prior = await env.SMOL_D1.prepare(`
			SELECT c.Mixtape_Id AS Mixtape_Id, m.Title AS Title, m.Desc AS Desc, m.Smols AS Smols,
				m."Address" AS Address, m.Revision AS Revision
			FROM MixtapeRetryClaim c LEFT JOIN Mixtapes m ON m.Id = c.Mixtape_Id
			WHERE c.Retry_Key = ?1
		`).bind(key).first<{ Mixtape_Id: string; Title: string | null; Desc: string | null; Smols: string | null; Address: string | null; Revision: number | null }>()
		const priorDiverged = Boolean(prior?.Title !== null && prior?.Title !== undefined
			&& await retryKey(prior.Address!, prior.Smols!, prior.Title, prior.Desc ?? '') !== key)

		const id = newMixtapeId()
		const token = newMixtapeId()
		const results = await env.SMOL_D1.batch([
			env.SMOL_D1.prepare(`DELETE FROM MixtapeRetryClaim WHERE Created_At < datetime('now', '${IDEMPOTENT_RETRY_WINDOW}')`),
			env.SMOL_D1.prepare(`
				DELETE FROM MixtapeRetryClaim
				WHERE Retry_Key = ?1 AND (
					NOT EXISTS (
						SELECT 1 FROM Mixtapes m
						WHERE m.Id = MixtapeRetryClaim.Mixtape_Id AND m.Deleted_At IS NULL
							AND m.Created_At >= datetime('now', '${IDEMPOTENT_RETRY_WINDOW}')
					)
					OR (Mixtape_Id = ?2 AND EXISTS (SELECT 1 FROM Mixtapes m WHERE m.Id = ?2 AND m.Revision = ?3))
				)
			`).bind(key, priorDiverged ? prior!.Mixtape_Id : null, priorDiverged ? prior!.Revision : null),
			env.SMOL_D1.prepare('INSERT OR IGNORE INTO MixtapeRetryClaim (Retry_Key, Mixtape_Id, Attempt_Token) VALUES (?1, ?2, ?3)').bind(key, id, token),
			env.SMOL_D1.prepare(`
				INSERT INTO Mixtapes (Id, Title, Desc, Smols, "Address", Updated_At, Visibility, Revision)
				SELECT ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, 'public', 1
				WHERE EXISTS (SELECT 1 FROM MixtapeRetryClaim WHERE Retry_Key = ?1 AND Mixtape_Id = ?2)
			`).bind(key, id, title, desc, smolsString, sub),
			env.SMOL_D1.prepare(BUMP_EPOCH_SQL),
		])

		if (results[3]?.meta?.changes === 1) {
			return await afterCommit(c, [id], async (purgeIds) => {
				const { cohort, outcome } = await classifyClaimedCreate(env, sub, key, id, token)
				cohort.changedIds.forEach((changed) => purgeIds.add(changed))
				// Never report a classification that never committed; the row stays recoverable.
				if (outcome === 'not_committed') return createPending(c)
				if (outcome === 'conflict') return createConflict(c, id)
				if (outcome === 'superseded') return await currentClaimResponse(c, sub, key, id, 201) ?? createConflict(c, id)
				const view = cohortView(cohort, id)
				if (!view) return createConflict(c, id)
				return privateJson(c, { ...writeReceipt(view.row, view.decision), deduplicated: false }, 201)
			})
		}

		// Replay of an existing claim: wait for the winner, recover a failed/abandoned one.
		let wait = await awaitClaim(env, key)
		let cohort: CohortResult | null = null
		while (wait.state === 'recoverable') {
			const recoveryToken = newMixtapeId()
			const takeover = await env.SMOL_D1.prepare(`
				UPDATE MixtapeRetryClaim SET Finalized = ${CLAIM_IN_PROGRESS}, Created_At = CURRENT_TIMESTAMP, Attempt_Token = ?3
				WHERE Retry_Key = ?1 AND Mixtape_Id = ?2
					AND (Finalized = ${CLAIM_FAILED} OR (Finalized = ${CLAIM_IN_PROGRESS} AND Created_At <= datetime('now', '${CLAIM_STALE_AFTER}')))
			`).bind(key, wait.mixtapeId, recoveryToken).run()
			if (takeover.meta?.changes === 1) {
				// This request now owns recovery of the EXISTING row: classify it (no second insert).
				const recoveredId = wait.mixtapeId
				const recovery = await afterCommit(c, [recoveredId], async (purgeIds) => {
					const result = await classifyClaimedCreate(env, sub, key, recoveredId, recoveryToken)
					result.cohort.changedIds.forEach((changed) => purgeIds.add(changed))
					return result
				})
				if (recovery.outcome === 'not_committed') return createPending(c)
				if (recovery.outcome === 'conflict') {
					// The owner deleted/edited the row while WE held recovery: nobody else is working
					// on this claim, so go straight back into the bounded atomic replacement check.
					conflictId = recoveredId
					cohort = null
					wait = { state: 'gone' }
					break
				}
				if (recovery.outcome === 'superseded') {
					const current = await currentClaimResponse(c, sub, key, recoveredId, 200)
					if (current) return current
					conflictId = recoveredId
					cohort = null
					wait = { state: 'gone' }
					break // re-enter the bounded, atomic claim check
				}
				cohort = recovery.cohort
				wait = { state: 'finalized', mixtapeId: recoveredId }
				break
			}
			wait = await awaitClaim(env, key) // someone else recovered it first
		}
		if (wait.state === 'pending') return createPending(c)
		if (wait.state !== 'finalized') continue // claim vanished: claim again

		// Build the receipt from ONE cohort snapshot, and only if that very row is live and still
		// has this exact normalized content (owner, ordered smols, title, description).
		const snapshot = cohort ?? { ...(await loadCohortSnapshot(env, sub)), decisions: null }
		const row = snapshot.rows.find((candidate) => candidate.Id === wait.mixtapeId)
		if (!row || await rowRetryKey(row) !== key) {
			conflictId = wait.mixtapeId
			// Deleted or edited away since the claim. Never release it here: the next iteration's
			// replacement batch re-validates the claim (still absent / still divergent) and replaces
			// it together with the new row in ONE transaction, so an Undo/restore at any point in
			// between keeps the original as the only live copy.
			continue
		}
		const decisions = snapshot.decisions ?? (await deriveDecisions(snapshot.rows, snapshot.publicSmols)).decisions
		const decision = decisions.get(row.Id)
		if (!decision) continue
		return privateJson(c, { ...writeReceipt(row, decision), deduplicated: true })
	}
	return createConflict(c, conflictId)
})

/** Terminal live target of a merged mixtape. Cycle-safe, no hop limit (writes flatten aliases). */
async function resolveMergeTarget(env: Env, row: MixtapeRow): Promise<MixtapeRow | null> {
	const seen = new Set<string>([row.Id])
	let current: MixtapeRow | null = row
	while (current && current.Deleted_At && current.Hidden_Reason === 'merged' && current.Related_Mixtape_Id) {
		if (seen.has(current.Related_Mixtape_Id)) return null
		seen.add(current.Related_Mixtape_Id)
		current = await loadMixtapeRow(env, current.Related_Mixtape_Id)
	}
	return current && !current.Deleted_At ? current : null
}

// Get single mixtape by ID. Public or owner-hidden rows are playable unlisted links (200).
mixtapes.get('/:id', publicCache(), async (c) => {
	const { env } = c
	const id = c.req.param('id')

	const mixtapeRow = await loadMixtapeRow(env, id)
	if (!mixtapeRow) {
		return c.json({ error: 'Mixtape not found' }, 404)
	}

	if (mixtapeRow.Deleted_At || mixtapeRow.Visibility === 'deleted') {
		if (mixtapeRow.Hidden_Reason === 'merged') {
			const target = await resolveMergeTarget(env, mixtapeRow)
			if (target) {
				return c.json({ error: 'This mixtape was merged into another mixtape', code: 'mixtape_merged', mergedInto: target.Id }, 404)
			}
		}
		return c.json({ error: 'Mixtape not found' }, 404)
	}

	const cohortRows = await loadOwnerRows(env, mixtapeRow.Address)
	const publicSmolRows = await loadPublicSmolRows(env, cohortRows.flatMap((row) => parseStoredSmolIds(row.Smols)))
	const { decisions } = await deriveDecisions(cohortRows, publicSmolRows)
	const decision = decisions.get(id)
	const smolRows = parseStoredSmolIds(mixtapeRow.Smols)
		.map((smolId) => publicSmolRows.get(smolId))
		.filter((row): row is MixtapeSmolRow => Boolean(row))

	// Fetch KV data in bulk (up to 100 keys at once)
	const publicSmolIds = smolRows.map((row) => row.Id)
	const kvData = publicSmolIds.length > 0
		? await env.SMOL_KV.get<SmolKVData>(publicSmolIds, 'json')
		: new Map<string, SmolKVData | null>()

	const smolsWithKV = smolRows.map((row) => ({
		Id: row.Id,
		Title: row.Title,
		Address: row.Address,
		Mint_Token: row.Mint_Token,
		Mint_Amm: row.Mint_Amm,
		Song_1: row.Song_1,
		Public: row.Public,
		Tags: kvData.get(row.Id)?.lyrics?.style || [],
	}))

	const view = ownerView(mixtapeRow, decision, publicSmolRows)
	const response = c.json({
		Id: view.Id,
		Title: view.Title,
		Desc: view.Desc,
		Address: view.Address,
		Created_At: view.Created_At,
		Updated_At: view.Updated_At,
		Smols: smolsWithKV,
		Visibility: view.Visibility,
		Hidden_Reason: view.Hidden_Reason,
		Related_Mixtape_Id: view.Related_Mixtape_Id,
		Related_Mixtape_Title: view.Related_Mixtape_Title,
		Uniqueness_Score: view.Uniqueness_Score,
		Advice: view.Advice,
		Revision: view.Revision,
		Stored_Track_Count: view.Stored_Track_Count,
		Public_Track_Count: view.Public_Track_Count,
	})

	response.headers.append('Cache-Tag', 'mixtapes')
	response.headers.append('Cache-Tag', `mixtape:${id}`)
	if (view.Visibility !== 'public') {
		response.headers.set('X-Robots-Tag', 'noindex')
	}

	return response
})

// Edit (PUT = full replace of title/desc/smols; PATCH = any subset). Owner-only.
async function updateMixtape(c: Context<HonoEnv>, mode: 'put' | 'patch') {
	const { env } = c
	const sub = requireOwnerSub(c)
	const id = c.req.param('id')!
	const body = await readJsonBody(c)
	const expectedRevision = parseExpectedRevision(body.expectedRevision)

	if (mode === 'patch' && body.title === undefined && body.desc === undefined && body.smols === undefined) {
		throw new HTTPException(400, { message: 'Nothing to update' })
	}

	const row = await loadOwnedLiveRow(env, id, sub)
	if (expectedRevision !== undefined && expectedRevision !== row.Revision) {
		return await revisionConflict(c, id, sub)
	}

	const title = mode === 'put' || body.title !== undefined ? parseTitle(body.title) : row.Title
	const desc = mode === 'put' || body.desc !== undefined ? parseDesc(body.desc) : row.Desc
	let smols = row.Smols
	if (mode === 'put' || body.smols !== undefined) {
		const smolIds = parseRequestedSmolIds(body.smols)
		const publicSmolRows = await loadPublicSmolRows(env, smolIds)
		if (publicSmolRows.size !== smolIds.length) {
			throw new HTTPException(400, { message: 'Mixtapes can only include public smols' })
		}
		smols = smolIds.join(',')
	}

	const [updated] = await env.SMOL_D1.batch([
		env.SMOL_D1.prepare(`
			UPDATE Mixtapes
			SET Title = ?1, Desc = ?2, Smols = ?3, Revision = Revision + 1, Updated_At = CURRENT_TIMESTAMP
			WHERE Id = ?4 AND "Address" = ?5 AND Deleted_At IS NULL AND Revision = ?6
		`).bind(title, desc, smols, id, sub, row.Revision),
		env.SMOL_D1.prepare(BUMP_EPOCH_SQL),
	])
	if (updated?.meta?.changes !== 1) {
		return await revisionConflict(c, id, sub)
	}

	return await afterCommit(c, [id], async (purgeIds) => {
		const cohort = await reevaluateOwnerCohort(env, sub, { subjectId: id, allowAi: true })
		cohort.changedIds.forEach((changed) => purgeIds.add(changed))
		const result = cohortView(cohort, id)
		if (!result) return concurrentDelete(c, id)
		return privateJson(c, { ...writeReceipt(result.row, result.decision), mixtape: result.view })
	})
}

mixtapes.put('/:id', parseAuth, (c) => updateMixtape(c, 'put'))
mixtapes.patch('/:id', parseAuth, (c) => updateMixtape(c, 'patch'))

// Soft delete (undoable). Only the playlist record changes; songs and tokens are untouched.
mixtapes.delete('/:id', parseAuth, async (c) => {
	const { env } = c
	const sub = requireOwnerSub(c)
	const id = c.req.param('id')

	const existing = await loadMixtapeRow(env, id)
	if (!existing) {
		throw new HTTPException(404, { message: 'Mixtape not found' })
	}
	if (existing.Address !== sub) {
		throw new HTTPException(403, { message: 'Only the mixtape owner can delete it' })
	}
	if (existing.Deleted_At) {
		if (existing.Hidden_Reason === 'merged') {
			return privateJson(c, { error: 'This mixtape was merged into another mixtape', code: 'mixtape_merged', mergedInto: existing.Related_Mixtape_Id }, 409)
		}
		return privateJson(c, { id, deleted: true, undoable: true })
	}

	await env.SMOL_D1.batch([
		env.SMOL_D1.prepare(`
			UPDATE Mixtapes
			SET Deleted_At = CURRENT_TIMESTAMP, Updated_At = CURRENT_TIMESTAMP, Visibility = 'deleted',
				Hidden_Reason = 'deleted', Related_Mixtape_Id = NULL, Uniqueness_Score = NULL, Revision = Revision + 1
			WHERE Id = ?1 AND "Address" = ?2 AND Deleted_At IS NULL
		`).bind(id, sub),
		env.SMOL_D1.prepare(BUMP_EPOCH_SQL),
	])

	return await afterCommit(c, [id], async (purgeIds) => {
		const cohort = await reevaluateOwnerCohort(env, sub, { allowAi: false })
		cohort.changedIds.forEach((changed) => purgeIds.add(changed))
		return privateJson(c, { id, deleted: true, undoable: true })
	})
})

// Undo a soft delete (merged sources cannot be restored; their songs already live in the target).
mixtapes.post('/:id/restore', parseAuth, async (c) => {
	const { env } = c
	const sub = requireOwnerSub(c)
	const id = c.req.param('id')

	const existing = await loadMixtapeRow(env, id)
	if (!existing) {
		throw new HTTPException(404, { message: 'Mixtape not found' })
	}
	if (existing.Address !== sub) {
		throw new HTTPException(403, { message: 'Only the mixtape owner can restore it' })
	}
	if (existing.Deleted_At && existing.Hidden_Reason === 'merged') {
		return privateJson(c, { error: 'Merged mixtapes cannot be restored', code: 'mixtape_merged', mergedInto: existing.Related_Mixtape_Id }, 409)
	}

	if (existing.Deleted_At) {
		await env.SMOL_D1.batch([
			env.SMOL_D1.prepare(`
				UPDATE Mixtapes
				SET Deleted_At = NULL, Updated_At = CURRENT_TIMESTAMP, Visibility = 'public',
					Hidden_Reason = NULL, Related_Mixtape_Id = NULL, Revision = Revision + 1
				WHERE Id = ?1 AND "Address" = ?2 AND Deleted_At IS NOT NULL AND Hidden_Reason = 'deleted'
			`).bind(id, sub),
			env.SMOL_D1.prepare(BUMP_EPOCH_SQL),
		])
	}

	return await afterCommit(c, [id], async (purgeIds) => {
		const cohort = await reevaluateOwnerCohort(env, sub, { allowAi: false })
		cohort.changedIds.forEach((changed) => purgeIds.add(changed))
		const result = cohortView(cohort, id)
		if (!result) return concurrentDelete(c, id, 'Mixtape was deleted concurrently after restore')
		return privateJson(c, { ...writeReceipt(result.row, result.decision), restored: true, mixtape: result.view })
	})
})

// Merge source (:id) into targetId. Owner of BOTH. Appends the source's songs that the target
// doesn't have (source order), then soft-deletes the source as 'merged' → target.
mixtapes.post('/:id/merge', parseAuth, async (c) => {
	const { env } = c
	const sub = requireOwnerSub(c)
	const sourceId = c.req.param('id')
	const body = await readJsonBody(c)

	if (typeof body.targetId !== 'string' || !body.targetId.trim()) {
		throw new HTTPException(400, { message: 'Missing targetId' })
	}
	const targetId = body.targetId.trim()
	if (targetId === sourceId) {
		throw new HTTPException(400, { message: 'A mixtape cannot be merged into itself' })
	}

	// One read for both rows: the batch below requires exactly these two revisions.
	const { results: pairRows } = await env.SMOL_D1.prepare(`${MIXTAPE_SELECT} WHERE Id IN (?1, ?2)`).bind(sourceId, targetId).all<MixtapeRow>()
	const source = assertOwnedLive(pairRows.find((row) => row.Id === sourceId), sub)
	const target = assertOwnedLive(pairRows.find((row) => row.Id === targetId), sub)
	const title = body.title !== undefined ? parseTitle(body.title) : target.Title
	const desc = body.desc !== undefined ? parseDesc(body.desc) : target.Desc

	const targetIds = parseStoredSmolIds(target.Smols)
	const sourceIds = parseStoredSmolIds(source.Smols)
	const sourcePublic = await loadPublicSmolRows(env, sourceIds)
	const targetSet = new Set(targetIds)

	// The source is tombstoned for good, so never silently drop songs it still references.
	const unavailableCount = sourceIds.filter((id) => !sourcePublic.has(id) && !targetSet.has(id)).length
	if (unavailableCount > 0) {
		return privateJson(c, {
			error: `${unavailableCount} song${unavailableCount === 1 ? ' in this mixtape is' : 's in this mixtape are'} not public right now, so merging would lose ${unavailableCount === 1 ? 'it' : 'them'}. Remove ${unavailableCount === 1 ? 'it' : 'them'} first, or wait until ${unavailableCount === 1 ? 'it is' : 'they are'} public again.`,
			code: 'merge_unavailable_tracks',
			unavailableCount,
		}, 409)
	}

	const added = sourceIds.filter((id) => !targetSet.has(id))
	const merged = [...targetIds, ...added]
	if (merged.length > MAX_MIXTAPE_SMOLS) {
		throw new HTTPException(400, { message: `Merged mixtape would have ${merged.length} songs (max ${MAX_MIXTAPE_SMOLS})` })
	}
	const mergedSmols = merged.join(',')

	// One D1 batch = one transaction. Statement 1 updates the target ONLY if the target AND the
	// source are both still live at exactly the revisions read above; if it changed nothing,
	// statement 2 violates CHECK (Epoch >= 0) and the whole batch rolls back. Statement 3 then
	// tombstones the source under the same exact precondition (guarded the same way), and
	// statement 5 flattens older aliases straight to the target so chains stay one hop.
	// A competing merge/edit can therefore never touch either row on behalf of a loser.
	try {
		await env.SMOL_D1.batch([
			env.SMOL_D1.prepare(`
				UPDATE Mixtapes
				SET Smols = ?1, Title = ?2, Desc = ?3, Revision = Revision + 1, Updated_At = CURRENT_TIMESTAMP
				WHERE Id = ?4 AND "Address" = ?5 AND Deleted_At IS NULL AND Revision = ?6
					AND EXISTS (SELECT 1 FROM Mixtapes WHERE Id = ?7 AND "Address" = ?5 AND Deleted_At IS NULL AND Revision = ?8)
			`).bind(mergedSmols, title, desc, targetId, sub, target.Revision, sourceId, source.Revision),
			env.SMOL_D1.prepare(ABORT_IF_PREVIOUS_MISSED_SQL),
			env.SMOL_D1.prepare(`
				UPDATE Mixtapes
				SET Deleted_At = CURRENT_TIMESTAMP, Updated_At = CURRENT_TIMESTAMP, Visibility = 'deleted',
					Hidden_Reason = 'merged', Related_Mixtape_Id = ?1, Uniqueness_Score = NULL, Revision = Revision + 1
				WHERE Id = ?2 AND "Address" = ?3 AND Deleted_At IS NULL AND Revision = ?4
			`).bind(targetId, sourceId, sub, source.Revision),
			env.SMOL_D1.prepare(ABORT_IF_PREVIOUS_MISSED_SQL),
			env.SMOL_D1.prepare(`
				UPDATE Mixtapes SET Related_Mixtape_Id = ?1
				WHERE "Address" = ?2 AND Deleted_At IS NOT NULL AND Hidden_Reason = 'merged' AND Related_Mixtape_Id = ?3
			`).bind(targetId, sub, sourceId),
			env.SMOL_D1.prepare(BUMP_EPOCH_SQL),
		])
	} catch (error) {
		if (!isGuardAbort(error)) throw error
		return await revisionConflict(c, targetId, sub)
	}

	return await afterCommit(c, [sourceId, targetId], async (purgeIds) => {
		const cohort = await reevaluateOwnerCohort(env, sub, { allowAi: false })
		cohort.changedIds.forEach((changed) => purgeIds.add(changed))
		// The merge itself committed (source tombstoned); a target deleted right afterwards is an
		// expected owner race, reported explicitly rather than as a server error.
		const result = cohortView(cohort, targetId)
		return privateJson(c, {
			targetId,
			mergedId: sourceId,
			addedCount: added.length,
			totalTracks: merged.length,
			target: result?.view ?? null,
			...(result ? {} : { targetDeletedConcurrently: true }),
		})
	})
})

export default mixtapes
