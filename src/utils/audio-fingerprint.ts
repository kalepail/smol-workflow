import { parseBuffer, type IAudioMetadata } from 'music-metadata';

export interface AudioFingerprint {
	hash: string;
	byteLength: number;
	audioUrl: string;
	duration?: number;
	bitrate?: number;
	sampleRate?: number;
}

// Minimum bytes needed for reliable fingerprint comparison.
// 32KB balances reliability vs. fetch time for streaming audio.
// Smaller values risk false matches; larger values may timeout waiting for data.
export const FINGERPRINT_MIN_BYTES = 32768; // 32KB

/**
 * Custom error for insufficient audio data.
 *
 * Thrown when a streaming song hasn't buffered enough data yet.
 * Callers should catch this separately from network errors:
 * - InsufficientAudioDataError: Song still streaming, retry later
 * - Other errors (network, timeout): Propagate to trigger workflow retry
 *
 * After multiple attempts, callers can pass minBytes: 0 to extractFingerprint
 * to accept whatever data is available (for very short songs).
 */
export class InsufficientAudioDataError extends Error {
	bytesReceived: number;
	bytesRequired: number;

	constructor(bytesReceived: number, bytesRequired: number = FINGERPRINT_MIN_BYTES) {
		super(`Insufficient audio data: got ${bytesReceived} bytes, need ${bytesRequired}`);
		this.name = 'InsufficientAudioDataError';
		this.bytesReceived = bytesReceived;
		this.bytesRequired = bytesRequired;
	}
}

/**
 * Extract fingerprint and metadata from audio URL.
 * Uses music-metadata for parsing, with manual hash for primary matching.
 * @param audioUrl - URL to fetch audio from
 * @param maxAudioBytes - Optional limit for audio bytes to hash (for comparing against partial streaming data)
 * @param minBytes - Minimum bytes required (default: FINGERPRINT_MIN_BYTES). Set to 0 to accept any amount.
 *
 * @throws {InsufficientAudioDataError} When not enough audio data is available (song still streaming)
 * @throws {Error} On network errors or timeouts (should trigger workflow retry)
 */
