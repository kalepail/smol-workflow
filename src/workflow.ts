import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent, WorkflowStepConfig } from 'cloudflare:workers';
import type { SmolDurableObject } from './do';
import { pixellab } from './ai/pixellab';
import { imageDescribe } from './ai/cf';
import { generateLyrics } from './ai/aisonggenerator';
import { checkNSFW, isNsfwBlocked, normalizeNsfwResult } from './ai/nsfw';
import { NonRetryableError } from 'cloudflare:workflows';
import { purgeCacheByTags } from './utils/cache';
import { artistSmolsCacheTag, playlistCacheTag } from './utils/cache-tags';
import { generateOrReuseSongs, isValidMusicProvider, normalizeMusicProvider } from './utils/songs';
import { isDurableObjectId } from './utils/durable-object-id';
import { isWorkflowNotFoundError } from './utils/workflow-errors';
import { createHiddenSearchState, createQueuedSearchState, queueSearchIndexingById } from './utils/search';
import { refundGenerationQuota } from './utils/quota';

/**
 * Smol Generation Workflow
 *
 * Generates a "smol" combining:
 * - AI-generated pixel art (via Pixellab)
 * - Image description (via Cloudflare Workers AI)
 * - Lyrics, title, and style tags (via AISG lyrics route / Workers AI fallback)
 * - NSFW classification (Workers AI Clef 27B + cover PNG, fail-closed; NSFW_PROVIDER rollback)
 * - Music generation:
 *   - Primary: AISG v6 (2 tracks, split submit + paginated discovery + bounded poll + swap validation)
 *   - Explicit or Automatic Fallback: ElevenLabs Music v2.5 via Cloudflare AI Gateway BYOK (1 track, direct to R2)
 */

const config: WorkflowStepConfig = {
	retries: {
		limit: 5,
		delay: '10 second',
		backoff: 'exponential',
	},
	timeout: '5 minutes',
};

// Non-stream step results are capped at 1 MiB. Leave headroom for encoding.
const MAX_RETRY_SNAPSHOT_BYTES = 900 * 1024;

function isSchemaCompatError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return /no such column|has no column named|NOT NULL constraint failed:\s*Smols\.Song_2/i.test(msg);
}

/**
 * Reduce restored retry state to the fields `run` and `generateOrReuseSongs`
 * read, as a plain JSON value safe to persist as a step result.
 */
export function toRetrySnapshot(restored: WorkflowSteps | null | undefined, retry_id: string): WorkflowSteps | null {
	if (!restored?.payload) {
		return null;
	}

	const snapshot = JSON.parse(JSON.stringify({
		payload: restored.payload,
		image_base64: restored.image_base64,
		description: restored.description,
		lyrics: restored.lyrics,
		nsfw: restored.nsfw,
		song_ids: restored.song_ids,
		songs: restored.songs,
		requested_provider: restored.requested_provider,
		active_provider: restored.active_provider,
		actual_provider: restored.actual_provider,
		fallback_from: restored.fallback_from,
		fallback_reason: restored.fallback_reason,
		generation_meta: restored.generation_meta,
		provider_attempt: restored.provider_attempt,
		original_fingerprints: restored.original_fingerprints,
		quota_reservation_id: restored.quota_reservation_id,
		quota_day_key: restored.quota_day_key,
		quota_provider: restored.quota_provider,
	})) as WorkflowSteps;

	if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_RETRY_SNAPSHOT_BYTES) {
		console.warn('Retry snapshot too large for a step result; regenerating image', retry_id);
		// A regenerated cover was never moderated: drop the verdict with the image it judged.
		snapshot.image_base64 = undefined;
		snapshot.nsfw = undefined;
	}

	return snapshot;
}

