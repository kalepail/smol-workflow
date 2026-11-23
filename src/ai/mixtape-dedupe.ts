/**
 * Mixtape uniqueness — Tier 2 semantic tie-breaker (`@cf/cloudflare/clef-flash`).
 *
 * Contract (MIXTAPE_DEDUPE_SPEC.md §2, reports/25 §1.3 & §5):
 *  - WRITE-TIME ONLY (POST /mixtapes, PUT/PATCH /mixtapes/:id) and only for the top-1
 *    same-owner borderline pair found by Tier 1. GET routes and check-uniqueness never
 *    import or call this module.
 *  - Gated by `MIXTAPE_DEDUPE_AI_ENABLED` (enabled unless exactly "false").
 *  - 1,500 ms hard timeout, strict response validation, and FAIL-OPEN: any error,
 *    timeout or malformed payload returns `{ ok: false }` and Tier 1 stands.
 *  - Questions/criteria are server constants; editorial text only travels as `state` data.
 */
import { dedupeOrdered, pairMetrics, type MixtapeCandidate } from '../utils/mixtape-visibility'

export const MIXTAPE_DEDUPE_MODEL = '@cf/cloudflare/clef-flash'
export const MIXTAPE_DEDUPE_MODEL_SELECTOR = 'clef-flash'
export const MIXTAPE_DEDUPE_TIMEOUT_MS = 1500
/** Live separation: all UNIQUE <= 0.149, all DUPLICATE >= 0.548 (reports/25 §3). */
export const MIXTAPE_DEDUPE_THRESHOLD = 0.5
export const MIXTAPE_DEDUPE_PROMPT_VERSION = 1

const MAX_TITLE_CHARS = 120
const MAX_DESC_CHARS = 400
const MAX_UNIQUE_SAMPLE = 12
const MAX_SHARED_SAMPLE = 15

const RELATIONS = ['duplicate_revision', 'copycat_ripoff', 'distinct_sequel_or_series', 'distinct_anthology_or_remix'] as const
export type MixtapeRelation = typeof RELATIONS[number]

export type SemanticFallbackReason = 'disabled' | 'timeout' | 'error' | 'invalid_response'

export interface SemanticVerdict {
	pDuplicate: number
	isDuplicate: boolean
	relation: MixtapeRelation | null
	model: string
	latencyMs: number
	inputTokens: number | null
}

export type SemanticResult =
	| { ok: true; verdict: SemanticVerdict }
	| { ok: false; reason: SemanticFallbackReason; latencyMs: number }

export function isMixtapeDedupeAiEnabled(env: Pick<Env, 'MIXTAPE_DEDUPE_AI_ENABLED' | 'AI'>): boolean {
	return env.MIXTAPE_DEDUPE_AI_ENABLED !== 'false' && Boolean(env.AI)
}

function truncate(value: string, max: number): string {
	const chars = Array.from(value)
	return chars.length > max ? `${chars.slice(0, max).join('')}…` : value
}

function hoursApart(a: string, b: string): number | null {
	const toMs = (value: string) => Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
	const delta = Math.abs(toMs(b) - toMs(a))
	return Number.isFinite(delta) ? Math.round((delta / 3_600_000) * 100) / 100 : null
}

/**
 * Build the clef-flash `state` + typed `questions` for an (older A, newer B) pair.
 * Precomputed ratios keep the prompt tiny and stop the model doing set arithmetic.
 */
