export type AisgErrorCode =
	| 'content_policy'
	| 'invalid_request'
	| 'idempotency_conflict'
	| 'credits_exhausted'
	| 'provider_auth_error'
	| 'provider_unavailable'
	| 'submit_outcome_unknown';

export class AisgProviderError extends Error {
	readonly provider = 'aisonggenerator' as const;
	readonly code: AisgErrorCode;
	readonly retryable: boolean;
	readonly outcome: 'rejected' | 'unknown';
	readonly fallbackEligible: boolean;
	readonly status?: number;

	constructor(params: {
		message: string;
		code: AisgErrorCode;
		retryable: boolean;
		outcome: 'rejected' | 'unknown';
		fallbackEligible: boolean;
		status?: number;
	}) {
		super(params.message);
		this.name = 'AisgProviderError';
		this.code = params.code;
		this.retryable = params.retryable;
		this.outcome = params.outcome;
		this.fallbackEligible = params.fallbackEligible;
		this.status = params.status;
	}
}

export type AisgTaskSubmitResult =
	| {
		kind: 'task';
		task_id: string;
		workspace_id?: string;
	}
	| {
		kind: 'song_ids';
		song_ids: string[];
	};

export interface AisgTaskDiscoveryResult {
	task_id: string;
	music_ids: string[];
	next_page?: number;
}

/**
 * Outcome of replaying a keyed AISG submit for reconciliation.
 * - `task`: aisonggenerator-worker holds an accepted/completed receipt for this Idempotency-Key
 *   (or the key had no receipt and this replay was the first dispatch under it).
 * - `unresolved`: the receipt is still in_flight/ambiguous (504 `aisg_dispatch_unknown`), the
 *   payload no longer matches the key (409), or the replay itself failed. Never authorizes a new key.
 */
export type AisgAttemptReplayResult =
	| { kind: 'task'; task_id: string; workspace_id?: string }
	| { kind: 'unresolved'; code: AisgErrorCode; status?: number; outcome: 'rejected' | 'unknown' };

const CONTENT_POLICY_PATTERN = /content\s*policy|policy\s*violation|moderation|copyright|nsfw|prohibited|inappropriate|sensitive|explicit|safety/i;
const CREDITS_PATTERN = /insufficient\s*credit|no\s*credit|out\s*of\s*credit|credit.*exhaust|balance|payment\s*required|quota/i;
const AUTH_PATTERN = /session\s*expired|unauthori[sz]ed|not\s*authenticated|login\s*required|cookie|forbidden/i;

export function isContentPolicyMessage(message: string | undefined | null): boolean {
	if (!message) {
		return false;
	}
	return CONTENT_POLICY_PATTERN.test(message);
}

