// Augment the Cloudflare.Env interface with secrets not in wrangler.jsonc
// This ensures the global `env` from cloudflare:workers has the right types
// These secrets are managed via `wrangler secret put` or `.dev.vars`
declare namespace Cloudflare {
	interface Env {
		SECRET: string
		SK: string
		PIXELLAB_KEY: string
		CF_API_TOKEN: string
		CF_ZONE_ID: string
		SEARCH_BACKFILL_CRON_ENABLED: string
		SEARCH_BACKFILL_CRON_PAGE_LIMIT: string
		SEARCH_BACKFILL_CRON_STALL_RUNS: string
		SEARCH_BACKFILL_CRON_MAX_WAVES: string
		SMOL_SEARCH_INDEX: Vectorize
		SEARCH_QUEUE: Queue<SearchQueueMessage>
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

type SearchStatus = 'queued' | 'processing' | 'ready' | 'hidden' | 'failed'

interface SearchStoredMetadata {
	style_primary: string
	mood_primary: string
	theme_primary: string
	lyric_presence: 'instrumental' | 'sparse' | 'lyric-heavy'
	brightness_level: 'dark' | 'neutral' | 'bright'
	energy_level: 'low' | 'mid' | 'high'
	modality_guess: 'minor' | 'major' | 'mixed' | 'unknown'
	style_tags: string[]
	title: string
}

interface SearchState {
	status: SearchStatus
	version: string
	queued_at?: string
	indexed_at?: string
	source_hash?: string
	vector_ids?: string[]
	metadata?: SearchStoredMetadata
	last_error?: string
	mutation_id?: string
	mutation_requested_at?: string
}

type SearchQueueMessage =
	| {
		type: 'upsert'
		smolId: string
	}
	| {
		type: 'upsert_batch'
		smolIds: string[]
	}
	| {
		type: 'finalize'
		smolId: string
		vectorIds: string[]
	}
	| {
		type: 'delete'
		smolId: string
		vectorIds?: string[]
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
	search?: SearchState
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
