import { NonRetryableError } from 'cloudflare:workflows';

export const ELEVENLABS_MODEL_ID = 'music_v2_5';
export const ELEVENLABS_PACING_MODEL = '@cf/zai-org/glm-5.3' as const;
export const DEFAULT_ELEVENLABS_MUSIC_LENGTH_MS = 120_000;
export const MIN_ELEVENLABS_CHUNK_MS = 3_000;
export const MAX_ELEVENLABS_CHUNK_MS = 120_000;
export const MIN_ELEVENLABS_TOTAL_MS = 3_000;
export const MAX_ELEVENLABS_TOTAL_MS = 600_000;
export const MAX_ELEVENLABS_CHUNKS = 30;
export const MAX_ELEVENLABS_CHUNK_LINES = 30;
export const MAX_ELEVENLABS_LINE_CHARS = 200;
export const MAX_ELEVENLABS_STYLES = 50;
// Pure empirical fallback fitted via L1 minimization on 116 live measured SMOL vocal songs
// (no genre/tempo keyword lists). Used as the neutral anchor for agentic pacing and fallback.
export const FALLBACK_CHUNK_BASE_MS = 12_000;
export const FALLBACK_PER_SUNG_LINE_MS = 2_500;
export const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
export const ELEVENLABS_MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MiB hard cap (matches AISG; safely fits up to 10 min auto-length tracks)
export const CANONICAL_SONG_BASE_URL = 'https://api.smol.xyz/song';

export type ElevenLabsErrorCode =
	| 'provider_misconfigured'
	| 'provider_auth_error'
	| 'provider_quota_exceeded'
	| 'content_policy'
	| 'invalid_composition_plan'
	| 'invalid_request'
	| 'provider_unavailable'
	| 'empty_audio'
	| 'audio_too_large'
	| 'truncated_audio'
	| 'storage_commit_failed'
	| 'invalid_audio_response'
	| 'submit_outcome_unknown';

export class ElevenLabsProviderError extends Error {
	readonly provider = 'elevenlabs' as const;
	readonly code: ElevenLabsErrorCode;
	readonly retryable: boolean;
	readonly outcome: 'rejected' | 'unknown';
	readonly status?: number;

	constructor(params: {
		message: string;
		code: ElevenLabsErrorCode;
		retryable: boolean;
		outcome: 'rejected' | 'unknown';
		status?: number;
	}) {
		super(params.message);
		this.name = 'ElevenLabsProviderError';
		this.code = params.code;
		this.retryable = params.retryable;
		this.outcome = params.outcome;
		this.status = params.status;
	}
}

export interface ElevenLabsCompositionChunk {
	text: string;
	duration_ms: number;
	positive_styles: string[];
	negative_styles: string[];
}

export type ElevenLabsMusicRequestBody =
	| {
		model_id: typeof ELEVENLABS_MODEL_ID;
		prompt: string;
		force_instrumental: true;
		music_length_ms?: number;
	}
	| {
		model_id: typeof ELEVENLABS_MODEL_ID;
		composition_plan: {
			chunks: ElevenLabsCompositionChunk[];
		};
	};

export interface ElevenLabsGenerationResult {
	song: AiSongGeneratorSong;
	receipt: {
		r2_key: string;
		bytes: number;
		upstream_song_id?: string;
		gateway_log_id?: string;
		reused_from_r2?: boolean;
	};
}

export function resolveOptionalElevenLabsMusicLengthMs(env: Env): number | undefined {
	const raw = env.ELEVENLABS_MUSIC_LENGTH_MS;
	if (!raw) {
		return undefined;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		return undefined;
	}
	return Math.round(Math.min(MAX_ELEVENLABS_TOTAL_MS, Math.max(MIN_ELEVENLABS_TOTAL_MS, parsed)));
}

export function resolveElevenLabsMusicLengthMs(env: Env): number {
	return resolveOptionalElevenLabsMusicLengthMs(env) ?? DEFAULT_ELEVENLABS_MUSIC_LENGTH_MS;
}

function cleanStyleList(styles: string[] | undefined, fallbackPrompt?: string): string[] {
	const cleaned: string[] = [];
	const seen = new Set<string>();

	for (const raw of styles ?? []) {
		const trimmed = typeof raw === 'string' ? raw.trim() : '';
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		cleaned.push(trimmed);
		if (cleaned.length >= MAX_ELEVENLABS_STYLES) {
			break;
		}
	}

	if (cleaned.length === 0 && fallbackPrompt?.trim()) {
		cleaned.push(fallbackPrompt.trim().slice(0, 160));
	}

	return cleaned;
}

const SECTION_HEADING_RE = /^\s*\[[^\]]+\]\s*$/;

