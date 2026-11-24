/**
 * Song Generation, Provider Routing, Automatic Fallback, and Bounded Polling Utilities
 *
 * Supports:
 * - AISG v6 (primary default, 2 tracks): split task submit -> paginated read-only discovery ->
 *   bounded polling -> 2-track swap validation -> post-swap R2 commit
 * - ElevenLabs Music v2.5 (explicit choice or automatic fallback, 1 track): direct AI Gateway BYOK ->
 *   R2 commit (no polling or fingerprinting)
 *
 * Paid-submission safety invariants:
 * - Every paid submit step uses `retries: { limit: 0 }`.
 * - Active/claimed/ambiguous attempts carry across the entire retry chain (for BOTH providers).
 * - Still-pending AISG tasks/songs resume discovery/polling instead of triggering a second paid submit
 *   or paid ElevenLabs fallback.
 * - Automatic AISG -> ElevenLabs fallback runs ONLY on confirmed eligible rejections or terminal
 *   non-policy AISG failures.
 */

import { NonRetryableError } from 'cloudflare:workflows';
import { BoundedReadError, readBoundedStream } from './bounded-read';
import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import type { SmolDurableObject } from '../do';
import {
	AisgProviderError,
	discoverAisgTaskSongs,
	getSongs,
	isContentPolicyMessage,
	replayAisgTaskSubmit,
	submitAisgTask,
} from '../ai/aisonggenerator';
import {
	ElevenLabsProviderError,
	generateElevenLabsSong,
	getCanonicalSongUrl,
	getElevenLabsMusicId,
	planElevenLabsVocalDurations,
	estimateFallbackChunkDurationsMs,
	splitElevenLabsLyricSections,
	resolveOptionalElevenLabsMusicLengthMs,
	toNonRetryableElevenLabsError,
} from '../ai/elevenlabs';
import { fetchHttpsFollowingSafeRedirects, UnsafeFetchUrlError } from './safe-fetch';
import {
	extractFingerprint,
	InsufficientAudioDataError,
	matchSongsByFingerprint,
	type AudioFingerprint,
} from './audio-fingerprint';
import {
	commitGenerationQuota,
	getGenerationQuotaReservation,
	markAmbiguousGenerationQuota,
	refundGenerationQuota,
	reserveGenerationQuota,
	transitionFallbackQuota,
} from './quota';

export const DEFAULT_MUSIC_PROVIDER: MusicProvider = 'aisonggenerator';
export const SUPPORTED_MUSIC_PROVIDERS = ['aisonggenerator', 'elevenlabs'] as const;

const EXPECTED_AISG_TRACK_COUNT = 2;
const MAX_FINGERPRINT_ATTEMPTS = 5;
const DISCOVERY_MAX_ITERATIONS = 6;
const POLL_MAX_ITERATIONS = 24;
const AISG_AUDIO_FETCH_TIMEOUT_MS = 45_000;
const AISG_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export { matchSongsByFingerprint, type AudioFingerprint };

export function isValidMusicProvider(value: unknown): value is MusicProvider {
	return value === 'aisonggenerator' || value === 'elevenlabs';
}

export function normalizeMusicProvider(value: unknown): MusicProvider {
	return isValidMusicProvider(value) ? value : DEFAULT_MUSIC_PROVIDER;
}

export function isFallbackEnabled(env: Env): boolean {
	return env.ELEVENLABS_FALLBACK_ENABLED !== 'false';
}

export interface SongGenerationOutcome {
	songs: AiSongGeneratorSong[];
	song_ids: string[];
	requested_provider: MusicProvider;
	active_provider: MusicProvider;
	actual_provider: MusicProvider | null;
	fallback_from?: MusicProvider;
	fallback_reason?: string;
	generation_meta: GenerationMeta;
	reused_songs: boolean;
}

