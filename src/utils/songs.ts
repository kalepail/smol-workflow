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
import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import type { SmolDurableObject } from '../do';
import {
	AisgProviderError,
	discoverAisgTaskSongs,
	getAisgAttemptReceipt,
	getSongs,
	isContentPolicyMessage,
	submitAisgTask,
} from '../ai/aisonggenerator';
import {
	ElevenLabsProviderError,
	generateElevenLabsSong,
	getCanonicalSongUrl,
	getElevenLabsMusicId,
	toNonRetryableElevenLabsError,
} from '../ai/elevenlabs';
import {
	extractFingerprint,
	InsufficientAudioDataError,
	matchSongsByFingerprint,
	type AudioFingerprint,
} from './audio-fingerprint';

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

function isPollableAisgIds(retrySteps: WorkflowSteps): boolean {
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

			const response = await fetch(song.audio, {
				signal: AbortSignal.timeout(AISG_AUDIO_FETCH_TIMEOUT_MS),
			});
			if (!response.ok) {
				throw new Error(`Failed to fetch finalized audio for ${musicId} (${response.status})`);
			}

			const arrayBuffer = await response.arrayBuffer();
			if (arrayBuffer.byteLength === 0) {
				throw new Error(`Empty audio downloaded for ${musicId}`);
			}
			if (arrayBuffer.byteLength > AISG_MAX_AUDIO_BYTES) {
				throw new NonRetryableError(`Audio for ${musicId} exceeded ${AISG_MAX_AUDIO_BYTES} bytes`);
			}

			await env.SMOL_BUCKET.put(r2Key, arrayBuffer, {
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
 * Execute ElevenLabs 1-track generation (explicit or automatic fallback) inside a non-retried paid step.
 */
async function runElevenLabsGeneration(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	smolId: string;
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
	const stepName = fallback_from ? 'generate song (elevenlabs fallback)' : 'generate song (elevenlabs)';

	await step.do('record elevenlabs provider state', config, async () => {
		await saveProviderProgress(stub, {
			requested_provider,
			active_provider: 'elevenlabs',
			actual_provider: null,
			fallback_from,
			fallback_reason,
		});
	});

	// Paid submit step: retries MUST be 0 so an ambiguous response never triggers a silent second charge.
	const result = await step.do(
		stepName,
		{
			...config,
			retries: { limit: 0, delay: '1 second' },
		},
		async () => {
			// Check R2 first before attempting a paid claim (covers committed prior artifacts cleanly)
			const existingMusicId = getElevenLabsMusicId(targetSmolId);
			const existingHead = typeof env.SMOL_BUCKET.head === 'function'
				? await env.SMOL_BUCKET.head(`${existingMusicId}.mp3`)
				: null;
			if (existingHead && existingHead.size > 0) {
				await updateAttemptIfSupported(stub, {
					provider: 'elevenlabs',
					status: 'committed',
					source_smol_id: targetSmolId,
					song_ids: [existingMusicId],
					r2_keys: [`${existingMusicId}.mp3`],
					upstream_song_id: existingHead.customMetadata?.upstreamSongId,
					gateway_log_id: existingHead.customMetadata?.gatewayLogId,
					updated_at: new Date().toISOString(),
				});
				return {
					song: {
						music_id: existingMusicId,
						status: 4,
						audio: getCanonicalSongUrl(existingMusicId),
						service: 'elevenlabs',
					} satisfies AiSongGeneratorSong,
					receipt: {
						r2_key: `${existingMusicId}.mp3`,
						bytes: existingHead.size,
						upstream_song_id: existingHead.customMetadata?.upstreamSongId,
						gateway_log_id: existingHead.customMetadata?.gatewayLogId,
						reused_from_r2: true,
					},
				};
			}

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

				return generated;
			} catch (err) {
				// Only a confirmed pre-charge rejection (ElevenLabsProviderError with outcome==='rejected')
				// may mark the attempt 'failed'. Any unknown outcome or unexpected post-dispatch error
				// MUST record 'ambiguous' so a retry cannot silently charge a second time.
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
		reused_songs: Boolean(result.receipt.reused_from_r2),
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
	retry_id?: string;
	retry_steps: WorkflowSteps;
	prompt: string;
	description: string;
	lyrics: AiSongGeneratorLyrics;
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
		retry_id,
		retry_steps,
		prompt,
		description,
		lyrics,
		is_instrumental,
		requested_provider,
		override_provider,
	} = params;

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
		// Try read-only attempt reconciliation against aisonggenerator-worker if we have an attempt_id
		// and don't yet have a task_id or full 2 song_ids.
		let resolvedTaskId = attempt.task_id;
		let resolvedWorkspaceId = attempt.workspace_id;
		let resolvedSongIds = toDistinctStringIds(attempt.song_ids ?? retry_steps.song_ids);

		if (
			attempt.attempt_id
			&& (attempt.status === 'claimed' || attempt.status === 'ambiguous')
			&& !resolvedTaskId
			&& resolvedSongIds.length < EXPECTED_AISG_TRACK_COUNT
		) {
			const receipt = await step.do('reconcile aisonggenerator attempt', config, async () => {
				return await getAisgAttemptReceipt(env, attempt.attempt_id!);
			});

			if (receipt && (receipt.status === 'accepted' || receipt.status === 'completed')) {
				resolvedTaskId = receipt.task_id ?? resolvedTaskId;
				resolvedWorkspaceId = receipt.workspace_id ?? resolvedWorkspaceId;
				if (Array.isArray(receipt.music_ids) && receipt.music_ids.length > 0) {
					resolvedSongIds = toDistinctStringIds(receipt.music_ids);
				}
			} else {
				throw new NonRetryableError(
					`Previous aisonggenerator attempt (${attempt.attempt_id}, status=${receipt?.status ?? attempt.status}) requires reconciliation before authorizing another charge`
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
	const retrySongIds = toDistinctStringIds(retry_steps?.song_ids);
	const retrySongs = Array.isArray(retry_steps?.songs) ? retry_steps!.songs! : [];
	const distinctRetrySongMusicIds = toDistinctStringIds(
		retrySongs.map((s) => s?.music_id).filter((id): id is string => Boolean(id))
	);
	const isExplicitAisgSnapshot = previousProvider === 'aisonggenerator'
		|| retrySongs.some((s) => (s.service || s.provider || '').toLowerCase() === 'aisonggenerator');
	const requiredTrackCount = isExplicitAisgSnapshot ? EXPECTED_AISG_TRACK_COUNT : 1;
	const songIdsMatchRetrySongs = distinctRetrySongMusicIds.length === retrySongs.length
		&& distinctRetrySongMusicIds.length === retrySongIds.length
		&& distinctRetrySongMusicIds.every((id) => retrySongIds.includes(id));
	const hasCompleteSongs = retrySongs.length >= requiredTrackCount
		&& songIdsMatchRetrySongs
		&& retrySongs.every((s) => Boolean(s?.music_id && s.status >= 4 && s.audio));

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
			retry_id,
			retry_steps,
			prompt,
			description,
			lyrics,
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
				throw new NonRetryableError(`Song generation failed (${quickCheck.failure.code}): ${quickCheck.failure.message}`);
			}
			if (override_provider === 'elevenlabs') {
				return await runElevenLabsGeneration({
					env,
					stub,
					step,
					config,
					smolId,
					prompt,
					description,
					lyrics,
					is_instrumental,
					requested_provider,
				});
			}
			if (isFallbackEnabled(env)) {
				return await runElevenLabsGeneration({
					env,
					stub,
					step,
					config,
					smolId,
					prompt,
					description,
					lyrics,
					is_instrumental,
					requested_provider,
					fallback_from: 'aisonggenerator',
					fallback_reason: quickCheck.failure.code,
				});
			}
			throw new NonRetryableError(`Song generation failed (${quickCheck.failure.code}): ${quickCheck.failure.message}`);
		}
	}

	// Refuse incomplete historical AISG snapshot (e.g. 1 completed AISG track without song_ids or task_id)
	// rather than falling through to a fresh paid submission.
	if (
		isExplicitAisgSnapshot
		&& distinctRetrySongMusicIds.length > 0
		&& distinctRetrySongMusicIds.length < EXPECTED_AISG_TRACK_COUNT
		&& retrySongs.every((s) => typeof s.status !== 'number' || s.status >= 0)
	) {
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
	await step.do('record aisonggenerator provider state', config, async () => {
		await saveProviderProgress(stub, {
			requested_provider: 'aisonggenerator',
			active_provider: 'aisonggenerator',
			actual_provider: null,
		});
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
			throw new NonRetryableError(
				`AISG submission outcome unknown (${submitOutcome.code}): ${submitOutcome.message}`
			);
		}
		if (submitOutcome.fallbackEligible && isFallbackEnabled(env)) {
			return await runElevenLabsGeneration({
				env,
				stub,
				step,
				config,
				smolId,
				prompt,
				description,
				lyrics,
				is_instrumental,
				requested_provider: 'aisonggenerator',
				fallback_from: 'aisonggenerator',
				fallback_reason: submitOutcome.code,
			});
		}
		await step.do('save failed song state', config, () =>
			saveStateOnlyStep(stub, 'songs', [{
				music_id: smolId,
				status: submitOutcome.code === 'content_policy' ? -1 : -4,
				audio: '',
				service: 'aisonggenerator',
				error_message: submitOutcome.message,
			}])
		);
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
			return await runElevenLabsGeneration({
				env,
				stub,
				step,
				config,
				smolId,
				prompt,
				description,
				lyrics,
				is_instrumental,
				requested_provider,
				fallback_from: 'aisonggenerator',
				fallback_reason: terminalFailure.code,
			});
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