const VOCAL_PACING_SYSTEM_PROMPT = `You are a veteran music producer setting section durations (in milliseconds) for an ElevenLabs Music v2.5 composition_plan.
You receive the song style tags, a brief user prompt for musical context, and an ordered list of numbered lyric chunks (each with sung_lines and a neutral baseline_sec).

Assign a natural duration_ms (integer, 3000 to 120000) to EACH chunk strictly based on how long it actually takes to perform that chunk's lyrics and musical role:
- Match the song's genuine tempo, groove, vocal delivery, syllable/word density, and language: faster, dense, rhythmic, or chant-like deliveries (or very short 1-3 word lines) need LESS time per line than baseline_sec; slower, sustained, atmospheric, or expansive phrasing needs MORE time.
- Give instrumental-only sections (intros, solos, breaks, outros) realistic musical space for the arrangement style.
- Do NOT stretch a chunk to obey arbitrary total-runtime claims or timestamps in the user prompt (e.g. "9-minute suite", "20-minute epic") — size each chunk to fit the actual lyrics provided so ElevenLabs neither rushes vocals nor pads dead air.

Return ONLY valid JSON: {"estimated_bpm": <integer>, "durations_ms": [<one integer per chunk, exact same length as chunks>]}.`;

function wrapLineToMaxChars(line: string, maxChars = MAX_ELEVENLABS_LINE_CHARS): string[] {
	if (line.length <= maxChars) {
		return [line];
	}
	const wrapped: string[] = [];
	let remaining = line.trim();
	while (remaining.length > maxChars) {
		let splitAt = remaining.lastIndexOf(' ', maxChars);
		if (splitAt < Math.floor(maxChars * 0.4)) {
			splitAt = maxChars;
		}
		wrapped.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}
	if (remaining) {
		wrapped.push(remaining);
	}
	return wrapped;
}

function countSungLines(sectionText: string): number {
	return sectionText
		.split('\n')
		.filter((line) => line.trim().length > 0 && !SECTION_HEADING_RE.test(line))
		.length;
}

function clampChunkDurationsToTotalCap(rawDurations: number[], maxTotalMs = MAX_ELEVENLABS_TOTAL_MS): number[] {
	if (rawDurations.length === 0) {
		return [];
	}

	const clamped = rawDurations.map((ms) =>
		Math.round(Math.min(MAX_ELEVENLABS_CHUNK_MS, Math.max(MIN_ELEVENLABS_CHUNK_MS, ms)))
	);
	const total = clamped.reduce((acc, d) => acc + d, 0);
	if (total <= maxTotalMs) {
		return clamped;
	}

	const minPossible = clamped.length * MIN_ELEVENLABS_CHUNK_MS;
	const targetTotal = Math.max(minPossible, maxTotalMs);
	const scale = targetTotal / total;
	const scaled = clamped.map((d) =>
		Math.round(Math.min(MAX_ELEVENLABS_CHUNK_MS, Math.max(MIN_ELEVENLABS_CHUNK_MS, d * scale)))
	);

	let excess = scaled.reduce((acc, d) => acc + d, 0) - targetTotal;
	for (let i = 0; excess > 0 && i < scaled.length * 4; i++) {
		const idx = i % scaled.length;
		if (scaled[idx] > MIN_ELEVENLABS_CHUNK_MS) {
			const sub = Math.min(excess, scaled[idx] - MIN_ELEVENLABS_CHUNK_MS);
			scaled[idx] -= sub;
			excess -= sub;
		}
	}

	return scaled;
}

/**
 * Split saved lyrics into ElevenLabs Music v2.5 compliant section chunks:
 * - Preserves existing [Section] headings and exact lyrics verbatim
 * - Splits unheaded multi-stanza lyrics on blank lines so they don't collapse into one giant chunk
 * - Enforces ElevenLabs limits: <= 30 lines/chunk, <= 200 chars/line, <= 30 chunks total
 */