function toDistinctStringIds(ids: Array<string | number> | undefined): string[] {
	if (!Array.isArray(ids)) {
		return [];
	}
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of ids) {
		const id = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
		if (!id || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}

function inferSnapshotProvider(retrySteps: WorkflowSteps): MusicProvider | 'legacy' | null {
	if (isValidMusicProvider(retrySteps.actual_provider)) {
		return retrySteps.actual_provider;
	}
	if (isValidMusicProvider(retrySteps.generation_meta?.actual_provider)) {
		return retrySteps.generation_meta!.actual_provider;
	}
	const services = (retrySteps.songs ?? [])
		.map((s) => (s.service || s.provider || '').toLowerCase())
		.filter(Boolean);
	if (services.length > 0) {
		if (services.every((s) => s === 'elevenlabs')) return 'elevenlabs';
		if (services.every((s) => s === 'aisonggenerator')) return 'aisonggenerator';
		return 'legacy';
	}
	const ids = toDistinctStringIds(retrySteps.song_ids);
	if (ids.length > 0 && ids.every((id) => id.startsWith('el-'))) {
		return 'elevenlabs';
	}
	if (Array.isArray(retrySteps.song_ids) && retrySteps.song_ids.some((id) => typeof id === 'number')) {
		return 'legacy';
	}
	if (isValidMusicProvider(retrySteps.active_provider)) {
		return retrySteps.active_provider;
	}
	return isValidMusicProvider(retrySteps.payload?.provider) ? retrySteps.payload!.provider : null;
}

export function isPollableAisgIds(retrySteps: WorkflowSteps): boolean {
	const ids = toDistinctStringIds(retrySteps.song_ids);
	if (ids.length === 0) return false;
	if (ids.some((id) => id.startsWith('el-'))) return false;
	if (Array.isArray(retrySteps.song_ids) && retrySteps.song_ids.some((id) => typeof id === 'number')) {
		return false;
	}
	const inferred = inferSnapshotProvider(retrySteps);
	if (inferred === 'elevenlabs' || inferred === 'legacy') {
		return false;
	}
	if (Array.isArray(retrySteps.songs) && retrySteps.songs.length > 0) {
		if (retrySteps.songs.some((s) => typeof s.status === 'number' && s.status < 0)) {
			return false;
		}
		if (retrySteps.songs.some((s) => s.service && s.service !== 'aisonggenerator')) {
			return false;
		}
	}
	return true;
}

export function hasReusableCompleteSongs(retrySteps: WorkflowSteps | undefined): boolean {
	if (!retrySteps) return false;
	const previousProvider = inferSnapshotProvider(retrySteps);
	const retrySongIds = toDistinctStringIds(retrySteps.song_ids);
	const retrySongs = Array.isArray(retrySteps.songs) ? retrySteps.songs : [];
	const distinctRetrySongMusicIds = toDistinctStringIds(
		retrySongs.map((s) => s?.music_id).filter((id): id is string => Boolean(id))
	);
	const isExplicitAisgSnapshot = previousProvider === 'aisonggenerator'
		|| retrySongs.some((s) => (s.service || s.provider || '').toLowerCase() === 'aisonggenerator');
	const requiredTrackCount = isExplicitAisgSnapshot ? EXPECTED_AISG_TRACK_COUNT : 1;
	const songIdsMatchRetrySongs = distinctRetrySongMusicIds.length === retrySongs.length
		&& distinctRetrySongMusicIds.length === retrySongIds.length
		&& distinctRetrySongMusicIds.every((id) => retrySongIds.includes(id));

	return retrySongs.length >= requiredTrackCount
		&& songIdsMatchRetrySongs
		&& retrySongs.every((s) => Boolean(s?.music_id && s.status >= 4 && s.audio));
}

export function hasIncompleteAisgSnapshot(retrySteps: WorkflowSteps | undefined): boolean {
	if (!retrySteps) return false;
	const previousProvider = inferSnapshotProvider(retrySteps);
	const retrySongs = Array.isArray(retrySteps.songs) ? retrySteps.songs : [];
	const distinctRetrySongMusicIds = toDistinctStringIds(
		retrySongs.map((s) => s?.music_id).filter((id): id is string => Boolean(id))
	);
	const isExplicitAisgSnapshot = previousProvider === 'aisonggenerator'
		|| retrySongs.some((s) => (s.service || s.provider || '').toLowerCase() === 'aisonggenerator');

	return isExplicitAisgSnapshot
		&& distinctRetrySongMusicIds.length > 0
		&& distinctRetrySongMusicIds.length < EXPECTED_AISG_TRACK_COUNT
		&& retrySongs.every((s) => typeof s.status !== 'number' || s.status >= 0);
}

export function resolveRetryTargetProvider(
	retrySteps: WorkflowSteps,
	overrideProvider?: MusicProvider
): MusicProvider {
	if (overrideProvider) {
		return overrideProvider;
	}
	if (retrySteps.active_provider === 'elevenlabs' || retrySteps.fallback_from === 'aisonggenerator') {
		return 'elevenlabs';
	}
	if (isValidMusicProvider(retrySteps.payload?.provider)) {
		return retrySteps.payload!.provider;
	}
	if (isValidMusicProvider(retrySteps.requested_provider)) {
		return retrySteps.requested_provider;
	}
	return DEFAULT_MUSIC_PROVIDER;
}

export type RetryAdmissionPlan =
	| {
		kind: 'reuse';
		reason: 'complete_songs' | 'active_attempt' | 'pollable_aisg' | 'incomplete_aisg_snapshot' | 'r2_elevenlabs_artifact';
		expectedR2Key?: string;
	}
	| {
		kind: 'fresh';
		targetProvider: MusicProvider;
	};

/**
 * Classify whether retrying `retrySteps` will reuse/reconcile an existing paid/pending/complete
 * attempt or dispatch a fresh paid provider call.
 * R2 lookup errors propagate (never swallowed as "missing") so callers treat them as retryable 503.
 */
export async function classifyRetryAdmission(
	env: Env,
	retryId: string,
	retrySteps: WorkflowSteps,
	overrideProvider?: MusicProvider
): Promise<RetryAdmissionPlan> {
	if (hasReusableCompleteSongs(retrySteps)) {
		return { kind: 'reuse', reason: 'complete_songs' };
	}

	// Active/claimed/submitted/committed/ambiguous paid attempts always enter reconcileCarriedAttempt first
	if (retrySteps.provider_attempt && retrySteps.provider_attempt.status !== 'failed') {
		return { kind: 'reuse', reason: 'active_attempt' };
	}

	// Pending AISG IDs enter Path 2 quick-check/resume (if quick-check later hits terminal_failed,
	// ElevenLabs fallback/override enforces independent quota inside the workflow before dispatch)
	if (isPollableAisgIds(retrySteps)) {
		return { kind: 'reuse', reason: 'pollable_aisg' };
	}

	// Incomplete historical AISG snapshot fails closed without making a paid call
	if (hasIncompleteAisgSnapshot(retrySteps)) {
		return { kind: 'reuse', reason: 'incomplete_aisg_snapshot' };
	}

	// Path 1B: prior ElevenLabs fallback whose committed R2 artifact already exists.
	// Propagate R2 errors (fail closed / retryable) rather than treating transient R2 failures as missing.
	const previousProvider = inferSnapshotProvider(retrySteps);
	const providerChangedOnRetry = Boolean(
		overrideProvider
		&& previousProvider
		&& previousProvider !== overrideProvider
	);
	if (
		!providerChangedOnRetry
		&& (retrySteps.active_provider === 'elevenlabs' || retrySteps.fallback_from === 'aisonggenerator')
	) {
		const prevSmolId = retrySteps.provider_attempt?.source_smol_id ?? retryId;
		if (prevSmolId && typeof env.SMOL_BUCKET?.head === 'function') {
			const r2Key = `${getElevenLabsMusicId(prevSmolId)}.mp3`;
			const head = await env.SMOL_BUCKET.head(r2Key);
			if (head && head.size > 0) {
				return { kind: 'reuse', reason: 'r2_elevenlabs_artifact', expectedR2Key: r2Key };
			}
		}
	}

	return {
		kind: 'fresh',
		targetProvider: resolveRetryTargetProvider(retrySteps, overrideProvider),
	};
}

export async function doesRetryReuseExistingAttempt(
	env: Env,
	retryId: string,
	retrySteps: WorkflowSteps,
	overrideProvider?: MusicProvider
): Promise<boolean> {
	const plan = await classifyRetryAdmission(env, retryId, retrySteps, overrideProvider);
	return plan.kind === 'reuse';
}

async function saveProviderProgress(
	stub: DurableObjectStub<SmolDurableObject>,
	progress: {
		requested_provider: MusicProvider;
		active_provider: MusicProvider;
		actual_provider: MusicProvider | null;
		fallback_from?: MusicProvider;
		fallback_reason?: string;
	}
): Promise<void> {
	const generation_meta: GenerationMeta = {
		requested_provider: progress.requested_provider,
		actual_provider: progress.actual_provider,
		...(progress.fallback_from ? { fallback_from: progress.fallback_from } : {}),
		...(progress.fallback_reason ? { fallback_reason: progress.fallback_reason } : {}),
	};

	const doStub = stub as unknown as {
		saveSteps?: (entries: Record<string, unknown>) => Promise<void>;
		saveStep: (step: string, data: unknown, options?: { persistMedia?: boolean }) => Promise<void>;
	};

	if (typeof doStub.saveSteps === 'function') {
		await doStub.saveSteps({
			requested_provider: progress.requested_provider,
			active_provider: progress.active_provider,
			actual_provider: progress.actual_provider,
			...(progress.fallback_from ? { fallback_from: progress.fallback_from } : {}),
			...(progress.fallback_reason ? { fallback_reason: progress.fallback_reason } : {}),
			generation_meta,
		});
		return;
	}

	await doStub.saveStep('requested_provider', progress.requested_provider, { persistMedia: false });
	await doStub.saveStep('active_provider', progress.active_provider, { persistMedia: false });
	await doStub.saveStep('actual_provider', progress.actual_provider, { persistMedia: false });
	if (progress.fallback_from) {
		await doStub.saveStep('fallback_from', progress.fallback_from, { persistMedia: false });
	}
	if (progress.fallback_reason) {
		await doStub.saveStep('fallback_reason', progress.fallback_reason, { persistMedia: false });
	}
	await doStub.saveStep('generation_meta', generation_meta, { persistMedia: false });
}

async function saveStateOnlyStep(
	stub: DurableObjectStub<SmolDurableObject>,
	key: string,
	data: unknown
): Promise<void> {
	const doStub = stub as unknown as {
		saveStep: (step: string, data: unknown, options?: { persistMedia?: boolean }) => Promise<void>;
	};
	await doStub.saveStep(key, data, { persistMedia: false });
}

async function claimAttemptIfSupported(
	stub: DurableObjectStub<SmolDurableObject>,
	provider: MusicProvider,
	meta?: Partial<ProviderAttemptState>
): Promise<{ claimed: boolean; attempt?: ProviderAttemptState }> {
	const doStub = stub as unknown as {
		claimPaidAttempt?: (
			p: MusicProvider,
			m?: Partial<ProviderAttemptState>
		) => Promise<{ claimed: boolean; attempt: ProviderAttemptState }>;
	};
	if (typeof doStub.claimPaidAttempt === 'function') {
		return await doStub.claimPaidAttempt(provider, meta);
	}
	return { claimed: true };
}

async function updateAttemptIfSupported(
	stub: DurableObjectStub<SmolDurableObject>,
	attempt: ProviderAttemptState
): Promise<void> {
	const doStub = stub as unknown as {
		updatePaidAttempt?: (a: ProviderAttemptState) => Promise<void>;
	};
	if (typeof doStub.updatePaidAttempt === 'function') {
		await doStub.updatePaidAttempt(attempt);
	}
}

function parseDeclaredContentLength(response: Response): number | null {
	const header = response.headers.get('content-length');
	if (!header || !/^\d+$/.test(header.trim())) {
		return null;
	}
	const value = Number(header.trim());
	return Number.isSafeInteger(value) ? value : null;
}

/** Reads finalized AISG audio with a hard byte cap so an oversized upstream is never buffered in full. */
async function readAisgAudioBody(response: Response, musicId: string): Promise<Uint8Array> {
	try {
		return await readBoundedStream(response.body, AISG_MAX_AUDIO_BYTES, parseDeclaredContentLength(response));
	} catch (err) {
		if (!(err instanceof BoundedReadError)) {
			throw err;
		}
		if (err.reason === 'too_large') {
			throw new NonRetryableError(`Audio for ${musicId} exceeded ${AISG_MAX_AUDIO_BYTES} bytes`);
		}
		if (err.reason === 'empty') {
			throw new Error(`Empty audio downloaded for ${musicId}`);
		}
		throw new Error(`Truncated audio downloaded for ${musicId} (expected ${err.declaredLength} bytes, received ${err.receivedBytes})`);
	}
}

/**
 * Commit final AISG MP3 files to R2 AFTER swap resolution completes.
 * Reuses an existing R2 object only when verified (non-empty and not remapped by a swap).
 */
export async function commitSongsAudioToR2(params: {
	env: Env;
	smolId: string;
	songs: AiSongGeneratorSong[];
	provider: MusicProvider | null;
	swapped?: boolean;
}): Promise<AiSongGeneratorSong[]> {
	const { env, smolId, songs, provider, swapped } = params;
	const committed: AiSongGeneratorSong[] = [];

	for (const song of songs) {
		const musicId = song.music_id?.trim();
		if (!musicId || !song.audio || song.status < 4) {
			throw new NonRetryableError(`Cannot commit incomplete song ${musicId || 'unknown'} to R2`);
		}

		const r2Key = `${musicId}.mp3`;
		const canonicalUrl = getCanonicalSongUrl(musicId);
		const existing = typeof env.SMOL_BUCKET.head === 'function'
			? await env.SMOL_BUCKET.head(r2Key)
			: null;

		const isCanonicalAudio = song.audio === canonicalUrl;
		const existingMatchesSource = Boolean(
			existing
			&& existing.size > 0
			&& (
				isCanonicalAudio
				|| (!swapped && (!existing.customMetadata?.sourceUrl || existing.customMetadata.sourceUrl === song.audio))
			)
		);

		if (!existingMatchesSource) {
			if (isCanonicalAudio) {
				throw new NonRetryableError(`Verified R2 audio missing for canonical song ${musicId}`);
			}

			let response: Response;
			try {
				response = await fetchHttpsFollowingSafeRedirects(song.audio, {
					signal: AbortSignal.timeout(AISG_AUDIO_FETCH_TIMEOUT_MS),
				});
			} catch (err) {
				if (err instanceof UnsafeFetchUrlError) {
					throw new NonRetryableError(`Refusing non-https audio URL for ${musicId}: ${err.message}`);
				}
				throw err;
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new Error(`Failed to fetch finalized audio for ${musicId} (${response.status})`);
			}

			const audioBytes = await readAisgAudioBody(response, musicId);

			await env.SMOL_BUCKET.put(r2Key, audioBytes, {
				httpMetadata: { contentType: 'audio/mpeg' },
				customMetadata: {
					smolId,
					provider: provider ?? song.service ?? 'aisonggenerator',
					sourceUrl: song.audio,
				},
			});
		}

		committed.push({
			...song,
			music_id: musicId,
			audio: song.audio || canonicalUrl,
		});
	}

	return committed;
}

/**
 * Require a fresh provider-specific reservation before ANY new paid dispatch (defense in depth).
 * - A reuse-only workflow MUST stop instead of dispatching unreserved paid work.
 * - If the workflow already carries a matching provider-specific reservation, reuse it directly.
 * - Otherwise (e.g. legacy unreserved workflow or mismatched inherited reservation), atomically reserve
 *   a distinct provider-specific reservation inside a workflow step before dispatching.
 */
async function ensureFreshPaidDispatchQuota(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	smolId: string;
	targetProvider: MusicProvider;
	address?: string;
	quotaReservationId?: string;
	quotaDayKey?: string;
	quotaProvider?: MusicProvider;
	reuseOnly?: boolean;
}): Promise<{ reservationId: string; dayKey?: string; provider: MusicProvider }> {
	const {
		env,
		stub,
		step,
		config,
		smolId,
		targetProvider,
		address,
		quotaReservationId,
		quotaDayKey,
		quotaProvider,
		reuseOnly,
	} = params;

	if (reuseOnly) {
		throw new NonRetryableError(
			`Reuse-only retry refused to dispatch unreserved paid ${targetProvider} generation because expected reusable artifact was unavailable`
		);
	}

	if (quotaReservationId && quotaProvider === targetProvider) {
		return {
			reservationId: quotaReservationId,
			dayKey: quotaDayKey,
			provider: targetProvider,
		};
	}

	return await reservePaidDispatchQuota({
		env,
		stub,
		step,
		config,
		smolId,
		targetProvider,
		address,
		reservationId: `${smolId}:dispatch:${targetProvider}`,
		stepName: `reserve ${targetProvider} dispatch quota`,
	});
}

/**
 * Reserve a NEW per-user (and global) quota slot under `reservationId` before a paid dispatch.
 * On denial, records a -4 song state and throws NonRetryableError so no paid call is made.
 */
async function reservePaidDispatchQuota(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	smolId: string;
	targetProvider: MusicProvider;
	address?: string;
	reservationId: string;
	stepName: string;
}): Promise<{ reservationId: string; dayKey?: string; provider: MusicProvider }> {
	const { env, stub, step, config, smolId, targetProvider, address, reservationId: dispatchReservationId, stepName } = params;

	type DispatchAuthResult =
		| { ok: true; reservationId: string; dayKey: string }
		| { ok: false; code: string; error: string };

	const auth = await step.do(
		stepName,
		config,
		async (): Promise<DispatchAuthResult> => {
			if (!address) {
				return {
					ok: false,
					code: 'missing_address',
					error: `Missing user address for ${targetProvider} quota enforcement`,
				};
			}
			if (!env.USER_QUOTA) {
				return {
					ok: false,
					code: 'quota_unavailable',
					error: `${targetProvider} quota service is unavailable`,
				};
			}

			const reserved = await reserveGenerationQuota(env, {
				address,
				reservationId: dispatchReservationId,
				provider: targetProvider,
			});
			if (reserved.ok) {
				return {
					ok: true,
					reservationId: dispatchReservationId,
					dayKey: reserved.dayKey,
				};
			}
			if (reserved.code === 'quota_exceeded') {
				return {
					ok: false,
					code: 'quota_exceeded',
					error: reserved.payload.error,
				};
			}
			return {
				ok: false,
				code: 'quota_conflict',
				error: `Unable to reserve ${targetProvider} quota (conflict with ${reserved.existingProvider})`,
			};
		}
	);

	if (!auth.ok) {
		await step.do('record dispatch quota denial', config, async () => {
			await saveStateOnlyStep(stub, 'songs', [{
				music_id: targetProvider === 'elevenlabs' ? getElevenLabsMusicId(smolId) : smolId,
				status: -4,
				audio: '',
				service: targetProvider,
				error_message: auth.error,
			}]);
		});
		throw new NonRetryableError(`Paid ${targetProvider} dispatch blocked by quota (${auth.code}): ${auth.error}`);
	}

	return {
		reservationId: auth.reservationId,
		dayKey: auth.dayKey,
		provider: targetProvider,
	};
}