export async function extractFingerprint(
	audioUrl: string,
	maxAudioBytes?: number,
	minBytes: number = FINGERPRINT_MIN_BYTES
): Promise<AudioFingerprint | null> {
	// Fetch audio data (up to 32KB for fingerprinting)
	// Use 15s timeout to avoid hanging on streaming audio that hasn't buffered enough data
	const response = await fetch(audioUrl, {
		headers: { 'Range': `bytes=0-${FINGERPRINT_MIN_BYTES}` },
		signal: AbortSignal.timeout(15000),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch audio: ${response.status} ${response.statusText}`);
	}

	const buffer = await response.arrayBuffer();
	const data = new Uint8Array(buffer);

	// If we got less than minimum required, audio likely still streaming
	if (data.length < minBytes) {
		throw new InsufficientAudioDataError(data.length, minBytes);
	}

	// Need at least some data to fingerprint
	if (data.length === 0) {
		return null;
	}

	// Try to parse metadata using music-metadata
	let metadata: IAudioMetadata | null = null;
	try {
		metadata = await parseBuffer(data, { mimeType: 'audio/mpeg' }, { duration: true });
	} catch (parseErr) {
		console.warn('music-metadata parse failed, using manual hash only:', parseErr);
	}

	// Manual hash: skip ID3v2 header, hash audio frames
	let offset = 0;
	if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
		const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) |
			((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
		offset = 10 + size;
	}

	// Use maxAudioBytes if provided (for comparing against streaming fingerprint),
	// otherwise use default of 16KB - enough for unique identification
	const bytesToHash = maxAudioBytes ?? 16384;
	const audioData = data.slice(offset, Math.min(offset + bytesToHash, data.length));
	const hash = await hashData(audioData);

	return {
		hash,
		byteLength: audioData.length,
		audioUrl,
		duration: metadata?.format.duration,
		bitrate: metadata?.format.bitrate,
		sampleRate: metadata?.format.sampleRate,
	};
}

async function hashData(data: Uint8Array): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hashBuffer))
		.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Match finalized songs to streaming fingerprints and reorder if needed.
 * Uses two-tier matching: hash first, then duration/metadata fallback.
 *
 * Note: This is called for complete songs, so errors are handled gracefully
 * with fallback to duration matching or keeping original order.
 */
export async function matchSongsByFingerprint(
	streamingFingerprints: Record<string, AudioFingerprint>,
	completeSongs: AiSongGeneratorSong[]
): Promise<{ songs: AiSongGeneratorSong[], swapped: boolean }> {
	const originalMusicIds = Object.keys(streamingFingerprints);
	const result: AiSongGeneratorSong[] = [];
	const matched = new Set<string>();
	let swapped = false;

	// Primary matching: by hash
	// For each streaming fingerprint, hash complete songs with the SAME byte length for fair comparison
	for (const musicId of originalMusicIds) {
		const streamingFp = streamingFingerprints[musicId];

		// Find matching complete song by hashing with same byte length
		for (const song of completeSongs) {
			if (matched.has(song.music_id) || !song.audio) continue;

			// Hash complete song with streaming fingerprint's byte length
			// Use minBytes: 0 since we're comparing against a known fingerprint size
			// Errors caught here - if fingerprinting fails, skip to next song
			let completeFp: AudioFingerprint | null = null;
			try {
				completeFp = await extractFingerprint(song.audio, streamingFp.byteLength, 0);
			} catch (err) {
				console.warn(`Failed to fingerprint complete song ${song.music_id} for hash matching:`, err);
				continue;
			}
			if (!completeFp) continue;

			if (completeFp.hash === streamingFp.hash) {
				matched.add(song.music_id);
				if (song.music_id !== musicId) {
					swapped = true;
					console.warn(`Song swap detected (hash match): streaming ${musicId} → complete ${song.music_id}`);
				}
				result.push({ ...song, music_id: musicId });
				break;
			}
		}
	}

	// Secondary matching: by duration proximity (for unmatched songs)
	// With 2 songs, compare original vs swapped order - if swapped is closer, swap
	const unmatchedIds = originalMusicIds.filter(id => !result.find(r => r.music_id === id));
	const unmatchedComplete = completeSongs.filter(s => !matched.has(s.music_id));

	if (unmatchedIds.length === 2 && unmatchedComplete.length === 2) {
		// Get fingerprints for duration comparison - errors handled gracefully
		let fp1: AudioFingerprint | null = null;
		let fp2: AudioFingerprint | null = null;
		try {
			[fp1, fp2] = await Promise.all([
				extractFingerprint(unmatchedComplete[0].audio!),
				extractFingerprint(unmatchedComplete[1].audio!)
			]);
		} catch (err) {
			console.warn('Failed to fingerprint for duration matching, keeping original order:', err);
			// Fall through to fallback below
		}

		// Only do duration matching if we got valid fingerprints
		if (fp1 && fp2) {
			const streamingDurations = unmatchedIds.map(id => streamingFingerprints[id].duration ?? 0);
			const completeDurations = [fp1.duration ?? 0, fp2.duration ?? 0];

			// Compare original order vs swapped order
			const originalDiff = Math.abs(streamingDurations[0] - completeDurations[0]) +
				Math.abs(streamingDurations[1] - completeDurations[1]);
			const swappedDiff = Math.abs(streamingDurations[0] - completeDurations[1]) +
				Math.abs(streamingDurations[1] - completeDurations[0]);

			console.log(`Duration matching: original diff=${originalDiff.toFixed(1)}s, swapped diff=${swappedDiff.toFixed(1)}s`);

			if (swappedDiff < originalDiff) {
				// Swapped order is closer - swap the songs
				swapped = true;
				console.warn(`Song swap detected (duration): swapped order is ${(originalDiff - swappedDiff).toFixed(1)}s closer`);
				result.push({ ...unmatchedComplete[1], music_id: unmatchedIds[0] });
				result.push({ ...unmatchedComplete[0], music_id: unmatchedIds[1] });
			} else {
				// Keep original order
				result.push({ ...unmatchedComplete[0], music_id: unmatchedIds[0] });
				result.push({ ...unmatchedComplete[1], music_id: unmatchedIds[1] });
			}
		} else {
			// Fingerprinting failed - keep original order
			console.warn('Duration matching skipped (fingerprinting failed), keeping original order');
			result.push({ ...unmatchedComplete[0], music_id: unmatchedIds[0] });
			result.push({ ...unmatchedComplete[1], music_id: unmatchedIds[1] });
		}
	} else if (unmatchedIds.length > 0) {
		// Fallback for edge cases: just keep original order
		for (const musicId of unmatchedIds) {
			const original = completeSongs.find(s => s.music_id === musicId);
			if (original) {
				console.warn(`No fingerprint match for ${musicId}, keeping original`);
				result.push(original);
			}
		}
	}

	return {
		songs: result.length === completeSongs.length ? result : completeSongs,
		swapped
	};
}