function classifyAisgHttpError(
	status: number,
	rawText: string,
	options: { isPaidSubmit?: boolean } = {}
): AisgProviderError {
	let parsedCode: string | undefined;
	let parsedMessage = rawText.slice(0, 400).trim();
	let parsedRetryable: boolean | undefined;
	let parsedOutcome: 'rejected' | 'unknown' | undefined;
	let hasTypedOutcome = false;

	try {
		const json = JSON.parse(rawText) as {
			code?: string;
			error?: string;
			message?: string;
			retryable?: boolean;
			outcome?: 'rejected' | 'unknown';
		};
		if (typeof json.code === 'string') parsedCode = json.code;
		if (typeof json.message === 'string' && json.message.trim()) parsedMessage = json.message.trim();
		else if (typeof json.error === 'string' && json.error.trim()) parsedMessage = json.error.trim();
		if (typeof json.retryable === 'boolean') parsedRetryable = json.retryable;
		if (json.outcome === 'rejected' || json.outcome === 'unknown') {
			parsedOutcome = json.outcome;
			hasTypedOutcome = true;
		}
	} catch {
		// plain text / untyped gateway error body
	}

	const combined = `${parsedCode ?? ''} ${parsedMessage}`;

	if (parsedOutcome === 'unknown' || parsedCode === 'aisg_dispatch_unknown') {
		return new AisgProviderError({
			message: parsedMessage || `AISG submission outcome unknown (${status})`,
			code: 'submit_outcome_unknown',
			retryable: false,
			outcome: 'unknown',
			fallbackEligible: false,
			status,
		});
	}

	// On a paid submit, classify ambiguous transport/gateway statuses BEFORE interpreting ANY
	// free-form error text (so e.g. HTTP 504 "upstream authorization cookie timeout" or untyped
	// 5xx NEVER matches auth/credits text heuristics and NEVER authorizes paid ElevenLabs fallback).
	// Positive evidence of rejection is required: HTTP 4xx (excluding 408/499) OR structured
	// worker JSON with explicit outcome:'rejected' on non-timeout 5xx (500/502/503).
	if (options.isPaidSubmit) {
		const isAmbiguousTransportStatus = status === 408 || status === 499 || status === 504 || status >= 520;
		const isUntypedServerError = status >= 500 && !(hasTypedOutcome && parsedOutcome === 'rejected');
		if (isAmbiguousTransportStatus || isUntypedServerError) {
			return new AisgProviderError({
				message: parsedMessage || `Ambiguous AISG gateway error (${status}); submission outcome unknown`,
				code: 'submit_outcome_unknown',
				retryable: false,
				outcome: 'unknown',
				fallbackEligible: false,
				status,
			});
		}
	}

	if (parsedCode === 'idempotency_conflict' || status === 409) {
		return new AisgProviderError({
			message: parsedMessage || 'AISG idempotency conflict',
			code: 'idempotency_conflict',
			retryable: false,
			outcome: 'rejected',
			fallbackEligible: false,
			status,
		});
	}

	if (
		parsedCode === 'content_policy'
		|| parsedCode === 'aisg_policy_rejected'
		|| CONTENT_POLICY_PATTERN.test(combined)
	) {
		return new AisgProviderError({
			message: parsedMessage || 'AISG rejected request under content policy',
			code: 'content_policy',
			retryable: false,
			outcome: 'rejected',
			fallbackEligible: false,
			status,
		});
	}

	if (
		status === 402
		|| parsedCode === 'credits_exhausted'
		|| parsedCode === 'aisg_insufficient_credits'
		|| CREDITS_PATTERN.test(combined)
	) {
		return new AisgProviderError({
			message: parsedMessage || 'AISG credits exhausted',
			code: 'credits_exhausted',
			retryable: false,
			outcome: 'rejected',
			fallbackEligible: true,
			status,
		});
	}

	if (
		status === 401
		|| status === 403
		|| parsedCode === 'provider_auth_error'
		|| parsedCode === 'aisg_auth_error'
		|| parsedCode === 'aisg_forbidden'
		|| AUTH_PATTERN.test(combined)
	) {
		return new AisgProviderError({
			message: parsedMessage || `AISG authentication error (${status})`,
			code: 'provider_auth_error',
			retryable: false,
			outcome: 'rejected',
			fallbackEligible: true,
			status,
		});
	}

	if (status === 400 || status === 422 || parsedCode === 'invalid_request') {
		return new AisgProviderError({
			message: parsedMessage || `AISG rejected invalid request (${status})`,
			code: 'invalid_request',
			retryable: false,
			outcome: 'rejected',
			fallbackEligible: false,
			status,
		});
	}

	return new AisgProviderError({
		message: parsedMessage || `AISG request failed (${status})`,
		code: 'provider_unavailable',
		retryable: parsedRetryable ?? (status === 429 || status >= 500),
		outcome: 'rejected',
		fallbackEligible: true,
		status,
	});
}

function normalizeDistinctSongIds(values: unknown): string[] {
	if (!Array.isArray(values)) {
		return [];
	}
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		result.push(id);
	}
	return result;
}

/**
 * Instrumental caption sent to AISG. New lyrics (`intent_v`) send "" so the cover caption never steers
 * an instrumental; old stored lyrics keep sending it, so their idempotency hashes stay stable.
 */
export function aisgSubmitDescription(description: string, lyrics: AiSongGeneratorLyrics, is_instrumental: boolean): string {
	return is_instrumental && lyrics.intent_v ? '' : description;
}

/** Max trimmed prompt length for including cover `# Description` as optional visual flavor on vocal songs. */
export const SHORT_PROMPT_DESCRIPTION_MAX_CHARS = 160;