/**
 * Enforce ElevenLabs daily/global quota BEFORE any automatic AISG -> ElevenLabs fallback
 * or pending-AISG -> ElevenLabs override. Never allows fallback to bypass ElevenLabs limits.
 *
 * Accounting policy:
 * - Confirmed pre-charge AISG rejection (`aisgWasUnbilled === true`): transfers the unbilled Classic
 *   slot to ElevenLabs via `transitionFallbackQuota` (or refunds Classic if ElevenLabs cap is exceeded).
 * - Already-accepted/billed AISG failure (`aisgWasUnbilled === false`, e.g., poll/quick-check failure):
 *   RETAINS the accepted Classic reservation permanently on its original UTC day (`markAmbiguous`),
 *   and reserves ElevenLabs INDEPENDENTLY under a distinct reservation ID (`<smolId>:fallback:elevenlabs`).
 *   This guarantees Classic usage is never lost on fallback success/unknown outcomes and never breaks
 *   across UTC midnight if ElevenLabs subsequently rejects.
 */
async function authorizeElevenLabsFallbackQuota(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	smolId: string;
	address?: string;
	quotaReservationId?: string;
	quotaDayKey?: string;
	aisgWasUnbilled: boolean;
	failureReason: string;
}): Promise<{ reservationId: string; dayKey: string; provider: 'elevenlabs' }> {
	const {
		env,
		stub,
		step,
		config,
		smolId,
		address,
		quotaReservationId,
		quotaDayKey,
		aisgWasUnbilled,
		failureReason,
	} = params;

	type FallbackAuthStepResult =
		| { ok: true; reservationId: string; dayKey: string }
		| { ok: false; error: string; code: string };

	const authResult = await step.do(
		'authorize elevenlabs fallback quota',
		config,
		async (): Promise<FallbackAuthStepResult> => {
			if (!address) {
				return {
					ok: false,
					code: 'missing_address',
					error: 'Missing user address for ElevenLabs fallback quota enforcement',
				};
			}
			if (!env.USER_QUOTA) {
				return {
					ok: false,
					code: 'quota_unavailable',
					error: 'ElevenLabs fallback quota service is unavailable',
				};
			}

			// Case 1: Confirmed pre-charge AISG rejection -> transfer the unbilled Classic slot to ElevenLabs
			if (aisgWasUnbilled && quotaReservationId) {
				const transitioned = await transitionFallbackQuota(env, {
					address,
					reservationId: quotaReservationId,
					fromProvider: 'aisonggenerator',
					toProvider: 'elevenlabs',
					previousDayKey: quotaDayKey,
				});
				if (transitioned.ok) {
					return {
						ok: true,
						reservationId: quotaReservationId,
						dayKey: transitioned.dayKey,
					};
				}
				if (transitioned.code === 'quota_exceeded') {
					return {
						ok: false,
						code: 'quota_exceeded',
						error: transitioned.payload.error,
					};
				}
				return {
					ok: false,
					code: 'quota_invalid_state',
					error: `Unable to transition quota reservation to ElevenLabs (${transitioned.status})`,
				};
			}

			// Case 2: Already-accepted/billed AISG failure (or legacy smol with no prior reservation):
			// Retain the billed Classic attempt on its original UTC day first, then reserve ElevenLabs independently!
			if (!aisgWasUnbilled && quotaReservationId) {
				await markAmbiguousGenerationQuota(env, {
					address,
					reservationId: quotaReservationId,
					dayKey: quotaDayKey,
					reason: `aisg_billed_fallback_${failureReason}`,
				});
			}

			const independentFallbackId = `${smolId}:fallback:elevenlabs`;
			const reserved = await reserveGenerationQuota(env, {
				address,
				reservationId: independentFallbackId,
				provider: 'elevenlabs',
			});
			if (reserved.ok) {
				return {
					ok: true,
					reservationId: independentFallbackId,
					dayKey: reserved.dayKey,
				};
			}
			if (reserved.code === 'quota_exceeded') {
				return {
					ok: false,
					code: 'quota_exceeded',
					error: reserved.payload.error,
				};
			}
			return {
				ok: false,
				code: 'quota_conflict',
				error: `Unable to reserve ElevenLabs fallback quota (conflict with ${reserved.existingProvider})`,
			};
		}
	);

	if (!authResult.ok) {
		await step.do('handle elevenlabs fallback quota denial', config, async () => {
			if (address && quotaReservationId) {
				if (aisgWasUnbilled) {
					await refundGenerationQuota(env, {
						address,
						reservationId: quotaReservationId,
						dayKey: quotaDayKey,
						reason: `aisg_rejected_fallback_${authResult.code}`,
					});
				} else {
					await markAmbiguousGenerationQuota(env, {
						address,
						reservationId: quotaReservationId,
						dayKey: quotaDayKey,
						reason: `aisg_billed_fallback_${authResult.code}`,
					});
				}
			}

			await saveStateOnlyStep(stub, 'songs', [{
				music_id: smolId,
				status: -4,
				audio: '',
				service: 'aisonggenerator',
				error_message: `Classic failed (${failureReason}) and ElevenLabs fallback unavailable: ${authResult.error}`,
			}]);
		});

		throw new NonRetryableError(`ElevenLabs fallback blocked by quota (${authResult.code}): ${authResult.error}`);
	}

	return {
		reservationId: authResult.reservationId,
		dayKey: authResult.dayKey,
		provider: 'elevenlabs',
	};
}

function isOwnFreshReservationId(reservationId: string | undefined, smolId: string): boolean {
	if (!reservationId) {
		return false;
	}
	return (
		reservationId === smolId
		|| reservationId === `${smolId}:fallback:elevenlabs`
		|| reservationId === `${smolId}:dispatch:elevenlabs`
		|| reservationId === `${smolId}:dispatch:aisonggenerator`
	);
}

/**
 * Reconcile ElevenLabs quota strictly from the actual dispatch vs reuse outcome:
 * - If a predecessor's already-paid R2 artifact was reused without a paid dispatch, REFUND this
 *   successor's fresh reservation instead of committing it!
 * - Otherwise (genuine paid dispatch or replay of this instance's own R2 artifact), COMMIT it.
 */
async function settleElevenLabsQuotaFromOutcome(
	env: Env,
	params: {
		address?: string;
		reservationId?: string;
		dayKey?: string;
		quotaProvider?: MusicProvider;
		smolId: string;
		targetSmolId: string;
		reusedFromR2: boolean;
	}
): Promise<void> {
	const { address, reservationId, dayKey, quotaProvider, smolId, targetSmolId, reusedFromR2 } = params;
	if (!address || !reservationId) {
		return;
	}
	const isPredecessorReuse = reusedFromR2 && targetSmolId !== smolId && isOwnFreshReservationId(reservationId, smolId);
	if (isPredecessorReuse) {
		await refundGenerationQuota(env, {
			address,
			reservationId,
			dayKey,
			reason: 'reused_predecessor_r2_artifact',
		});
		return;
	}
	if (!quotaProvider || quotaProvider === 'elevenlabs') {
		await commitGenerationQuota(env, {
			address,
			reservationId,
			actualProvider: 'elevenlabs',
			dayKey,
		});
	}
}

/**
 * Execute ElevenLabs 1-track generation (explicit or automatic fallback) inside a non-retried paid step.
 */
/** Vocal pacing that never throws: planner -> empirical baseline -> undefined. */
export async function planElevenLabsVocalDurationsSafely(
	env: Env,
	prompt: string,
	lyrics: AiSongGeneratorLyrics
): Promise<number[] | undefined> {
	try {
		return await planElevenLabsVocalDurations({ env, prompt, lyrics });
	} catch (err) {
		console.warn(
			'ElevenLabs vocal pacing failed; using empirical baseline:',
			err instanceof Error ? err.message : String(err)
		);
	}
	try {
		return estimateFallbackChunkDurationsMs(splitElevenLabsLyricSections(lyrics.lyrics ?? ''));
	} catch {
		return undefined;
	}
}

