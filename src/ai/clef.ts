/**
 * Shared strict unwrapping for `@cf/cloudflare/clef*` responses (mixtape dedupe + NSFW).
 *
 * Accepts the direct binding shape `{ model, answers, usage }` or at most two Cloudflare
 * envelopes (`{ success, errors, result }` / `{ state, result }`). Any reported failure at any
 * level (including `success: "false"`), deeper nesting, a missing model, non-record answers or
 * malformed usage rejects the WHOLE response before any probability is read.
 */

export interface ClefPayload {
	model: string
	answers: Record<string, unknown>
	usage: { input_tokens: number; output_tokens: number }
}

/** Cloudflare REST/gateway envelopes we accept around the binding payload (raw → result → result). */
const MAX_ENVELOPES = 2

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isTokenCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Envelope status checks applied at EVERY level, including the terminal payload. */
function envelopeOk(node: Record<string, unknown>): boolean {
	if ('success' in node && node.success !== true) return false // must be the boolean true when present
	if ('errors' in node && (!Array.isArray(node.errors) || node.errors.length > 0)) return false
	if ('state' in node && node.state !== 'Completed') return false
	return true
}

export function unwrapClefPayload(raw: unknown): ClefPayload | null {
	let payload: unknown = raw
	for (let unwrapped = 0; ; unwrapped += 1) {
		if (!isRecord(payload) || !envelopeOk(payload)) return null
		if ('answers' in payload) break
		if (!('result' in payload) || unwrapped >= MAX_ENVELOPES) return null
		payload = payload.result
	}
	if (!isRecord(payload.answers)) return null
	if (typeof payload.model !== 'string' || !payload.model.trim()) return null
	const usage = payload.usage
	if (!isRecord(usage) || !isTokenCount(usage.input_tokens) || !isTokenCount(usage.output_tokens)) return null
	return {
		model: payload.model,
		answers: payload.answers,
		usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
	}
}

/** A finite `noul` probability in [0, 1], or null. */
export function readNoul(answer: unknown): number | null {
	if (!isRecord(answer) || answer.type !== 'noul') return null
	const p = answer.noul
	return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? p : null
}
