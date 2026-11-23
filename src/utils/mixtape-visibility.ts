/**
 * Mixtape uniqueness rubric — Tier 1 (pure, deterministic, synchronous, zero I/O).
 *
 * Implements MIXTAPE_DEDUPE_SPEC.md §2. Visibility is DERIVED, never a manual toggle:
 * hidden ("owner") mixtapes keep their direct link and stay playable; they are only
 * left off the public Mixtapes page.
 *
 * Hard invariants:
 *  - Same-owner boundary: mixtapes are only ever compared inside one owner's cohort.
 *    Cross-owner overlap (even 100% containment) NEVER hides anything.
 *  - Order independence: every decision is made against a total order
 *    (rank or Created_At/Id), so input order never changes the result.
 *  - No chained pointers: every hidden row points directly at a row that is public.
 *
 * Keep this file free of Worker/D1 imports so smol-fe can mirror it 1:1.
 */

export type MixtapeVisibility = 'public' | 'owner' | 'deleted'

export type MixtapeHiddenReason =
	| 'empty'
	| 'duplicate'
	| 'superseded'
	| 'overlap'
	| 'semantic_duplicate'
	| 'too_few'
	| 'merged'
	| 'deleted'

export interface MixtapeCandidate {
	id: string
	address: string
	title: string
	desc: string
	createdAt: string
	/** Ordered track IDs that currently resolve to `Smols.Public = 1`. */
	publicTracks: string[]
	/**
	 * Ordered stored track IDs (including private/missing references). When provided,
	 * an exact `duplicate` additionally requires identical stored lists, so a song
	 * turning private can never manufacture an exact retry.
	 */
	storedTracks?: string[]
}

export interface MixtapeDecision {
	id: string
	visibility: 'public' | 'owner'
	hiddenReason: MixtapeHiddenReason | null
	relatedId: string | null
	relatedTitle: string | null
	uniquenessScore: number | null
	advice: string | null
}

export interface PairMetrics {
	intersection: number
	union: number
	jaccard: number
	containmentA: number
	containmentB: number
	maxContainment: number
	sameSet: boolean
	sameOrder: boolean
}

export interface BorderlinePair {
	a: MixtapeCandidate
	b: MixtapeCandidate
	metrics: PairMetrics
	trigger: 'jaccard' | 'containment' | 'same_set_changed'
}

export const OVERLAP_MIN_TRACKS = 3
export const OVERLAP_JACCARD = 0.8
export const MIN_LISTED_TRACKS = 2
export const BORDERLINE_JACCARD_MIN = 0.45
export const BORDERLINE_CONTAINMENT_MIN = 0.7

// ---------------------------------------------------------------------------
// Normalization & metrics
// ---------------------------------------------------------------------------

/** NFKC, locale-independent lowercase, trimmed, whitespace collapsed. Digits/punctuation preserved. */
export function normalizeMixtapeText(value: string | null | undefined): string {
	return (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/** First-occurrence ordered de-duplication; IDs are opaque & case-sensitive. */
export function dedupeOrdered(ids: readonly string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const raw of ids) {
		const id = raw.trim()
		if (!id || seen.has(id)) continue
		seen.add(id)
		out.push(id)
	}
	return out
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i])
}

export function pairMetrics(aTracks: readonly string[], bTracks: readonly string[]): PairMetrics {
	const a = new Set(aTracks)
	const b = new Set(bTracks)
	let intersection = 0
	for (const id of a) if (b.has(id)) intersection += 1
	const union = a.size + b.size - intersection
	const containmentA = a.size ? intersection / a.size : 0
	const containmentB = b.size ? intersection / b.size : 0
	return {
		intersection,
		union,
		jaccard: union ? intersection / union : 0,
		containmentA,
		containmentB,
		maxContainment: Math.max(containmentA, containmentB),
		sameSet: a.size > 0 && intersection === a.size && intersection === b.size,
		sameOrder: sameList(aTracks, bTracks),
	}
}

function isStrictSubset(small: Set<string>, big: Set<string>): boolean {
	if (small.size === 0 || small.size >= big.size) return false
	for (const id of small) if (!big.has(id)) return false
	return true
}

