import { parseBuffer, type IAudioMetadata } from 'music-metadata';
import { fetchHttpsFollowingSafeRedirects } from './safe-fetch';

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
const FINGERPRINT_READ_CAP = FINGERPRINT_MIN_BYTES + 1;

/**
 * Custom error for insufficient audio data.
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
 * Fetch up to FINGERPRINT_READ_CAP bytes from audioUrl, safely capping reads even if
 * the upstream ignores Range and responds with 200 OK for a multi-megabyte MP3.
 * Only https URLs without credentials are fetched (redirect targets included).
 */
async function fetchCappedAudioPrefix(audioUrl: string): Promise<Uint8Array> {
	// https-only, credential-free, manually followed + re-validated redirects (throws UnsafeFetchUrlError
	// before ANY request to an unsafe URL or redirect target).
	const response = await fetchHttpsFollowingSafeRedirects(audioUrl, {
		headers: { 'Range': `bytes=0-${FINGERPRINT_MIN_BYTES}` },
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`Failed to fetch audio: ${response.status} ${response.statusText}`);
	}

	if (!response.body) {
		const buffer = await response.arrayBuffer();
		return new Uint8Array(buffer.slice(0, FINGERPRINT_READ_CAP));
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		while (total < FINGERPRINT_READ_CAP) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value || value.byteLength === 0) {
				continue;
			}
			const remaining = FINGERPRINT_READ_CAP - total;
			if (value.byteLength > remaining) {
				chunks.push(value.subarray(0, remaining));
				total += remaining;
				await reader.cancel('Fingerprint prefix cap reached').catch(() => {});
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}

	const data = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return data;
}

async function fingerprintFromBytes(
	data: Uint8Array,
	audioUrl: string,
	maxAudioBytes?: number,
	minBytes: number = FINGERPRINT_MIN_BYTES,
	fallbackDuration?: number
): Promise<AudioFingerprint | null> {
	if (data.length < minBytes) {
		throw new InsufficientAudioDataError(data.length, minBytes);
	}

	if (data.length === 0) {
		return null;
	}

	let metadata: IAudioMetadata | null = null;
	try {
		metadata = await parseBuffer(data, { mimeType: 'audio/mpeg' }, { duration: true });
	} catch (parseErr) {
		console.warn('music-metadata parse failed, using manual hash only:', parseErr);
	}

	// Manual hash: skip ID3v2 header, hash audio frames
	let offset = 0;
	if (data.length >= 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
		const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) |
			((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
		offset = Math.min(10 + size, data.length);
	}

	const bytesToHash = maxAudioBytes ?? 16384;
	const audioData = data.slice(offset, Math.min(offset + bytesToHash, data.length));
	const hash = await hashData(audioData);

	return {
		hash,
		byteLength: audioData.length,
		audioUrl,
		duration: metadata?.format.duration ?? fallbackDuration,
		bitrate: metadata?.format.bitrate,
		sampleRate: metadata?.format.sampleRate,
	};
}

/**
 * Extract fingerprint and metadata from audio URL.
 */
export async function extractFingerprint(
	audioUrl: string,
	maxAudioBytes?: number,
	minBytes: number = FINGERPRINT_MIN_BYTES,
	fallbackDuration?: number
): Promise<AudioFingerprint | null> {
	const data = await fetchCappedAudioPrefix(audioUrl);
	return fingerprintFromBytes(data, audioUrl, maxAudioBytes, minBytes, fallbackDuration);
}

async function hashData(data: Uint8Array): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hashBuffer))
		.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Match finalized songs to streaming fingerprints and reorder if needed.
 * Caches each candidate audio prefix fetch once per invocation (max 2 fetches for 2 songs).
 */