export function splitElevenLabsLyricSections(lyricsText: string): string[] {
	const normalized = lyricsText.replace(/\r\n/g, '\n').trim();
	if (!normalized) {
		throw new ElevenLabsProviderError({
			message: 'Vocal ElevenLabs composition requires non-empty lyrics',
			code: 'invalid_composition_plan',
			retryable: false,
			outcome: 'rejected',
		});
	}

	const lines = normalized.split('\n');
	const rawSections: string[] = [];
	let current: string[] = [];

	for (const line of lines) {
		if (SECTION_HEADING_RE.test(line)) {
			if (current.some((entry) => entry.trim().length > 0)) {
				rawSections.push(current.join('\n').trim());
			}
			current = [line.trim()];
		} else {
			current.push(line);
		}
	}

	if (current.some((entry) => entry.trim().length > 0)) {
		rawSections.push(current.join('\n').trim());
	}

	// Expand unheaded multi-stanza blocks and enforce per-chunk line & char caps
	const expanded: string[] = [];
	let verseCounter = 1;
	for (const rawSection of rawSections) {
		const trimmedSection = rawSection.trim();
		if (!trimmedSection) continue;
		const sectionLines = trimmedSection.split('\n');
		const hasHeading = SECTION_HEADING_RE.test(sectionLines[0] ?? '');

		if (!hasHeading) {
			const stanzas = trimmedSection.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
			for (const stanza of stanzas) {
				const wrappedLines = stanza
					.split('\n')
					.map((l) => l.trim())
					.filter(Boolean)
					.flatMap((l) => wrapLineToMaxChars(l));
				const maxBodyLines = MAX_ELEVENLABS_CHUNK_LINES - 1;
				for (let i = 0; i < wrappedLines.length; i += maxBodyLines) {
					expanded.push(`[Verse ${verseCounter++}]\n${wrappedLines.slice(i, i + maxBodyLines).join('\n')}`);
				}
			}
			continue;
		}

		const heading = sectionLines[0].trim().slice(0, MAX_ELEVENLABS_LINE_CHARS);
		const bodyLines = sectionLines
			.slice(1)
			.map((l) => l.trim())
			.filter(Boolean)
			.flatMap((l) => wrapLineToMaxChars(l));

		if (bodyLines.length === 0) {
			expanded.push(heading);
			continue;
		}

		const maxBodyLines = MAX_ELEVENLABS_CHUNK_LINES - 1;
		for (let i = 0; i < bodyLines.length; i += maxBodyLines) {
			expanded.push(`${heading}\n${bodyLines.slice(i, i + maxBodyLines).join('\n')}`);
		}
	}

	if (expanded.length === 0) {
		throw new ElevenLabsProviderError({
			message: 'Vocal ElevenLabs composition produced no lyric sections',
			code: 'invalid_composition_plan',
			retryable: false,
			outcome: 'rejected',
		});
	}

	if (expanded.length <= MAX_ELEVENLABS_CHUNKS) {
		return expanded;
	}

	// Coalesce while respecting MAX_ELEVENLABS_CHUNKS and MAX_ELEVENLABS_CHUNK_LINES
	const coalesced: string[] = [];
	const perBucket = Math.ceil(expanded.length / MAX_ELEVENLABS_CHUNKS);
	for (let i = 0; i < expanded.length; i += perBucket) {
		const mergedLines = expanded
			.slice(i, i + perBucket)
			.join('\n')
			.split('\n')
			.slice(0, MAX_ELEVENLABS_CHUNK_LINES);
		coalesced.push(mergedLines.join('\n'));
	}
	return coalesced;
}

/**
 * Pure empirical fallback durations per chunk fitted on 116 live SMOL vocal songs
 * (zero hardcoded semantic/lexical genre or tempo word lists).
 */
export function estimateFallbackChunkDurationsMs(sections: string[]): number[] {
	const raw = sections.map((section) => {
		const sungLines = countSungLines(section);
		if (sungLines === 0) {
			return FALLBACK_CHUNK_BASE_MS;
		}
		return FALLBACK_CHUNK_BASE_MS + sungLines * FALLBACK_PER_SUNG_LINE_MS;
	});
	return clampChunkDurationsToTotalCap(raw, MAX_ELEVENLABS_TOTAL_MS);
}

function extractPacingContent(raw: unknown): unknown {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const envelope = (raw as { result?: unknown }).result;
	const source = (envelope && typeof envelope === 'object' ? envelope : raw) as {
		response?: unknown;
		choices?: Array<{ message?: { content?: unknown } }>;
	};
	const choiceContent = source.choices?.[0]?.message?.content;
	if (typeof choiceContent === 'string' && choiceContent.trim()) {
		return choiceContent;
	}
	return source.response;
}

export function parsePlannedVocalDurationsMs(raw: unknown, expectedCount: number): number[] | null {
	let draft = raw;
	if (typeof draft === 'string') {
		const cleaned = draft.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
		try {
			draft = JSON.parse(cleaned);
		} catch {
			const start = cleaned.indexOf('{');
			const end = cleaned.lastIndexOf('}');
			if (start >= 0 && end > start) {
				try {
					draft = JSON.parse(cleaned.slice(start, end + 1));
				} catch {
					return null;
				}
			} else {
				return null;
			}
		}
	}

	const candidate = draft as { durations_ms?: unknown } | null;
	if (!Array.isArray(candidate?.durations_ms) || candidate.durations_ms.length !== expectedCount) {
		return null;
	}

	const parsed = candidate.durations_ms.map((val) => Number(val));
	if (parsed.some((n) => !Number.isFinite(n) || n <= 0)) {
		return null;
	}

	return clampChunkDurationsToTotalCap(parsed, MAX_ELEVENLABS_TOTAL_MS);
}