function byCreatedAsc(a: MixtapeCandidate, b: MixtapeCandidate): number {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Keeper rank: larger public set first, then newest Created_At, then largest Id. */
function byKeeperRank(sizes: Map<string, number>) {
	return (a: MixtapeCandidate, b: MixtapeCandidate): number => {
		const sizeDiff = (sizes.get(b.id) ?? 0) - (sizes.get(a.id) ?? 0)
		if (sizeDiff) return sizeDiff
		return -byCreatedAsc(a, b)
	}
}

/** Returns the stronger mixtape of a pair according to the keeper rank. */
export function strongerOf(a: MixtapeCandidate, b: MixtapeCandidate): MixtapeCandidate {
	const sizes = new Map([
		[a.id, new Set(a.publicTracks).size],
		[b.id, new Set(b.publicTracks).size],
	])
	return byKeeperRank(sizes)(a, b) <= 0 ? a : b
}

function roundHalfUp(value: number): number {
	return Math.floor(value + 0.5)
}

export function scoreFromSimilarity(similarity: number): number {
	return Math.min(100, Math.max(0, roundHalfUp(100 * (1 - similarity))))
}

// ---------------------------------------------------------------------------
// Owner advice (plain, non-punitive)
// ---------------------------------------------------------------------------

export function mixtapeAdvice(reason: MixtapeHiddenReason | null, relatedTitle?: string | null): string | null {
	const other = relatedTitle ? `“${relatedTitle}”` : 'another of your mixtapes'
	switch (reason) {
		case null:
			return null
		case 'empty':
			return 'None of the songs in this mixtape are public right now, so it isn’t shown on the Mixtapes page. Add a public song and it will be listed again automatically. Your link still works.'
		case 'duplicate':
			return `This is an exact copy of your mixtape ${other}, so only the original is shown on the Mixtapes page. Change the songs, order, title or description to list it separately, or delete this copy. Your link still works.`
		case 'superseded':
			return `Every song here is also in your bigger mixtape ${other}, so that one is shown on the Mixtapes page instead. Add a song that isn’t in ${other} to list this one too, or merge them. Your link still works.`
		case 'overlap':
			return `This mixtape shares most of its songs with your mixtape ${other}, so only one of them is shown on the Mixtapes page. Swap in a few different songs to list both, or merge them. Your link still works.`
		case 'semantic_duplicate':
			return `This looks like another version of your mixtape ${other}, so only one of them is shown on the Mixtapes page. Give it a different set of songs or theme to list both, or merge them. Your link still works.`
		case 'too_few':
			return 'Add 1 more song to show on the Mixtapes page. You can still share it as a link.'
		case 'merged':
			return `This mixtape was merged into ${other}.`
		case 'deleted':
			return 'This mixtape was deleted. You can restore it.'
	}
}

// ---------------------------------------------------------------------------
// Tier 1 classification
// ---------------------------------------------------------------------------

function hide(
	decisions: Map<string, MixtapeDecision>,
	row: MixtapeCandidate,
	reason: MixtapeHiddenReason,
	related: MixtapeCandidate | null,
	uniquenessScore: number | null,
) {
	decisions.set(row.id, {
		id: row.id,
		visibility: 'owner',
		hiddenReason: reason,
		relatedId: related?.id ?? null,
		relatedTitle: related?.title ?? null,
		uniquenessScore,
		advice: mixtapeAdvice(reason, related?.title ?? null),
	})
}

function sameSetChanged(a: MixtapeCandidate, b: MixtapeCandidate, metrics: PairMetrics): boolean {
	return metrics.sameSet && (
		!metrics.sameOrder
		|| normalizeMixtapeText(a.title) !== normalizeMixtapeText(b.title)
		|| normalizeMixtapeText(a.desc) !== normalizeMixtapeText(b.desc)
	)
}

function classifyCohort(
	cohort: MixtapeCandidate[],
	decisions: Map<string, MixtapeDecision>,
	verdicts: ReadonlyMap<string, SemanticDuplicateVerdict>,
) {
	const tracks = new Map<string, string[]>()
	const sets = new Map<string, Set<string>>()
	const sizes = new Map<string, number>()
	for (const row of cohort) {
		const ordered = dedupeOrdered(row.publicTracks)
		tracks.set(row.id, ordered)
		sets.set(row.id, new Set(ordered))
		sizes.set(row.id, ordered.length)
	}

	// Rule 1 — empty: no public tracks. Stored IDs are kept so it auto-relists.
	const live: MixtapeCandidate[] = []
	for (const row of cohort) {
		if (sizes.get(row.id) === 0) hide(decisions, row, 'empty', null, null)
		else live.push(row)
	}

	// Rule 2 — exact retry: identical ordered public tracks + normalized title & desc
	// (and identical stored lists when known). Keep the EARLIEST so shared links stay canonical.
	const groups = new Map<string, MixtapeCandidate[]>()
	for (const row of live) {
		const key = JSON.stringify([
			tracks.get(row.id),
			normalizeMixtapeText(row.title),
			normalizeMixtapeText(row.desc),
			row.storedTracks ? dedupeOrdered(row.storedTracks) : null,
		])
		const group = groups.get(key)
		if (group) group.push(row)
		else groups.set(key, [row])
	}
	const survivors: MixtapeCandidate[] = []
	const retryCopies: Array<[MixtapeCandidate, MixtapeCandidate]> = []
	for (const group of groups.values()) {
		group.sort(byCreatedAsc)
		survivors.push(group[0])
		for (const dup of group.slice(1)) {
			hide(decisions, dup, 'duplicate', group[0], 0)
			retryCopies.push([dup, group[0]])
		}
	}

	// Rules 3–5 + Tier 2 in ONE pass over the keeper rank (|S| DESC, newest, Id DESC).
	// A row is only ever compared with rows already KEPT, and a kept row is never hidden
	// later, so every pointer targets a surviving public keeper (no A → B → C chains).
	// A row whose would-be keeper got hidden is re-tested against the survivors and is
	// promoted when none of them match.
	survivors.sort(byKeeperRank(sizes))
	const keepers: MixtapeCandidate[] = []
	const keeperIds = new Set<string>()
	const pendingScore: Array<[MixtapeCandidate, 'too_few' | 'semantic_duplicate', MixtapeCandidate | null, number]> = []
	for (const row of survivors) {
		// Rule 3 — superseded: strict subset of a kept same-owner mixtape.
		const superset = keepers.find((k) => isStrictSubset(sets.get(row.id)!, sets.get(k.id)!))
		if (superset) {
			hide(decisions, row, 'superseded', superset, 0)
			continue
		}

		// Rule 4 — overlap: both >= 3 tracks and Jaccard >= 0.80. Same track set with a changed
		// order/title/description takes precedence: it is a borderline edition for Tier 2.
		let overlap: MixtapeCandidate | undefined
		let overlapJ = 0
		for (const k of keepers) {
			if (Math.min(sizes.get(row.id)!, sizes.get(k.id)!) < OVERLAP_MIN_TRACKS) continue
			const metrics = pairMetrics(tracks.get(row.id)!, tracks.get(k.id)!)
			if (sameSetChanged(row, k, metrics)) continue
			if (metrics.jaccard >= OVERLAP_JACCARD) {
				overlap = k
				overlapJ = metrics.jaccard
				break
			}
		}
		if (overlap) {
			hide(decisions, row, 'overlap', overlap, scoreFromSimilarity(overlapJ))
			continue
		}

		// Tier 2 — persisted semantic verdict, only while its keeper survived.
		const verdict = verdicts.get(row.id)
		if (verdict && keeperIds.has(verdict.keeperId)) {
			pendingScore.push([row, 'semantic_duplicate', keepers.find((k) => k.id === verdict.keeperId)!, verdict.pDuplicate])
			continue
		}

		// Rule 5 — too_few: a single public song is a link, not a listed mixtape.
		if (sizes.get(row.id)! < MIN_LISTED_TRACKS) {
			pendingScore.push([row, 'too_few', null, 0])
			continue
		}

		keepers.push(row)
		keeperIds.add(row.id)
	}

	// Uniqueness score: 100 × (1 − max Jaccard vs the same owner's listed mixtapes).
	const scoreOf = (row: MixtapeCandidate) => {
		let maxJ = 0
		for (const other of keepers) {
			if (other.id === row.id) continue
			maxJ = Math.max(maxJ, pairMetrics(tracks.get(row.id)!, tracks.get(other.id)!).jaccard)
		}
		return scoreFromSimilarity(maxJ)
	}

	for (const row of keepers) {
		decisions.set(row.id, {
			id: row.id,
			visibility: 'public',
			hiddenReason: null,
			relatedId: null,
			relatedTitle: null,
			uniquenessScore: scoreOf(row),
			advice: null,
		})
	}
	for (const [row, reason, keeper, pDuplicate] of pendingScore) {
		const score = reason === 'semantic_duplicate' ? Math.min(scoreOf(row), scoreFromSimilarity(pDuplicate)) : scoreOf(row)
		hide(decisions, row, reason, keeper, score)
	}

	// A retry copy whose original was hidden by a later rule shares the original's content,
	// so it inherits the original's decision and points straight at the same public keeper.
	for (const [copy, original] of retryCopies) {
		const originalDecision = decisions.get(original.id)!
		if (originalDecision.visibility !== 'public') decisions.set(copy.id, { ...originalDecision, id: copy.id })
	}
}

/**
 * Classify every mixtape (any number of owners). Rows are grouped by exact `address`;
 * no comparison ever crosses an owner boundary. `semanticVerdicts` are still-valid
 * persisted Tier 2 duplicate verdicts (callers validate fingerprints); each applies
 * only when no deterministic rule hides the row first and its keeper is still listed.
 */
export function classifyOwnerMixtapes(
	rows: readonly MixtapeCandidate[],
	semanticVerdicts: readonly SemanticDuplicateVerdict[] = [],
): Map<string, MixtapeDecision> {
	const cohorts = new Map<string, MixtapeCandidate[]>()
	for (const row of rows) {
		const cohort = cohorts.get(row.address)
		if (cohort) cohort.push(row)
		else cohorts.set(row.address, [row])
	}
	const addressOf = new Map(rows.map((row) => [row.id, row.address]))
	const verdicts = new Map<string, SemanticDuplicateVerdict>()
	for (const verdict of [...semanticVerdicts].sort((a, b) => (a.hiddenId < b.hiddenId ? -1 : a.hiddenId > b.hiddenId ? 1 : 0))) {
		const address = addressOf.get(verdict.hiddenId)
		if (!address || address !== addressOf.get(verdict.keeperId) || verdict.hiddenId === verdict.keeperId) continue
		if (!verdicts.has(verdict.hiddenId)) verdicts.set(verdict.hiddenId, verdict)
	}
	const decisions = new Map<string, MixtapeDecision>()
	for (const cohort of cohorts.values()) classifyCohort(cohort, decisions, verdicts)
	return decisions
}

// ---------------------------------------------------------------------------
// Borderline band (Tier 2 hand-off, write-time only)
// ---------------------------------------------------------------------------

export function borderlineTrigger(a: MixtapeCandidate, b: MixtapeCandidate, metrics = pairMetrics(dedupeOrdered(a.publicTracks), dedupeOrdered(b.publicTracks))): BorderlinePair['trigger'] | null {
	if (metrics.intersection === 0) return null
	if (metrics.sameSet) return sameSetChanged(a, b, metrics) ? 'same_set_changed' : null
	if (metrics.jaccard >= BORDERLINE_JACCARD_MIN && metrics.jaccard < OVERLAP_JACCARD) return 'jaccard'
	if (metrics.maxContainment >= BORDERLINE_CONTAINMENT_MIN && metrics.maxContainment < 1) return 'containment'
	return null
}

/**
 * Top-1 same-owner borderline pair among rows that are still public after Tier 1.
 * When `subjectId` is given, only pairs involving that mixtape are considered.
 * Ranked by Jaccard DESC, max containment DESC, then peer Id ASC (deterministic).
 */
export function findBorderlinePair(
	rows: readonly MixtapeCandidate[],
	decisions: ReadonlyMap<string, MixtapeDecision>,
	subjectId?: string,
	exclude?: (a: MixtapeCandidate, b: MixtapeCandidate) => boolean,
): BorderlinePair | null {
	const isPublic = (row: MixtapeCandidate) => decisions.get(row.id)?.visibility === 'public'
	const live = rows.filter(isPublic).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
	let best: BorderlinePair | null = null
	for (let i = 0; i < live.length; i += 1) {
		for (let j = i + 1; j < live.length; j += 1) {
			const [x, y] = live[i].id < live[j].id ? [live[i], live[j]] : [live[j], live[i]]
			if (x.address !== y.address) continue
			if (subjectId && x.id !== subjectId && y.id !== subjectId) continue
			if (exclude?.(x, y)) continue
			const metrics = pairMetrics(dedupeOrdered(x.publicTracks), dedupeOrdered(y.publicTracks))
			const trigger = borderlineTrigger(x, y, metrics)
			if (!trigger) continue
			const better = !best
				|| metrics.jaccard > best.metrics.jaccard
				|| (metrics.jaccard === best.metrics.jaccard && metrics.maxContainment > best.metrics.maxContainment)
			if (better) best = { a: x, b: y, metrics, trigger }
		}
	}
	return best
}

// ---------------------------------------------------------------------------
// Tier 2 verdict inputs (persisted clef-flash verdicts; applied on every read, zero inference)
// ---------------------------------------------------------------------------

export interface SemanticDuplicateVerdict {
	hiddenId: string
	keeperId: string
	pDuplicate: number
}

/**
 * Deterministic SHA-256 fingerprint of exactly what Tier 2 judged for a pair: both Ids,
 * their resolved PUBLIC track order, and normalized title & description. A persisted
 * verdict is only trusted while this still matches, so a song flipping private (which
 * changes no mixtape revision) invalidates it immediately, with zero inference.
 */
export async function pairFingerprint(a: MixtapeCandidate, b: MixtapeCandidate): Promise<string> {
	const [x, y] = a.id < b.id ? [a, b] : [b, a]
	const payload = JSON.stringify([x, y].map((m) => [m.id, dedupeOrdered(m.publicTracks), normalizeMixtapeText(m.title), normalizeMixtapeText(m.desc)]))
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
