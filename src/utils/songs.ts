/**
 * Song Generation and Polling Utilities
 *
 * This module handles the complexity of:
 * 1. Deciding whether to reuse songs from a retry or generate new ones
 * 2. Polling for song completion with swap detection
 * 3. Validating song order against fingerprints
 *
 * IMPORTANT: Audio URL Swap Detection
 * ------------------------------------
 * The aisonggenerator API can return audio URLs that get swapped between songs
 * during streaming or between streaming and completion. This causes the client
 * to hear the wrong audio in the wrong slot.
 *
 * To prevent this, we:
 * 1. Capture "original" fingerprints when we FIRST see audio for each song
 * 2. On every poll, if URLs changed, compare current audio against originals
 * 3. Reorder songs BEFORE saving so the client always sees correct audio
 *
 * The fingerprints and last-known URLs are persisted in the Durable Object
 * so this works correctly across workflow restarts and step retries.
 */

import { NonRetryableError } from 'cloudflare:workflows';
import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import type { SmolDurableObject } from '../do';
import { generateSongs, getSongs } from '../ai/aisonggenerator';
import { extractFingerprint, matchSongsByFingerprint, InsufficientAudioDataError, type AudioFingerprint } from './audio-fingerprint';

// Max attempts to fingerprint a song before accepting partial data.
// With exponential backoff on the workflow step (~10s, 20s, 40s, 80s, 160s),
// this gives the song ~5 minutes to buffer enough data.
// On the final attempt, we accept whatever data is available (minBytes: 0)
// to handle very short songs that may never reach the 32KB threshold.
const MAX_FINGERPRINT_ATTEMPTS = 5;

// Re-export for convenience
export { matchSongsByFingerprint, type AudioFingerprint };

/**
 * Result of deciding how to handle songs for a workflow run.
 * Either we have songs ready to use, or we need to poll for them.
 */
export type SongsDecisionResult =
	| { needsPolling: false; songs: AiSongGeneratorSong[]; song_ids: number[] | string[]; source: 'aisonggenerator' | 'diffrhythm' }
	| { needsPolling: true; songs: null; song_ids: number[] | string[]; source: 'aisonggenerator' | 'diffrhythm' };

/**
 * Determines how to handle songs for this workflow run.
 *
 * For RETRY workflows (retry_steps provided):
 * - If songs are already complete: reuse them (with fingerprint validation)
 * - If song_ids exist but incomplete: quick-check if they finished, else regenerate
 *
 * For FRESH workflows (no retry_steps):
 * - Generate new songs and poll for completion
 *
 * @returns Decision result indicating whether polling is needed
 */