async function runElevenLabsGeneration(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	smolId: string;
	address?: string;
	quotaReservationId?: string;
	quotaDayKey?: string;
	quotaProvider?: MusicProvider;
	reuseOnly?: boolean;
	prompt: string;
	description: string;
	lyrics: AiSongGeneratorLyrics;
	is_instrumental: boolean;
	requested_provider: MusicProvider;
	fallback_from?: MusicProvider;
	fallback_reason?: string;
	resumeFromR2SmolId?: string;
}): Promise<SongGenerationOutcome> {
	const {
		env,
		stub,
		step,
		config,
		smolId,
		address,
		quotaReservationId,
		quotaDayKey,
		quotaProvider,
		reuseOnly,
		prompt,
		description,
		lyrics,
		is_instrumental,
		requested_provider,
		fallback_from,
		fallback_reason,
		resumeFromR2SmolId,
	} = params;

	const targetSmolId = resumeFromR2SmolId ?? smolId;
	const existingMusicId = getElevenLabsMusicId(targetSmolId);
	const stepName = fallback_from ? 'generate song (elevenlabs fallback)' : 'generate song (elevenlabs)';

	// Always perform pre-claim R2 HEAD inside a RETRYABLE step BEFORE claiming any paid attempt:
	// - Transient R2 read failures retry cleanly via Workflows without stranding quota.
	// - If retries exhaust before any paid claim, release own fresh reservation cleanly.
	// - If a committed R2 artifact already exists, reuse it and reconcile quota from reuse outcome.
	// - If a reuse-only workflow finds its expected artifact missing, stop immediately without dispatching.
	let existingR2Meta: { size: number; upstreamSongId?: string; gatewayLogId?: string } | null = null;
	try {
		existingR2Meta = await step.do('check existing elevenlabs r2 artifact', config, async () => {
			if (typeof env.SMOL_BUCKET.head !== 'function') {
				return null;
			}
			const head = await env.SMOL_BUCKET.head(`${existingMusicId}.mp3`);
			if (!head || head.size <= 0) {
				return null;
			}
			if (head.customMetadata?.smolId && head.customMetadata.smolId !== targetSmolId) {
				return null;
			}
			return {
				size: head.size,
				upstreamSongId: head.customMetadata?.upstreamSongId,
				gatewayLogId: head.customMetadata?.gatewayLogId,
			};
		});
	} catch (err) {
		if (
			!(err instanceof Error && err.name === 'SuspendSignal')
			&& address
			&& quotaReservationId
			&& isOwnFreshReservationId(quotaReservationId, smolId)
		) {
			await step.do('refund quota on pre-claim r2 failure', config, async () => {
				await refundGenerationQuota(env, {
					address,
					reservationId: quotaReservationId,
					dayKey: quotaDayKey,
					reason: 'pre_claim_r2_head_failed',
				});
			}).catch(() => {});
		}
		throw err;
	}

	if (existingR2Meta) {
		const reusedSong: AiSongGeneratorSong = {
			music_id: existingMusicId,
			status: 4,
			audio: getCanonicalSongUrl(existingMusicId),
			service: 'elevenlabs',
		};
		const songs = [reusedSong];
		const song_ids = [existingMusicId];
		const generation_meta: GenerationMeta = {
			requested_provider,
			actual_provider: 'elevenlabs',
			...(fallback_from ? { fallback_from } : {}),
			...(fallback_reason ? { fallback_reason } : {}),
		};

		await step.do('save song ids', config, () => saveStateOnlyStep(stub, 'song_ids', song_ids));
		await step.do('save songs', config, async () => {
			await updateAttemptIfSupported(stub, {
				provider: 'elevenlabs',
				status: 'committed',
				source_smol_id: targetSmolId,
				song_ids,
				r2_keys: [`${existingMusicId}.mp3`],
				upstream_song_id: existingR2Meta!.upstreamSongId,
				gateway_log_id: existingR2Meta!.gatewayLogId,
				updated_at: new Date().toISOString(),
			});
			await saveStateOnlyStep(stub, 'songs', songs);
			await saveProviderProgress(stub, {
				requested_provider,
				active_provider: 'elevenlabs',
				actual_provider: 'elevenlabs',
				fallback_from,
				fallback_reason,
			});
			await settleElevenLabsQuotaFromOutcome(env, {
				address,
				reservationId: quotaReservationId,
				dayKey: quotaDayKey,
				quotaProvider,
				smolId,
				targetSmolId,
				reusedFromR2: true,
			});
		});

		return {
			songs,
			song_ids,
			requested_provider,
			active_provider: 'elevenlabs',
			actual_provider: 'elevenlabs',
			fallback_from,
			fallback_reason,
			generation_meta,
			reused_songs: true,
		};
	}

	if (reuseOnly) {
		throw new NonRetryableError(
			`Expected reusable ElevenLabs R2 artifact (${existingMusicId}.mp3) is missing; refusing unreserved paid dispatch`
		);
	}

	// Require a fresh ElevenLabs-specific reservation before ANY new paid ElevenLabs dispatch
	const paidQuota = await ensureFreshPaidDispatchQuota({
		env,
		stub,
		step,
		config,
		smolId,
		targetProvider: 'elevenlabs',
		address,
		quotaReservationId,
		quotaDayKey,
		quotaProvider,
		reuseOnly,
	});

	await step.do('record elevenlabs provider state', config, async () => {
		await saveProviderProgress(stub, {
			requested_provider,
			active_provider: 'elevenlabs',
			actual_provider: null,
			fallback_from,
			fallback_reason,
		});
		await saveStateOnlyStep(stub, 'quota_reservation_id', paidQuota.reservationId);
		await saveStateOnlyStep(stub, 'quota_provider', 'elevenlabs');
		if (paidQuota.dayKey) {
			await saveStateOnlyStep(stub, 'quota_day_key', paidQuota.dayKey);
		}
	});

	// For vocal tracks without an explicit ELEVENLABS_MUSIC_LENGTH_MS override, run a cheap
	// checkpointed Workers AI pacing step (glm-5.3 with empirical fallback) BEFORE the non-retried
	// paid submit step. It runs only after the pre-claim R2 check above found no committed artifact
	// (that result is reused; no second HEAD after quota admission). The step body NEVER throws: any
	// AI/helper failure degrades to the empirical baseline, or to `undefined` (the paid step then
	// derives the baseline itself or rejects the lyrics pre-dispatch with a refund), so a fresh quota
	// reservation can never be stranded between admission and the paid step.
	let plannedChunkDurationsMs: number[] | undefined;
	if (!is_instrumental && resolveOptionalElevenLabsMusicLengthMs(env) === undefined) {
		plannedChunkDurationsMs = await step.do(
			'plan elevenlabs vocal pacing',
			config,
			async () => await planElevenLabsVocalDurationsSafely(env, prompt, lyrics)
		);
	}

	// Paid submit step: retries MUST be 0 so an ambiguous response never triggers a silent second charge.
	// Pre-claim R2 HEAD already ran in the retryable step above; if the provider helper itself discovers
	// a newly committed R2 artifact (receipt.reused_from_r2 === true), quota is reconciled from reuse outcome
	// (refunding a fresh successor reservation instead of committing it!).
	const result = await step.do(
		stepName,
		{
			...config,
			retries: { limit: 0, delay: '1 second' },
		},
		async () => {
			const claim = await claimAttemptIfSupported(stub, 'elevenlabs', {
				source_smol_id: targetSmolId,
			});
			if (!claim.claimed && claim.attempt) {
				throw new NonRetryableError(
					`Paid attempt (${claim.attempt.provider}, status=${claim.attempt.status}) already claimed for ${targetSmolId} with no committed R2 artifact; refusing duplicate charge`
				);
			}

			try {
				const generated = await generateElevenLabsSong({
					env,
					smolId: targetSmolId,
					prompt,
					description,
					lyrics,
					isInstrumental: is_instrumental,
					chunkDurationsMs: plannedChunkDurationsMs,
				});

				await updateAttemptIfSupported(stub, {
					provider: 'elevenlabs',
					status: 'committed',
					source_smol_id: targetSmolId,
					song_ids: [generated.song.music_id],
					r2_keys: [generated.receipt.r2_key],
					upstream_song_id: generated.receipt.upstream_song_id,
					gateway_log_id: generated.receipt.gateway_log_id,
					updated_at: new Date().toISOString(),
				});

				await settleElevenLabsQuotaFromOutcome(env, {
					address,
					reservationId: paidQuota.reservationId,
					dayKey: paidQuota.dayKey,
					quotaProvider: 'elevenlabs',
					smolId,
					targetSmolId,
					reusedFromR2: Boolean(generated.receipt.reused_from_r2),
				}).catch(() => {});

				return generated;
			} catch (err) {
				// Only a confirmed pre-charge rejection (ElevenLabsProviderError with outcome==='rejected')
				// may mark the attempt 'failed' and refund THIS ElevenLabs reservation (any previously
				// accepted Classic reservation lives on its own row and stays untouched).
				const isConfirmedRejection = err instanceof ElevenLabsProviderError && err.outcome === 'rejected';
				const errorCode = err instanceof ElevenLabsProviderError ? err.code : 'storage_commit_failed';
				const errorMessage = err instanceof Error ? err.message : String(err);

				await updateAttemptIfSupported(stub, {
					provider: 'elevenlabs',
					status: isConfirmedRejection ? 'failed' : 'ambiguous',
					source_smol_id: targetSmolId,
					error_code: errorCode,
					error_message: errorMessage,
					updated_at: new Date().toISOString(),
				});

				if (address && paidQuota.reservationId) {
					if (isConfirmedRejection) {
						await refundGenerationQuota(env, {
							address,
							reservationId: paidQuota.reservationId,
							dayKey: paidQuota.dayKey,
							reason: errorCode,
						}).catch(() => {});
					} else {
						await markAmbiguousGenerationQuota(env, {
							address,
							reservationId: paidQuota.reservationId,
							dayKey: paidQuota.dayKey,
							reason: errorCode,
						}).catch(() => {});
					}
				}

				await saveStateOnlyStep(stub, 'songs', [{
					music_id: getElevenLabsMusicId(targetSmolId),
					status: errorCode === 'content_policy' ? -1 : -4,
					audio: '',
					service: 'elevenlabs',
					error_message: errorMessage,
				}]);

				throw toNonRetryableElevenLabsError(err);
			}
		}
	);

	const songs = [result.song];
	const song_ids = [result.song.music_id];
	const reusedFromR2 = Boolean(result.receipt.reused_from_r2);
	const generation_meta: GenerationMeta = {
		requested_provider,
		actual_provider: 'elevenlabs',
		...(fallback_from ? { fallback_from } : {}),
		...(fallback_reason ? { fallback_reason } : {}),
	};

	await step.do('save song ids', config, () => saveStateOnlyStep(stub, 'song_ids', song_ids));
	await step.do('save songs', config, async () => {
		await saveStateOnlyStep(stub, 'songs', songs);
		await saveProviderProgress(stub, {
			requested_provider,
			active_provider: 'elevenlabs',
			actual_provider: 'elevenlabs',
			fallback_from,
			fallback_reason,
		});
		await settleElevenLabsQuotaFromOutcome(env, {
			address,
			reservationId: paidQuota.reservationId,
			dayKey: paidQuota.dayKey,
			quotaProvider: 'elevenlabs',
			smolId,
			targetSmolId,
			reusedFromR2,
		});
	});

	return {
		songs,
		song_ids,
		requested_provider,
		active_provider: 'elevenlabs',
		actual_provider: 'elevenlabs',
		fallback_from,
		fallback_reason,
		generation_meta,
		reused_songs: reusedFromR2,
	};
}

/**
 * Discover BOTH AISG v6 song IDs from a submitted task via paginated read-only GET /api/tasks/:id.
 * - Accumulates distinct IDs across pages and iterations (never discarding earlier partial IDs).
 * - Always checks page 1 (newest) and follows `next_page` continuation cursors when returned.
 * - Persists any partial IDs alongside `task_id` in `provider_attempt` for safe resumption.
 */
async function discoverAisgSongIds(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	taskId: string;
	workspaceId?: string;
	attemptId?: string;
	initialSongIds?: string[];
}): Promise<string[]> {
	const { env, stub, step, config, taskId, workspaceId, attemptId } = params;
	const collected = new Set<string>(toDistinctStringIds(params.initialSongIds));
	let nextPageCursor: number | undefined;

	for (let attempt = 1; attempt <= DISCOVERY_MAX_ITERATIONS && collected.size < EXPECTED_AISG_TRACK_COUNT; attempt++) {
		const cursorForStep = nextPageCursor;
		const alreadyCollected = Array.from(collected);
		const stepResult = await step.do(
			`discover aisonggenerator songs #${attempt}`,
			{
				...config,
				retries: { limit: 2, delay: '5 second', backoff: 'exponential' },
			},
			async () => {
				const foundThisStep = new Set<string>();
				// Always check page 1 so newly indexed items on page 1 are discovered promptly
				let page1: Awaited<ReturnType<typeof discoverAisgTaskSongs>>;
				try {
					page1 = await discoverAisgTaskSongs(env, taskId, workspaceId, 1);
				} catch (err) {
					if (err instanceof AisgProviderError && !err.retryable) {
						throw new NonRetryableError(`AISG discovery failed (${err.code}): ${err.message}`);
					}
					throw err;
				}
				for (const id of page1.music_ids) {
					foundThisStep.add(id);
				}

				let nextCursor: number | undefined = page1.next_page;
				const combinedCount = new Set([...alreadyCollected, ...foundThisStep]).size;

				// Follow continuation cursor if we haven't already accumulated both distinct IDs.
				// Transient retryable errors on optional deeper pages do not abort discovery so
				// subsequent iterations can still recheck page 1 for newly indexed tracks.
				if (combinedCount < EXPECTED_AISG_TRACK_COUNT) {
					const deeperPage = cursorForStep && cursorForStep > 1 ? cursorForStep : page1.next_page;
					if (deeperPage && deeperPage > 1) {
						try {
							const deeper = await discoverAisgTaskSongs(env, taskId, workspaceId, deeperPage);
							for (const id of deeper.music_ids) {
								foundThisStep.add(id);
							}
							nextCursor = deeper.next_page;
						} catch (err) {
							if (err instanceof AisgProviderError && !err.retryable) {
								throw new NonRetryableError(`AISG discovery failed (${err.code}): ${err.message}`);
							}
							// Keep cursor on the failed deeper page so the next iteration can retry or catch page 1
							nextCursor = deeperPage;
						}
					}
				}

				return {
					music_ids: Array.from(foundThisStep),
					next_page: nextCursor,
				};
			}
		);

		for (const id of stepResult.music_ids) {
			collected.add(id);
		}
		nextPageCursor = stepResult.next_page;

		if (collected.size >= EXPECTED_AISG_TRACK_COUNT) {
			break;
		}

		if (attempt < DISCOVERY_MAX_ITERATIONS) {
			await step.sleep(`wait for aisonggenerator discovery #${attempt}`, '5 seconds');
		}
	}

	const discoveredIds = Array.from(collected).slice(0, EXPECTED_AISG_TRACK_COUNT);
	await step.do('record aisonggenerator discovery receipt', config, async () => {
		await updateAttemptIfSupported(stub, {
			provider: 'aisonggenerator',
			status: 'submitted',
			...(attemptId ? { attempt_id: attemptId } : {}),
			task_id: taskId,
			workspace_id: workspaceId,
			...(discoveredIds.length > 0 ? { song_ids: discoveredIds } : {}),
			updated_at: new Date().toISOString(),
		});
	});

	return discoveredIds;
}

