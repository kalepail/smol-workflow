import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent, WorkflowStepConfig } from 'cloudflare:workers';
import { pixellab } from './ai/pixellab';
import { imageDescribe } from './ai/cf';
import { generateLyrics } from './ai/aisonggenerator';
import { checkNSFW } from './ai/nsfw';
import { NonRetryableError } from 'cloudflare:workflows';
import { purgePlaylistCache, purgeUserCreatedCache, purgePublicSmolsCache } from './utils/cache';
import { decideSongsStrategy, pollUntilComplete } from './utils/songs';

/**
 * Smol Generation Workflow
 *
 * This workflow generates a "smol" - a combination of:
 * - AI-generated image (via Pixellab)
 * - Image description (via CF AI)
 * - Lyrics with title and style (via AI)
 * - NSFW check
 * - Two songs (via aisonggenerator or diffrhythm)
 *
 * RETRY HANDLING
 * --------------
 * When retry_id is provided, this workflow attempts to reuse work from a
 * previous failed run:
 * - Image, description, lyrics, NSFW check: reused if available
 * - Songs: complex logic in decideSongsStrategy() handles:
 *   - Complete songs: reused with fingerprint validation
 *   - Pending songs: quick-check if completed, else regenerate
 *   - No songs: generate new ones
 *
 * SONG SWAP DETECTION
 * -------------------
 * The aisonggenerator API can swap audio between songs during streaming.
 * This is handled by capturing fingerprints when we first see audio for
 * each song, then comparing on every poll to detect and correct swaps.
 * See src/utils/songs.ts for detailed documentation.
 */

const config: WorkflowStepConfig = {
	retries: {
		limit: 5,
		delay: '10 second',
		backoff: 'exponential',
	},
	timeout: '5 minutes',
}