export async function decideSongsStrategy(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	retry_steps: WorkflowSteps | undefined;
	prompt: string;
	description: string;
	lyrics: AiSongGeneratorLyrics;
	is_public: boolean;
	is_instrumental: boolean;
}): Promise<SongsDecisionResult> {
	const { env, stub, step, config, retry_steps, prompt, description, lyrics, is_public, is_instrumental } = params;

	// Check if we have complete songs from a previous run we can reuse
	const hasCompleteSongs = retry_steps?.songs?.length === 2
		&& retry_steps?.song_ids?.length === 2
		&& retry_steps.songs.every(s => s.status >= 4 && s.audio);

	// Check if retry has song_ids that might have completed since
	// (retry-only: retry_steps is null for fresh workflows)
	const hasPendingSongIds = !hasCompleteSongs
		&& retry_steps?.song_ids?.length === 2
		&& retry_steps?.songs?.length === 2
		&& retry_steps.songs.every(s => s.status >= 0); // Not already in error state

	// =========================================================================
	// PATH 1: Reuse complete songs from previous run
	// =========================================================================
	if (hasCompleteSongs) {
		let songs = retry_steps!.songs!;
		const song_ids = retry_steps!.song_ids!;

		// Validate order against original fingerprints if available from previous run
		const oldFingerprints = retry_steps!.original_fingerprints;
		if (oldFingerprints && Object.keys(oldFingerprints).length === 2) {
			const matched = await step.do('validate song order', config, async () => {
				return matchSongsByFingerprint(oldFingerprints, songs);
			});
			if (matched.swapped) {
				console.log('Correcting song order from previous run');
				songs = matched.songs;
			}
		}

		// Save to new DO for consistency
		await step.do('save song ids', config, () => stub.saveStep('song_ids', song_ids));
		await step.do('save songs', config, () => stub.saveStep('songs', songs));

		return { needsPolling: false, songs, song_ids, source: 'aisonggenerator' };
	}

	// =========================================================================
	// PATH 2: Quick-check if pending songs have completed since retry was created
	// =========================================================================
	if (hasPendingSongIds) {
		const song_ids = retry_steps!.song_ids!;
		const source = 'aisonggenerator'; // Default - if it was diffrhythm and failed, we'll regenerate anyway

		const quickCheck = await step.do('quick check retry songs', {
			...config,
			retries: { limit: 0, delay: '1 second' }, // No retries - either ready now or we regenerate
		}, async () => {
			try {
				const currentSongs = await getSongs(env, song_ids, source);
				const allComplete = currentSongs.every(s => s.status >= 4 && s.audio);
				const anyError = currentSongs.some(s => s.status < 0);

				if (anyError) return { success: false, reason: 'error', songs: currentSongs };
				if (allComplete) return { success: true, reason: 'complete', songs: currentSongs };
				return { success: false, reason: 'incomplete', songs: currentSongs };
			} catch (err) {
				console.warn('Quick check failed with error, will regenerate:', err);
				return { success: false, reason: 'error', songs: [] as AiSongGeneratorSong[] };
			}
		});

		if (quickCheck.success) {
			console.log('Retry songs completed, reusing');
			let songs = quickCheck.songs;

			// Validate order against original fingerprints if available
			const oldFingerprints = retry_steps!.original_fingerprints;
			if (oldFingerprints && Object.keys(oldFingerprints).length === 2) {
				const matched = await step.do('validate song order', config, async () => {
					return matchSongsByFingerprint(oldFingerprints, songs);
				});
				if (matched.swapped) {
					console.log('Correcting song order from previous run');
					songs = matched.songs;
				}
			}

			await step.do('save song ids', config, () => stub.saveStep('song_ids', song_ids));
			await step.do('save songs', config, () => stub.saveStep('songs', songs));

			return { needsPolling: false, songs, song_ids, source };
		}

		// Songs stuck or errored - fall through to generate new ones
		console.log(`Retry songs not ready (${quickCheck.reason}), regenerating`);
	}

	// =========================================================================
	// PATH 3: Generate new songs (fresh workflow or retry regeneration)
	// =========================================================================
	const generated = await generateNewSongs({
		env, step, config, prompt, description, lyrics, is_public, is_instrumental
	});

	await step.do('save song ids', config, () => stub.saveStep('song_ids', generated.song_ids));

	return { needsPolling: true, songs: null, song_ids: generated.song_ids, source: generated.source };
}

/**
 * Generate new songs, trying aisonggenerator first with diffrhythm fallback.
 */
async function generateNewSongs(params: {
	env: Env;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	prompt: string;
	description: string;
	lyrics: AiSongGeneratorLyrics;
	is_public: boolean;
	is_instrumental: boolean;
}): Promise<{ song_ids: number[] | string[]; source: 'aisonggenerator' | 'diffrhythm' }> {
	const { env, step, config, prompt, description, lyrics, is_public, is_instrumental } = params;

	try {
		const song_ids = await step.do('generate songs (aisonggenerator)', config, async () => {
			return generateSongs(env, prompt, description, lyrics, is_public, is_instrumental, 'aisonggenerator');
		});
		return { song_ids, source: 'aisonggenerator' };
	} catch {
		const song_ids = await step.do('generate songs (diffrhythm)', config, async () => {
			return generateSongs(env, prompt, description, lyrics, is_public, is_instrumental, 'diffrhythm');
		});
		return { song_ids, source: 'diffrhythm' };
	}
}