export function buildMixtapeDedupeInput(
	a: MixtapeCandidate,
	b: MixtapeCandidate,
	trackTitles: ReadonlyMap<string, string>,
): Ai_Cf_Cloudflare_Clef_Input {
	const [existing, candidate] = a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id <= b.id) ? [a, b] : [b, a]
	const existingTracks = dedupeOrdered(existing.publicTracks)
	const candidateTracks = dedupeOrdered(candidate.publicTracks)
	const metrics = pairMetrics(existingTracks, candidateTracks)
	const existingSet = new Set(existingTracks)
	const candidateSet = new Set(candidateTracks)
	const title = (id: string) => truncate(trackTitles.get(id) ?? 'Untitled song', MAX_TITLE_CHARS)

	return {
		model: MIXTAPE_DEDUPE_MODEL_SELECTOR,
		state: {
			relationship_metrics: {
				same_author: true,
				hours_apart: hoursApart(existing.createdAt, candidate.createdAt),
				existing_track_count: existingTracks.length,
				candidate_track_count: candidateTracks.length,
				shared_track_count: metrics.intersection,
				track_jaccard: Math.round(metrics.jaccard * 10_000) / 10_000,
				smaller_set_containment: Math.round(metrics.maxContainment * 10_000) / 10_000,
				exact_same_order: metrics.sameOrder,
			},
			existing_mixtape: {
				title: truncate(existing.title, MAX_TITLE_CHARS),
				description: truncate(existing.desc, MAX_DESC_CHARS),
				track_count: existingTracks.length,
				unique_tracks_sample: existingTracks.filter((id) => !candidateSet.has(id)).slice(0, MAX_UNIQUE_SAMPLE).map(title),
			},
			candidate_mixtape: {
				title: truncate(candidate.title, MAX_TITLE_CHARS),
				description: truncate(candidate.desc, MAX_DESC_CHARS),
				track_count: candidateTracks.length,
				unique_tracks_sample: candidateTracks.filter((id) => !existingSet.has(id)).slice(0, MAX_UNIQUE_SAMPLE).map(title),
			},
			shared_tracks_sample: candidateTracks.filter((id) => existingSet.has(id)).slice(0, MAX_SHARED_SAMPLE).map(title),
		},
		questions: {
			is_duplicate: {
				type: 'noul',
				instructions: 'Should `candidate_mixtape` be treated as a duplicate, draft revision, accidental republish, or low-effort copycat of `existing_mixtape` rather than a distinct new mixtape?',
				criteria: {
					true: 'Same mixtape republished, draft expanded into final version by the same author, minor typo/reorder/rename revision, or a cross-author copycat reusing almost all tracks with minimal original curation.',
					false: 'A genuinely distinct mixtape: e.g. a sequel (Vol 2 / Part 2) with mostly new tracks, a large community anthology incorporating a smaller EP, a themed remix adding substantial new curation, or casual track overlap.',
				},
			},
			relation: {
				type: 'choice',
				instructions: 'Which category best describes the relationship between `candidate_mixtape` and `existing_mixtape`?',
				criteria: {
					duplicate_revision: 'Same author republishing, fixing typos, reordering, renaming, or expanding an earlier draft of the same mixtape.',
					copycat_ripoff: 'Different author copying the vast majority of the tracklist with cosmetic rebranding and minimal original curation.',
					distinct_sequel_or_series: 'Same author releasing a distinct follow-up installment (e.g. Vol 2 / Part 2) with mostly new tracks.',
					distinct_anthology_or_remix: 'A distinct curation, themed remix, or larger community anthology that legitimately shares some tracks.',
				},
			},
		},
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isTokenCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Cloudflare REST/gateway envelopes we accept around the binding payload (raw → result → result). */
const MAX_ENVELOPES = 2

/** Envelope status checks applied at EVERY level, including the terminal payload. */
function envelopeOk(node: Record<string, unknown>): boolean {
	if ('success' in node && node.success !== true) return false // must be the boolean true when present
	if ('errors' in node && (!Array.isArray(node.errors) || node.errors.length > 0)) return false
	if ('state' in node && node.state !== 'Completed') return false
	return true
}

/**
 * Strict validation of a clef-flash payload. Accepts the direct binding shape
 * `{ model, answers, usage }` or at most two Cloudflare envelopes (`{ success, errors, result }`
 * / `{ state, result }`). Any reported failure at any level (including `success: "false"`),
 * deeper nesting, missing model, malformed answers or usage rejects the WHOLE response before
 * a probability is used (fail open to Tier 1).
 */
export function parseMixtapeDedupeResponse(raw: unknown): Omit<SemanticVerdict, 'latencyMs'> | null {
	let payload: unknown = raw
	for (let unwrapped = 0; ; unwrapped += 1) {
		if (!isRecord(payload) || !envelopeOk(payload)) return null
		if ('answers' in payload) break
		if (!('result' in payload) || unwrapped >= MAX_ENVELOPES) return null
		payload = payload.result
	}
	if (!isRecord(payload) || !isRecord(payload.answers)) return null
	if (typeof payload.model !== 'string' || !payload.model.trim()) return null
	if (!isRecord(payload.usage) || !isTokenCount(payload.usage.input_tokens) || !isTokenCount(payload.usage.output_tokens)) return null

	const isDuplicate = payload.answers.is_duplicate
	if (!isRecord(isDuplicate) || isDuplicate.type !== 'noul') return null
	const p = isDuplicate.noul
	if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null

	let relation: MixtapeRelation | null = null
	const rel = payload.answers.relation
	if (rel !== undefined) {
		if (!isRecord(rel) || rel.type !== 'choice' || typeof rel.choice !== 'string' || !(RELATIONS as readonly string[]).includes(rel.choice)) return null
		relation = rel.choice as MixtapeRelation
	}

	return {
		pDuplicate: p,
		isDuplicate: p >= MIXTAPE_DEDUPE_THRESHOLD,
		relation,
		model: payload.model,
		inputTokens: payload.usage.input_tokens,
	}
}

class SemanticTimeoutError extends Error {}

/**
 * Ask clef-flash whether a borderline same-owner pair is the same mixtape.
 * Never throws; every failure is a fail-open `{ ok: false, reason }`.
 */
export async function adjudicateMixtapePair(
	env: Pick<Env, 'MIXTAPE_DEDUPE_AI_ENABLED' | 'AI'>,
	a: MixtapeCandidate,
	b: MixtapeCandidate,
	trackTitles: ReadonlyMap<string, string>,
	timeoutMs = MIXTAPE_DEDUPE_TIMEOUT_MS,
): Promise<SemanticResult> {
	const startedAt = Date.now()
	if (!isMixtapeDedupeAiEnabled(env)) return { ok: false, reason: 'disabled', latencyMs: 0 }

	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const input = buildMixtapeDedupeInput(a, b, trackTitles)
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new SemanticTimeoutError()), timeoutMs)
		})
		const raw = await Promise.race([env.AI.run(MIXTAPE_DEDUPE_MODEL, input), timeout])
		const latencyMs = Date.now() - startedAt
		const parsed = parseMixtapeDedupeResponse(raw)
		if (!parsed) {
			console.warn('mixtape_dedupe_tier2_fallback', { reason: 'invalid_response', latencyMs })
			return { ok: false, reason: 'invalid_response', latencyMs }
		}
		return { ok: true, verdict: { ...parsed, latencyMs } }
	} catch (error) {
		const latencyMs = Date.now() - startedAt
		const reason: SemanticFallbackReason = error instanceof SemanticTimeoutError ? 'timeout' : 'error'
		console.warn('mixtape_dedupe_tier2_fallback', { reason, latencyMs, error: error instanceof Error ? error.message : String(error) })
		return { ok: false, reason, latencyMs }
	} finally {
		if (timer) clearTimeout(timer)
	}
}