/**
 * Agentic per-chunk duration planner for ElevenLabs Music v2.5 vocal compositions.
 * Runs ONLY when ELEVENLABS_MUSIC_LENGTH_MS is not explicitly overridden.
 * Uses @cf/zai-org/glm-5.3 anchored on the empirical baseline, falling back cleanly
 * to estimateFallbackChunkDurationsMs on any AI error or invalid response.
 */
export async function planElevenLabsVocalDurations(params: {
	env: Env;
	prompt: string;
	lyrics: AiSongGeneratorLyrics;
	sections?: string[];
}): Promise<number[] | undefined> {
	if (resolveOptionalElevenLabsMusicLengthMs(params.env) !== undefined) {
		return undefined;
	}

	const sections = params.sections ?? splitElevenLabsLyricSections(params.lyrics.lyrics);
	const fallbackDurations = estimateFallbackChunkDurationsMs(sections);

	if (typeof params.env.AI?.run !== 'function') {
		return fallbackDurations;
	}

	const chunkPayload = sections.map((text, index) => ({
		index,
		sung_lines: countSungLines(text),
		baseline_sec: Math.round(fallbackDurations[index] / 1000),
		text,
	}));

	try {
		const response = await params.env.AI.run(ELEVENLABS_PACING_MODEL, {
			messages: [
				{ role: 'system', content: VOCAL_PACING_SYSTEM_PROMPT },
				{
					role: 'user',
					content: JSON.stringify({
						prompt: params.prompt.trim().slice(0, 600),
						styles: cleanStyleList(params.lyrics.style),
						chunk_count: sections.length,
						chunks: chunkPayload,
					}),
				},
			],
			max_completion_tokens: 1200,
			temperature: 0.15,
			reasoning_effort: 'low',
			response_format: { type: 'json_object' },
		});

		const planned = parsePlannedVocalDurationsMs(extractPacingContent(response), sections.length);
		if (planned) {
			return planned;
		}
		console.warn('ElevenLabs vocal pacing model returned invalid durations; using empirical baseline');
	} catch (err) {
		console.warn(
			'ElevenLabs vocal pacing model failed; using empirical baseline:',
			err instanceof Error ? err.message : String(err)
		);
	}

	return fallbackDurations;
}

/**
 * Split saved lyrics into section-headed chunks for ElevenLabs Music v2.5 composition_plan.
 * Preserves existing [Section] headings and language; wraps unlabelled lyrics in [Verse N].
 * Uses explicit plannedDurationsMs when provided, explicit totalDurationMs override if set,
 * or the empirical baseline durations otherwise.
 */
export function buildElevenLabsCompositionChunks(
	lyricsText: string,
	styles: string[],
	totalDurationMs?: number,
	fallbackPrompt?: string,
	plannedDurationsMs?: number[]
): ElevenLabsCompositionChunk[] {
	const sections = splitElevenLabsLyricSections(lyricsText);
	const positiveStyles = cleanStyleList(styles, fallbackPrompt);

	let durations: number[];
	if (plannedDurationsMs && plannedDurationsMs.length === sections.length) {
		durations = clampChunkDurationsToTotalCap(plannedDurationsMs, MAX_ELEVENLABS_TOTAL_MS);
	} else if (totalDurationMs !== undefined) {
		// Explicit ELEVENLABS_MUSIC_LENGTH_MS override: distribute proportionally by char weight
		const maxChunksForDuration = Math.max(1, Math.min(MAX_ELEVENLABS_CHUNKS, Math.floor(totalDurationMs / MIN_ELEVENLABS_CHUNK_MS)));
		const targetSections = sections.length <= maxChunksForDuration
			? sections
			: (() => {
				const out: string[] = [];
				const perBucket = Math.ceil(sections.length / maxChunksForDuration);
				for (let i = 0; i < sections.length; i += perBucket) {
					out.push(sections.slice(i, i + perBucket).join('\n').split('\n').slice(0, MAX_ELEVENLABS_CHUNK_LINES).join('\n'));
				}
				return out;
			})();

		const boundedTotal = Math.min(
			Math.min(MAX_ELEVENLABS_TOTAL_MS, targetSections.length * MAX_ELEVENLABS_CHUNK_MS),
			Math.max(targetSections.length * MIN_ELEVENLABS_CHUNK_MS, totalDurationMs)
		);
		const weights = targetSections.map((text) => Math.max(1, text.replace(/\s+/g, '').length));
		const totalWeight = weights.reduce((acc, w) => acc + w, 0);

		durations = weights.map((w) => {
			const share = Math.round((w / totalWeight) * boundedTotal);
			return Math.min(MAX_ELEVENLABS_CHUNK_MS, Math.max(MIN_ELEVENLABS_CHUNK_MS, share));
		});

		let diff = boundedTotal - durations.reduce((acc, d) => acc + d, 0);
		for (let i = 0; diff !== 0 && i < durations.length * 4; i++) {
			const idx = i % durations.length;
			if (diff > 0 && durations[idx] < MAX_ELEVENLABS_CHUNK_MS) {
				const add = Math.min(diff, MAX_ELEVENLABS_CHUNK_MS - durations[idx]);
				durations[idx] += add;
				diff -= add;
			} else if (diff < 0 && durations[idx] > MIN_ELEVENLABS_CHUNK_MS) {
				const sub = Math.min(-diff, durations[idx] - MIN_ELEVENLABS_CHUNK_MS);
				durations[idx] -= sub;
				diff += sub;
			}
		}

		return targetSections.map((text, idx) => ({
			text,
			duration_ms: durations[idx],
			positive_styles: positiveStyles,
			negative_styles: [],
		}));
	} else {
		durations = estimateFallbackChunkDurationsMs(sections);
	}

	return sections.map((text, idx) => ({
		text,
		duration_ms: durations[idx],
		positive_styles: positiveStyles,
		negative_styles: [],
	}));
}

