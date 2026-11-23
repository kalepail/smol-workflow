import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cache } from 'hono/cache'
import type { HonoEnv, SmolKVData } from '../types'
import { parseAuth } from '../middleware/auth'
import { purgeMixtapeCache } from '../utils/cache'
import {
	applySemanticDuplicates,
	classifyOwnerMixtapes,
	dedupeOrdered,
	findBorderlinePair,
	normalizeMixtapeText,
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
const MAX_MERGE_HOPS = 10
const DRAFT_ID = '__draft__'

const PUBLIC_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=120'
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

/** Compact persisted clef-flash receipt (`Mixtapes.Ai_Verdict`). `pair`/`revs` are aligned and sorted by Id. */
interface AiVerdictReceipt {
	v: 1
	pv: number
	model: string
	pair: [string, string]
	revs: [number, number]
	p?: number
	dup?: boolean
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

// ---------------------------------------------------------------------------
// Derivation (Tier 1 + persisted Tier 2 overlay). Pure given rows + public songs.
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

/** A receipt is only trusted while both mixtapes are still at the revisions it judged. */
function receiptIsCurrent(receipt: AiVerdictReceipt, revisions: ReadonlyMap<string, number>): boolean {
	return !receipt.fallback
		&& typeof receipt.p === 'number'
		&& receipt.pv === MIXTAPE_DEDUPE_PROMPT_VERSION
		&& revisions.get(receipt.pair[0]) === receipt.revs[0]
		&& revisions.get(receipt.pair[1]) === receipt.revs[1]
}

function deriveDecisions(rows: MixtapeRow[], publicSmols: ReadonlyMap<string, unknown>) {
	const candidates = rows.map((row) => toCandidate(row, publicSmols))
	const decisions = classifyOwnerMixtapes(candidates)
	const revisions = new Map(rows.map((row) => [row.Id, row.Revision]))
	const verdicts: SemanticDuplicateVerdict[] = []
	for (const row of rows) {
		const receipt = parseReceipt(row.Ai_Verdict)
		if (receipt?.dup && receipt.hidden === row.Id && receipt.keep && receiptIsCurrent(receipt, revisions)) {
			verdicts.push({ hiddenId: row.Id, keeperId: receipt.keep, pDuplicate: receipt.p! })
		}
	}
	applySemanticDuplicates(candidates, decisions, verdicts)
	return { candidates, decisions, revisions }
}

// ---------------------------------------------------------------------------
// Write-time cohort re-evaluation (Tier 1 + optional top-1 borderline Tier 2)
// ---------------------------------------------------------------------------

interface CohortResult {
	rows: MixtapeRow[]
	decisions: Map<string, MixtapeDecision>
	publicSmols: Map<string, MixtapeSmolRow>
	changedIds: string[]
}

async function reevaluateOwnerCohort(
	env: Env,
	address: string,
	options: { subjectId?: string; allowAi: boolean },
): Promise<CohortResult> {
	const rows = await loadOwnerRows(env, address)
	const publicSmols = await loadPublicSmolRows(env, rows.flatMap((row) => parseStoredSmolIds(row.Smols)))
	const { candidates, decisions, revisions } = deriveDecisions(rows, publicSmols)
	const newReceipts = new Map<string, AiVerdictReceipt>()

	const subjectId = options.subjectId
	if (options.allowAi && subjectId && decisions.get(subjectId)?.visibility === 'public') {
		const pair = findBorderlinePair(candidates, decisions, subjectId)
		if (pair) {
			const ids = pairKey(pair.a.id, pair.b.id)
			// Every AI-eligible write bumps the subject's Revision, so prior receipts for this
			// pair are never current here: always adjudicate fresh (one call, fail-open).
			const revs: [number, number] = [revisions.get(ids[0]) ?? 1, revisions.get(ids[1]) ?? 1]
			const titles = new Map([...publicSmols.values()].map((smol) => [smol.Id, smol.Title]))
			const result = await adjudicateMixtapePair(env, pair.a, pair.b, titles)
			const base = { v: 1 as const, pv: MIXTAPE_DEDUPE_PROMPT_VERSION, pair: ids, revs, at: new Date().toISOString() }
			if (result.ok) {
				const keeper = strongerOf(pair.a, pair.b)
				const hidden = keeper.id === pair.a.id ? pair.b : pair.a
				const receipt: AiVerdictReceipt = {
					...base,
					model: result.verdict.model,
					p: Math.round(result.verdict.pDuplicate * 10_000) / 10_000,
					dup: result.verdict.isDuplicate,
					rel: result.verdict.relation,
					keep: result.verdict.isDuplicate ? keeper.id : null,
					hidden: result.verdict.isDuplicate ? hidden.id : null,
					ms: result.verdict.latencyMs,
				}
				if (result.verdict.isDuplicate) {
					applySemanticDuplicates(candidates, decisions, [{ hiddenId: hidden.id, keeperId: keeper.id, pDuplicate: result.verdict.pDuplicate }])
					newReceipts.set(hidden.id, receipt)
				} else {
					newReceipts.set(subjectId, receipt)
				}
			} else if (result.reason !== 'disabled') {
				newReceipts.set(subjectId, { ...base, model: MIXTAPE_DEDUPE_MODEL_SELECTOR, fallback: result.reason, ms: result.latencyMs })
			}
		}
	}

	const statements: D1PreparedStatement[] = []
	const changedIds: string[] = []
	for (const row of rows) {
		const decision = decisions.get(row.Id)!
		const receipt = newReceipts.get(row.Id)
		const aiVerdict = receipt ? JSON.stringify(receipt) : row.Ai_Verdict
		const changed = row.Visibility !== decision.visibility
			|| row.Hidden_Reason !== decision.hiddenReason
			|| row.Related_Mixtape_Id !== decision.relatedId
			|| row.Uniqueness_Score !== decision.uniquenessScore
			|| row.Ai_Verdict !== aiVerdict
		if (!changed) continue
		changedIds.push(row.Id)
		statements.push(env.SMOL_D1.prepare(`
			UPDATE Mixtapes
			SET Visibility = ?1, Hidden_Reason = ?2, Related_Mixtape_Id = ?3, Uniqueness_Score = ?4, Ai_Verdict = ?5
			WHERE Id = ?6 AND Deleted_At IS NULL
		`).bind(decision.visibility, decision.hiddenReason, decision.relatedId, decision.uniquenessScore, aiVerdict, row.Id))
		Object.assign(row, {
			Visibility: decision.visibility,
			Hidden_Reason: decision.hiddenReason,
			Related_Mixtape_Id: decision.relatedId,
			Uniqueness_Score: decision.uniquenessScore,
			Ai_Verdict: aiVerdict,
		})
	}
	if (statements.length) await env.SMOL_D1.batch(statements)

	return { rows, decisions, publicSmols, changedIds }
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

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

function cohortView(cohort: CohortResult, id: string) {
	const row = cohort.rows.find((r) => r.Id === id)
	if (!row) throw new HTTPException(500, { message: 'Mixtape vanished during re-evaluation' })
	const decision = cohort.decisions.get(id)!
	return { row, decision, view: ownerView(row, decision, cohort.publicSmols) }
}

function privateJson(c: Context<HonoEnv>, body: unknown, status: 200 | 201 | 404 | 409 = 200) {
	return c.json(body, status, { ...PRIVATE_HEADERS })
}

function purge(c: Context<HonoEnv>, ids: Iterable<string>) {
	c.executionCtx.waitUntil(purgeMixtapeCache([...new Set(ids)]))
}

/** Load a live mixtape for an owner mutation: 404 when missing/deleted, 403 when not the owner. */
async function loadOwnedLiveRow(env: Env, id: string, sub: string): Promise<MixtapeRow> {
	const row = await loadMixtapeRow(env, id)
	if (!row || row.Deleted_At || row.Visibility === 'deleted') {
		throw new HTTPException(404, { message: 'Mixtape not found' })
	}
	if (row.Address !== sub) {
		throw new HTTPException(403, { message: 'Only the mixtape owner can change it' })
	}
	return row
}

async function revisionConflict(c: Context<HonoEnv>, id: string, address: string) {
	const rows = await loadOwnerRows(c.env, address)
	const publicSmols = await loadPublicSmolRows(c.env, rows.flatMap((row) => parseStoredSmolIds(row.Smols)))
	const { decisions } = deriveDecisions(rows, publicSmols)
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

// Public listing: only non-deleted, Tier-1-public mixtapes, re-derived from live Smols.Public on
// every (cache-miss) request so legacy/unclassified rows or songs made private never leak.
mixtapes.get(
	'/',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: PUBLIC_CACHE_CONTROL,
	}),
	async (c) => {
		const { env } = c

		const { results } = await env.SMOL_D1.prepare(`
			${MIXTAPE_SELECT}
			WHERE Deleted_At IS NULL AND Visibility != 'deleted'
			ORDER BY Created_At DESC, Id DESC
		`).all<MixtapeRow>()

		const publicSmols = await loadPublicSmolRows(env, results.flatMap((row) => parseStoredSmolIds(row.Smols)))
		const { decisions } = deriveDecisions(results, publicSmols)

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
	}
)

// Owner listing: every non-deleted mixtape of the caller, including hidden ones, with coaching.
mixtapes.get('/mine', parseAuth, async (c) => {
	const sub = requireOwnerSub(c)
	const rows = await loadOwnerRows(c.env, sub)
	const publicSmols = await loadPublicSmolRows(c.env, rows.flatMap((row) => parseStoredSmolIds(row.Smols)))
	const { decisions } = deriveDecisions(rows, publicSmols)
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
		throw new HTTPException(row && !row.Deleted_At && row.Address !== sub ? 403 : 404, {
			message: row && !row.Deleted_At && row.Address !== sub ? 'Only the mixtape owner can check it' : 'Mixtape not found',
		})
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
	const before = deriveDecisions(rows, publicSmols).decisions
	const { candidates, decisions } = deriveDecisions(hypothetical, publicSmols)
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

	// Idempotent exact retry (double-tap / flaky network) within 15 minutes → return the original.
	const { results: recent } = await env.SMOL_D1.prepare(`
		${MIXTAPE_SELECT}
		WHERE "Address" = ?1 AND Smols = ?2 AND Deleted_At IS NULL
			AND Created_At >= datetime('now', '${IDEMPOTENT_RETRY_WINDOW}')
		ORDER BY Created_At ASC, Id ASC
	`).bind(sub, smolsString).all<MixtapeRow>()
	const retryOf = recent.find((row) => normalizeMixtapeText(row.Title) === normalizeMixtapeText(title)
		&& normalizeMixtapeText(row.Desc) === normalizeMixtapeText(desc))
	if (retryOf) {
		const rows = await loadOwnerRows(env, sub)
		const publicSmols = await loadPublicSmolRows(env, rows.flatMap((row) => parseStoredSmolIds(row.Smols)))
		const { decisions } = deriveDecisions(rows, publicSmols)
		return privateJson(c, { ...writeReceipt(retryOf, decisions.get(retryOf.Id)!), deduplicated: true })
	}

	const inserted = await env.SMOL_D1.prepare(`
		INSERT INTO Mixtapes (Title, Desc, Smols, "Address", Updated_At, Visibility, Revision)
		VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, 'public', 1)
		RETURNING Id
	`)
		.bind(title, desc, smolsString, sub)
		.first<{ Id: string }>()
	const id = inserted!.Id

	const cohort = await reevaluateOwnerCohort(env, sub, { subjectId: id, allowAi: true })
	const { row, decision } = cohortView(cohort, id)
	purge(c, [id, ...cohort.changedIds])

	return privateJson(c, { ...writeReceipt(row, decision), deduplicated: false }, 201)
})

// Get single mixtape by ID. Public or owner-hidden rows are playable unlisted links (200).
mixtapes.get(
	'/:id',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: PUBLIC_CACHE_CONTROL,
	}),
	async (c) => {
		const { env } = c
		const id = c.req.param('id')

		const mixtapeRow = await loadMixtapeRow(env, id)
		if (!mixtapeRow) {
			return c.json({ error: 'Mixtape not found' }, 404)
		}

		if (mixtapeRow.Deleted_At || mixtapeRow.Visibility === 'deleted') {
			if (mixtapeRow.Hidden_Reason === 'merged' && mixtapeRow.Related_Mixtape_Id) {
				let target = await loadMixtapeRow(env, mixtapeRow.Related_Mixtape_Id)
				for (let hop = 0; target?.Deleted_At && target.Hidden_Reason === 'merged' && target.Related_Mixtape_Id && hop < MAX_MERGE_HOPS; hop += 1) {
					target = await loadMixtapeRow(env, target.Related_Mixtape_Id)
				}
				if (target && !target.Deleted_At) {
					return c.json({ error: 'This mixtape was merged into another mixtape', code: 'mixtape_merged', mergedInto: target.Id }, 404)
				}
			}
			return c.json({ error: 'Mixtape not found' }, 404)
		}

		const cohortRows = await loadOwnerRows(env, mixtapeRow.Address)
		const publicSmolRows = await loadPublicSmolRows(env, cohortRows.flatMap((row) => parseStoredSmolIds(row.Smols)))
		const { decisions } = deriveDecisions(cohortRows, publicSmolRows)
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
	}
)

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

	const updated = await env.SMOL_D1.prepare(`
		UPDATE Mixtapes
		SET Title = ?1, Desc = ?2, Smols = ?3, Revision = Revision + 1, Updated_At = CURRENT_TIMESTAMP
		WHERE Id = ?4 AND "Address" = ?5 AND Deleted_At IS NULL AND Revision = ?6
		RETURNING Id
	`).bind(title, desc, smols, id, sub, row.Revision).first<{ Id: string }>()
	if (!updated) {
		return await revisionConflict(c, id, sub)
	}

	const cohort = await reevaluateOwnerCohort(env, sub, { subjectId: id, allowAi: true })
	const result = cohortView(cohort, id)
	purge(c, [id, ...cohort.changedIds])

	return privateJson(c, { ...writeReceipt(result.row, result.decision), mixtape: result.view })
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

	await env.SMOL_D1.prepare(`
		UPDATE Mixtapes
		SET Deleted_At = CURRENT_TIMESTAMP, Updated_At = CURRENT_TIMESTAMP, Visibility = 'deleted',
			Hidden_Reason = 'deleted', Related_Mixtape_Id = NULL, Uniqueness_Score = NULL, Revision = Revision + 1
		WHERE Id = ?1 AND "Address" = ?2 AND Deleted_At IS NULL
	`).bind(id, sub).run()

	const cohort = await reevaluateOwnerCohort(env, sub, { allowAi: false })
	purge(c, [id, ...cohort.changedIds])

	return privateJson(c, { id, deleted: true, undoable: true })
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
		await env.SMOL_D1.prepare(`
			UPDATE Mixtapes
			SET Deleted_At = NULL, Updated_At = CURRENT_TIMESTAMP, Visibility = 'public',
				Hidden_Reason = NULL, Related_Mixtape_Id = NULL, Revision = Revision + 1
			WHERE Id = ?1 AND "Address" = ?2 AND Deleted_At IS NOT NULL AND Hidden_Reason = 'deleted'
		`).bind(id, sub).run()
	}

	const cohort = await reevaluateOwnerCohort(env, sub, { allowAi: false })
	const result = cohortView(cohort, id)
	purge(c, [id, ...cohort.changedIds])

	return privateJson(c, { ...writeReceipt(result.row, result.decision), restored: true, mixtape: result.view })
})