/**
 * Check and reconcile any carried-over paid attempt BEFORE authorizing a new paid call
 * across ALL providers (explicit ElevenLabs, AISG, fallback, and override retries).
 */
async function reconcileCarriedAttempt(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	smolId: string;
	address?: string;
	quotaReservationId?: string;
	quotaDayKey?: string;
	quotaProvider?: MusicProvider;
	retry_id?: string;
	retry_steps: WorkflowSteps;
	prompt: string;
	description: string;
	lyrics: AiSongGeneratorLyrics;
	is_public: boolean;
	is_instrumental: boolean;
	requested_provider: MusicProvider;
	override_provider?: MusicProvider;
}): Promise<SongGenerationOutcome | null> {
	const {
		env,
		stub,
		step,
		config,
		smolId,
		address,
		quotaReservationId: carriedQuotaReservationId,
		quotaDayKey: carriedQuotaDayKey,
		quotaProvider,
		retry_id,
		retry_steps,
		prompt,
		description,
		lyrics,
		is_public,
		is_instrumental,
		requested_provider,
		override_provider,
	} = params;

	// Mutable: a legacy AISG replay may need to reserve its own slot before it can dispatch.
	let quotaReservationId = carriedQuotaReservationId;
	let quotaDayKey = carriedQuotaDayKey;

	const attempt = retry_steps.provider_attempt;
	if (!attempt || attempt.status === 'failed') {
		return null;
	}

	// Copy the carried attempt into this successor DO immediately so replays within this
	// workflow also see the predecessor's paid claim/receipt.
	await step.do('carry predecessor attempt state', config, async () => {
		await updateAttemptIfSupported(stub, attempt);
	});

	// 1. ElevenLabs carried attempt (claimed / committed / ambiguous)
	if (attempt.provider === 'elevenlabs') {
		const sourceSmolId = attempt.source_smol_id ?? retry_id ?? smolId;
		const existingMusicId = getElevenLabsMusicId(sourceSmolId);
		const existingR2 = await step.do('reconcile elevenlabs r2 artifact', config, async () => {
			const head = typeof env.SMOL_BUCKET.head === 'function'
				? await env.SMOL_BUCKET.head(`${existingMusicId}.mp3`)
				: null;
			return head && head.size > 0 ? { size: head.size } : null;
		});

		if (existingR2) {
			return await runElevenLabsGeneration({
				env,
				stub,
				step,
				config,
				smolId,
				address,
				quotaReservationId,
				quotaDayKey,
				quotaProvider: 'elevenlabs',
				reuseOnly: true,
				prompt,
				description,
				lyrics,
				is_instrumental,
				requested_provider,
				fallback_from: retry_steps.fallback_from,
				fallback_reason: retry_steps.fallback_reason,
				resumeFromR2SmolId: sourceSmolId,
			});
		}

		// No committed R2 artifact while attempt is claimed/ambiguous/committed -> refuse duplicate charge
		throw new NonRetryableError(
			`Previous elevenlabs attempt (status=${attempt.status}) for ${sourceSmolId} requires reconciliation before authorizing another charge`
		);
	}

	// 2. AISG carried attempt (claimed / submitted / ambiguous)
	if (attempt.provider === 'aisonggenerator') {
		// Reconcile against aisonggenerator-worker by replaying the keyed submit (same Idempotency-Key and
		// payload) when we have an attempt_id but no task_id or full 2 song_ids. The worker answers from its
		// stored receipt; an in_flight/ambiguous receipt comes back unresolved and never re-submits.
		let resolvedTaskId = attempt.task_id;
		let resolvedWorkspaceId = attempt.workspace_id;
		let resolvedSongIds = toDistinctStringIds(attempt.song_ids ?? retry_steps.song_ids);

		if (
			attempt.attempt_id
			&& (attempt.status === 'claimed' || attempt.status === 'ambiguous')
			&& !resolvedTaskId
			&& resolvedSongIds.length < EXPECTED_AISG_TRACK_COUNT
		) {
			// aisonggenerator-worker answers a keyed replay identically whether it came from a stored receipt
			// or a first submit (no receipt -> fresh PAID dispatch under this key). The replay is therefore only
			// permitted while an AISG quota reservation covers this attempt:
			// - the carried reservation, but only when the quota DO confirms it is an AISG reservation that
			//   still counts a slot (reserved / committed / ambiguous). The carried ID alone is not trusted:
			//   a prior replay may have refunded it after a typed rejection (the worker then cleared its
			//   receipt, so the next replay is a fresh paid dispatch), and a refunded row can never be committed.
			// - otherwise (legacy attempt with no reservation, a non-AISG one, or a refunded/missing one), a NEW
			//   reservation made here first. Denial refuses the replay. It is refunded only on positive evidence
			//   that the worker did not dispatch (409 / typed rejection); otherwise it stays held and is committed
			//   by the normal poll/commit path (an existing legacy receipt was never counted, so counting it once
			//   is correct).
			const carriedId = quotaReservationId;
			const carriedCoversAisg = Boolean(
				carriedId
				&& address
				&& (quotaProvider === undefined || quotaProvider === 'aisonggenerator')
				&& await step.do('verify carried aisonggenerator quota', config, async () => {
					const record = await getGenerationQuotaReservation(env, { address: address!, reservationId: carriedId! });
					return Boolean(
						record
						&& record.provider === 'aisonggenerator'
						&& (record.status === 'reserved' || record.status === 'committed' || record.status === 'ambiguous')
					);
				})
			);
			let replayReservation: { reservationId: string; dayKey?: string } | null = null;
			if (!carriedCoversAisg) {
				replayReservation = await reservePaidDispatchQuota({
					env,
					stub,
					step,
					config,
					smolId,
					targetProvider: 'aisonggenerator',
					address,
					reservationId: `${smolId}:reconcile:aisonggenerator`,
					stepName: 'reserve aisonggenerator reconcile quota',
				});
				// Persist before the replay so a successor retry carries (and settles) this reservation
				// instead of reserving again or leaving it orphaned.
				const held = replayReservation;
				await step.do('record aisonggenerator reconcile quota', config, async () => {
					await saveStateOnlyStep(stub, 'quota_reservation_id', held.reservationId);
					await saveStateOnlyStep(stub, 'quota_provider', 'aisonggenerator');
					if (held.dayKey) {
						await saveStateOnlyStep(stub, 'quota_day_key', held.dayKey);
					}
				});
			}

			// A replay with no stored receipt dispatches under the original key, so it is a paid step: no retries.
			const receipt = await step.do(
				'reconcile aisonggenerator attempt',
				{ ...config, retries: { limit: 0, delay: '1 second' } },
				async () => await replayAisgTaskSubmit(
					env,
					prompt,
					description,
					lyrics,
					is_public,
					is_instrumental,
					attempt.attempt_id!
				)
			);

			if (receipt.kind === 'task') {
				resolvedTaskId = receipt.task_id;
				resolvedWorkspaceId = receipt.workspace_id ?? resolvedWorkspaceId;
				if (replayReservation) {
					quotaReservationId = replayReservation.reservationId;
					quotaDayKey = replayReservation.dayKey;
				}
			} else {
				if (replayReservation && address) {
					const held = replayReservation;
					const notDispatched = receipt.outcome === 'rejected';
					await step.do(
						notDispatched ? 'refund aisonggenerator reconcile quota' : 'retain aisonggenerator reconcile quota',
						config,
						async () => {
							if (notDispatched) {
								await refundGenerationQuota(env, {
									address,
									reservationId: held.reservationId,
									dayKey: held.dayKey,
									reason: `aisg_reconcile_${receipt.code}`,
								});
							} else {
								await markAmbiguousGenerationQuota(env, {
									address,
									reservationId: held.reservationId,
									dayKey: held.dayKey,
									reason: `aisg_reconcile_${receipt.code}`,
								});
							}
						}
					);
				}
				throw new NonRetryableError(
					`Previous aisonggenerator attempt (${attempt.attempt_id}, status=${attempt.status}, replay=${receipt.code}) requires reconciliation before authorizing another charge`
				);
			}
		}

		if (
			(attempt.status === 'claimed' || attempt.status === 'ambiguous')
			&& !resolvedTaskId
			&& resolvedSongIds.length < EXPECTED_AISG_TRACK_COUNT
		) {
			throw new NonRetryableError(
				`Previous aisonggenerator attempt (status=${attempt.status}) requires reconciliation before authorizing another charge`
			);
		}

		// If an override_provider was requested while an AISG job is still active/submitted,
		// resume or reconcile it rather than silently paying for a second provider!
		if (resolvedSongIds.length >= EXPECTED_AISG_TRACK_COUNT) {
			await step.do('save song ids', config, () => saveStateOnlyStep(stub, 'song_ids', resolvedSongIds));
			return await pollAndCommitAisgOrFallback({
				env,
				stub,
				step,
				config,
				smolId,
				address,
				quotaReservationId,
				quotaDayKey,
				songIds: resolvedSongIds,
				prompt,
				description,
				lyrics,
				is_instrumental,
				requested_provider,
				skipInitialSleep: true,
			});
		}

		if (resolvedTaskId) {
			const discoveredIds = await discoverAisgSongIds({
				env,
				stub,
				step,
				config,
				taskId: resolvedTaskId,
				workspaceId: resolvedWorkspaceId,
				attemptId: attempt.attempt_id,
				initialSongIds: resolvedSongIds,
			});

			if (discoveredIds.length < EXPECTED_AISG_TRACK_COUNT) {
				throw new NonRetryableError(
					`AISG task ${resolvedTaskId} is still pending discovery (${discoveredIds.length}/${EXPECTED_AISG_TRACK_COUNT} IDs); retry later to resume without re-submitting`
				);
			}

			await step.do('save song ids', config, () => saveStateOnlyStep(stub, 'song_ids', discoveredIds));
			return await pollAndCommitAisgOrFallback({
				env,
				stub,
				step,
				config,
				smolId,
				address,
				quotaReservationId,
				quotaDayKey,
				songIds: discoveredIds,
				prompt,
				description,
				lyrics,
				is_instrumental,
				requested_provider,
				skipInitialSleep: true,
			});
		}

		throw new NonRetryableError(
			`Previous aisonggenerator attempt (status=${attempt.status}) has no full task or 2-track receipt; refusing singleton or duplicate charge${override_provider ? ` (override=${override_provider})` : ''}`
		);
	}

	return null;
}

/**
 * Full music generation orchestrator covering:
 * 1. Reuse of complete 1-track or 2-track songs on retry (including legacy / ElevenLabs artifacts)
 * 2. Reconciliation / resumption of ANY carried-over paid attempt across the retry chain
 * 3. Resumption of prior ElevenLabs fallback runs (never restarting AISG on retry!)
 * 4. Resumption of pending AISG songs without re-paying (quick-check -> resume polling)
 * 5. Explicit ElevenLabs generation (zero AISG music calls / polls / fingerprints)
 * 6. AISG v6 split submit + paginated discovery + bounded polling + swap validation + R2 commit
 * 7. Automatic AISG -> ElevenLabs fallback strictly on confirmed eligible failures
 */