export function buildElevenLabsRequestBody(params: {
	prompt: string;
	description?: string;
	lyrics?: AiSongGeneratorLyrics;
	isInstrumental: boolean;
	musicLengthMs?: number;
	chunkDurationsMs?: number[];
}): ElevenLabsMusicRequestBody {
	const clampedTotalMs = params.musicLengthMs !== undefined
		? Math.round(Math.min(MAX_ELEVENLABS_TOTAL_MS, Math.max(MIN_ELEVENLABS_TOTAL_MS, params.musicLengthMs)))
		: undefined;

	if (params.isInstrumental) {
		const styleSummary = cleanStyleList(params.lyrics?.style).join(', ');
		const parts = [
			params.prompt.trim(),
			styleSummary ? `Style: ${styleSummary}` : '',
			params.description?.trim() && params.prompt.trim().length <= 240 ? params.description.trim() : '',
		].filter(Boolean);
		const combinedPrompt = parts.join('\n').trim();
		if (!combinedPrompt) {
			throw new ElevenLabsProviderError({
				message: 'Instrumental ElevenLabs composition requires a prompt',
				code: 'invalid_request',
				retryable: false,
				outcome: 'rejected',
			});
		}

		return {
			model_id: ELEVENLABS_MODEL_ID,
			prompt: combinedPrompt,
			force_instrumental: true,
			...(clampedTotalMs !== undefined ? { music_length_ms: clampedTotalMs } : {}),
		};
	}

	// Vocal composition: send ONLY model_id + composition_plan (no prompt, force_instrumental, or top-level music_length_ms)
	const chunks = buildElevenLabsCompositionChunks(
		params.lyrics?.lyrics ?? '',
		params.lyrics?.style ?? [],
		clampedTotalMs,
		params.prompt,
		params.chunkDurationsMs
	);

	return {
		model_id: ELEVENLABS_MODEL_ID,
		composition_plan: { chunks },
	};
}

function classifyElevenLabsHttpError(status: number, bodyText: string): ElevenLabsProviderError {
	let detailMessage = bodyText.slice(0, 400).trim();
	let detailStatus = '';
	try {
		const parsed = JSON.parse(bodyText) as {
			detail?: string | { status?: string; message?: string; code?: string };
			error?: string | { message?: string; code?: string };
			message?: string;
		};
		if (typeof parsed.detail === 'string') {
			detailMessage = parsed.detail;
		} else if (parsed.detail && typeof parsed.detail === 'object') {
			detailMessage = parsed.detail.message || detailMessage;
			detailStatus = parsed.detail.status || parsed.detail.code || '';
		} else if (typeof parsed.error === 'string') {
			detailMessage = parsed.error;
		} else if (parsed.error && typeof parsed.error === 'object') {
			detailMessage = parsed.error.message || detailMessage;
			detailStatus = parsed.error.code || '';
		} else if (typeof parsed.message === 'string') {
			detailMessage = parsed.message;
		}
	} catch {
		// Plain text error body
	}

	// Unconfirmed gateway/upstream transport errors (5xx, 408, 499) may have occurred AFTER
	// ElevenLabs accepted and billed the composition. Classify BEFORE any free-form text
	// heuristics and mark outcome='unknown' so callers record an ambiguous attempt rather
	// than releasing the paid claim for a second charge.
	if (status === 408 || status === 499 || status >= 500) {
		return new ElevenLabsProviderError({
			message: `ElevenLabs gateway or upstream error (${status}): ${detailMessage || 'submission outcome unknown'}`,
			code: 'submit_outcome_unknown',
			retryable: false,
			outcome: 'unknown',
			status,
		});
	}

	const combined = `${detailStatus} ${detailMessage}`.toLowerCase();

	if (status === 401 || status === 403) {
		return new ElevenLabsProviderError({
			message: `ElevenLabs gateway authentication failed (${status}): ${detailMessage || 'unauthorized'}`,
			code: 'provider_auth_error',
			retryable: false,
			outcome: 'rejected',
			status,
		});
	}

	if (status === 402 || /quota|credit|insufficient|billing|limit_exceeded/.test(combined)) {
		return new ElevenLabsProviderError({
			message: `ElevenLabs quota or billing rejected (${status}): ${detailMessage || 'quota exceeded'}`,
			code: 'provider_quota_exceeded',
			retryable: false,
			outcome: 'rejected',
			status,
		});
	}

	if (
		/bad_prompt|bad_composition_plan|content_policy|copyright|policy|moderation|prohibited|unsafe|terms/.test(combined)
	) {
		return new ElevenLabsProviderError({
			message: detailMessage || 'ElevenLabs rejected the prompt or lyrics under its content policy',
			code: 'content_policy',
			retryable: false,
			outcome: 'rejected',
			status,
		});
	}

	if (status === 400 || status === 422) {
		return new ElevenLabsProviderError({
			message: `ElevenLabs rejected the composition request (${status}): ${detailMessage || 'invalid request'}`,
			code: 'invalid_request',
			retryable: false,
			outcome: 'rejected',
			status,
		});
	}

	if (status === 429) {
		return new ElevenLabsProviderError({
			message: `ElevenLabs rate limited (${status}): ${detailMessage || 'too many requests'}`,
			code: 'provider_unavailable',
			retryable: true,
			outcome: 'rejected',
			status,
		});
	}

	return new ElevenLabsProviderError({
		message: `ElevenLabs request rejected (${status}): ${detailMessage || 'client error'}`,
		code: 'invalid_request',
		retryable: false,
		outcome: 'rejected',
		status,
	});
}