async function persistSmolAndPlaylistD1(params: {
	env: Env;
	id: string;
	title: string;
	tags: string[];
	song1: string;
	song2: string | null;
	address: string;
	isSearchPublic: boolean;
	isInstrumental: boolean;
	requestedProvider: MusicProvider;
	actualProvider: MusicProvider | null;
	playlist?: string;
}): Promise<void> {
	const {
		env,
		id,
		title,
		tags,
		song1,
		song2,
		address,
		isSearchPublic,
		isInstrumental,
		requestedProvider,
		actualProvider,
		playlist,
	} = params;

	const runStatements = async (statements: D1PreparedStatement[]) => {
		if (typeof env.SMOL_D1.batch === 'function' && statements.length > 1) {
			await env.SMOL_D1.batch(statements);
			return;
		}
		for (const stmt of statements) {
			await stmt.run();
		}
	};

	const playlistStmt = playlist
		? env.SMOL_D1.prepare(`INSERT OR IGNORE INTO Playlists (Id, Title) VALUES (?1, ?2)`).bind(id, playlist)
		: null;

	// Replay can encounter a row published by the prior worker, so fill only missing tags.
	for (const includeTags of [true, false]) {
		const insert = env.SMOL_D1.prepare(`
			INSERT INTO Smols (Id, Title, Song_1, Song_2, Address, Public, Instrumental,
				Requested_Provider, Actual_Provider${includeTags ? ', Tags' : ''})
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9${includeTags ? ', ?10' : ''})
			ON CONFLICT (Id) DO ${includeTags ? 'UPDATE SET Tags = excluded.Tags WHERE Smols.Tags IS NULL' : 'NOTHING'}
		`).bind(
			id, title, song1, song2, address, isSearchPublic, isInstrumental, requestedProvider, actualProvider,
			...(includeTags ? [JSON.stringify(tags)] : []),
		);
		try {
			await runStatements(playlistStmt ? [insert, playlistStmt] : [insert]);
			return;
		} catch (err) {
			if (!isSchemaCompatError(err)) throw err;
		}
	}

	// Pre-migration compatibility fallback (Song_2 TEXT NOT NULL -> '' for 1-track Smols, no provider columns)
	const preMigrationInsert = env.SMOL_D1.prepare(`
		INSERT INTO Smols (Id, Title, Song_1, Song_2, Address, Public, Instrumental)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
		ON CONFLICT (Id) DO NOTHING
	`).bind(
		id,
		title,
		song1,
		song2 ?? '',
		address,
		isSearchPublic,
		isInstrumental,
	);

	await runStatements(playlistStmt ? [preMigrationInsert, playlistStmt] : [preMigrationInsert]);
}