export async function generateOrReuseSongs(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	smolId: string;
	address?: string;
	quotaReservationId?: string;
	quotaDayKey?: string;
	quotaProvider?: MusicProvider;
	quotaReuseOnly?: boolean;
	retry_id?: string;
	retry_steps: WorkflowSteps | undefined;
	prompt: string;
	description: string;
	lyrics: AiSongGeneratorLyrics;
	is_public: boolean;
	is_instrumental: boolean;
	requested_provider: MusicProvider;
	override_provider?: MusicProvider;
}): Promise<SongGenerationOutcome> {
	const {
		env,
		stub,
		step,
		config,
		smolId,
		address,
		quotaReservationId,
		quotaDayKey,
		quotaProvider,
		quotaReuseOnly,
		retry_id,
		retry_steps,
		prompt,
		description,
		lyrics,
		is_public,
		is_instrumental,
		requested_provider,
		override_provider,
	} = params;

	const previousProvider = retry_steps ? inferSnapshotProvider(retry_steps) : null;
	const providerChangedOnRetry = Boolean(
		override_provider
		&& previousProvider
		&& previousProvider !== override_provider
	);

	// =========================================================================
	// PATH 1: Reuse complete songs from a previous run (1-track ElevenLabs/legacy OR 2-track AISG!)
	// Already-paid completed tracks are reused rather than discarded for a second charge.
	// AISG snapshots MUST have 2 distinct matching IDs; legitimate ElevenLabs & non-AISG singles pass.
	// =========================================================================
	const retrySongs = Array.isArray(retry_steps?.songs) ? retry_steps!.songs! : [];
	const hasCompleteSongs = hasReusableCompleteSongs(retry_steps);

	if (hasCompleteSongs) {
		let songs = retrySongs;
		const song_ids = songs.map((s) => s.music_id);
		const actualProvider: MusicProvider | null = previousProvider === 'elevenlabs' || previousProvider === 'aisonggenerator'
			? previousProvider
			: null;
		const fallbackFrom = retry_steps?.fallback_from;
		const fallbackReason = retry_steps?.fallback_reason;
		let swapped = false;

		const oldFingerprints = retry_steps?.original_fingerprints;
		if (
			actualProvider !== 'elevenlabs'
			&& songs.length === 2
			&& oldFingerprints
			&& Object.keys(oldFingerprints).length === 2
		) {
			const matched = await step.do('validate song order', config, async () => {
				return matchSongsByFingerprint(oldFingerprints, songs);
			});
			if (matched.swapped) {
				swapped = true;
				songs = matched.songs;
			}
		}

		songs = await step.do('persist song audio', config, async () => {
			return await commitSongsAudioToR2({
				env,
				smolId,
				songs,
				provider: actualProvider,
				swapped,
			});
		});

		await step.do('save song ids', config, () => saveStateOnlyStep(stub, 'song_ids', song_ids));
		await step.do('save songs', config, async () => {
			await saveStateOnlyStep(stub, 'songs', songs);
			await saveProviderProgress(stub, {
				requested_provider,
				active_provider: actualProvider ?? requested_provider,
				actual_provider: actualProvider,
				fallback_from: fallbackFrom,
				fallback_reason: fallbackReason,
			});
			if (address && quotaReservationId && actualProvider) {
				await commitGenerationQuota(env, {
					address,
					reservationId: quotaReservationId,
					actualProvider,
					dayKey: quotaDayKey,
				});
			}
		});

		return {
			songs,
			song_ids,
			requested_provider,
			active_provider: actualProvider ?? requested_provider,
			actual_provider: actualProvider,
			fallback_from: fallbackFrom,
			fallback_reason: fallbackReason,
			generation_meta: {
				requested_provider,
				actual_provider: actualProvider,
				...(fallbackFrom ? { fallback_from: fallbackFrom } : {}),
				...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
			},
			reused_songs: true,
		};
	}

	// =========================================================================
	// PATH 1A: Reconcile / resume ANY carried-over paid attempt BEFORE ANY provider branch
	// (Covers explicit ElevenLabs, AISG, fallback, and override retries uniformly!)
	// =========================================================================
	if (retry_steps) {
		const reconciled = await reconcileCarriedAttempt({
			env,
			stub,
			step,
			config,
			smolId,
			address,
			quotaReservationId,
			quotaDayKey,
			quotaProvider,
			retry_id,
			retry_steps,
			prompt,
			description,
			lyrics,
			is_public,
			is_instrumental,
			requested_provider,
			override_provider,
		});
		if (reconciled) {
			return reconciled;
		}
	}

	// =========================================================================
	// PATH 1B: Resume a prior ElevenLabs fallback run instead of restarting AISG!
	// =========================================================================
	if (
		!providerChangedOnRetry
		&& retry_steps
		&& (
			retry_steps.active_provider === 'elevenlabs'
			|| retry_steps.fallback_from === 'aisonggenerator'
		)
	) {
		const prevSmolId = retry_steps.provider_attempt?.source_smol_id ?? retry_id ?? smolId;
		return await runElevenLabsGeneration({
			env,
			stub,
			step,
			config,
			smolId,
			address,
			quotaReservationId,
			quotaDayKey,
			quotaProvider,
			reuseOnly: quotaReuseOnly,
			prompt,
			description,
			lyrics,
			is_instrumental,
			requested_provider,
			fallback_from: retry_steps.fallback_from,
			fallback_reason: retry_steps.fallback_reason,
			resumeFromR2SmolId: prevSmolId,
		});
	}

	// =========================================================================
	// PATH 2: Resume pending AISG songs on retry (NEVER fall through to fresh submit while pending!)
	// Checked even when override_provider was supplied so still-pending or finished AISG jobs
	// are resumed rather than silently discarded for a second paid call.
	// Enforces 2 distinct matching IDs on AISG retry paths (never publishes an AISG singleton!).
	// =========================================================================
	if (retry_steps && isPollableAisgIds(retry_steps)) {
		const pendingIds = toDistinctStringIds(retry_steps.song_ids);
		if (pendingIds.length < EXPECTED_AISG_TRACK_COUNT) {
			throw new NonRetryableError(
				`Incomplete AISG retry state (${pendingIds.length}/${EXPECTED_AISG_TRACK_COUNT} distinct song IDs with no task_id); refusing singleton publish or duplicate charge`
			);
		}
		const targetIds = pendingIds.slice(0, EXPECTED_AISG_TRACK_COUNT);
		const targetIdSet = new Set(targetIds);

		const quickCheck = await step.do(
			'quick check retry songs',
			{
				...config,
				retries: { limit: 2, delay: '5 second', backoff: 'exponential' },
			},
			async () => {
				const currentSongs = await getSongs(env, targetIds);
				const matchedSongs = currentSongs.filter((s) => Boolean(s?.music_id && targetIdSet.has(s.music_id.trim())));
				const distinctMatchedIds = toDistinctStringIds(matchedSongs.map((s) => s.music_id));
				const failedSong = matchedSongs.find((s) => s.status < 0);
				if (failedSong) {
					return {
						state: 'terminal_failed' as const,
						songs: matchedSongs,
						failure: classifyNegativeSongStatus(failedSong),
					};
				}
				if (distinctMatchedIds.length !== EXPECTED_AISG_TRACK_COUNT) {
					return { state: 'incomplete' as const, songs: matchedSongs };
				}
				// Deduplicate in targetIds order so every returned song corresponds 1-to-1 with a distinct target ID
				const orderedSongs = targetIds
					.map((id) => matchedSongs.find((s) => s.music_id.trim() === id))
					.filter((s): s is AiSongGeneratorSong => Boolean(s));
				if (orderedSongs.length === EXPECTED_AISG_TRACK_COUNT && orderedSongs.every((s) => s.status >= 4 && s.audio)) {
					return { state: 'complete' as const, songs: orderedSongs };
				}
				return { state: 'incomplete' as const, songs: orderedSongs };
			}
		);

		if (quickCheck.state === 'complete') {
			let songs = quickCheck.songs;
			let swapped = false;
			const oldFingerprints = retry_steps.original_fingerprints;
			if (songs.length === 2 && oldFingerprints && Object.keys(oldFingerprints).length === 2) {
				const matched = await step.do('validate song order', config, async () => {
					return matchSongsByFingerprint(oldFingerprints, songs);
				});
				if (matched.swapped) {
					swapped = true;
					songs = matched.songs;
				}
			}

			songs = await step.do('persist song audio', config, async () => {
				return await commitSongsAudioToR2({
					env,
					smolId,
					songs,
					provider: 'aisonggenerator',
					swapped,
				});
			});

			const finalIds = songs.map((s) => s.music_id);
			await step.do('save song ids', config, () => saveStateOnlyStep(stub, 'song_ids', finalIds));
			await step.do('save songs', config, async () => {
				await saveStateOnlyStep(stub, 'songs', songs);
				await saveProviderProgress(stub, {
					requested_provider,
					active_provider: 'aisonggenerator',
					actual_provider: 'aisonggenerator',
				});
				if (address && quotaReservationId) {
					await commitGenerationQuota(env, {
						address,
						reservationId: quotaReservationId,
						actualProvider: 'aisonggenerator',
						dayKey: quotaDayKey,
					});
				}
			});

			return {
				songs,
				song_ids: finalIds,
				requested_provider,
				active_provider: 'aisonggenerator',
				actual_provider: 'aisonggenerator',
				generation_meta: {
					requested_provider,
					actual_provider: 'aisonggenerator',
				},
				reused_songs: true,
			};
		}

		// Still generating/streaming -> resume polling the EXISTING AISG IDs without re-paying!
		if (quickCheck.state === 'incomplete') {
			await step.do('save song ids', config, () => saveStateOnlyStep(stub, 'song_ids', targetIds));
			return await pollAndCommitAisgOrFallback({
				env,
				stub,
				step,
				config,
				smolId,
				address,
				quotaReservationId,
				quotaDayKey,
				songIds: targetIds,
				prompt,
				description,
				lyrics,
				is_instrumental,
				requested_provider,
				skipInitialSleep: true,
			});
		}

		// Confirmed terminal failure on existing AISG songs
		if (quickCheck.state === 'terminal_failed') {
			if (!quickCheck.failure.fallbackEligible) {
				if (address && quotaReservationId) {
					await step.do('mark failed aisg quota non-refundable', config, () =>
						markAmbiguousGenerationQuota(env, {
							address,
							reservationId: quotaReservationId,
							dayKey: quotaDayKey,
							reason: quickCheck.failure.code,
						})
					);
				}
				throw new NonRetryableError(`Song generation failed (${quickCheck.failure.code}): ${quickCheck.failure.message}`);
			}
			if (override_provider === 'elevenlabs') {
				const fallbackAuth = await authorizeElevenLabsFallbackQuota({
					env,
					stub,
					step,
					config,
					smolId,
					address,
					quotaReservationId,
					quotaDayKey,
					aisgWasUnbilled: false,
					failureReason: quickCheck.failure.code,
				});
				return await runElevenLabsGeneration({
					env,
					stub,
					step,
					config,
					smolId,
					address,
					quotaReservationId: fallbackAuth.reservationId,
					quotaDayKey: fallbackAuth.dayKey,
					quotaProvider: 'elevenlabs',
					prompt,
					description,
					lyrics,
					is_instrumental,
					requested_provider,
				});
			}
			if (isFallbackEnabled(env)) {
				const fallbackAuth = await authorizeElevenLabsFallbackQuota({
					env,
					stub,
					step,
					config,
					smolId,
					address,
					quotaReservationId,
					quotaDayKey,
					aisgWasUnbilled: false,
					failureReason: quickCheck.failure.code,
				});
				return await runElevenLabsGeneration({
					env,
					stub,
					step,
					config,
					smolId,
					address,
					quotaReservationId: fallbackAuth.reservationId,
					quotaDayKey: fallbackAuth.dayKey,
					quotaProvider: 'elevenlabs',
					prompt,
					description,
					lyrics,
					is_instrumental,
					requested_provider,
					fallback_from: 'aisonggenerator',
					fallback_reason: quickCheck.failure.code,
				});
			}
			if (address && quotaReservationId) {
				await step.do('mark failed aisg quota non-refundable', config, () =>
					markAmbiguousGenerationQuota(env, {
						address,
						reservationId: quotaReservationId,
						dayKey: quotaDayKey,
						reason: quickCheck.failure.code,
					})
				);
			}
			throw new NonRetryableError(`Song generation failed (${quickCheck.failure.code}): ${quickCheck.failure.message}`);
		}
	}

	// Refuse incomplete historical AISG snapshot (e.g. 1 completed AISG track without song_ids or task_id)
	// rather than falling through to a fresh paid submission.
	if (hasIncompleteAisgSnapshot(retry_steps)) {
		const distinctRetrySongMusicIds = toDistinctStringIds(
			retrySongs.map((s) => s?.music_id).filter((id): id is string => Boolean(id))
		);
		throw new NonRetryableError(
			`Incomplete historical AISG snapshot (${distinctRetrySongMusicIds.length}/${EXPECTED_AISG_TRACK_COUNT} tracks); refusing singleton publish or duplicate charge`
		);
	}

	// =========================================================================
	// PATH 3A: Explicit ElevenLabs generation (zero AISG music calls!)
	// =========================================================================
	if (requested_provider === 'elevenlabs') {
		return await runElevenLabsGeneration({
			env,
			stub,
			step,
			config,
			smolId,
			address,
			quotaReservationId,
			quotaDayKey,
			quotaProvider,
			reuseOnly: quotaReuseOnly,
			prompt,
			description,
			lyrics,
			is_instrumental,
			requested_provider: 'elevenlabs',
		});
	}

	// =========================================================================
	// PATH 3B: Fresh AISG v6 generation (split submit -> paginated discovery -> bounded poll -> R2)
	// with automatic fallback to ElevenLabs STRICTLY on confirmed eligible failures
	// =========================================================================
	const paidAisgQuota = await ensureFreshPaidDispatchQuota({
		env,
		stub,
		step,
		config,
		smolId,
		targetProvider: 'aisonggenerator',
		address,
		quotaReservationId,
		quotaDayKey,
		quotaProvider,
		reuseOnly: quotaReuseOnly,
	});
	const activeAisgReservationId = paidAisgQuota.reservationId;
	const activeAisgDayKey = paidAisgQuota.dayKey;

	await step.do('record aisonggenerator provider state', config, async () => {
		await saveProviderProgress(stub, {
			requested_provider: 'aisonggenerator',
			active_provider: 'aisonggenerator',
			actual_provider: null,
		});
		await saveStateOnlyStep(stub, 'quota_reservation_id', activeAisgReservationId);
		await saveStateOnlyStep(stub, 'quota_provider', 'aisonggenerator');
		if (activeAisgDayKey) {
			await saveStateOnlyStep(stub, 'quota_day_key', activeAisgDayKey);
		}
	});

	const aisgAttemptId = `smol-${smolId}-aisg`;

	type SubmitStepOutcome =
		| { ok: true; result: Awaited<ReturnType<typeof submitAisgTask>> }
		| { ok: false; code: string; message: string; outcome: 'rejected' | 'unknown'; fallbackEligible: boolean };

	const submitOutcome = await step.do(
		'submit aisonggenerator task',
		{
			...config,
			retries: { limit: 0, delay: '1 second' },
		},
		async (): Promise<SubmitStepOutcome> => {
			const claim = await claimAttemptIfSupported(stub, 'aisonggenerator', {
				attempt_id: aisgAttemptId,
				source_smol_id: smolId,
			});
			if (!claim.claimed && claim.attempt) {
				if (claim.attempt.provider === 'aisonggenerator' && claim.attempt.task_id) {
					return {
						ok: true,
						result: {
							kind: 'task',
							task_id: claim.attempt.task_id,
							workspace_id: claim.attempt.workspace_id,
						},
					};
				}
				if (claim.attempt.provider === 'aisonggenerator' && claim.attempt.song_ids && claim.attempt.song_ids.length >= EXPECTED_AISG_TRACK_COUNT) {
					return {
						ok: true,
						result: {
							kind: 'song_ids',
							song_ids: claim.attempt.song_ids,
						},
					};
				}
				return {
					ok: false,
					code: 'submit_outcome_unknown',
					message: `Paid attempt (${claim.attempt.provider}, status=${claim.attempt.status}) already claimed with no full receipt; entering reconciliation`,
					outcome: 'unknown',
					fallbackEligible: false,
				};
			}

			try {
				const submitted = await submitAisgTask(
					env,
					prompt,
					description,
					lyrics,
					is_public,
					is_instrumental,
					aisgAttemptId
				);

				await updateAttemptIfSupported(stub, {
					provider: 'aisonggenerator',
					status: 'submitted',
					attempt_id: aisgAttemptId,
					source_smol_id: smolId,
					...(submitted.kind === 'task'
						? { task_id: submitted.task_id, workspace_id: submitted.workspace_id }
						: { song_ids: submitted.song_ids }),
					updated_at: new Date().toISOString(),
				});

				return { ok: true, result: submitted };
			} catch (err) {
				if (err instanceof AisgProviderError) {
					await updateAttemptIfSupported(stub, {
						provider: 'aisonggenerator',
						status: err.outcome === 'unknown' ? 'ambiguous' : 'failed',
						attempt_id: aisgAttemptId,
						source_smol_id: smolId,
						error_code: err.code,
						error_message: err.message,
						updated_at: new Date().toISOString(),
					});

					if (err.outcome === 'unknown' && address && activeAisgReservationId) {
						await markAmbiguousGenerationQuota(env, {
							address,
							reservationId: activeAisgReservationId,
							dayKey: activeAisgDayKey,
							reason: err.code,
						}).catch(() => {});
					}

					return {
						ok: false,
						code: err.code,
						message: err.message,
						outcome: err.outcome,
						fallbackEligible: err.fallbackEligible,
					};
				}

				const message = err instanceof Error ? err.message : String(err);
				await updateAttemptIfSupported(stub, {
					provider: 'aisonggenerator',
					status: 'ambiguous',
					attempt_id: aisgAttemptId,
					source_smol_id: smolId,
					error_code: 'submit_outcome_unknown',
					error_message: message,
					updated_at: new Date().toISOString(),
				});

				if (address && activeAisgReservationId) {
					await markAmbiguousGenerationQuota(env, {
						address,
						reservationId: activeAisgReservationId,
						dayKey: activeAisgDayKey,
						reason: 'submit_outcome_unknown',
					}).catch(() => {});
				}

				return {
					ok: false,
					code: 'submit_outcome_unknown',
					message,
					outcome: 'unknown',
					fallbackEligible: false,
				};
			}
		}
	);

	if (!submitOutcome.ok) {
		if (submitOutcome.outcome === 'unknown') {
			if (address && activeAisgReservationId) {
				await step.do('mark ambiguous aisg quota', config, () =>
					markAmbiguousGenerationQuota(env, {
						address,
						reservationId: activeAisgReservationId,
						dayKey: activeAisgDayKey,
						reason: submitOutcome.code,
					})
				);
			}
			throw new NonRetryableError(
				`AISG submission outcome unknown (${submitOutcome.code}): ${submitOutcome.message}`
			);
		}
		if (submitOutcome.fallbackEligible && isFallbackEnabled(env)) {
			const fallbackAuth = await authorizeElevenLabsFallbackQuota({
				env,
				stub,
				step,
				config,
				smolId,
				address,
				quotaReservationId: activeAisgReservationId,
				quotaDayKey: activeAisgDayKey,
				aisgWasUnbilled: true,
				failureReason: submitOutcome.code,
			});
			return await runElevenLabsGeneration({
				env,
				stub,
				step,
				config,
				smolId,
				address,
				quotaReservationId: fallbackAuth.reservationId,
				quotaDayKey: fallbackAuth.dayKey,
				quotaProvider: 'elevenlabs',
				prompt,
				description,
				lyrics,
				is_instrumental,
				requested_provider: 'aisonggenerator',
				fallback_from: 'aisonggenerator',
				fallback_reason: submitOutcome.code,
			});
		}
		await step.do('save failed song state', config, async () => {
			if (address && activeAisgReservationId) {
				await refundGenerationQuota(env, {
					address,
					reservationId: activeAisgReservationId,
					dayKey: activeAisgDayKey,
					reason: submitOutcome.code,
				});
			}
			await saveStateOnlyStep(stub, 'songs', [{
				music_id: smolId,
				status: submitOutcome.code === 'content_policy' ? -1 : -4,
				audio: '',
				service: 'aisonggenerator',
				error_message: submitOutcome.message,
			}]);
		});
		throw new NonRetryableError(`AISG generation rejected (${submitOutcome.code}): ${submitOutcome.message}`);
	}

	// Step 3B.2: Discover BOTH song IDs via paginated read-only GET /api/tasks/:id.
	// An accepted AISG task with < 2 discovered IDs is STILL PENDING — retain the receipt
	// for retry resumption and NEVER buy a second song via ElevenLabs or publish a singleton.
	let songIds: string[];
	if (submitOutcome.result.kind === 'task') {
		songIds = await discoverAisgSongIds({
			env,
			stub,
			step,
			config,
			taskId: submitOutcome.result.task_id,
			workspaceId: submitOutcome.result.workspace_id,
			attemptId: aisgAttemptId,
		});
		if (songIds.length < EXPECTED_AISG_TRACK_COUNT) {
			throw new NonRetryableError(
				`AISG task ${submitOutcome.result.task_id} accepted but still pending discovery (${songIds.length}/${EXPECTED_AISG_TRACK_COUNT} IDs); retry to resume without re-submitting`
			);
		}
	} else {
		songIds = submitOutcome.result.song_ids;
		if (songIds.length < EXPECTED_AISG_TRACK_COUNT) {
			throw new NonRetryableError(
				`AISG accepted submission returned incomplete track set (${songIds.length}/${EXPECTED_AISG_TRACK_COUNT} IDs); refusing silent singleton or duplicate charge`
			);
		}
	}

	await step.do('save song ids', config, () => saveStateOnlyStep(stub, 'song_ids', songIds));

	return await pollAndCommitAisgOrFallback({
		env,
		stub,
		step,
		config,
		smolId,
		address,
		quotaReservationId: activeAisgReservationId,
		quotaDayKey: activeAisgDayKey,
		songIds,
		prompt,
		description,
		lyrics,
		is_instrumental,
		requested_provider: 'aisonggenerator',
	});
}

