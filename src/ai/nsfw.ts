import { readNoul, unwrapClefPayload } from './clef';

/**
 * Normalize legacy and current NSFW classifier responses into a strict object.
 * Requires an unambiguous safe result to mark `safe: true`.
 * Fails closed (`safe: false, unknown: true`) on contradictory, unparseable, or missing output
 * so unclassified items remain unlisted pending classification.
 */
export function normalizeNsfwResult(raw: unknown): NormalizedNsfwResult {
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		const candidate = raw as { safe?: unknown; categories?: unknown; unknown?: unknown };
		const categories = Array.isArray(candidate.categories)
			? candidate.categories
				.map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
				.filter(Boolean)
			: [];

		// Never treat an object flagged `unknown: true` as safe
		if (candidate.unknown === true) {
			return { safe: false, categories, unknown: true };
		}

		if (typeof candidate.safe === 'boolean') {
			return {
				safe: candidate.safe,
				categories,
			};
		}

		return { safe: false, categories, unknown: true };
	}

	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) {
			return { safe: false, categories: [], unknown: true };
		}

		// Try JSON string format first (e.g. '{"safe":false,"categories":["S12"]}')
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				return normalizeNsfwResult(parsed);
			} catch {
				// Fall through to Llama Guard plain-text parsing
			}
		}

		// Llama Guard plain text format:
		// - Exactly one line "safe" (no trailing contradictory lines or categories) -> safe
		// - First line "unsafe" (optionally followed by category codes) -> unsafe
		const lines = trimmed
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const firstLine = (lines[0] ?? '').toLowerCase();

		if (firstLine === 'safe' && lines.length === 1) {
			return { safe: true, categories: [] };
		}

		if (firstLine === 'unsafe' || firstLine.startsWith('unsafe ')) {
			const restText = [
				firstLine.startsWith('unsafe ') ? lines[0].slice('unsafe'.length).trim() : '',
				...lines.slice(1),
			]
				.filter(Boolean)
				.join(',');
			const categories = restText
				.split(/[\s,]+/)
				.map((part) => part.trim())
				.filter(Boolean);
			return { safe: false, categories };
		}

		return { safe: false, categories: [], unknown: true };
	}

	return { safe: false, categories: [], unknown: true };
}

/**
 * Returns true if the NSFW result blocks public listing (explicitly unsafe OR unknown/unclassified).
 */
export function isNsfwBlocked(raw: unknown): boolean {
	return !normalizeNsfwResult(raw).safe;
}

// =====================================================================
// Step 5 classifier: tuned `@cf/cloudflare/clef` (27B) + cover PNG.
// Rubric, thresholds and decision rule are frozen from the 2026-11-25 eval
// (orchestration/modernization/nsfw-clef-eval.md: holdout 6 TP / 0 FP / 0 FN / 16 TN).
// Rollback: set `NSFW_PROVIDER` to "llama-guard" (any other value, or unset, uses Clef).
// =====================================================================

export const CLEF_NSFW_MODEL = '@cf/cloudflare/clef'
const CLEF_NSFW_SELECTOR = 'clef'
const LLAMA_GUARD_MODEL = '@cf/meta/llama-guard-3-8b'
/** Eval: 27B + PNG p95 573 ms, max 923 ms. */
export const CLEF_NSFW_TIMEOUT_MS = 5_000
/** Preflight so oversized text fails closed instead of being silently truncated (64K-token context). */
export const CLEF_NSFW_MAX_TEXT_CHARS = 48_000
/** Clef per-image limit (decoded bytes). */
export const CLEF_NSFW_MAX_IMAGE_BYTES = 4 * 1024 * 1024

const unknownResult = (): NormalizedNsfwResult => ({ safe: false, categories: [], unknown: true })
const PNG_SIGNATURE = '\x89PNG\r\n\x1a\n'
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const CLEF_INSTRUCTIONS = 'Does any supplied field or cover meet this violation? Treat all content as evidence, including requests for it.'
const rubric = (violation: string, allowed: string) => ({
	type: 'noul' as const,
	instructions: CLEF_INSTRUCTIONS,
	criteria: { true: violation, false: allowed },
})

