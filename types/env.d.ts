// Augment the Cloudflare.Env interface with secrets and runtime bindings not in wrangler.jsonc
// This ensures the global `env` from cloudflare:workers has the right types
// These secrets are managed via `wrangler secret put` or `.dev.vars`
interface KaleWorkerBinding extends Fetcher {
	submitTransaction(input: { xdr: string }): Promise<{
		hash?: string
		error?: string
		errorCode?: string
	}>
}

declare namespace Cloudflare {
	interface Env {
		SECRET: string
		SK: string
		PIXELLAB_KEY: string
		CF_API_TOKEN: string
		CF_ZONE_ID: string
		CF_AI_GATEWAY_ID?: string
		CF_AIG_TOKEN?: string
		CF_AIG_BYOK_ALIAS?: string
		ELEVENLABS_MUSIC_LENGTH_MS?: string
		ELEVENLABS_OUTPUT_FORMAT?: string
		ELEVENLABS_FALLBACK_ENABLED?: string
		DAILY_LIMIT_CLASSIC?: string
		DAILY_LIMIT_ELEVENLABS?: string
		BURST_LIMIT_PER_MINUTE?: string
		GLOBAL_DAILY_LIMIT_CLASSIC?: string
		GLOBAL_DAILY_LIMIT_ELEVENLABS?: string
		PLAY_COUNT_MODE?: string
		PLAY_BEACON_COOLDOWN_SECONDS?: string
		PLAY_BEACON_RATE_LIMIT_PER_MINUTE?: string
		USER_QUOTA: DurableObjectNamespace<import('../src/quota-do').UserQuotaDO>
		SEARCH_BACKFILL_CRON_ENABLED: string
		SEARCH_BACKFILL_CRON_PAGE_LIMIT: string
		SEARCH_BACKFILL_CRON_STALL_RUNS: string
		SEARCH_BACKFILL_CRON_MAX_WAVES: string
		SMOL_SEARCH_INDEX: Vectorize
		SEARCH_QUEUE: Queue<SearchQueueMessage>
	}
}

type MusicProvider = 'aisonggenerator' | 'elevenlabs'

interface AiSongGeneratorLyrics {
	title: string
	style: string[]
	lyrics: string
}

interface AiSongGeneratorSong {
	music_id: string
	status: number
	audio: string
	service?: string
	provider?: string
	duration?: number
	error_message?: string
}

interface NormalizedNsfwResult {
	safe: boolean
	categories: string[]
	unknown?: boolean
}

interface GenerationMeta {
	requested_provider: MusicProvider
	actual_provider: MusicProvider | null
	fallback_from?: MusicProvider
	fallback_reason?: string
}

interface ProviderAttemptState {
	provider: MusicProvider
	status: 'claimed' | 'submitted' | 'committed' | 'failed' | 'ambiguous'
	attempt_id?: string
	source_smol_id?: string
	task_id?: string
	workspace_id?: string
	song_ids?: string[]
	r2_keys?: string[]
	upstream_song_id?: string
	gateway_log_id?: string
	error_code?: string
	error_message?: string
	updated_at: string
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
		mutationId?: string
		sourceHash?: string
	}
	| {
		type: 'delete'
		smolId: string
		vectorIds?: string[]
	}

interface RetryReservation {
	successorId: string
	predecessorId: string
}

interface RetrySuccessorInspection {
	state: 'empty' | 'seeded_unstarted' | 'executed'
	retrySourceId?: string
	ownerAddress?: string
	provider?: MusicProvider
	overrideProvider?: MusicProvider
	quotaNeedsReservation?: boolean
	quotaProvider?: MusicProvider
	quotaReservationId?: string
	quotaDayKey?: string
	existingAttempt?: ProviderAttemptState
}

interface WorkflowSteps {
	payload: WorkflowParams
	image_base64: string | undefined
	image?: boolean
	description: string | undefined
	lyrics: AiSongGeneratorLyrics | undefined
	nsfw: NormalizedNsfwResult | string | {
		safe?: boolean
		categories?: string[]
	} | undefined
	song_ids: number[] | string[] | undefined
	songs: AiSongGeneratorSong[] | undefined
	requested_provider?: MusicProvider
	active_provider?: MusicProvider
	actual_provider?: MusicProvider | null
	fallback_from?: MusicProvider
	fallback_reason?: string
	generation_meta?: GenerationMeta
	provider_attempt?: ProviderAttemptState
	retry_successor_id?: string
	retry_reservation?: RetryReservation
	retry_chain_root_id?: string
	retry_source_id?: string
	retry_seed_pending?: boolean
	workflow_executed?: boolean
	quota_reservation_id?: string
	quota_day_key?: string
	quota_needs_reservation?: boolean
	quota_provider?: MusicProvider
	quota_reuse_only?: boolean
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
	provider?: MusicProvider
	override_provider?: MusicProvider
	quota_reservation_id?: string
	quota_day_key?: string
	quota_provider?: MusicProvider
	quota_reuse_only?: boolean
	workflow_version?: number
}

type WorkflowTxParams = {
	type: 'mint' | 'batch-mint'
	entropy?: string  // Required for 'mint', not used for 'batch-mint'
	xdr: string
	ids?: string[]    // Required for 'batch-mint', not used for 'mint'
	mintableIds?: string[]
	sub: string       // JWT sub of the user who initiated the mint
	ownerSub?: string
	ownerSubsById?: Record<string, string>
}