type BoundedPollStepResult =
	| { state: 'complete'; songs: AiSongGeneratorSong[]; swapped: boolean }
	| { state: 'pending'; songs: AiSongGeneratorSong[] }
	| {
		state: 'failed';
		songs: AiSongGeneratorSong[];
		code: string;
		message: string;
		fallbackEligible: boolean;
	};

function classifyNegativeSongStatus(song: AiSongGeneratorSong): {
	code: string;
	message: string;
	fallbackEligible: boolean;
} {
	const detail = song.error_message?.trim();
	if (song.status === -1 || isContentPolicyMessage(detail)) {
		return {
			code: 'content_policy',
			message: detail || 'content policy violation',
			fallbackEligible: false,
		};
	}
	if (song.status === -2) {
		return {
			code: 'generation_timeout',
			message: detail || 'generation timeout',
			fallbackEligible: true,
		};
	}
	if (song.status === -3) {
		return {
			code: 'provider_unavailable',
			message: detail || 'service temporarily unavailable',
			fallbackEligible: true,
		};
	}
	return {
		code: 'poll_failed',
		message: detail || `error code ${song.status}`,
		fallbackEligible: true,
	};
}

/**
 * Bounded deterministic polling loop for AISG songs.
 * - Confirmed terminal non-policy song failure (`status < 0`) -> marks AISG attempt failed and
 *   triggers automatic ElevenLabs fallback (when enabled).
 * - Ordinary polling exhaustion while songs are still pending (`status >= 0`) -> keeps accepted
 *   receipt for retry resumption and NEVER buys a second song via ElevenLabs!
 */