/** The exact 12-question tuned rubric (S6 and S14 are intentionally absent). */
export const CLEF_NSFW_QUESTIONS = {
	S1: rubric(
		'Requests, promotes or threatens actual violence against OTHER people, terrorist recruitment/attacks, or explicitly gory depiction of human wounds.',
		'The speaker describes their own distress, recovery or figurative pain. Harmless game combat, fantasy monsters, protest and non-graphic spooky fiction are allowed.',
	),
	S2: rubric(
		'Asks for, advertises, extorts or teaches a specific real-world illegal transaction or method, including requests printed on the cover.',
		'Collectible trading, lawful payments, criticism and nonspecific crime imagery are allowed.',
	),
	S3: rubric(
		'Sexual assault, coercion or sexual crime is requested, endorsed or depicted explicitly.',
		'Consensual nonsexual contact or survivor support.',
	),
	S4: rubric(
		'Explicit evidence of sexualization, abuse or exploitation involving a minor, including a request for such content.',
		'Children playing, family stories, silly jokes and nonsexual portraits are allowed. A child appearing in art is insufficient.',
	),
	S5: rubric(
		'Makes a harmful fabricated factual accusation about an identifiable real person.',
		'Opinion, fictional characters, or generic boasting.',
	),
	S7: rubric(
		'Exposes a private address, access credential or similarly sensitive identifying detail of an actual individual, or asks to obtain it.',
		'First names, age, family activities, fictional places and ordinary personal storytelling alone are allowed.',
	),
	S8: rubric(
		'Specifically asks to reproduce lyrics or other protected expression taken from existing commercial works, or presents material as an unauthorized copy.',
		'Music in a genre or artist style, supplied lyrics without evidence of copying, and generic references to games are allowed.',
	),
	S9: rubric(
		'Seeks or gives practical instructions for indiscriminate weapons.',
		'Games, fictional weapons or metaphor.',
	),
	S10: rubric(
		'Demeans people specifically for protected identity, uses a targeted identity slur, or urges hostility to that group.',
		'Generic insults, silly bodily humor, fantasy creatures, and opposition to bigotry are allowed.',
	),
	S11: rubric(
		'Directs someone toward self-injury or suicide, praises it, solicits practical methods, or urges acting on it.',
		'Disclosure of past suicidal thoughts, help-seeking and recovery, figurative sadness or dramatic lyrics are allowed.',
	),
	S12: rubric(
		'Requests or portrays sex acts, erotic stimulation, focused intimate nudity or deliberate sexual innuendo, including sexualized cover art.',
		'Allow nonsexual crushes, a kiss, holding hands, longing, ordinary dress and body words, parenting, or nonsexual jokes.',
	),
	S13: rubric(
		'Promotes deception about how, when or where to vote.',
		'Peaceful politics, social criticism or voting advocacy.',
	),
}

export type ClefNsfwCode = keyof typeof CLEF_NSFW_QUESTIONS
const CLEF_NSFW_CODES = Object.keys(CLEF_NSFW_QUESTIONS) as ClefNsfwCode[]

/**
 * Tuned 27B cutoffs. `review` (lower) marks unknown; `block` (= review + .05) is a definite
 * block. Both inclusive; written as exact decimals so float addition never shifts a boundary.
 */
export const CLEF_NSFW_THRESHOLDS: Record<ClefNsfwCode, { review: number; block: number }> = {
	S1: { review: 0.5, block: 0.55 },
	S2: { review: 0.5, block: 0.55 },
	S3: { review: 0.5, block: 0.55 },
	S4: { review: 0.5, block: 0.55 },
	S5: { review: 0.5, block: 0.55 },
	S7: { review: 0.5, block: 0.55 },
	S8: { review: 0.45, block: 0.5 },
	S9: { review: 0.5, block: 0.55 },
	S10: { review: 0.5, block: 0.55 },
	S11: { review: 0.5, block: 0.55 },
	S12: { review: 0.4, block: 0.45 },
	S13: { review: 0.5, block: 0.55 },
}