export class Workflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		let retry_steps: WorkflowSteps | undefined;
		let payload = event.payload;

		const { retry_id, playlist } = payload;

		// =====================================================================
		// STEP 1: Load retry state (if this is a retry)
		// =====================================================================
		if (retry_id) {
			await step.do(
				'retry workflow',
				config,
				async () => {
					try {
						const retry_doid = this.env.DURABLE_OBJECT.idFromString(retry_id);
						const retry_stub = this.env.DURABLE_OBJECT.get(retry_doid);

						retry_steps = await retry_stub.getSteps() as WorkflowSteps;
						payload = {
							...payload, // original payload
							...retry_steps?.payload // previous payload (notably we keep the original address)
						};
					} catch (err) {
						// Fallback for legacy gens
						retry_steps = await this.env.SMOL_KV.get(retry_id, 'json') as WorkflowSteps;
						payload = {
							...payload,
							...retry_steps?.payload
						};
					}
				}
			);
		}

		const { address, prompt, public: is_public = true, instrumental: is_instrumental = false } = payload;

		if (!address) {
			throw new NonRetryableError("Missing address: unable to start workflow without user authentication");
		}

		if (!prompt) {
			throw new NonRetryableError("Missing prompt: please provide a description for your smol");
		}

		const doid = this.env.DURABLE_OBJECT.idFromString(event.instanceId);
		const stub = this.env.DURABLE_OBJECT.get(doid);

		await step.do('save payload', config, async () => stub.saveStep('payload', payload));

		// =====================================================================
		// STEP 2: Generate image (or reuse from retry)
		// =====================================================================
		const image_base64 = retry_steps?.image_base64 || await step.do(
			'generate image',
			{
				...config,
				retries: {
					...config.retries,
					limit: 6,  // ~10 min with exponential backoff
				},
			} as WorkflowStepConfig,
			async () => {
				return await pixellab(prompt, 'pixflux');
			}
		);

		await step.do('save generated image', config, () => stub.saveStep('image_base64', image_base64));

		// =====================================================================
		// STEP 3: Describe image (or reuse from retry)
		// =====================================================================
		const description = retry_steps?.description || await step.do('describe image', config, async () => {
			return await imageDescribe(this.env, image_base64, prompt);
		});

		await step.do('save image description', config, () => stub.saveStep('description', description));

		// =====================================================================
		// STEP 4: Generate lyrics (or reuse from retry)
		// =====================================================================
		const lyrics = retry_steps?.lyrics || await step.do('generate lyrics', config, async () => {
			const lyrics = await generateLyrics(this.env, prompt, description);

			if (
				!lyrics.title
				|| !lyrics.lyrics
				|| (lyrics.style?.length ?? 0) < 2
			) {
				const missing = [
					!lyrics.title && 'title',
					!lyrics.lyrics && 'lyrics',
					(lyrics.style?.length ?? 0) < 2 && 'style'
				].filter(Boolean).join(', ');
				throw new Error(`Lyrics generation incomplete (missing: ${missing}). Try a different prompt.`);
			}

			return lyrics;
		});

		await step.do('save generated lyrics', config, () => stub.saveStep('lyrics', lyrics));

		// =====================================================================
		// STEP 5: Check NSFW (or reuse from retry)
		// =====================================================================
		const nsfw = retry_steps?.nsfw || await step.do('check nsfw', config, async () => {
			return await checkNSFW(this.env, prompt, description, JSON.stringify(lyrics.lyrics));
		});

		await step.do('save nsfw check', config, () => stub.saveStep('nsfw', nsfw));

		// =====================================================================
		// STEP 6: Handle songs (complex - see decideSongsStrategy)
		//
		// This decides whether to:
		// - Reuse complete songs from a retry (with fingerprint validation)
		// - Quick-check if pending songs completed (with fingerprint validation)
		// - Generate new songs and poll for completion
		// =====================================================================
		const songsDecision = await decideSongsStrategy({
			env: this.env,
			stub,
			step,
			config,
			retry_steps,
			prompt,
			description,
			lyrics,
			is_public,
			is_instrumental,
		});

		let songs: AiSongGeneratorSong[];
		const song_ids = songsDecision.song_ids;

		if (songsDecision.needsPolling) {
			// Poll for songs with swap detection on every snapshot
			songs = await pollUntilComplete({
				env: this.env,
				stub,
				step,
				config,
				song_ids: songsDecision.song_ids,
				source: songsDecision.source,
			});
		} else {
			// Songs already available (from retry)
			songs = songsDecision.songs;
		}

		// Track whether we reused complete songs (for cleanup logic)
		const hasCompleteSongs = retry_steps?.songs?.length === 2
			&& retry_steps?.song_ids?.length === 2
			&& retry_steps.songs.every(s => s.status >= 4 && s.audio);

		// =====================================================================
		// STEP 7: Complete workflow - save to D1/KV and cleanup retry if needed
		// =====================================================================
		await step.do('complete workflow', config, async () => {
			await stub.setToFlush();

			// Insert into D1
			await this.env.SMOL_D1.prepare(`
                INSERT INTO Smols (Id, Title, Song_1, Song_2, Address, Public, Instrumental)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
				ON CONFLICT (Id) DO NOTHING
            `)
				.bind(
					event.instanceId,
					lyrics.title,
					songs[0].music_id,
					songs[1].music_id,
					address,
					typeof nsfw !== 'string' && nsfw?.safe === false ? false : is_public,
					is_instrumental,
				)
				.run();

			// Save to KV for quick lookups
			await this.env.SMOL_KV.put(event.instanceId, JSON.stringify({
				payload,
				image_base64,
				description,
				lyrics,
				nsfw,
				song_ids,
				songs,
			}));

			// Cleanup old retry data if this is a retry
			if (retry_id) {
				try {
					const retry_doid = this.env.DURABLE_OBJECT.idFromString(retry_id);
					const retry_stub = this.env.DURABLE_OBJECT.get(retry_doid);
					await retry_stub.setToFlush();
				} catch { }

				await this.env.SMOL_D1.prepare(`DELETE FROM Smols WHERE Id = ?1`).bind(retry_id).run();
				await this.env.SMOL_KV.delete(retry_id);

				// Clean up orphaned R2 files from retry
				await this.env.SMOL_BUCKET.delete(`${retry_id}.png`);

				// Clean up old song mp3s if we regenerated (not reusing hasCompleteSongs)
				if (!hasCompleteSongs && retry_steps?.songs) {
					for (const song of retry_steps.songs) {
						if (song.status >= 4 && song.music_id) {
							await this.env.SMOL_BUCKET.delete(`${song.music_id}.mp3`);
						}
					}
				}
			}

			// Handle playlist if specified
			if (playlist) {
				await this.env.SMOL_D1.prepare(`INSERT INTO Playlists (Id, Title) VALUES (?1, ?2)`).bind(event.instanceId, playlist).run();
				await purgePlaylistCache(playlist);
			}

			// Purge caches so the smol appears immediately
			await Promise.all([
				purgeUserCreatedCache(address),
				purgePublicSmolsCache(),
			]);
		});

		return [
			payload,
			image_base64,
			description,
			lyrics,
			nsfw,
			song_ids,
			songs,
		];
	}
}