async function readBoundedAudioStream(
	body: ReadableStream<Uint8Array>,
	declaredLength: number | null,
	maxBytes: number
): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value || value.byteLength === 0) {
				continue;
			}
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel('Audio exceeded maximum allowed size').catch(() => {});
				throw new ElevenLabsProviderError({
					message: `ElevenLabs audio exceeded maximum allowed size (${maxBytes} bytes)`,
					code: 'audio_too_large',
					retryable: false,
					outcome: 'rejected',
				});
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	if (totalBytes <= 0) {
		throw new ElevenLabsProviderError({
			message: 'ElevenLabs returned an empty audio response',
			code: 'empty_audio',
			retryable: false,
			outcome: 'rejected',
		});
	}

	if (declaredLength !== null && totalBytes !== declaredLength) {
		throw new ElevenLabsProviderError({
			message: `Truncated ElevenLabs audio response (expected ${declaredLength} bytes, received ${totalBytes})`,
			code: 'truncated_audio',
			retryable: false,
			outcome: 'rejected',
		});
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}

export function getElevenLabsMusicId(smolId: string): string {
	return `el-${smolId}`;
}

export function getCanonicalSongUrl(musicId: string): string {
	return `${CANONICAL_SONG_BASE_URL}/${musicId}.mp3`;
}

/**
 * Compose a single 1-track MP3 via ElevenLabs Music v2.5 through Cloudflare AI Gateway BYOK
 * and store it directly into SMOL_BUCKET R2 inside the paid workflow step.
 */
