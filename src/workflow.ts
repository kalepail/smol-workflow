import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent, WorkflowStepConfig } from 'cloudflare:workers';
import { pixellab } from './ai/pixellab';
import { imageDescribe } from './ai/cf';
import { generateLyrics, generateSongs, getSongs } from './ai/aisonggenerator';
import { checkNSFW } from './ai/nsfw';
import { NonRetryableError } from 'cloudflare:workflows';
import { purgePlaylistCache, purgeUserCreatedCache, purgePublicSmolsCache } from './utils/cache';
import { extractFingerprint, matchSongsByFingerprint, type AudioFingerprint } from './utils/audio-fingerprint';

// ensure gen can be paid for
// [maybe pay to proxy?]
// gen (prompt)
// image (pixellab)
// meta (cf ai)
// title
// story
// describe image (cf ai)
// song (aisongenerator)
// gen lyrics
// gen song
// pay for gen
// [maybe refund if error]
// deliver results

// TODO store a version for each smol to make it easier to debug in the future 

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

						// if for some reason the above fails (legacy gens)
					} catch (err) {
						retry_steps = await this.env.SMOL_KV.get(retry_id, 'json') as WorkflowSteps;
						payload = {
							...payload, // original payload
							...retry_steps?.payload // previous payload (notably we keep the original address)
						};
					}
				}
			);
		}

		const { address, prompt, public: is_public = true, instrumental: is_instrumental = false } = payload;

		if (!address) {
			throw new NonRetryableError("event.payload missing address");
		}

		if (!prompt) {
			throw new NonRetryableError("event.payload missing prompt");
		}

		const doid = this.env.DURABLE_OBJECT.idFromString(event.instanceId);
		const stub = this.env.DURABLE_OBJECT.get(doid);

		await step.do('save payload', config, async () => stub.saveStep('payload', payload));

		let image_base64 = retry_steps?.image_base64 || await step.do(
			'generate image',
			{
				...config,
				retries: {
					...config.retries,
					limit: 6,  // ~10 min with exponential backoff
				},
			} as WorkflowStepConfig,
			async () => {
				let image_base64 = await pixellab(prompt, 'pixflux');
				return image_base64;
			}
		);

		await step.do('save generated image', config, () => stub.saveStep('image_base64', image_base64))

		let description = retry_steps?.description || await step.do('describe image', config, async () => {
			let description = await imageDescribe(this.env, image_base64, prompt);
			return description;
		});

		await step.do('save image description', config, () => stub.saveStep('description', description))

		let lyrics = retry_steps?.lyrics || await step.do('generate lyrics', config, async () => {
			let lyrics = await generateLyrics(this.env, prompt, description);

			if (
				!lyrics.title
				|| !lyrics.lyrics
				|| (lyrics.style?.length ?? 0) < 2
			) {
				throw JSON.stringify({
					message: 'Generated incomplete lyrics',
					lyrics
				}, null, 2);
			}

			return lyrics;
		});

		await step.do('save generated lyrics', config, () => stub.saveStep('lyrics', lyrics))

		let nsfw = retry_steps?.nsfw || await step.do('check nsfw', config, async () => {
			let nsfw = await checkNSFW(this.env, prompt, description, JSON.stringify(lyrics.lyrics));
			return nsfw;
		})

		await step.do('save nsfw check', config, () => stub.saveStep('nsfw', nsfw))

		// Check if we have complete songs from a previous run we can reuse
		const hasCompleteSongs = retry_steps?.songs?.length === 2
			&& retry_steps?.song_ids?.length === 2
			&& retry_steps.songs.every(s => s.status >= 4 && s.audio);

		// Check if retry has song_ids that might have completed since (retry-only: retry_steps is null for fresh workflows)
		const hasPendingSongIds = !hasCompleteSongs
			&& retry_steps?.song_ids?.length === 2
			&& retry_steps?.songs?.length === 2
			&& retry_steps.songs.every(s => s.status >= 0); // Not already in error state

		let songs!: AiSongGeneratorSong[]; // Assigned in all code paths (directly or via polling)
		let song_ids: number[] | string[];
		let source: 'aisonggenerator' | 'diffrhythm';
		let needsPolling = false;

		if (hasCompleteSongs) {
			// Reuse complete songs from previous run - no need to regenerate or poll
			songs = retry_steps!.songs!;
			song_ids = retry_steps!.song_ids!;
			source = 'aisonggenerator'; // Doesn't matter since we won't poll

			// Still save to new DO for consistency
			await step.do('save song ids', config, () => stub.saveStep('song_ids', song_ids));
			await step.do('save songs', config, () => stub.saveStep('songs', songs));
		} else if (hasPendingSongIds) {
			// Previous run had song_ids but songs weren't complete
			// Quick check if they've completed since - ONE poll, no retries, no waiting
			song_ids = retry_steps!.song_ids!;
			// Default to aisonggenerator - if it was diffrhythm and failed, we'll regenerate anyway
			source = 'aisonggenerator';

			const quickCheck = await step.do('quick check retry songs', {
				...config,
				retries: { limit: 0, delay: '1 second' }, // No retries - either ready now or we regenerate
			}, async () => {
				try {
					const currentSongs = await getSongs(this.env, song_ids, source);
					// Success = ALL songs have status >= 4 (complete) AND have audio URL
					const allComplete = currentSongs.every(s => s.status >= 4 && s.audio);
					const anyError = currentSongs.some(s => s.status < 0);

					if (anyError) {
						return { success: false, reason: 'error', songs: currentSongs };
					}
					if (allComplete) {
						return { success: true, reason: 'complete', songs: currentSongs };
					}
					// Status 0-3 without completion = still processing or stuck, regenerate
					return { success: false, reason: 'incomplete', songs: currentSongs };
				} catch (err) {
					// API error (network, invalid source, etc.) - treat as failure and regenerate
					console.warn('Quick check failed with error, will regenerate:', err);
					return { success: false, reason: 'error', songs: [] };
				}
			});

			if (quickCheck.success) {
				// Songs completed since the retry was created - use them
				console.log('Retry songs completed, reusing');
				songs = quickCheck.songs;
				await step.do('save song ids', config, () => stub.saveStep('song_ids', song_ids));
				await step.do('save songs', config, () => stub.saveStep('songs', songs));
			} else {
				// Songs stuck or errored - regenerate from scratch
				console.log(`Retry songs not ready (${quickCheck.reason}), regenerating`);
				try {
					song_ids = await step.do('generate songs (aisonggenerator)', config, async () => {
						let song_ids = await generateSongs(this.env, prompt, description, lyrics, is_public, is_instrumental, 'aisonggenerator');
						return song_ids;
					})
					source = 'aisonggenerator';
				} catch {
					song_ids = await step.do('generate songs (diffrhythm)', config, async () => {
						let song_ids = await generateSongs(this.env, prompt, description, lyrics, is_public, is_instrumental, 'diffrhythm');
						return song_ids;
					})
					source = 'diffrhythm';
				}
				await step.do('save song ids', config, () => stub.saveStep('song_ids', song_ids));
				needsPolling = true;
			}
		} else {
			// Generate new songs
			try {
				song_ids = await step.do('generate songs (aisonggenerator)', config, async () => {
					let song_ids = await generateSongs(this.env, prompt, description, lyrics, is_public, is_instrumental, 'aisonggenerator');
					return song_ids;
				})
				source = 'aisonggenerator';
			} catch {
				song_ids = await step.do('generate songs (diffrhythm)', config, async () => {
					let song_ids = await generateSongs(this.env, prompt, description, lyrics, is_public, is_instrumental, 'diffrhythm');
					return song_ids;
				})
				source = 'diffrhythm';
			}

			await step.do('save song ids', config, () => stub.saveStep('song_ids', song_ids));
			needsPolling = true;
		}

		if (needsPolling) {

			// Helper to poll songs with different success criteria
			const pollSongs = async (mode: 'streaming' | 'complete'): Promise<AiSongGeneratorSong[]> => {
				const songs = await getSongs(this.env, song_ids, source);

				let has_audio = false;
				let all_have_audio = true;
				let is_complete = true;

				for (const song of songs) {
					if (song.status < 0) {
						await stub.saveStep('songs', songs);
						throw new NonRetryableError(`Song ${song.music_id || 'unknown'} has negative status: ${song.status}`);
					}

					if (song.audio) {
						has_audio = true;
					} else {
						all_have_audio = false;
					}

					if (song.status < 4) {
						is_complete = false;
					}
				}

				// Always save progress
				await stub.saveStep('songs', songs);

				// No audio yet - waiting for generation to start
				if (!has_audio) {
					throw new Error('Songs missing audio');
				}

				// For streaming mode, need ALL songs to have audio for fingerprinting
				if (mode === 'streaming') {
					if (!all_have_audio) {
						const missingSongs = songs.filter(s => !s.audio).map(s => `${s.music_id}: status=${s.status}`);
						throw new Error(`Songs still waiting for audio: ${missingSongs.join('; ')}`);
					}
					return songs;
				}

				// For complete mode, need all songs to be status >= 4
				if (!is_complete) {
					const incomplete = songs.filter(s => s.status < 4).map(s => `${s.music_id}: status=${s.status}, audio=${!!s.audio}`);
					throw new Error(`Songs still streaming: ${incomplete.join('; ')}`);
				}

				return songs;
			};

			await step.sleep('wait for songs to start streaming', '30 seconds');

			// Poll until we have streaming audio - 5 retries
			const streamingSongs = await step.do(
				'wait for streaming',
				{
					...config,
					retries: {
						...config.retries,
						limit: 5,
					},
				} as WorkflowStepConfig,
				() => pollSongs('streaming')
			);

			// Check if songs are already complete (fast generation)
			const alreadyComplete = streamingSongs.every(s => s.status >= 4);

			if (alreadyComplete) {
				// Songs completed quickly - no need to wait or poll again
				console.log('Songs already complete during streaming poll, skipping wait');
				songs = streamingSongs;
			} else {
				// Normal flow: capture streaming fingerprints, wait, then poll for complete
				let streamingFingerprints: Record<string, AudioFingerprint> | undefined;

				if (source === 'aisonggenerator') {
					streamingFingerprints = await step.do('capture streaming fingerprints', config, async () => {
						const currentSteps = await stub.getSteps() as WorkflowSteps;
						const currentSongs = currentSteps.songs as AiSongGeneratorSong[];
						const fingerprints: Record<string, AudioFingerprint> = {};

						for (const song of currentSongs || []) {
							if (song.audio) {
								const fp = await extractFingerprint(song.audio);
								if (fp) {
									fingerprints[song.music_id] = fp;
								} else {
									console.warn(`Failed to extract fingerprint for song ${song.music_id} (audio: ${song.audio})`);
								}
							}
						}

						const songCount = currentSongs?.length ?? 0;
						const fpCount = Object.keys(fingerprints).length;
						if (fpCount < songCount) {
							console.warn(`Only captured ${fpCount}/${songCount} fingerprints`);
						}

						return fingerprints;
					});

					await step.do('save streaming fingerprints', config, () => stub.saveStep('streaming_fingerprints', streamingFingerprints));
				}

				await step.sleep('wait for songs to complete', '90 seconds');

				// Poll until songs are complete - 6 retries (~10 min with exponential backoff)
				songs = await step.do(
					'get songs',
					{
						...config,
						retries: {
							...config.retries,
							limit: 6,
						},
					} as WorkflowStepConfig,
					() => pollSongs('complete')
				);

				// Match fingerprints to detect and correct audio swaps (aisonggenerator only)
				// Requires exactly 2 fingerprints - partial matching doesn't reliably detect swaps
				const fingerprintCount = streamingFingerprints ? Object.keys(streamingFingerprints).length : 0;
				if (source === 'aisonggenerator' && fingerprintCount === 2) {
					const matched = await step.do('match song fingerprints', config, async () => {
						return matchSongsByFingerprint(streamingFingerprints!, songs);
					});

					if (matched.swapped) {
						console.log('Reordering songs based on fingerprint matching');
					}
					songs = matched.songs;

					// Save the corrected songs order
					await step.do('save matched songs', config, () => stub.saveStep('songs', songs));
				} else if (source === 'aisonggenerator') {
					console.warn(`Skipping swap detection: only ${fingerprintCount}/2 fingerprints captured`);
				}
			}
		}

		// mint smol on Stellar
		// await step.do('mint smol', config, async () => {
		// 	// TODO this probably should just be done inline here vs sent to another workflow
		// 	// TODO actually I want mining smols to be a separate explicit step after a song has been minted
		// 		// This will ensure the artist thinks the content is worth being minted
		// 		// And it will allow them to decide the starting price 
		// 			// (maybe, 
		// 			// probably not though as that could mess up the 10M ratio, 
		// 			// though I guess I could scrape whatever is left above the 100 KALE base and immediately sell it into the AMM?)
		// 	await this.env.TX_WORKFLOW.create({
		// 		params: {
		// 			type: 'mint',
		// 			owner: address,
		// 			entropy: event.instanceId,
		// 			name: lyrics.title,
		// 		}
		// 	});
		// });

		await step.do('complete workflow', config, async () => {
			await stub.setToFlush();
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
					typeof nsfw !== 'string' && nsfw?.safe === false ? false : is_public, // if nsfw has been marked unsafe force smol to be private
					is_instrumental,
				)
				.run()
			await this.env.SMOL_KV.put(event.instanceId, JSON.stringify({
				payload,
				image_base64,
				description,
				lyrics,
				nsfw,
				song_ids,
				songs,
			}));

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

			if (playlist) {
				await this.env.SMOL_D1.prepare(`INSERT INTO Playlists (Id, Title) VALUES (?1, ?2)`).bind(event.instanceId, playlist).run()
				// Purge playlist cache so the smol appears immediately in the playlist
				await purgePlaylistCache(playlist)
			}

			// Purge caches now that the smol is created
			// User needs to see their new smol in their created list and the public list
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