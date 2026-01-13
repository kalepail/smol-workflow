// Augment the Cloudflare.Env interface with secrets not in wrangler.jsonc
// This ensures the global `env` from cloudflare:workers has the right types
// These secrets are managed via `wrangler secret put` or `.dev.vars`
declare namespace Cloudflare {
	interface Env {
		SECRET: string
		LAUNCHTUBE_TOKEN: string
		SK: string
		CF_API_TOKEN: string
		CF_ZONE_ID: string
	}
}

interface AiSongGeneratorLyrics {
    title: string
    style: string[]
    lyrics: string
}

interface AiSongGeneratorSong {
    music_id: string
    status: number
    audio: string
}

interface WorkflowSteps {
	payload: WorkflowParams
	image_base64: string | undefined
	description: string | undefined
	lyrics: AiSongGeneratorLyrics | undefined
	nsfw: string | {
		safe?: boolean
		categories?: string[]
	} | undefined
	song_ids: number[] | string[] | undefined
	songs: AiSongGeneratorSong[] | undefined
	streaming_fingerprints?: Record<string, {
		hash: string
		byteLength: number
		audioUrl: string
		duration?: number
		bitrate?: number
		sampleRate?: number
	}>
	// Fingerprints captured when we first see audio for each song (keyed by music_id)
	original_fingerprints?: Record<string, {
		hash: string
		byteLength: number
		audioUrl: string
		duration?: number
		bitrate?: number
		sampleRate?: number
	}>
	// Last known audio URLs for each song (keyed by music_id) - used to detect URL changes
	last_known_urls?: Record<string, string>
	// Track fingerprint attempts per song (keyed by music_id).
	// Incremented when a song doesn't have enough buffered data for fingerprinting.
	// After 5 attempts, we accept partial data to handle short songs.
	fingerprint_attempts?: Record<string, number>
}

type WorkflowParams = {
	address?: string
	prompt?: string
	retry_id?: string
	public?: boolean
	instrumental?: boolean
	playlist?: string
}

type WorkflowTxParams = {
	type: 'mint' | 'batch-mint'
	entropy?: string  // Required for 'mint', not used for 'batch-mint'
	xdr: string
	ids?: string[]    // Required for 'batch-mint', not used for 'mint'
	sub: string       // JWT sub of the user who initiated the mint
}