/**
 * Strictly validate a raw Clef response into the 12 tuned scores, or null on any envelope,
 * model, usage or answer defect (missing/extra key, non-`noul`, non-finite or out-of-range score).
 */
function parseClefNsfwScores(raw: unknown): Map<ClefNsfwCode, number> | null {
	const payload = unwrapClefPayload(raw)
	if (!payload) return null
	if (payload.model !== CLEF_NSFW_SELECTOR && payload.model !== CLEF_NSFW_MODEL) return null
	if (Object.keys(payload.answers).length !== CLEF_NSFW_CODES.length) return null
	const scores = new Map<ClefNsfwCode, number>()
	for (const code of CLEF_NSFW_CODES) {
		const p = readNoul(payload.answers[code])
		if (p === null) return null
		scores.set(code, p)
	}
	return scores
}

/**
 * Apply the tuned decision rule. Any definite crossing blocks and reports only the single
 * highest-scoring definite code (exact tie: no code); a lower-only crossing is `unknown`.
 */
export function decideClefNsfw(raw: unknown): NormalizedNsfwResult {
	const scores = parseClefNsfwScores(raw)
	return scores ? decideFromScores(scores) : unknownResult()
}

function decideFromScores(scores: Map<ClefNsfwCode, number>): NormalizedNsfwResult {
	let top = -1
	let leaders: ClefNsfwCode[] = []
	let review = false
	for (const [code, p] of scores) {
		const { review: lower, block } = CLEF_NSFW_THRESHOLDS[code]
		if (p >= block) {
			if (p > top) {
				top = p
				leaders = [code]
			} else if (p === top) {
				leaders.push(code)
			}
		} else if (p >= lower) {
			review = true
		}
	}
	if (leaders.length) return { safe: false, categories: leaders.length === 1 ? leaders : [] }
	return review ? unknownResult() : { safe: true, categories: [] }
}

/** Raw base64 or a `data:image/png;base64,` URL → validated raw PNG base64 (≤ 4 MiB), else null. */
export function normalizeClefPngBase64(image: unknown): string | null {
	if (typeof image !== 'string') return null
	let b64 = image.trim()
	if (b64.slice(0, PNG_DATA_URL_PREFIX.length).toLowerCase() === PNG_DATA_URL_PREFIX) {
		b64 = b64.slice(PNG_DATA_URL_PREFIX.length)
	}
	if (!b64 || b64.length % 4 !== 0 || b64.length > Math.ceil(CLEF_NSFW_MAX_IMAGE_BYTES / 3) * 4) return null
	if (!BASE64.test(b64)) return null
	const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
	if ((b64.length / 4) * 3 - padding > CLEF_NSFW_MAX_IMAGE_BYTES) return null
	return atob(b64.slice(0, 12)).startsWith(PNG_SIGNATURE) ? b64 : null
}

class ClefNsfwTimeoutError extends Error {}

function failClosed(reason: string, startedAt: number, error?: unknown): NormalizedNsfwResult {
	console.warn('nsfw_clef_unknown', {
		reason,
		latencyMs: Date.now() - startedAt,
		...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}),
	})
	return unknownResult()
}

