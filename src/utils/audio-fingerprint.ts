import { parseBuffer, type IAudioMetadata } from 'music-metadata';

export interface AudioFingerprint {
	hash: string;
	byteLength: number;
	audioUrl: string;
	duration?: number;
	bitrate?: number;
	sampleRate?: number;
}

/**
 * Extract fingerprint and metadata from audio URL.
 * Uses music-metadata for parsing, with manual hash for primary matching.
 * @param audioUrl - URL to fetch audio from
 * @param maxAudioBytes - Optional limit for audio bytes to hash (for comparing against partial streaming data)
 */
export async function extractFingerprint(audioUrl: string, maxAudioBytes?: number): Promise<AudioFingerprint | null> {
	try {
		// Fetch audio data (up to 100KB for fingerprinting)
		const response = await fetch(audioUrl, {
			headers: { 'Range': 'bytes=0-102400' }
		});
		if (!response.ok) return null;

		const buffer = await response.arrayBuffer();
		const data = new Uint8Array(buffer);

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
		// otherwise use default of 51200 bytes
		const bytesToHash = maxAudioBytes ?? 51200;
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
	} catch (err) {
		console.error('Failed to extract fingerprint:', err);
		return null;
	}
}

async function hashData(data: Uint8Array): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hashBuffer))
		.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Match finalized songs to streaming fingerprints and reorder if needed.
 * Uses two-tier matching: hash first, then duration/metadata fallback.
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
			const completeFp = await extractFingerprint(song.audio, streamingFp.byteLength);
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
		// Get fingerprints for duration comparison
		const [fp1, fp2] = await Promise.all([
			extractFingerprint(unmatchedComplete[0].audio!),
			extractFingerprint(unmatchedComplete[1].audio!)
		]);

		const streamingDurations = unmatchedIds.map(id => streamingFingerprints[id].duration ?? 0);
		const completeDurations = [fp1?.duration ?? 0, fp2?.duration ?? 0];

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