export async function generateElevenLabsSong(params: {
	env: Env;
	smolId: string;
	prompt: string;
	description?: string;
	lyrics?: AiSongGeneratorLyrics;
	isInstrumental: boolean;
	chunkDurationsMs?: number[];
	maxBytes?: number;
}): Promise<ElevenLabsGenerationResult> {
	const { env, smolId, prompt, description, lyrics, isInstrumental, chunkDurationsMs } = params;
	const maxBytes = params.maxBytes ?? ELEVENLABS_MAX_AUDIO_BYTES;
	const musicId = getElevenLabsMusicId(smolId);
	const r2Key = `${musicId}.mp3`;
	const canonicalUrl = getCanonicalSongUrl(musicId);
	const configuredMusicLengthMs = resolveOptionalElevenLabsMusicLengthMs(env);

	// 1. Check R2 first: if this generation instance already committed audio, reuse without paying again.
	// Any R2 lookup failure happens strictly BEFORE ElevenLabs dispatch, so classify as rejected/retryable
	// rather than letting callers treat it as an ambiguous paid dispatch.
	let existing: R2Object | null = null;
	if (typeof env.SMOL_BUCKET.head === 'function') {
		try {
			existing = await env.SMOL_BUCKET.head(r2Key);
		} catch (err) {
			throw new ElevenLabsProviderError({
				message: `R2 pre-dispatch lookup failed for ${r2Key}: ${err instanceof Error ? err.message : String(err)}`,
				code: 'provider_unavailable',
				retryable: true,
				outcome: 'rejected',
			});
		}
	}
	if (existing && existing.size > 0 && (!existing.customMetadata?.smolId || existing.customMetadata.smolId === smolId)) {
		const reusedDurationSeconds = chunkDurationsMs && chunkDurationsMs.length > 0
			? Math.round(chunkDurationsMs.reduce((acc, d) => acc + d, 0) / 1000)
			: configuredMusicLengthMs !== undefined
				? Math.round(configuredMusicLengthMs / 1000)
				: undefined;
		return {
			song: {
				music_id: musicId,
				status: 4,
				audio: canonicalUrl,
				service: 'elevenlabs',
				...(reusedDurationSeconds !== undefined ? { duration: reusedDurationSeconds } : {}),
			},
			receipt: {
				r2_key: r2Key,
				bytes: existing.size,
				upstream_song_id: existing.customMetadata?.upstreamSongId,
				gateway_log_id: existing.customMetadata?.gatewayLogId,
				reused_from_r2: true,
			},
		};
	}

	// 2. Fail closed when AI Gateway or BYOK authorization is missing.
	const gatewayId = env.CF_AI_GATEWAY_ID?.trim();
	const aigToken = env.CF_AIG_TOKEN?.trim();
	if (!gatewayId || !aigToken) {
		throw new ElevenLabsProviderError({
			message: 'ElevenLabs AI Gateway BYOK is not configured (missing CF_AI_GATEWAY_ID or CF_AIG_TOKEN)',
			code: 'provider_misconfigured',
			retryable: false,
			outcome: 'rejected',
		});
	}

	// 3. Build and validate the native music_v2_5 payload BEFORE dispatching any network request.
	const requestBody = buildElevenLabsRequestBody({
		prompt,
		description,
		lyrics,
		isInstrumental,
		musicLengthMs: configuredMusicLengthMs,
		chunkDurationsMs,
	});

	const baseUrl = await env.AI.gateway(gatewayId).getUrl('elevenlabs');
	const outputFormat = (env.ELEVENLABS_OUTPUT_FORMAT || DEFAULT_ELEVENLABS_OUTPUT_FORMAT).trim();
	const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/music?output_format=${encodeURIComponent(outputFormat)}`;
	const byokAlias = (env.CF_AIG_BYOK_ALIAS || 'default').trim();

	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': 'smol-workflow/1.0',
				'cf-aig-authorization': `Bearer ${aigToken}`,
				'cf-aig-byok-alias': byokAlias,
				'cf-aig-no-wholesale': 'true',
				'cf-aig-skip-cache': 'true',
				'cf-aig-collect-log-payload': 'false',
			},
			body: JSON.stringify(requestBody),
			signal: AbortSignal.timeout(180_000),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ElevenLabsProviderError({
			message: `ElevenLabs request outcome unknown after dispatch: ${message}`,
			code: 'submit_outcome_unknown',
			retryable: false,
			outcome: 'unknown',
		});
	}

	if (!response.ok) {
		const errBody = await response.text().catch(() => '');
		throw classifyElevenLabsHttpError(response.status, errBody);
	}

	// Once ElevenLabs returns HTTP 2xx, generation may already have been billed upstream.
	// Every unusable 2xx response (wrong content-type, missing body, zero declared length,
	// declared oversize, stream truncation, or R2 commit error) MUST carry outcome='unknown'
	// so the caller marks the attempt 'ambiguous' instead of authorizing a second charge.
	const contentType = (response.headers.get('content-type') || '').toLowerCase();
	if (contentType && (contentType.includes('application/json') || contentType.startsWith('text/'))) {
		await response.body?.cancel().catch(() => {});
		throw new ElevenLabsProviderError({
			message: `ElevenLabs returned unexpected content-type: ${contentType}`,
			code: 'invalid_audio_response',
			retryable: false,
			outcome: 'unknown',
			status: response.status,
		});
	}

	if (!response.body) {
		throw new ElevenLabsProviderError({
			message: 'ElevenLabs returned a response with no body stream',
			code: 'empty_audio',
			retryable: false,
			outcome: 'unknown',
			status: response.status,
		});
	}

	const upstreamSongId = response.headers.get('song-id')?.trim() || undefined;
	const gatewayLogId = response.headers.get('cf-aig-log-id')?.trim() || undefined;
	const contentLengthRaw = response.headers.get('content-length')?.trim();
	const declaredLength = contentLengthRaw && /^\d+$/.test(contentLengthRaw) ? Number(contentLengthRaw) : null;

	if (declaredLength !== null) {
		if (declaredLength <= 0) {
			await response.body.cancel().catch(() => {});
			throw new ElevenLabsProviderError({
				message: 'ElevenLabs declared zero-byte audio response',
				code: 'empty_audio',
				retryable: false,
				outcome: 'unknown',
				status: response.status,
			});
		}
		if (declaredLength > maxBytes) {
			await response.body.cancel().catch(() => {});
			throw new ElevenLabsProviderError({
				message: `ElevenLabs declared audio size ${declaredLength} exceeds cap ${maxBytes}`,
				code: 'audio_too_large',
				retryable: false,
				outcome: 'unknown',
				status: response.status,
			});
		}
	}

	const customMetadata: Record<string, string> = {
		smolId,
		provider: 'elevenlabs',
	};
	if (upstreamSongId) {
		customMetadata.upstreamSongId = upstreamSongId;
	}
	if (gatewayLogId) {
		customMetadata.gatewayLogId = gatewayLogId;
	}

	const putOptions: R2PutOptions = {
		httpMetadata: {
			contentType: 'audio/mpeg',
		},
		customMetadata,
	};

	let committedBytes: number;

	// Once ElevenLabs has returned HTTP 200, upstream generation has already occurred and been billed.
	// Any subsequent stream truncation, overflow, or R2 storage error MUST be marked outcome='unknown'
	// so the caller records an ambiguous attempt rather than silently authorizing a second charge.
	if (declaredLength !== null && typeof FixedLengthStream !== 'undefined') {
		const fixed = new FixedLengthStream(declaredLength);
		try {
			const [putObj] = await Promise.all([
				env.SMOL_BUCKET.put(r2Key, fixed.readable, putOptions),
				response.body.pipeTo(fixed.writable),
			]);
			committedBytes = putObj?.size ?? declaredLength;
			if (committedBytes !== declaredLength) {
				await env.SMOL_BUCKET.delete(r2Key).catch(() => {});
				throw new ElevenLabsProviderError({
					message: `Truncated ElevenLabs audio stream (expected ${declaredLength}, stored ${committedBytes})`,
					code: 'truncated_audio',
					retryable: false,
					outcome: 'unknown',
				});
			}
		} catch (err) {
			if (err instanceof ElevenLabsProviderError) {
				throw err;
			}
			await env.SMOL_BUCKET.delete(r2Key).catch(() => {});
			throw new ElevenLabsProviderError({
				message: `ElevenLabs audio stream or R2 commit failed after 200 OK: ${err instanceof Error ? err.message : String(err)}`,
				code: 'storage_commit_failed',
				retryable: false,
				outcome: 'unknown',
			});
		}
	} else {
		// Unknown-length (chunked) response or Node test runtime: read bounded chunks up to maxBytes
		// and validate exact declaredLength (if supplied) before writing to R2.
		let bytes: Uint8Array;
		try {
			bytes = await readBoundedAudioStream(response.body, declaredLength, maxBytes);
		} catch (err) {
			if (err instanceof ElevenLabsProviderError) {
				throw new ElevenLabsProviderError({
					message: err.message,
					code: err.code,
					retryable: false,
					outcome: 'unknown',
					status: response.status,
				});
			}
			throw new ElevenLabsProviderError({
				message: `ElevenLabs stream read failed after 200 OK: ${err instanceof Error ? err.message : String(err)}`,
				code: 'truncated_audio',
				retryable: false,
				outcome: 'unknown',
				status: response.status,
			});
		}
		try {
			await env.SMOL_BUCKET.put(r2Key, bytes, putOptions);
		} catch (err) {
			throw new ElevenLabsProviderError({
				message: `R2 storage commit failed after ElevenLabs returned audio: ${err instanceof Error ? err.message : String(err)}`,
				code: 'storage_commit_failed',
				retryable: false,
				outcome: 'unknown',
				status: response.status,
			});
		}
		committedBytes = bytes.byteLength;
	}

	const resolvedDurationSeconds = 'composition_plan' in requestBody
		? Math.round(requestBody.composition_plan.chunks.reduce((acc, chunk) => acc + chunk.duration_ms, 0) / 1000)
		: requestBody.music_length_ms !== undefined
			? Math.round(requestBody.music_length_ms / 1000)
			: undefined;

	return {
		song: {
			music_id: musicId,
			status: 4,
			audio: canonicalUrl,
			service: 'elevenlabs',
			...(resolvedDurationSeconds !== undefined ? { duration: resolvedDurationSeconds } : {}),
		},
		receipt: {
			r2_key: r2Key,
			bytes: committedBytes,
			upstream_song_id: upstreamSongId,
			gateway_log_id: gatewayLogId,
		},
	};
}

export function toNonRetryableElevenLabsError(error: unknown): NonRetryableError {
	if (error instanceof NonRetryableError) {
		return error;
	}
	if (error instanceof ElevenLabsProviderError) {
		return new NonRetryableError(`ElevenLabs generation failed (${error.code}): ${error.message}`);
	}
	return new NonRetryableError(`ElevenLabs generation failed: ${error instanceof Error ? error.message : String(error)}`);
}