async function pollAndCommitAisgOrFallback(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	smolId: string;
	address?: string;
	quotaReservationId?: string;
	quotaDayKey?: string;
	songIds: string[];
	prompt: string;
	description: string;
	lyrics: AiSongGeneratorLyrics;
	is_instrumental: boolean;
	requested_provider: MusicProvider;
	skipInitialSleep?: boolean;
}): Promise<SongGenerationOutcome> {
	const {
		env,
		stub,
		step,
		config,
		smolId,
		address,
		quotaReservationId,
		quotaDayKey,
		songIds,
		prompt,
		description,
		lyrics,
		is_instrumental,
		requested_provider,
		skipInitialSleep,
	} = params;

	if (!skipInitialSleep) {
		await step.sleep('wait for songs to start streaming', '15 seconds');
	}

	let finalSongs: AiSongGeneratorSong[] | null = null;
	let anySwapDetected = false;
	let terminalFailure: { code: string; message: string; fallbackEligible: boolean } | null = null;

	for (let attempt = 1; attempt <= POLL_MAX_ITERATIONS; attempt++) {
		const pollResult = await step.do(
			`poll songs #${attempt}`,
			{
				...config,
				retries: { limit: 2, delay: '5 second', backoff: 'exponential' },
			},
			async (): Promise<BoundedPollStepResult> => {
				const targetIds = toDistinctStringIds(songIds);
				const targetIdSet = new Set(targetIds);
				const fetched = await getSongs(env, targetIds);
				const matched = fetched.filter((s) => Boolean(s?.music_id && targetIdSet.has(s.music_id.trim())));

				for (const song of matched) {
					if (song.status < 0) {
						await saveStateOnlyStep(stub, 'songs', matched);
						const classified = classifyNegativeSongStatus(song);
						return {
							state: 'failed',
							songs: matched,
							...classified,
						};
					}
				}

				let songs = targetIds
					.map((id) => matched.find((s) => s.music_id.trim() === id))
					.filter((s): s is AiSongGeneratorSong => Boolean(s));

				if (songs.length !== targetIds.length || targetIds.length < EXPECTED_AISG_TRACK_COUNT) {
					await saveStateOnlyStep(stub, 'songs', songs);
					return { state: 'pending', songs };
				}

				const hasAudio = songs.some((s) => Boolean(s.audio));
				if (!hasAudio) {
					return { state: 'pending', songs };
				}

				let swapped = false;
				if (songs.length === 2) {
					try {
						const checked = await detectAndCorrectSwaps(stub, songs);
						songs = checked.songs;
						swapped = checked.swapped;
					} catch (err) {
						if (err instanceof InsufficientAudioDataError) {
							await saveStateOnlyStep(stub, 'songs', songs);
							return { state: 'pending', songs };
						}
						if (err instanceof UnsafeFetchUrlError) {
							// Never request (or retry) an unsafe provider URL; commit would refuse it too.
							throw new NonRetryableError(`Refusing unsafe AISG audio URL during fingerprinting: ${err.message}`);
						}
						throw err;
					}
				}

				await saveStateOnlyStep(stub, 'songs', songs);

				const allComplete = songs.every((s) => s.status >= 4 && Boolean(s.audio));
				if (allComplete) {
					return { state: 'complete', songs, swapped };
				}

				return { state: 'pending', songs };
			}
		);

		if (pollResult.state === 'complete') {
			finalSongs = pollResult.songs;
			anySwapDetected = anySwapDetected || pollResult.swapped;
			break;
		}

		if (pollResult.state === 'failed') {
			terminalFailure = {
				code: pollResult.code,
				message: pollResult.message,
				fallbackEligible: pollResult.fallbackEligible,
			};
			break;
		}

		if (attempt < POLL_MAX_ITERATIONS) {
			await step.sleep(`poll wait #${attempt}`, '10 seconds');
		}
	}

	if (!finalSongs) {
		if (!terminalFailure) {
			// Ordinary polling window exhaustion on a still-pending AISG job:
			// keep the accepted receipt so a retry resumes polling instead of buying a second song!
			throw new NonRetryableError(
				'AISG songs are still pending after the polling window; retry to resume polling without re-submitting'
			);
		}

		// Confirmed terminal AISG failure: mark AISG attempt failed so fallback can claim cleanly
		await step.do('mark aisonggenerator attempt failed', config, async () => {
			await updateAttemptIfSupported(stub, {
				provider: 'aisonggenerator',
				status: 'failed',
				source_smol_id: smolId,
				song_ids: songIds,
				error_code: terminalFailure!.code,
				error_message: terminalFailure!.message,
				updated_at: new Date().toISOString(),
			});
		});

		if (terminalFailure.fallbackEligible && isFallbackEnabled(env)) {
			const fallbackAuth = await authorizeElevenLabsFallbackQuota({
				env,
				stub,
				step,
				config,
				smolId,
				address,
				quotaReservationId,
				quotaDayKey,
				aisgWasUnbilled: false,
				failureReason: terminalFailure.code,
			});
			return await runElevenLabsGeneration({
				env,
				stub,
				step,
				config,
				smolId,
				address,
				quotaReservationId: fallbackAuth.reservationId,
				quotaDayKey: fallbackAuth.dayKey,
				quotaProvider: 'elevenlabs',
				prompt,
				description,
				lyrics,
				is_instrumental,
				requested_provider,
				fallback_from: 'aisonggenerator',
				fallback_reason: terminalFailure.code,
			});
		}

		if (address && quotaReservationId) {
			await step.do('mark failed aisg quota non-refundable', config, () =>
				markAmbiguousGenerationQuota(env, {
					address,
					reservationId: quotaReservationId,
					dayKey: quotaDayKey,
					reason: terminalFailure!.code,
				})
			);
		}

		throw new NonRetryableError(`Song generation failed (${terminalFailure.code}): ${terminalFailure.message}`);
	}

	const committedSongs = await step.do('persist song audio', config, async () => {
		const committed = await commitSongsAudioToR2({
			env,
			smolId,
			songs: finalSongs!,
			provider: 'aisonggenerator',
			swapped: anySwapDetected,
		});
		await updateAttemptIfSupported(stub, {
			provider: 'aisonggenerator',
			status: 'committed',
			source_smol_id: smolId,
			song_ids: committed.map((s) => s.music_id),
			r2_keys: committed.map((s) => `${s.music_id}.mp3`),
			updated_at: new Date().toISOString(),
		});
		if (address && quotaReservationId) {
			await commitGenerationQuota(env, {
				address,
				reservationId: quotaReservationId,
				actualProvider: 'aisonggenerator',
				dayKey: quotaDayKey,
			}).catch(() => {});
		}
		return committed;
	});

	const finalIds = committedSongs.map((s) => s.music_id);
	await step.do('save final songs', config, async () => {
		await saveStateOnlyStep(stub, 'song_ids', finalIds);
		await saveStateOnlyStep(stub, 'songs', committedSongs);
		await saveProviderProgress(stub, {
			requested_provider,
			active_provider: 'aisonggenerator',
			actual_provider: 'aisonggenerator',
		});
		if (address && quotaReservationId) {
			await commitGenerationQuota(env, {
				address,
				reservationId: quotaReservationId,
				actualProvider: 'aisonggenerator',
				dayKey: quotaDayKey,
			});
		}
	});

	return {
		songs: committedSongs,
		song_ids: finalIds,
		requested_provider,
		active_provider: 'aisonggenerator',
		actual_provider: 'aisonggenerator',
		generation_meta: {
			requested_provider,
			actual_provider: 'aisonggenerator',
		},
		reused_songs: false,
	};
}

async function detectAndCorrectSwaps(
	stub: DurableObjectStub<SmolDurableObject>,
	songs: AiSongGeneratorSong[]
): Promise<{ songs: AiSongGeneratorSong[]; swapped: boolean }> {
	const doStub = stub as unknown as {
		getStep?: <T>(key: string) => Promise<T | undefined>;
		getSteps: () => Promise<WorkflowSteps>;
	};

	let originalFingerprints: Record<string, AudioFingerprint>;
	let lastKnownUrls: Record<string, string>;
	let fingerprintAttempts: Record<string, number>;

	if (typeof doStub.getStep === 'function') {
		const [fp, urls, attempts] = await Promise.all([
			doStub.getStep<Record<string, AudioFingerprint>>('original_fingerprints'),
			doStub.getStep<Record<string, string>>('last_known_urls'),
			doStub.getStep<Record<string, number>>('fingerprint_attempts'),
		]);
		originalFingerprints = fp ?? {};
		lastKnownUrls = urls ?? {};
		fingerprintAttempts = attempts ?? {};
	} else {
		const currentSteps = await doStub.getSteps();
		originalFingerprints = currentSteps.original_fingerprints ?? {};
		lastKnownUrls = currentSteps.last_known_urls ?? {};
		fingerprintAttempts = currentSteps.fingerprint_attempts ?? {};
	}

	let stateChanged = false;
	let urlsChanged = false;
	let swapped = false;

	for (const song of songs) {
		if (!song.audio) continue;

		const lastUrl = lastKnownUrls[song.music_id];
		const isNewUrl = !lastUrl || lastUrl !== song.audio;

		if (isNewUrl) {
			urlsChanged = true;

			try {
				const attempts = fingerprintAttempts[song.music_id] || 0;
				const isLastAttempt = attempts >= MAX_FINGERPRINT_ATTEMPTS - 1;

				const fp = await extractFingerprint(
					song.audio,
					undefined,
					isLastAttempt ? 0 : undefined,
					song.duration
				);
				if (fp) {
					if (!originalFingerprints[song.music_id]) {
						originalFingerprints[song.music_id] = fp;
						stateChanged = true;
					}
					if (fingerprintAttempts[song.music_id]) {
						delete fingerprintAttempts[song.music_id];
						stateChanged = true;
					}
				}
			} catch (err) {
				if (err instanceof InsufficientAudioDataError) {
					const attempts = (fingerprintAttempts[song.music_id] || 0) + 1;
					fingerprintAttempts[song.music_id] = attempts;
					await saveStateOnlyStep(stub, 'fingerprint_attempts', fingerprintAttempts);
					throw err;
				}
				throw err;
			}

			lastKnownUrls[song.music_id] = song.audio;
			stateChanged = true;
		}
	}

	if (urlsChanged && Object.keys(originalFingerprints).length === 2) {
		const matched = await matchSongsByFingerprint(originalFingerprints, songs);
		if (matched.swapped) {
			swapped = true;
			songs = matched.songs;

			lastKnownUrls = {};
			for (const song of songs) {
				if (song.audio) {
					lastKnownUrls[song.music_id] = song.audio;
				}
			}
			stateChanged = true;
		}
	}

	if (stateChanged) {
		await saveStateOnlyStep(stub, 'original_fingerprints', originalFingerprints);
		await saveStateOnlyStep(stub, 'last_known_urls', lastKnownUrls);
		await saveStateOnlyStep(stub, 'fingerprint_attempts', fingerprintAttempts);
	}

	return { songs, swapped };
}