export interface GeneratedLyricsResponse extends AiSongGeneratorLyrics {
	service?: string;
	model?: string;
	meta?: {
		service?: string;
		model?: string;
		aisg_attempts?: number;
		cf_attempts?: number;
		ms?: number;
		fallbacks?: PipelineLyricsFallback[];
	};
}

export interface GenerateLyricsOptions {
	description?: string;
	instrumental?: boolean;
	smolId?: string;
}

/**
 * Cover-art captions are kept in Step 3 for UI details, Vectorize visual search, and NSFW,
 * but are NOT fed into vocal lyrics generation (otherwise the songwriter narrates literal
 * cover-art objects into the verses).
 */
export function shouldIncludeDescriptionInLyrics(
	_prompt: string,
	_description?: string,
	_instrumental = false
): boolean {
	return false;
}

// Generate lyrics from a prompt (Cloudflare AI Fable 5.2 -> Opus 5.5 -> DeepSeek V4.1 -> GLM-5.3 primary,
// with AISG emergency fallback inside aisonggenerator-worker).
export async function generateLyrics(
	env: Env,
	prompt: string,
	options: GenerateLyricsOptions = {}
): Promise<GeneratedLyricsResponse> {
	const includeDescription = shouldIncludeDescriptionInLyrics(prompt, options.description, options.instrumental);
	const trimmedDescription = includeDescription ? options.description!.trim() : '';
	const finalPrompt = includeDescription
		? `# Prompt
${prompt}

# Description
${trimmedDescription}

# NOTES
Write the title, lyrics, and style tags in the exact language of # Prompt unless another language is explicitly requested.
Stay faithful to # Prompt for genre, mood, vocalist, and subject; if it contains lyrics, keep them.
Treat # Description only as optional visual mood/imagery flavor — ignore anything that clashes with # Prompt, and never mention pixels, pixel art, 8-bit, or images.
Put [Section] headings on their own lines. Never write stage directions or instrument cues in parentheses.
`
		: `# Prompt
${prompt}

# NOTES
Write the title, lyrics, and style tags in the exact language of # Prompt unless another language is explicitly requested.
Stay faithful to # Prompt for genre, mood, vocalist, and subject; if it contains lyrics, keep them.
Put [Section] headings on their own lines. Never write stage directions or instrument cues in parentheses.
`;

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (options.smolId) {
		headers['X-Smol-Id'] = options.smolId;
	}

	const res = await env.AISONGGENERATOR.fetch('http://aisonggenerator-worker/api/lyrics', {
		method: 'POST',
		headers,
		// `user_prompt` (raw) lets the worker's language guard ignore the wrapper; older workers ignore it.
		body: JSON.stringify({
			prompt: finalPrompt,
			user_prompt: prompt,
		}),
		signal: AbortSignal.timeout(55_000),
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw new Error(`Lyrics generation failed (${res.status}): ${errText.slice(0, 300)}`);
	}

	return await res.json() as GeneratedLyricsResponse;
}

/**
 * Submit a paid AISG v6 generation task without blocking on song ID discovery.
 * Passes Idempotency-Key / attempt_id when provided so aisonggenerator-worker can deduplicate
 * and reconcile retries safely. Falls back to POST /api/songs only on HTTP 404 (staged rollout).
 */
export async function submitAisgTask(
	env: Env,
	prompt: string,
	description: string,
	lyrics: AiSongGeneratorLyrics,
	is_public = true,
	is_instrumental = false,
	attemptId?: string,
	smolId?: string
): Promise<AisgTaskSubmitResult> {
	const requestPayload = JSON.stringify({
		...lyrics,
		prompt,
		description: aisgSubmitDescription(description, lyrics, is_instrumental),
		public: is_public,
		instrumental: is_instrumental,
		...(attemptId ? { attempt_id: attemptId } : {}),
	});

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (attemptId) {
		headers['Idempotency-Key'] = attemptId;
	}
	if (smolId) {
		headers['X-Smol-Id'] = smolId;
	}

	let res: Response;
	try {
		res = await env.AISONGGENERATOR.fetch('http://aisonggenerator-worker/api/tasks', {
			method: 'POST',
			headers,
			body: requestPayload,
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		throw new AisgProviderError({
			message: `AISG submit outcome unknown after dispatch: ${err instanceof Error ? err.message : String(err)}`,
			code: 'submit_outcome_unknown',
			retryable: false,
			outcome: 'unknown',
			fallbackEligible: false,
		});
	}

	// Staged rollout fallback: if aisonggenerator-worker does not expose /api/tasks yet, use POST /api/songs.
	if (res.status === 404) {
		const songIds = await generateSongs(env, prompt, description, lyrics, is_public, is_instrumental, attemptId, smolId);
		return {
			kind: 'song_ids',
			song_ids: normalizeDistinctSongIds(songIds),
		};
	}

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw classifyAisgHttpError(res.status, errText, { isPaidSubmit: true });
	}

	const data = await res.json() as { task_id?: unknown; workspace_id?: unknown; music_ids?: unknown };
	const taskId = typeof data?.task_id === 'string' && data.task_id.trim() ? data.task_id.trim() : undefined;
	const workspaceId = typeof data?.workspace_id === 'string' && data.workspace_id.trim() ? data.workspace_id.trim() : undefined;

	if (taskId) {
		return {
			kind: 'task',
			task_id: taskId,
			workspace_id: workspaceId,
		};
	}

	const musicIds = normalizeDistinctSongIds(data?.music_ids);
	if (musicIds.length > 0) {
		return {
			kind: 'song_ids',
			song_ids: musicIds,
		};
	}

	throw new AisgProviderError({
		message: 'AISG submit succeeded but returned neither task_id nor music_ids',
		code: 'submit_outcome_unknown',
		retryable: false,
		outcome: 'unknown',
		fallbackEligible: false,
	});
}

/**
 * Reconcile a claimed/ambiguous AISG attempt by replaying POST /api/tasks with the SAME
 * Idempotency-Key and the SAME request payload (aisonggenerator-worker has no read-only attempt
 * route; its ProviderState DO answers a keyed replay from the stored receipt instead):
 * - accepted/completed receipt -> 200 `{ task_id, workspace_id? }`, no new upstream submit
 * - in_flight/ambiguous receipt -> 504 `aisg_dispatch_unknown` (outcome unknown, never re-submits)
 * - payload hash mismatch       -> 409 `idempotency_conflict`
 * - no receipt (never dispatched, or a confirmed rejection cleared it) -> first submit under this key
 * The payload must match submitAisgTask byte-for-byte in its fields, or the hash check returns 409.
 * Never falls back to the legacy /api/songs route.
 */
export async function replayAisgTaskSubmit(
	env: Env,
	prompt: string,
	description: string,
	lyrics: AiSongGeneratorLyrics,
	is_public: boolean,
	is_instrumental: boolean,
	attemptId: string,
	smolId?: string
): Promise<AisgAttemptReplayResult> {
	let res: Response;
	try {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Idempotency-Key': attemptId,
		};
		if (smolId) {
			headers['X-Smol-Id'] = smolId;
		}
		res = await env.AISONGGENERATOR.fetch('http://aisonggenerator-worker/api/tasks', {
			method: 'POST',
			headers,
			body: JSON.stringify({
				...lyrics,
				prompt,
				description: aisgSubmitDescription(description, lyrics, is_instrumental),
				public: is_public,
				instrumental: is_instrumental,
				attempt_id: attemptId,
			}),
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		return { kind: 'unresolved', code: 'submit_outcome_unknown', outcome: 'unknown' };
	}

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		const err = classifyAisgHttpError(res.status, errText, { isPaidSubmit: true });
		// `rejected` is positive evidence that no paid submit happened on THIS request (4xx incl. 409
		// idempotency_conflict, or typed outcome:'rejected'); everything else may have dispatched.
		return { kind: 'unresolved', code: err.code, status: res.status, outcome: err.outcome === 'rejected' ? 'rejected' : 'unknown' };
	}

	const data = await res.json().catch(() => null) as { task_id?: unknown; workspace_id?: unknown } | null;
	const taskId = typeof data?.task_id === 'string' && data.task_id.trim() ? data.task_id.trim() : undefined;
	const workspaceId = typeof data?.workspace_id === 'string' && data.workspace_id.trim() ? data.workspace_id.trim() : undefined;
	if (!taskId) {
		return { kind: 'unresolved', code: 'submit_outcome_unknown', status: res.status, outcome: 'unknown' };
	}
	return {
		kind: 'task',
		task_id: taskId,
		...(workspaceId ? { workspace_id: workspaceId } : {}),
	};
}

/**
 * Read-only discovery of AISG music IDs for a previously accepted task, honoring pagination (`page` / `next_page`).
 */
export async function discoverAisgTaskSongs(
	env: Env,
	taskId: string,
	workspaceId?: string,
	page?: number,
	smolId?: string
): Promise<AisgTaskDiscoveryResult> {
	const params = new URLSearchParams();
	if (workspaceId) {
		params.set('workspace_id', workspaceId);
	}
	if (typeof page === 'number' && Number.isInteger(page) && page >= 1) {
		params.set('page', String(page));
	}
	const query = params.toString() ? `?${params.toString()}` : '';
	const res = await env.AISONGGENERATOR.fetch(
		`http://aisonggenerator-worker/api/tasks/${encodeURIComponent(taskId)}${query}`,
		{
			method: 'GET',
			...(smolId ? { headers: { 'X-Smol-Id': smolId } } : {}),
			signal: AbortSignal.timeout(15_000),
		}
	);

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw classifyAisgHttpError(res.status, errText, { isPaidSubmit: false });
	}

	const data = await res.json() as { task_id?: string; music_ids?: unknown; next_page?: unknown };
	const nextPage = typeof data?.next_page === 'number' && Number.isInteger(data.next_page) && data.next_page >= 1
		? data.next_page
		: undefined;

	return {
		task_id: typeof data?.task_id === 'string' && data.task_id.trim() ? data.task_id.trim() : taskId,
		music_ids: normalizeDistinctSongIds(data?.music_ids),
		...(nextPage !== undefined ? { next_page: nextPage } : {}),
	};
}

// Legacy AISG song submission route (used only during staged rollout if /api/tasks returns 404)
export async function generateSongs(
	env: Env,
	prompt: string,
	description: string,
	lyrics: AiSongGeneratorLyrics,
	is_public = true,
	is_instrumental = false,
	attemptId?: string,
	smolId?: string
): Promise<string[]> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (attemptId) {
		headers['Idempotency-Key'] = attemptId;
	}
	if (smolId) {
		headers['X-Smol-Id'] = smolId;
	}

	let res: Response;
	try {
		res = await env.AISONGGENERATOR.fetch('http://aisonggenerator-worker/api/songs', {
			method: 'POST',
			headers,
			body: JSON.stringify({
				...lyrics,
				prompt,
				description: aisgSubmitDescription(description, lyrics, is_instrumental),
				public: is_public,
				instrumental: is_instrumental,
				...(attemptId ? { attempt_id: attemptId } : {}),
			}),
			signal: AbortSignal.timeout(45_000),
		});
	} catch (err) {
		throw new AisgProviderError({
			message: `AISG submit outcome unknown after dispatch: ${err instanceof Error ? err.message : String(err)}`,
			code: 'submit_outcome_unknown',
			retryable: false,
			outcome: 'unknown',
			fallbackEligible: false,
		});
	}

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw classifyAisgHttpError(res.status, errText, { isPaidSubmit: true });
	}

	return normalizeDistinctSongIds(await res.json());
}

// Read-only AISG song status snapshot
export async function getSongs(
	env: Env,
	ids: Array<number | string>,
	smolId?: string
): Promise<AiSongGeneratorSong[]> {
	const cleanedIds = normalizeDistinctSongIds(ids);
	if (cleanedIds.length === 0) {
		return [];
	}

	const res = await env.AISONGGENERATOR.fetch(
		`http://aisonggenerator-worker/api/songs?ids=${encodeURIComponent(cleanedIds.join(','))}`,
		{
			method: 'GET',
			...(smolId ? { headers: { 'X-Smol-Id': smolId } } : {}),
			signal: AbortSignal.timeout(20_000),
		}
	);

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw classifyAisgHttpError(res.status, errText, { isPaidSubmit: false });
	}

	return await res.json() as AiSongGeneratorSong[];
}