/**
 * Creates a poll function that fetches songs and handles swap detection.
 *
 * This is a factory function because the poll function needs access to:
 * - env, stub, song_ids, source (from the workflow context)
 * - Durable Object state (original_fingerprints, last_known_urls)
 *
 * The returned function can be called repeatedly (e.g., in step.do with retries)
 * and will correctly detect/correct swaps on each call.
 *
 * @param mode - 'streaming' waits for all songs to have audio URLs
 *               'complete' waits for all songs to have status >= 4
 */
export function createPollSongsFunction(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	song_ids: number[] | string[];
	source: 'aisonggenerator' | 'diffrhythm';
}) {
	const { env, stub, song_ids, source } = params;

	return async function pollSongs(mode: 'streaming' | 'complete'): Promise<AiSongGeneratorSong[]> {
		let songs = await getSongs(env, song_ids, source);

		let has_audio = false;
		let all_have_audio = true;
		let is_complete = true;

		for (const song of songs) {
			// Negative status = generation failed, non-retryable
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

		// No audio yet - waiting for generation to start
		if (!has_audio) {
			throw new Error('Songs missing audio');
		}

		// For aisonggenerator: detect and correct swaps BEFORE saving snapshot
		// This ensures the client always sees correct audio in correct slot
		if (source === 'aisonggenerator') {
			songs = await detectAndCorrectSwaps(stub, songs);
		}

		// Snapshot immediately when we have ANY audio
		// For aisonggenerator, songs are already reordered if needed
		await stub.saveStep('songs', songs);

		// For streaming mode, wait for ALL songs to have audio before proceeding
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
}

/**
 * Detects if audio URLs have been swapped and corrects the song order.
 *
 * This works by:
 * 1. Loading persisted state (original fingerprints + last known URLs) from DO
 * 2. For each song with a new/changed URL, capture its fingerprint
 * 3. If this is the FIRST audio we've seen for a song, store it as "original"
 * 4. If URLs changed and we have fingerprints for both songs, check for swap
 * 5. If swapped, reorder songs to match original fingerprints
 * 6. Persist updated state
 *
 * Error handling for fingerprinting:
 * - InsufficientAudioDataError (attempts 1-4): Throw to trigger workflow retry.
 *   The song is likely still streaming and needs more time to buffer data.
 * - InsufficientAudioDataError (attempt 5): Accept partial data (minBytes: 0).
 *   Either the song is very short, or we've waited long enough.
 * - Network/timeout errors: Always propagate to trigger workflow retry.
 *
 * The fingerprint's byteLength field tracks how many audio bytes (after ID3 header)
 * were actually hashed. This ensures fair comparison when matching complete songs
 * against streaming fingerprints - we hash the same number of bytes from each.
 *
 * @returns Songs array, potentially reordered if swap was detected
 */
async function detectAndCorrectSwaps(
	stub: DurableObjectStub<SmolDurableObject>,
	songs: AiSongGeneratorSong[]
): Promise<AiSongGeneratorSong[]> {
	// Load persisted state from DO
	const currentSteps = await stub.getSteps() as WorkflowSteps;
	let originalFingerprints: Record<string, AudioFingerprint> = currentSteps.original_fingerprints || {};
	let lastKnownUrls: Record<string, string> = currentSteps.last_known_urls || {};
	let fingerprintAttempts: Record<string, number> = currentSteps.fingerprint_attempts || {};

	let stateChanged = false;
	let urlsChanged = false;

	// Process each song with audio
	for (const song of songs) {
		if (!song.audio) continue;

		const lastUrl = lastKnownUrls[song.music_id];
		const isNewUrl = !lastUrl || lastUrl !== song.audio;

		if (isNewUrl) {
			urlsChanged = true;
			console.log(`Audio URL ${lastUrl ? 'changed' : 'appeared'} for song ${song.music_id}`);

			// Capture fingerprint for this new URL.
			// Track attempts so we can accept partial data on the final try.
			try {
				const attempts = fingerprintAttempts[song.music_id] || 0;
				const isLastAttempt = attempts >= MAX_FINGERPRINT_ATTEMPTS - 1;

				// On last attempt (5th try), accept whatever data we can get.
				// This handles short songs that may never reach 32KB threshold.
				// Earlier attempts use default minBytes to ensure reliable fingerprints.
				const fp = await extractFingerprint(song.audio, undefined, isLastAttempt ? 0 : undefined);
				if (fp) {
					// Only store as "original" if this is the FIRST audio we've seen for this song.
					// This is the fingerprint we'll compare against to detect swaps.
					if (!originalFingerprints[song.music_id]) {
						originalFingerprints[song.music_id] = fp;
						console.log(`Captured original fingerprint for song ${song.music_id} (${fp.byteLength} bytes)`);
						stateChanged = true;
					}
					// Success - clear attempt counter so future URL changes start fresh
					if (fingerprintAttempts[song.music_id]) {
						delete fingerprintAttempts[song.music_id];
						stateChanged = true;
					}
				}
			} catch (err) {
				if (err instanceof InsufficientAudioDataError) {
					// Song hasn't buffered enough data yet - increment attempt counter.
					// This is persisted in DO so it survives workflow step retries.
					// After MAX_FINGERPRINT_ATTEMPTS, we'll accept partial data above.
					const attempts = (fingerprintAttempts[song.music_id] || 0) + 1;
					fingerprintAttempts[song.music_id] = attempts;
					await stub.saveStep('fingerprint_attempts', fingerprintAttempts);

					console.log(`Fingerprint attempt ${attempts}/${MAX_FINGERPRINT_ATTEMPTS} for ${song.music_id}: ${err.message}`);
					throw err; // Triggers workflow step retry with exponential backoff
				} else {
					// Network errors, timeouts (15s), etc - always propagate.
					// These indicate infrastructure issues, not "song still streaming".
					throw err;
				}
			}

			lastKnownUrls[song.music_id] = song.audio;
			stateChanged = true;
		}
	}

	// Check for swap if URLs changed and we have original fingerprints for both songs
	if (urlsChanged && Object.keys(originalFingerprints).length === 2) {
		const matched = await matchSongsByFingerprint(originalFingerprints, songs);
		if (matched.swapped) {
			console.log('Reordering songs based on fingerprint matching');
			songs = matched.songs;

			// Update lastKnownUrls to reflect the reordered state
			lastKnownUrls = {};
			for (const song of songs) {
				if (song.audio) {
					lastKnownUrls[song.music_id] = song.audio;
				}
			}
			stateChanged = true;
		}
	}

	// Persist state if anything changed
	if (stateChanged) {
		await stub.saveStep('original_fingerprints', originalFingerprints);
		await stub.saveStep('last_known_urls', lastKnownUrls);
		await stub.saveStep('fingerprint_attempts', fingerprintAttempts);
	}

	return songs;
}

/**
 * Polls for songs until they reach the desired state.
 *
 * This is the main entry point for the polling phase. It handles:
 * 1. Initial wait for streaming to start (30s)
 * 2. Polling until all songs have audio URLs
 * 3. If not already complete, waiting for completion (90s)
 * 4. Polling until all songs have status >= 4
 *
 * Swap detection happens on EVERY poll, so the client always sees
 * the correct audio in the correct slot.
 *
 * @returns Final songs array with correct order
 */
export async function pollUntilComplete(params: {
	env: Env;
	stub: DurableObjectStub<SmolDurableObject>;
	step: WorkflowStep;
	config: WorkflowStepConfig;
	song_ids: number[] | string[];
	source: 'aisonggenerator' | 'diffrhythm';
}): Promise<AiSongGeneratorSong[]> {
	const { env, stub, step, config, song_ids, source } = params;

	const pollSongs = createPollSongsFunction({ env, stub, song_ids, source });

	await step.sleep('wait for songs to start streaming', '45 seconds');

	// Poll until ALL songs have streaming audio - 5 retries
	// (snapshots are saved as soon as ANY audio appears, with swap detection)
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
		console.log('Songs already complete during streaming poll, skipping wait');
		return streamingSongs;
	}

	await step.sleep('wait for songs to complete', '60 seconds');

	// Poll until songs are complete - 6 retries (~10 min with exponential backoff)
	// Swap detection happens on every poll via pollSongs
	const completeSongs = await step.do(
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

	return completeSongs;
}