export class Workflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		let retry_steps: WorkflowSteps | undefined;
		const initialPayload = event.payload;
		let payload: WorkflowParams = { ...initialPayload };

		const { retry_id, override_provider } = initialPayload;

		// =====================================================================
		// STEP 1: Load retry state (if this is a retry)
		// =====================================================================
		if (retry_id) {
			const restoredSteps = await step.do(
				'retry workflow',
				config,
				async () => {
					let restored: WorkflowSteps | null | undefined;

					if (isDurableObjectId(retry_id)) {
						try {
							const retry_doid = this.env.DURABLE_OBJECT.idFromString(retry_id);
							const retry_stub = this.env.DURABLE_OBJECT.get(retry_doid);

							restored = await retry_stub.getSteps() as WorkflowSteps;
						} catch (err) {
							console.warn('Retry DO lookup failed, falling back to KV', retry_id, err);
						}
					}

					if (!restored?.payload) {
						restored = await this.env.SMOL_KV.get(retry_id, 'json') as WorkflowSteps | null;
					}

					return toRetrySnapshot(restored, retry_id);
				}
			);

			retry_steps = restoredSteps ?? undefined;

			// Retry can be started by anyone; attribution intentionally stays
			// with the original smol creator from the saved payload.
			const restoredProvider = isValidMusicProvider(retry_steps?.payload?.provider)
				? retry_steps!.payload!.provider
				: isValidMusicProvider(retry_steps?.requested_provider)
					? retry_steps!.requested_provider
					: undefined;
			const effectiveProvider = isValidMusicProvider(override_provider)
				? override_provider
				: restoredProvider ?? normalizeMusicProvider(initialPayload.provider);

			const { retry_id: _droppedRetryId, override_provider: _droppedOverride, ...restoredCleanPayload } = retry_steps?.payload ?? {};
			payload = {
				...initialPayload,
				...restoredCleanPayload,
				provider: effectiveProvider,
				retry_id,
				...(isValidMusicProvider(override_provider) ? { override_provider } : {}),
			};
		} else {
			payload = {
				...payload,
				provider: normalizeMusicProvider(payload.provider),
			};
		}

		const {
			address,
			prompt,
			playlist,
			public: is_public = true,
			instrumental: is_instrumental = false,
		} = payload;
		const requested_provider = normalizeMusicProvider(payload.provider);
		const quota_reservation_id = initialPayload.quota_reservation_id ?? retry_steps?.quota_reservation_id;
		const quota_day_key = initialPayload.quota_day_key ?? retry_steps?.quota_day_key;
		const quota_provider = initialPayload.quota_provider ?? retry_steps?.quota_provider;
		const quota_reuse_only = initialPayload.quota_reuse_only === true;
		const ownsFreshReservation = Boolean(
			quota_reservation_id
			&& quota_reservation_id === event.instanceId
			&& !quota_reuse_only
		);

		if (!address) {
			throw new NonRetryableError('Missing address: unable to start workflow without user authentication');
		}

		if (!prompt) {
			throw new NonRetryableError('Missing prompt: please provide a description for your smol');
		}

		if (!isDurableObjectId(event.instanceId)) {
			throw new NonRetryableError(`Invalid workflow instance ID: ${event.instanceId}`);
		}

		const doid = this.env.DURABLE_OBJECT.idFromString(event.instanceId);
		const stub = this.env.DURABLE_OBJECT.get(doid);

		const persistedPayload: WorkflowParams = {
			address,
			prompt,
			public: is_public,
			instrumental: is_instrumental,
			...(playlist ? { playlist } : {}),
			provider: requested_provider,
			...(payload.workflow_version ? { workflow_version: payload.workflow_version } : {}),
		};

		await step.do('save payload', config, async () => {
			await stub.saveStep('payload', persistedPayload);
			const doStub = stub as unknown as {
				saveSteps?: (entries: Record<string, unknown>) => Promise<void>;
			};
			if ((quota_reservation_id || quota_day_key || quota_provider) && typeof doStub.saveSteps === 'function') {
				await doStub.saveSteps({
					...(quota_reservation_id ? { quota_reservation_id } : {}),
					...(quota_day_key ? { quota_day_key } : {}),
					...(quota_provider ? { quota_provider } : {}),
				});
			}
		});

		let image_base64: string;
		let description: string;
		let lyrics: AiSongGeneratorLyrics;
		let nsfw: NormalizedNsfwResult;

		try {
			// =====================================================================
			// STEP 2: Generate image (or reuse from retry)
			// =====================================================================
			image_base64 = retry_steps?.image_base64 || await step.do(
				'generate image',
				{
					...config,
					retries: {
						...config.retries,
						limit: 6, // ~10 min with exponential backoff
					},
				} as WorkflowStepConfig,
				async () => {
					return await pixellab(this.env, prompt, 'pixflux');
				}
			);

			await step.do('save generated image', config, () => stub.saveStep('image_base64', image_base64));

			// =====================================================================
			// STEP 3: Describe image (or reuse from retry)
			// =====================================================================
			description = retry_steps?.description || await step.do('describe image', config, async () => {
				return await imageDescribe(this.env, image_base64, prompt);
			});

			await step.do('save image description', config, () => stub.saveStep('description', description));

			// =====================================================================
			// STEP 4: Generate lyrics / title / style (or reuse from retry)
			// =====================================================================
			lyrics = retry_steps?.lyrics || await step.do('generate lyrics', config, async () => {
				const generated = await generateLyrics(this.env, prompt, description);

				const missingLyrics = !is_instrumental && !generated.lyrics?.trim();
				if (
					!generated.title?.trim()
					|| missingLyrics
					|| (generated.style?.length ?? 0) < 2
				) {
					const missing = [
						!generated.title?.trim() && 'title',
						missingLyrics && 'lyrics',
						(generated.style?.length ?? 0) < 2 && 'style',
					].filter(Boolean).join(', ');
					throw new Error(`Lyrics generation incomplete (missing: ${missing}). Try a different prompt.`);
				}

				return {
					title: generated.title.trim(),
					style: generated.style,
					lyrics: generated.lyrics ?? '',
				};
			});

			await step.do('save generated lyrics', config, () => stub.saveStep('lyrics', lyrics));

			// =====================================================================
			// STEP 5: Check NSFW, always normalized fail-closed. A retry reuses the stored verdict
			// ONLY when every moderated input (cover, description, lyrics) was reused unchanged;
			// any regenerated input is re-classified so it never inherits a stale safe verdict.
			// =====================================================================
			const reusedAllModerationInputs = Boolean(retry_steps?.image_base64 && retry_steps?.description && retry_steps?.lyrics);
			nsfw = retry_steps?.nsfw !== undefined && reusedAllModerationInputs
				? normalizeNsfwResult(retry_steps.nsfw)
				: await step.do('check nsfw', config, async () => {
					return await checkNSFW(this.env, prompt, description, lyrics.lyrics ?? '', image_base64);
				});

			await step.do('save nsfw check', config, () => stub.saveStep('nsfw', nsfw));
		} catch (err) {
			// Refund a fresh reservation ONLY if a pre-music step failed permanently before
			// any music provider call was dispatched (never on test SuspendSignal or inherited claims).
			if (ownsFreshReservation && !(err instanceof Error && err.name === 'SuspendSignal')) {
				await step.do('refund quota on pre-music failure', config, async () => {
					await refundGenerationQuota(this.env, {
						address,
						reservationId: quota_reservation_id!,
						dayKey: quota_day_key,
						reason: 'pre_music_step_failed',
					});
				}).catch(() => {});
			}
			throw err;
		}

		// =====================================================================
		// STEP 6: Generate or reuse songs (AISG v6 2-track / ElevenLabs 1-track)
		// =====================================================================
		const musicOutcome = await generateOrReuseSongs({
			env: this.env,
			stub,
			step,
			config,
			smolId: event.instanceId,
			address,
			quotaReservationId: quota_reservation_id,
			quotaDayKey: quota_day_key,
			quotaProvider: quota_provider,
			quotaReuseOnly: quota_reuse_only,
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

		const {
			songs,
			song_ids,
			active_provider,
			actual_provider,
			fallback_from,
			fallback_reason,
			generation_meta,
		} = musicOutcome;

		if (songs.length < 1 || !songs[0]?.music_id) {
			throw new NonRetryableError('Workflow produced no playable songs');
		}

		const isSearchPublic = isNsfwBlocked(nsfw) ? false : is_public;

		// =====================================================================
		// STEP 7A: Publish durable detail KV + D1 Smols/Playlists (checkpointed)
		// Preserves any newer existing search revision on step replay.
		// =====================================================================
		await step.do('publish smol', config, async () => {
			const song1 = songs[0].music_id;
			const song2 = songs.length > 1 && songs[1]?.music_id ? songs[1].music_id : null;

			const existingKv = await this.env.SMOL_KV.get(event.instanceId, 'json') as WorkflowSteps | null;
			const preservedSearch = existingKv?.search
				?? (isSearchPublic ? createQueuedSearchState() : createHiddenSearchState());

			// Write durable detail KV BEFORE D1 so GET /:id immediately sees KV once D1 row exists
			await this.env.SMOL_KV.put(event.instanceId, JSON.stringify({
				payload: persistedPayload,
				image_base64,
				image: true,
				description,
				lyrics,
				nsfw,
				song_ids,
				songs,
				requested_provider,
				active_provider,
				actual_provider,
				...(fallback_from ? { fallback_from } : {}),
				...(fallback_reason ? { fallback_reason } : {}),
				generation_meta,
				search: preservedSearch,
			}));

			// Write D1 Smols row + conflict-safe Playlist insert in one batch (pre- and post-migration safe)
			await persistSmolAndPlaylistD1({
				env: this.env,
				id: event.instanceId,
				title: lyrics.title,
				tags: lyrics.style ?? [],
				song1,
				song2,
				address,
				isSearchPublic,
				isInstrumental: is_instrumental,
				requestedProvider: requested_provider,
				actualProvider: actual_provider,
				playlist,
			});
		});

		// =====================================================================
		// STEP 7B: Enqueue search indexing (separate retryable checkpoint, fail-loud!)
		// Retries if KV record is not yet visible so enqueue never silently skips sending.
		// =====================================================================
		if (isSearchPublic) {
			await step.do('enqueue search indexing', config, async () => {
				const queued = await queueSearchIndexingById(this.env, event.instanceId);
				if (!queued) {
					throw new Error(`Search indexing enqueue skipped: KV record not yet visible for ${event.instanceId}`);
				}
			});
		}

		// =====================================================================
		// STEP 7C: Retire ONLY positively identified UNPUBLISHED, TERMINAL retry state
		// Never deletes any existing published D1 Smols row, its playlists/likes,
		// its detail KV, its search index, any active/still-running source workflow's
		// assets, or any shared/active MP3s.
		// Fails closed on D1 or Workflow status read errors.
		// =====================================================================
		if (retry_id && retry_id !== event.instanceId) {
			await step.do('cleanup retry state', config, async () => {
				// 1. Positively verify retry_id is NOT published in D1 (do NOT swallow D1 errors!)
				const publishedRow = await this.env.SMOL_D1.prepare(
					`SELECT Id FROM Smols WHERE Id = ?1`
				)
					.bind(retry_id)
					.first<{ Id: string }>();

				if (publishedRow) {
					// Published row exists (whether minted or unminted): preserve D1 row,
					// likes, mixtape/playlist references, KV detail, search vectors, and image.
					return;
				}

				// 2. Positively verify source workflow is NOT still active/complete before retiring its assets
				if (typeof this.env.WORKFLOW?.get === 'function') {
					try {
						const sourceInstance = await this.env.WORKFLOW.get(retry_id);
						const sourceStatus = await sourceInstance.status();
						if (sourceStatus.status !== 'errored' && sourceStatus.status !== 'terminated') {
							// Source is still running or already completed — never delete its KV/image/DO!
							return;
						}
					} catch (err) {
						if (!isWorkflowNotFoundError(err)) {
							// Indeterminate workflow lookup error: fail closed & retry step
							throw err;
						}
					}
				}

				// Confirmed unpublished, terminal/missing transient retry state: retire KV, image, and DO.
				await this.env.SMOL_KV.delete(retry_id);
				await this.env.SMOL_BUCKET.delete(`${retry_id}.png`);

				if (isDurableObjectId(retry_id)) {
					const retry_doid = this.env.DURABLE_OBJECT.idFromString(retry_id);
					const retry_stub = this.env.DURABLE_OBJECT.get(retry_doid);
					await retry_stub.setToFlush();
				}
			});
		}

		// =====================================================================
		// STEP 7D: Batched cache purge + schedule new DO flush alarm LAST
		// =====================================================================
		await step.do('finalize workflow', config, async () => {
			const purgeTags = new Set<string>([
				`user:${address}:created`,
			]);
			if (isSearchPublic) {
				purgeTags.add('public-smols');
				purgeTags.add(artistSmolsCacheTag(address));
			}
			if (playlist) {
				purgeTags.add(await playlistCacheTag(playlist));
			}

			await purgeCacheByTags([...purgeTags]);
			await stub.setToFlush();
		});

		return [
			persistedPayload,
			image_base64,
			description,
			lyrics,
			nsfw,
			song_ids,
			songs,
		];
	}
}