export async function matchSongsByFingerprint(
	streamingFingerprints: Record<string, AudioFingerprint>,
	completeSongs: AiSongGeneratorSong[]
): Promise<{ songs: AiSongGeneratorSong[], swapped: boolean }> {
	const originalMusicIds = Object.keys(streamingFingerprints);
	const result: AiSongGeneratorSong[] = [];
	const matched = new Set<string>();
	let swapped = false;

	// Fetch each complete song's capped prefix at most once across hash + duration matching
	const bytesCache = new Map<string, Uint8Array | null>();
	async function getSongBytes(song: AiSongGeneratorSong): Promise<Uint8Array | null> {
		if (!song.audio) return null;
		if (bytesCache.has(song.audio)) {
			return bytesCache.get(song.audio)!;
		}
		try {
			const bytes = await fetchCappedAudioPrefix(song.audio);
			bytesCache.set(song.audio, bytes);
			return bytes;
		} catch (err) {
			console.warn(`Failed to fetch fingerprint bytes for song ${song.music_id}:`, err);
			bytesCache.set(song.audio, null);
			return null;
		}
	}

	// Primary matching: by hash (using streaming fingerprint's exact byte length)
	for (const musicId of originalMusicIds) {
		const streamingFp = streamingFingerprints[musicId];

		for (const song of completeSongs) {
			if (matched.has(song.music_id) || !song.audio) continue;

			const bytes = await getSongBytes(song);
			if (!bytes) continue;

			let completeFp: AudioFingerprint | null = null;
			try {
				completeFp = await fingerprintFromBytes(bytes, song.audio, streamingFp.byteLength, 0, song.duration);
			} catch (err) {
				console.warn(`Failed to fingerprint complete song ${song.music_id} for hash matching:`, err);
				continue;
			}
			if (!completeFp) continue;

			if (completeFp.hash === streamingFp.hash) {
				matched.add(song.music_id);
				if (song.music_id !== musicId) {
					swapped = true;
					console.warn(`Song swap detected (hash match): streaming ${musicId} -> complete ${song.music_id}`);
				}
				result.push({ ...song, music_id: musicId });
				break;
			}
		}
	}

	// Secondary matching: by duration proximity (for 2 unmatched songs)
	const unmatchedIds = originalMusicIds.filter(id => !result.find(r => r.music_id === id));
	const unmatchedComplete = completeSongs.filter(s => !matched.has(s.music_id));

	if (unmatchedIds.length === 2 && unmatchedComplete.length === 2) {
		let d0 = unmatchedComplete[0].duration;
		let d1 = unmatchedComplete[1].duration;

		if (d0 === undefined || d1 === undefined) {
			const [b0, b1] = await Promise.all([
				getSongBytes(unmatchedComplete[0]),
				getSongBytes(unmatchedComplete[1]),
			]);
			try {
				const fp0 = b0 ? await fingerprintFromBytes(b0, unmatchedComplete[0].audio, undefined, 0, d0) : null;
				const fp1 = b1 ? await fingerprintFromBytes(b1, unmatchedComplete[1].audio, undefined, 0, d1) : null;
				d0 = fp0?.duration ?? d0;
				d1 = fp1?.duration ?? d1;
			} catch (err) {
				console.warn('Failed to parse duration for swap matching, keeping original order:', err);
			}
		}

		if (d0 !== undefined && d1 !== undefined) {
			const streamingDurations = unmatchedIds.map(id => streamingFingerprints[id].duration ?? 0);
			const completeDurations = [d0, d1];

			const originalDiff = Math.abs(streamingDurations[0] - completeDurations[0]) +
				Math.abs(streamingDurations[1] - completeDurations[1]);
			const swappedDiff = Math.abs(streamingDurations[0] - completeDurations[1]) +
				Math.abs(streamingDurations[1] - completeDurations[0]);

			if (swappedDiff < originalDiff) {
				swapped = true;
				result.push({ ...unmatchedComplete[1], music_id: unmatchedIds[0] });
				result.push({ ...unmatchedComplete[0], music_id: unmatchedIds[1] });
			} else {
				result.push({ ...unmatchedComplete[0], music_id: unmatchedIds[0] });
				result.push({ ...unmatchedComplete[1], music_id: unmatchedIds[1] });
			}
		} else {
			result.push({ ...unmatchedComplete[0], music_id: unmatchedIds[0] });
			result.push({ ...unmatchedComplete[1], music_id: unmatchedIds[1] });
		}
	} else if (unmatchedIds.length > 0) {
		for (const musicId of unmatchedIds) {
			const original = completeSongs.find(s => s.music_id === musicId);
			if (original) {
				result.push(original);
			}
		}
	}

	return {
		songs: result.length === completeSongs.length ? result : completeSongs,
		swapped,
	};
}