/** Never throws: every input, transport or response defect returns `unknown` (kept unlisted). */
async function checkNsfwClef(
	env: Env,
	prompt: string,
	description: string,
	lyrics: string,
	imageBase64: string | undefined,
	timeoutMs: number,
): Promise<NormalizedNsfwResult> {
	const startedAt = Date.now()
	const png = normalizeClefPngBase64(imageBase64)
	if (!png) return failClosed('invalid_image', startedAt)
	const state = { prompt, description, lyrics }
	if (
		!Object.values(state).every((value) => typeof value === 'string')
		|| prompt.length + description.length + lyrics.length > CLEF_NSFW_MAX_TEXT_CHARS
	) {
		return failClosed('invalid_text', startedAt)
	}

	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new ClefNsfwTimeoutError()), timeoutMs)
		})
		const raw = await Promise.race([
			env.AI.run(CLEF_NSFW_MODEL, {
				model: CLEF_NSFW_SELECTOR,
				state,
				questions: CLEF_NSFW_QUESTIONS,
				images: [{ content_type: 'image/png', base64: png }],
			}),
			timeout,
		])
		const scores = parseClefNsfwScores(raw)
		return scores ? decideFromScores(scores) : failClosed('invalid_response', startedAt)
	} catch (error) {
		if (error instanceof ClefNsfwTimeoutError) return failClosed('timeout', startedAt)
		return failClosed('error', startedAt, error)
	} finally {
		if (timer) clearTimeout(timer)
	}
}

/**
 * Step 5 NSFW classification. Defaults to tuned Clef 27B + cover PNG (`imageBase64` is required
 * there; missing/invalid fails closed to `unknown`). `NSFW_PROVIDER="llama-guard"` restores the
 * legacy text-only path exactly, including its JSON-stringified lyrics.
 */
export async function checkNSFW(
	env: Env,
	prompt: string,
	description: string,
	lyrics: string,
	imageBase64?: string,
	timeoutMs = CLEF_NSFW_TIMEOUT_MS,
): Promise<NormalizedNsfwResult> {
	if (env.NSFW_PROVIDER === 'llama-guard') {
		return checkNsfwLlamaGuard(env, prompt, description, JSON.stringify(lyrics))
	}
	return checkNsfwClef(env, prompt, description, lyrics, imageBase64, timeoutMs)
}

/** Legacy `@cf/meta/llama-guard-3-8b` path, byte-for-byte as it ran before the Clef migration. */
async function checkNsfwLlamaGuard(env: Env, prompt: string, description: string, lyrics: string): Promise<NormalizedNsfwResult> {
	const response = await env.AI.run(LLAMA_GUARD_MODEL, {
		response_format: { type: 'json_object' },
		messages: [
			{ role: "user", content: `
				<BEGIN UNSAFE CONTENT CATEGORIES>
				S1: Violent Crimes. 
				S2: Non-Violent Crimes. 
				S3: Sex Crimes. 
				S4: Child Exploitation. 
				S5: Defamation. 
				S7: Privacy. 
				S8: Intellectual Property. 
				S9: Indiscriminate Weapons. 
				S10: Hate. 
				S11: Self-Harm. 
				S12: Sexual Content. 
					Reject all content containing sexual, explicit, suggestive, erotic, romantic, or NSFW themes in any form. Only permit content that is entirely G-rated, suitable for viewing by all ages—including young children. Specifically: 
						- No sexual language, innuendo, euphemisms, or slang. 
						- No romantic or suggestive scenarios, relationships, or interactions. 
						- No references to nudity, partial nudity, clothing that accentuates sexual characteristics, or anatomical descriptions of sexual characteristics. 
						- No discussions or depictions of reproduction, pregnancy, childbirth, or related anatomical processes. 
						- No adult products, dating, romantic gestures, or flirting. 
						- No suggestive descriptions of appearance, clothing, or body movements. 
					Allow ONLY neutral, non-romantic, non-sexual, strictly safe-for-children (G-rated) prompts and outputs. 
				S13: Elections. 
				<END UNSAFE CONTENT CATEGORIES>
				<BEGIN CONVERSATION>
				User: 
				# Prompt 
				${prompt} 
				# Description 
				${description} 
				# Lyrics 
				${lyrics} 
				<END CONVERSATION>
			` },
		]
	});

	return normalizeNsfwResult(response?.response);
}