// Merge source (:id) into targetId. Owner of BOTH. Appends the source's public songs that the
// target doesn't have (source order), then soft-deletes the source as 'merged' → target.
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

	const source = await loadOwnedLiveRow(env, sourceId, sub)
	const target = await loadOwnedLiveRow(env, targetId, sub)
	const title = body.title !== undefined ? parseTitle(body.title) : target.Title
	const desc = body.desc !== undefined ? parseDesc(body.desc) : target.Desc

	const targetIds = parseStoredSmolIds(target.Smols)
	const sourceIds = parseStoredSmolIds(source.Smols)
	const sourcePublic = await loadPublicSmolRows(env, sourceIds)
	const targetSet = new Set(targetIds)
	const added = sourceIds.filter((id) => sourcePublic.has(id) && !targetSet.has(id))
	const merged = [...targetIds, ...added]
	if (merged.length > MAX_MIXTAPE_SMOLS) {
		throw new HTTPException(400, { message: `Merged mixtape would have ${merged.length} songs (max ${MAX_MIXTAPE_SMOLS})` })
	}
	const mergedSmols = merged.join(',')

	// One D1 batch = one transaction; each statement re-asserts the other row's state so
	// either both rows change or neither does (concurrent edits → 409).
	const [targetResult] = await env.SMOL_D1.batch([
		env.SMOL_D1.prepare(`
			UPDATE Mixtapes
			SET Smols = ?1, Title = ?2, Desc = ?3, Revision = Revision + 1, Updated_At = CURRENT_TIMESTAMP
			WHERE Id = ?4 AND "Address" = ?5 AND Deleted_At IS NULL AND Revision = ?6
				AND EXISTS (SELECT 1 FROM Mixtapes WHERE Id = ?7 AND "Address" = ?5 AND Deleted_At IS NULL AND Revision = ?8)
		`).bind(mergedSmols, title, desc, targetId, sub, target.Revision, sourceId, source.Revision),
		env.SMOL_D1.prepare(`
			UPDATE Mixtapes
			SET Deleted_At = CURRENT_TIMESTAMP, Updated_At = CURRENT_TIMESTAMP, Visibility = 'deleted',
				Hidden_Reason = 'merged', Related_Mixtape_Id = ?1, Uniqueness_Score = NULL, Revision = Revision + 1
			WHERE Id = ?2 AND "Address" = ?3 AND Deleted_At IS NULL AND Revision = ?4
				AND EXISTS (SELECT 1 FROM Mixtapes WHERE Id = ?1 AND Revision = ?5 AND Smols = ?6 AND Deleted_At IS NULL)
		`).bind(targetId, sourceId, sub, source.Revision, target.Revision + 1, mergedSmols),
	])
	if (!targetResult?.meta?.changes) {
		return await revisionConflict(c, targetId, sub)
	}

	const cohort = await reevaluateOwnerCohort(env, sub, { allowAi: false })
	const result = cohortView(cohort, targetId)
	purge(c, [sourceId, targetId, ...cohort.changedIds])

	return privateJson(c, {
		targetId,
		mergedId: sourceId,
		addedCount: added.length,
		totalTracks: merged.length,
		target: result.view,
	})
})

export default mixtapes
