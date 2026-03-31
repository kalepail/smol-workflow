import { createHash } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'

export const SEARCH_INDEX_VERSION = 'v2'

const EMBEDDING_MODEL = '@cf/baai/bge-m3'
const TAG_EXTRACTION_MODEL = '@cf/meta/llama-3.2-3b-instruct'
const SEARCH_TOP_K = 100
const SEARCH_RRF_K = 60
const SEARCH_MAX_LIMIT = 20
const SEARCH_HYDRATION_BATCH = 40
const SEARCH_FINALIZE_DELAY_SECONDS = 8
const SEARCH_FINALIZE_MAX_ATTEMPTS = 8
const SEARCH_BACKFILL_UPSERT_BATCH_SIZE = 12
const MAX_LYRICS_CHARS = 5000
const MAX_TAG_EXTRACTION_LYRICS_CHARS = 3000

const SEARCH_MODALITIES = ['style', 'title', 'lyrics', 'description'] as const

const MODALITY_WEIGHTS = {
	style: 1,
	title: 0.7,
	lyrics: 0.5,
	description: 0.3,
} as const

const MODALITY_CODES: Record<SearchModality, string> = {
	style: 's',
	title: 't',
	lyrics: 'l',
	description: 'd',
}

const SEARCH_METADATA_JSON_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: [
		'style_primary',
		'mood_primary',
		'theme_primary',
		'lyric_presence',
		'brightness_level',
		'energy_level',
		'modality_guess',
	],
	properties: {
		style_primary: { type: 'string', maxLength: 80 },
		mood_primary: { type: 'string', maxLength: 80 },
		theme_primary: { type: 'string', maxLength: 80 },
		lyric_presence: { type: 'string', enum: ['instrumental', 'sparse', 'lyric-heavy'] },
		brightness_level: { type: 'string', enum: ['dark', 'neutral', 'bright'] },
		energy_level: { type: 'string', enum: ['low', 'mid', 'high'] },
		modality_guess: { type: 'string', enum: ['minor', 'major', 'mixed', 'unknown'] },
	},
} as const

export type SearchModality = typeof SEARCH_MODALITIES[number]

type StoredSmolRecord = WorkflowSteps

export type SmolIndexSource = {
	id: string
	title: string
	public: boolean
	instrumental: boolean
	prompt?: string
	description?: string
	lyrics?: AiSongGeneratorLyrics
}

export type ParsedSearchHints = {
	instrumental?: boolean
	lyricPresence?: SearchStoredMetadata['lyric_presence'][]
	brightness?: SearchStoredMetadata['brightness_level']
	energy?: SearchStoredMetadata['energy_level']
	modality?: SearchStoredMetadata['modality_guess']
	excludeModality?: SearchStoredMetadata['modality_guess']
}

type SearchTextFields = Record<SearchModality, string>

export type RankedCandidate = {
	smolId: string
	score: number
	modalityScores: Partial<Record<SearchModality, number>>
}

type SearchQueueDisposition =
	| { action: 'ack' }
	| { action: 'retry'; delaySeconds: number }

type SearchMutationProgress = {
	isProcessed: boolean
	mutationId?: string
	processedMutation?: string
	requestedAt?: number
	processedAt?: number
	vectorCount?: number
	dimensions?: number
}

type PreparedSearchUpsert = {
	source: SmolIndexSource
	sourceHash: string
	metadata: SearchStoredMetadata
	texts: SearchTextFields
	vectorIds: string[]
}

type BatchQueueSkipReason = 'current' | 'pending' | 'missing'

export type BatchQueueResult = {
	queuedIds: string[]
	skipped: Record<BatchQueueSkipReason, number>
}

export type SearchMetadataExtraction = Pick<
	SearchStoredMetadata,
	| 'style_primary'
	| 'mood_primary'
	| 'theme_primary'
	| 'lyric_presence'
	| 'brightness_level'
	| 'energy_level'
	| 'modality_guess'
>

type AiJsonGenerationOutput = {
	response?: string | Record<string, unknown>
}

type SmolSearchRow = {
	Id: string
	Title: string
	Song_1: string
	Mint_Token: string | null
	Mint_Amm: string | null
	Created_At: string
	Public: number
}

export type SearchResultItem = {
	Id: string
	Title: string
	Song_1: string
	Mint_Token: string | null
	Mint_Amm: string | null
	Created_At: string
	score: number
	explanation: {
		matchedFields: SearchModality[]
		style?: string[]
		mood?: string
		theme?: string
	}
}

export type SearchResponse = {
	results: SearchResultItem[]
}

const ACK_QUEUE_MESSAGE: SearchQueueDisposition = { action: 'ack' }

function logSearchEvent(event: string, details: Record<string, unknown>): void {
	console.log({
		event,
		search_version: SEARCH_INDEX_VERSION,
		...details,
	})
}

function nowIso(): string {
	return new Date().toISOString()
}

export function normalizeText(input: string | undefined | null): string {
	return (input ?? '')
		.replace(/\s+/g, ' ')
		.trim()
}

export function truncateText(input: string, maxChars: number): string {
	if (input.length <= maxChars) {
		return input
	}

	return `${input.slice(0, maxChars).trim()}…`
}

export function uniqueStrings(values: Array<string | undefined | null>): string[] {
	return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))]
}

function chunkArray<T>(values: T[], size: number): T[][] {
	if (size < 1) {
		throw new Error('chunkArray size must be positive')
	}

	const chunks: T[][] = []
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size))
	}
	return chunks
}

function buildSearchSourceHash(source: SmolIndexSource): string {
	return createHash('sha256')
		.update(JSON.stringify({
			id: source.id,
			title: normalizeText(source.title),
			public: source.public,
			instrumental: source.instrumental,
			prompt: normalizeText(source.prompt),
			description: normalizeText(source.description),
			lyrics_title: normalizeText(source.lyrics?.title),
			lyrics: normalizeText(source.lyrics?.lyrics),
			style: uniqueStrings(source.lyrics?.style ?? []),
		}))
		.digest('hex')
}

export function clampSearchLimit(limit: number | undefined): number {
	if (!limit || Number.isNaN(limit) || limit < 1) {
		return 10
	}

	return Math.min(limit, SEARCH_MAX_LIMIT)
}

function encodeVectorBaseId(smolId: string): string {
	const normalized = normalizeText(smolId)
	if (!normalized) {
		throw new Error('Cannot build a vector id for an empty smol id')
	}

	if (/^[0-9a-f]+$/i.test(normalized) && normalized.length % 2 === 0) {
		return Buffer.from(normalized, 'hex').toString('base64url')
	}

	return Buffer.from(normalized, 'utf8').toString('base64url')
}

function buildVectorId(smolId: string, modality: SearchModality): string {
	return `${encodeVectorBaseId(smolId)}:${MODALITY_CODES[modality]}`
}

function getVectorIdsForSmol(smolId: string): string[] {
	return SEARCH_MODALITIES.map((modality) => buildVectorId(smolId, modality))
}

function getSearchIndex(env: Env): Vectorize {
	// Wrangler 4.59 still emits the legacy VectorizeIndex binding type even though
	// the runtime binding supports the V2 Vectorize methods used here.
	return env.SMOL_SEARCH_INDEX as unknown as Vectorize
}

export function isSearchQueryableState(
	search: SearchState | undefined
): search is SearchState & { indexed_at: string } {
	return Boolean(
		search
		&& search.version === SEARCH_INDEX_VERSION
		&& search.status !== 'hidden'
		&& search.indexed_at
	)
}

function buildBaseSearchState(status: SearchStatus): SearchState {
	const timestamp = nowIso()

	return {
		status,
		version: SEARCH_INDEX_VERSION,
		queued_at: status === 'queued' ? timestamp : undefined,
		indexed_at: status === 'ready' ? timestamp : undefined,
	}
}

export function createQueuedSearchState(): SearchState {
	return buildBaseSearchState('queued')
}

export function createHiddenSearchState(): SearchState {
	return buildBaseSearchState('hidden')
}

async function getStoredSmolRecord(env: Env, smolId: string): Promise<StoredSmolRecord | null> {
	return await env.SMOL_KV.get(smolId, 'json') as StoredSmolRecord | null
}

async function putStoredSmolRecord(env: Env, smolId: string, record: StoredSmolRecord): Promise<void> {
	await env.SMOL_KV.put(smolId, JSON.stringify(record))
}

async function updateStoredSmolRecord(
	env: Env,
	smolId: string,
	mutator: (record: StoredSmolRecord) => StoredSmolRecord | void
): Promise<StoredSmolRecord | null> {
	const record = await getStoredSmolRecord(env, smolId)
	if (!record) {
		return null
	}

	const updated = mutator(record) ?? record
	await putStoredSmolRecord(env, smolId, updated)
	return updated
}

async function setSearchState(
	env: Env,
	smolId: string,
	mutate: (search: SearchState | undefined) => SearchState
): Promise<StoredSmolRecord | null> {
	return await updateStoredSmolRecord(env, smolId, (record) => {
		record.search = mutate(record.search)
		return record
	})
}

export function guessEnergy(text: string): SearchStoredMetadata['energy_level'] {
	const haystack = text.toLowerCase()

	if (/(upbeat|energetic|dance|fast|anthem|punk|hyper|club)/.test(haystack)) {
		return 'high'
	}

	if (/(slow|ambient|mellow|chill|soft|gentle|acoustic)/.test(haystack)) {
		return 'low'
	}

	return 'mid'
}

export function guessBrightness(text: string): SearchStoredMetadata['brightness_level'] {
	const haystack = text.toLowerCase()

	if (/(bright|sunny|warm|joy|happy|colorful|hopeful|glow)/.test(haystack)) {
		return 'bright'
	}

	if (/(dark|gloom|lonely|sad|cold|night|moody|shadow)/.test(haystack)) {
		return 'dark'
	}

	return 'neutral'
}

export function guessModality(text: string): SearchStoredMetadata['modality_guess'] {
	const haystack = text.toLowerCase()

	if (/\bminor\b/.test(haystack)) {
		return 'minor'
	}

	if (/\bmajor\b/.test(haystack)) {
		return 'major'
	}

	return 'unknown'
}

export function guessMood(text: string): string {
	const haystack = text.toLowerCase()

	if (/(lonely|heartbreak|grief|sad|sorrow|loss)/.test(haystack)) {
		return 'melancholic'
	}

	if (/(joy|happy|euphoric|celebrate|bright|fun)/.test(haystack)) {
		return 'uplifting'
	}

	if (/(rage|angry|defiant|rebellious)/.test(haystack)) {
		return 'defiant'
	}

	if (/(dream|calm|float|gentle|peaceful)/.test(haystack)) {
		return 'dreamy'
	}

	return 'cinematic'
}

export function guessTheme(text: string): string {
	const haystack = text.toLowerCase()

	if (/(love|heart|romance|kiss)/.test(haystack)) {
		return 'love'
	}

	if (/(lonely|alone|isolation|empty)/.test(haystack)) {
		return 'loneliness'
	}

	if (/(night|city|street|neon)/.test(haystack)) {
		return 'nightlife'
	}

	if (/(dream|memory|nostalgia|yesterday)/.test(haystack)) {
		return 'nostalgia'
	}

	if (/(fight|rise|power|survive)/.test(haystack)) {
		return 'resilience'
	}

	return 'storytelling'
}

export function buildFallbackMetadata(source: SmolIndexSource): SearchStoredMetadata {
	const styleTags = uniqueStrings(source.lyrics?.style ?? [])
	const description = normalizeText(source.description)
	const lyrics = normalizeText(source.lyrics?.lyrics)
	const combined = [source.title, description, lyrics, ...styleTags].join(' ')

	return {
		style_primary: styleTags[0] ?? (source.instrumental ? 'instrumental' : 'vocal'),
		mood_primary: guessMood(combined),
		theme_primary: guessTheme(combined),
		lyric_presence: source.instrumental ? 'instrumental' : (lyrics.length > 800 ? 'lyric-heavy' : 'sparse'),
		brightness_level: guessBrightness(combined),
		energy_level: guessEnergy(combined),
		modality_guess: guessModality(combined),
		style_tags: styleTags,
		title: source.title,
	}
}

export function normalizeMetadataPhrase(value: unknown, fallback: string): string {
	if (typeof value !== 'string') {
		return fallback
	}

	const normalized = normalizeText(value).toLowerCase()
	return normalized || fallback
}

export function normalizeMetadataEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	if (typeof value !== 'string') {
		return fallback
	}

	const normalized = normalizeText(value).toLowerCase() as T
	return allowed.includes(normalized) ? normalized : fallback
}

export function tryParseJsonObject(value: string | Record<string, unknown> | undefined): Record<string, unknown> | null {
	if (!value) {
		return null
	}

	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? parsed as Record<string, unknown>
				: null
		} catch {
			return null
		}
	}

	return Array.isArray(value) ? null : value
}

export function normalizeExtractedSearchMetadata(
	value: Record<string, unknown> | null,
	fallback: SearchStoredMetadata
): SearchMetadataExtraction | null {
	if (!value) {
		return null
	}

	return {
		style_primary: normalizeMetadataPhrase(value.style_primary, fallback.style_primary),
		mood_primary: normalizeMetadataPhrase(value.mood_primary, fallback.mood_primary),
		theme_primary: normalizeMetadataPhrase(value.theme_primary, fallback.theme_primary),
		lyric_presence: normalizeMetadataEnum(value.lyric_presence, ['instrumental', 'sparse', 'lyric-heavy'], fallback.lyric_presence),
		brightness_level: normalizeMetadataEnum(value.brightness_level, ['dark', 'neutral', 'bright'], fallback.brightness_level),
		energy_level: normalizeMetadataEnum(value.energy_level, ['low', 'mid', 'high'], fallback.energy_level),
		modality_guess: normalizeMetadataEnum(value.modality_guess, ['minor', 'major', 'mixed', 'unknown'], fallback.modality_guess),
	}
}

function normalizeMutationTrackerValue(value: unknown): string | undefined {
	if (typeof value === 'string') {
		const normalized = normalizeText(value)
		return normalized || undefined
	}

	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value)
	}

	return undefined
}

function normalizeMutationTimestamp(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value
	}

	if (typeof value === 'string') {
		const parsed = Date.parse(value)
		return Number.isNaN(parsed) ? undefined : parsed
	}

	return undefined
}

async function getSearchMutationProgress(env: Env, search: SearchState | undefined): Promise<SearchMutationProgress> {
	const mutationId = normalizeMutationTrackerValue(search?.mutation_id)
	if (!mutationId) {
		return {
			isProcessed: false,
		}
	}

	const info = await getSearchIndex(env).describe()
	const processedMutation = normalizeMutationTrackerValue(info.processedUpToMutation)
	if (processedMutation === mutationId) {
		return {
			isProcessed: true,
			mutationId,
			processedMutation,
			requestedAt: normalizeMutationTimestamp(search?.mutation_requested_at ?? search?.queued_at),
			processedAt: normalizeMutationTimestamp(info.processedUpToDatetime),
			vectorCount: info.vectorCount,
			dimensions: info.dimensions,
		}
	}

	const processedAt = normalizeMutationTimestamp(info.processedUpToDatetime)
	const requestedAt = normalizeMutationTimestamp(search?.mutation_requested_at ?? search?.queued_at)
	return {
		isProcessed: processedAt !== undefined && requestedAt !== undefined && processedAt >= requestedAt,
		mutationId,
		processedMutation,
		requestedAt,
		processedAt,
		vectorCount: info.vectorCount,
		dimensions: info.dimensions,
	}
}

async function extractSearchMetadata(env: Env, source: SmolIndexSource): Promise<SearchStoredMetadata> {
	const fallback = buildFallbackMetadata(source)
	const content = [
		'Extract compact music-search metadata for a song object.',
		'Return JSON only with the keys:',
		'style_primary, mood_primary, theme_primary, lyric_presence, brightness_level, energy_level, modality_guess.',
		'Allowed lyric_presence: instrumental, sparse, lyric-heavy.',
		'Allowed brightness_level: dark, neutral, bright.',
		'Allowed energy_level: low, mid, high.',
		'Allowed modality_guess: minor, major, mixed, unknown.',
		'Keep style_primary, mood_primary, theme_primary as short lowercase phrases.',
		`Title: ${source.title}`,
		`Prompt: ${normalizeText(source.prompt) || 'n/a'}`,
		`Description: ${normalizeText(source.description) || 'n/a'}`,
		`Style tags: ${uniqueStrings(source.lyrics?.style ?? []).join(', ') || 'n/a'}`,
		`Lyrics: ${truncateText(normalizeText(source.lyrics?.lyrics), MAX_TAG_EXTRACTION_LYRICS_CHARS) || 'n/a'}`,
	].join('\n')

	const messages = [
		{
			role: 'system' as const,
			content: 'You output only valid JSON. No markdown, no prose, no code fences.',
		},
		{
			role: 'user' as const,
			content,
		},
	]

	const parseMetadataResponse = (response: AiTextGenerationOutput & AiJsonGenerationOutput): SearchStoredMetadata | null => {
		const parsed = normalizeExtractedSearchMetadata(tryParseJsonObject(response.response), fallback)
		if (!parsed) {
			return null
		}

		return {
			...parsed,
			style_tags: fallback.style_tags,
			title: fallback.title,
		}
	}

	try {
		const response = await env.AI.run(TAG_EXTRACTION_MODEL, {
			messages,
			response_format: {
				type: 'json_object',
			},
			max_tokens: 250,
			temperature: 0,
		}) as AiTextGenerationOutput & AiJsonGenerationOutput

		const parsed = parseMetadataResponse(response)
		if (parsed) {
			return parsed
		}
	} catch (error) {
		logSearchEvent('search_metadata_json_mode_failed', {
			title: source.title,
			error: error instanceof Error ? error.message : String(error),
		})
	}

	try {
		const response = await env.AI.run(TAG_EXTRACTION_MODEL, {
			messages,
			max_tokens: 250,
			temperature: 0,
		}) as AiTextGenerationOutput & AiJsonGenerationOutput

		const parsed = parseMetadataResponse(response)
		if (parsed) {
			return parsed
		}

		logSearchEvent('search_metadata_parse_failed', {
			title: source.title,
			responsePreview: typeof response.response === 'string'
				? truncateText(response.response, 200)
				: response.response,
		})
	} catch (error) {
		logSearchEvent('search_metadata_generation_failed', {
			title: source.title,
			error: error instanceof Error ? error.message : String(error),
		})
	}

	return fallback
}

function buildSearchTexts(source: SmolIndexSource, metadata: SearchStoredMetadata): SearchTextFields {
	const styleText = uniqueStrings([
		...(source.lyrics?.style ?? []),
		metadata.style_primary,
		metadata.mood_primary,
		metadata.theme_primary,
		metadata.brightness_level,
		metadata.energy_level,
		metadata.modality_guess,
	]).join(', ')

	return {
		style: styleText || (source.instrumental ? 'instrumental music' : source.title),
		title: normalizeText(source.title) || 'untitled song',
		lyrics: truncateText(normalizeText(source.lyrics?.lyrics), MAX_LYRICS_CHARS) || (source.instrumental ? 'instrumental music' : source.title),
		description: uniqueStrings([
			source.prompt,
			source.description,
			metadata.mood_primary,
			metadata.theme_primary,
		]).join('. ') || source.title,
	}
}

async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
	const response = await env.AI.run(EMBEDDING_MODEL, {
		text: texts,
		truncate_inputs: true,
	}) as Ai_Cf_Baai_Bge_M3_Ouput_Embedding

	if (!response.data?.length) {
		throw new Error('Embedding model returned no vectors')
	}

	return response.data
}

async function embedText(env: Env, text: string): Promise<number[]> {
	const vectors = await embedTexts(env, [text])
	if (!vectors[0]) {
		throw new Error('Embedding model returned no query vector')
	}

	return vectors[0]
}

// WARNING: 9 of the 10 Vectorize metadata indexes allowed per index are in use.
// The following properties have metadata indexes (see docs/search-index-setup.md):
//   smol_id, modality, public, instrumental, brightness_level,
//   energy_level, modality_guess, lyric_presence, search_version
// Adding another indexed property would hit the platform limit.
// Non-indexed properties (style_primary, style_tags, mood_primary, etc.) are
// stored as metadata but do NOT consume an index slot.
function buildVectorMetadata(
	source: SmolIndexSource,
	modality: SearchModality,
	metadata: SearchStoredMetadata
): Record<string, VectorizeVectorMetadata> {
	return {
		smol_id: source.id,
		modality,
		public: source.public,
		instrumental: source.instrumental,
		brightness_level: metadata.brightness_level,
		energy_level: metadata.energy_level,
		modality_guess: metadata.modality_guess,
		lyric_presence: metadata.lyric_presence,
		search_version: SEARCH_INDEX_VERSION,
		style_primary: metadata.style_primary,
		style_tags: metadata.style_tags,
		mood_primary: metadata.mood_primary,
		theme_primary: metadata.theme_primary,
		title: source.title,
	}
}

function buildVectors(source: SmolIndexSource, texts: SearchTextFields, embeddings: number[][], metadata: SearchStoredMetadata): VectorizeVector[] {
	return SEARCH_MODALITIES.map((modality, index) => ({
		id: buildVectorId(source.id, modality),
		values: embeddings[index] ?? [],
		metadata: buildVectorMetadata(source, modality, metadata),
	}))
}

async function loadSmolIndexSource(env: Env, smolId: string): Promise<SmolIndexSource | null> {
	const d1 = await env.SMOL_D1.prepare(`
		SELECT Id, Title, Public, Instrumental
		FROM Smols
		WHERE Id = ?1
	`)
		.bind(smolId)
		.first<{ Id: string; Title: string; Public: number; Instrumental: number }>()

	if (!d1) {
		return null
	}

	const kv = await getStoredSmolRecord(env, smolId)
	if (!kv) {
		return null
	}

	if (d1.Instrumental !== 1 && !kv.lyrics) {
		return null
	}

	return {
		id: d1.Id,
		title: d1.Title,
		public: d1.Public === 1,
		instrumental: d1.Instrumental === 1,
		prompt: kv.payload?.prompt,
		description: kv.description,
		lyrics: kv.lyrics,
	}
}

async function handleMissingUpsertSource(env: Env, smolId: string, attempts: number): Promise<SearchQueueDisposition> {
	const record = await getStoredSmolRecord(env, smolId)
	const d1Record = await env.SMOL_D1.prepare(`
		SELECT Id
		FROM Smols
		WHERE Id = ?1
	`)
		.bind(smolId)
		.first<{ Id: string }>()

	if (!record && !d1Record) {
		return ACK_QUEUE_MESSAGE
	}

	logSearchEvent('search_upsert_source_missing', {
		smolId,
		attempts,
		hasKvRecord: Boolean(record),
		hasD1Record: Boolean(d1Record),
	})

	if (attempts >= SEARCH_FINALIZE_MAX_ATTEMPTS) {
		await setSearchState(env, smolId, (existing) => ({
			...(existing ?? createQueuedSearchState()),
			status: 'failed',
			version: SEARCH_INDEX_VERSION,
			indexed_at: existing?.indexed_at,
			last_error: 'Source data missing for search indexing',
			mutation_id: undefined,
			mutation_requested_at: undefined,
		}))
		return ACK_QUEUE_MESSAGE
	}

	return {
		action: 'retry',
		delaySeconds: Math.min(30, Math.max(5, attempts * 5)),
	}
}

async function prepareSearchUpsert(env: Env, smolId: string, attempts: number): Promise<PreparedSearchUpsert | null> {
	const source = await loadSmolIndexSource(env, smolId)
	if (!source) {
		const result = await handleMissingUpsertSource(env, smolId, attempts)
		if (result.action === 'retry') {
			await env.SEARCH_QUEUE.send(
				{
					type: 'upsert',
					smolId,
				},
				{
					delaySeconds: result.delaySeconds,
				}
			)
		}
		return null
	}

	if (!source.public) {
		await deleteSmolVectors(env, smolId)
		await setSearchState(env, smolId, () => ({
			...createHiddenSearchState(),
			vector_ids: getVectorIdsForSmol(smolId),
			mutation_id: undefined,
			mutation_requested_at: undefined,
		}))
		return null
	}

	const record = await getStoredSmolRecord(env, smolId)
	const sourceHash = buildSearchSourceHash(source)
	const metadata = record?.search?.version === SEARCH_INDEX_VERSION
		&& record.search.source_hash === sourceHash
		&& record.search.metadata
		? record.search.metadata
		: await extractSearchMetadata(env, source)
	const texts = buildSearchTexts(source, metadata)
	return {
		source,
		sourceHash,
		metadata,
		texts,
		vectorIds: getVectorIdsForSmol(smolId),
	}
}

async function upsertSmolVectors(env: Env, smolId: string, attempts: number): Promise<SearchQueueDisposition> {
	const prepared = await prepareSearchUpsert(env, smolId, attempts)
	if (!prepared) {
		return ACK_QUEUE_MESSAGE
	}

	const embeddings = await embedTexts(env, [
		prepared.texts.style,
		prepared.texts.title,
		prepared.texts.lyrics,
		prepared.texts.description,
	])
	const vectors = buildVectors(prepared.source, prepared.texts, embeddings, prepared.metadata)
	const mutation = await getSearchIndex(env).upsert(vectors)

	logSearchEvent('search_upsert_enqueued', {
		smolId,
		attempts,
		title: prepared.source.title,
		public: prepared.source.public,
		instrumental: prepared.source.instrumental,
		mutationId: mutation.mutationId,
		vectorIds: prepared.vectorIds,
		vectorDimensions: vectors.map((vector) => vector.values.length),
		styleTagCount: prepared.metadata.style_tags.length,
		lyricPresence: prepared.metadata.lyric_presence,
	})

	await setSearchState(env, smolId, (existing) => ({
		...(existing ?? createQueuedSearchState()),
		status: 'processing',
		version: SEARCH_INDEX_VERSION,
		queued_at: existing?.queued_at ?? nowIso(),
		indexed_at: existing?.indexed_at,
		source_hash: prepared.sourceHash,
		vector_ids: prepared.vectorIds,
		metadata: prepared.metadata,
		last_error: undefined,
		mutation_id: mutation.mutationId,
		mutation_requested_at: nowIso(),
	}))

	await env.SEARCH_QUEUE.send(
		{
			type: 'finalize',
			smolId,
			vectorIds: prepared.vectorIds,
		},
		{
			delaySeconds: SEARCH_FINALIZE_DELAY_SECONDS,
		}
	)
	return ACK_QUEUE_MESSAGE
}

async function upsertSmolVectorBatch(env: Env, smolIds: string[], attempts: number): Promise<SearchQueueDisposition> {
	const uniqueSmolIds = uniqueStrings(smolIds)
	if (!uniqueSmolIds.length) {
		return ACK_QUEUE_MESSAGE
	}

	const preparedEntries = (await Promise.all(
		uniqueSmolIds.map(async (smolId) => await prepareSearchUpsert(env, smolId, attempts))
	)).filter((entry): entry is PreparedSearchUpsert => Boolean(entry))

	if (!preparedEntries.length) {
		return ACK_QUEUE_MESSAGE
	}

	const flattenedTexts = preparedEntries.flatMap(({ texts }) => [
		texts.style,
		texts.title,
		texts.lyrics,
		texts.description,
	])
	const embeddings = await embedTexts(env, flattenedTexts)

	let embeddingOffset = 0
	const vectors = preparedEntries.flatMap((entry) => {
		const entryEmbeddings = embeddings.slice(embeddingOffset, embeddingOffset + SEARCH_MODALITIES.length)
		embeddingOffset += SEARCH_MODALITIES.length
		return buildVectors(entry.source, entry.texts, entryEmbeddings, entry.metadata)
	})

	const mutation = await getSearchIndex(env).upsert(vectors)
	const queuedAt = nowIso()

	logSearchEvent('search_batch_upsert_enqueued', {
		smolCount: preparedEntries.length,
		attempts,
		mutationId: mutation.mutationId,
		vectorCount: vectors.length,
		vectorDimensions: uniqueStrings(vectors.map((vector) => String(vector.values.length))),
		smolIds: preparedEntries.map(({ source }) => source.id),
	})

	await Promise.all(preparedEntries.map(async (entry) => {
		await setSearchState(env, entry.source.id, (existing) => ({
			...(existing ?? createQueuedSearchState()),
			status: 'processing',
			version: SEARCH_INDEX_VERSION,
			queued_at: existing?.queued_at ?? queuedAt,
			indexed_at: existing?.indexed_at,
			source_hash: entry.sourceHash,
			vector_ids: entry.vectorIds,
			metadata: entry.metadata,
			last_error: undefined,
			mutation_id: mutation.mutationId,
			mutation_requested_at: queuedAt,
		}))
	}))

	await Promise.all(preparedEntries.map(async (entry) => {
		await env.SEARCH_QUEUE.send(
			{
				type: 'finalize',
				smolId: entry.source.id,
				vectorIds: entry.vectorIds,
			},
			{
				delaySeconds: SEARCH_FINALIZE_DELAY_SECONDS,
			}
		)
	}))

	return ACK_QUEUE_MESSAGE
}

async function deleteSmolVectors(env: Env, smolId: string, vectorIds: string[] = getVectorIdsForSmol(smolId)): Promise<void> {
	await getSearchIndex(env).deleteByIds(vectorIds)
}

async function finalizeSmolVectors(env: Env, smolId: string, vectorIds: string[]): Promise<SearchQueueDisposition> {
	const record = await getStoredSmolRecord(env, smolId)
	if (!record?.search) {
		return ACK_QUEUE_MESSAGE
	}

	if (record.search.status === 'hidden') {
		return ACK_QUEUE_MESSAGE
	}

	if (record.search.status !== 'processing') {
		return ACK_QUEUE_MESSAGE
	}

	if (record.search.version !== SEARCH_INDEX_VERSION) {
		return {
			action: 'retry',
			delaySeconds: SEARCH_FINALIZE_DELAY_SECONDS,
		}
	}

	const source = await loadSmolIndexSource(env, smolId)
	if (!source || !source.public) {
		await setSearchState(env, smolId, () => ({
			...createHiddenSearchState(),
			vector_ids: vectorIds,
			mutation_id: undefined,
			mutation_requested_at: undefined,
		}))
		return ACK_QUEUE_MESSAGE
	}

	const progress = await getSearchMutationProgress(env, record.search)
	if (progress.isProcessed) {
		logSearchEvent('search_finalize_ready', {
			smolId,
			mutationId: progress.mutationId,
			processedMutation: progress.processedMutation,
			requestedAt: progress.requestedAt,
			processedAt: progress.processedAt,
			vectorCount: progress.vectorCount,
			dimensions: progress.dimensions,
		})

		await setSearchState(env, smolId, (existing) => ({
			...(existing ?? createQueuedSearchState()),
			status: 'ready',
			version: SEARCH_INDEX_VERSION,
			queued_at: existing?.queued_at,
			indexed_at: nowIso(),
			vector_ids: vectorIds,
			metadata: existing?.metadata,
			last_error: undefined,
			mutation_id: existing?.mutation_id,
			mutation_requested_at: existing?.mutation_requested_at,
		}))
		return ACK_QUEUE_MESSAGE
	}

	logSearchEvent('search_finalize_pending', {
		smolId,
		mutationId: progress.mutationId,
		processedMutation: progress.processedMutation,
		requestedAt: progress.requestedAt,
		processedAt: progress.processedAt,
		vectorCount: progress.vectorCount,
		dimensions: progress.dimensions,
	})

	return {
		action: 'retry',
		delaySeconds: SEARCH_FINALIZE_DELAY_SECONDS,
	}
}

export function parseSearchHints(input: string | undefined | null): ParsedSearchHints {
	const text = normalizeText(input).toLowerCase()
	const hints: ParsedSearchHints = {}

	if (!text) {
		return hints
	}

	if (/(instrumental|no lyrics|without lyrics)/.test(text)) {
		hints.instrumental = true
		hints.lyricPresence = ['instrumental']
	}

	if (/(with lyrics|lyrical|vocals|singer|singing)/.test(text)) {
		hints.instrumental = false
		hints.lyricPresence = ['sparse', 'lyric-heavy']
	}

	if (/(bright|brighter|warm|sunny|colorful|colourful)/.test(text)) {
		hints.brightness = 'bright'
	}

	if (/(dark|darker|cold|shadowy|moody)/.test(text)) {
		hints.brightness = 'dark'
	}

	if (/(upbeat|faster|high energy|energetic|dancey)/.test(text)) {
		hints.energy = 'high'
	}

	if (/(calm|mellow|slow|ambient|low energy|gentle)/.test(text)) {
		hints.energy = 'low'
	}

	if (/(not in a minor key|not minor|no minor)/.test(text)) {
		hints.excludeModality = 'minor'
	}

	if (/(not in a major key|not major|no major)/.test(text)) {
		hints.excludeModality = 'major'
	}

	if (/\bminor\b/.test(text) && !hints.excludeModality) {
		hints.modality = 'minor'
	}

	if (/\bmajor\b/.test(text) && !hints.excludeModality) {
		hints.modality = 'major'
	}

	return hints
}

function buildVectorFilter(modality: SearchModality, hints: ParsedSearchHints): VectorizeVectorMetadataFilter {
	const filter: VectorizeVectorMetadataFilter = {
		modality,
		public: true,
		search_version: SEARCH_INDEX_VERSION,
	}

	if (typeof hints.instrumental === 'boolean') {
		filter.instrumental = hints.instrumental
	}

	if (hints.brightness) {
		filter.brightness_level = hints.brightness
	}

	if (hints.energy) {
		filter.energy_level = hints.energy
	}

	if (hints.modality) {
		filter.modality_guess = hints.modality
	}

	if (hints.excludeModality) {
		filter.modality_guess = { $ne: hints.excludeModality }
	}

	if (hints.lyricPresence?.length) {
		filter.lyric_presence = hints.lyricPresence.length === 1
			? hints.lyricPresence[0]
			: { $in: hints.lyricPresence }
	}

	return filter
}

function extractSmolId(match: VectorizeMatch): string {
	const smolId = typeof match.metadata?.smol_id === 'string'
		? match.metadata.smol_id
		: match.id.split(':')[0]

	return smolId
}

async function resolveQueryMap(
	queries: Record<SearchModality, Promise<VectorizeMatches>>
): Promise<Record<SearchModality, VectorizeMatches>> {
	const entries = await Promise.all(
		(Object.entries(queries) as [SearchModality, Promise<VectorizeMatches>][]).map(async ([modality, promise]) => {
			try {
				return [modality, await promise] as const
			} catch (error) {
				console.warn(`Vector search failed for ${modality}:`, error)
				return [modality, { matches: [], count: 0 }] as const
			}
		})
	)

	return Object.fromEntries(entries) as Record<SearchModality, VectorizeMatches>
}

async function runQuerySearch(env: Env, query: string, hints: ParsedSearchHints): Promise<Record<SearchModality, VectorizeMatches>> {
	const queryVector = await embedText(env, query)

	return await resolveQueryMap(Object.fromEntries(
		SEARCH_MODALITIES.map((modality) => [
			modality,
			getSearchIndex(env).query(queryVector, {
				topK: SEARCH_TOP_K,
				returnMetadata: 'indexed',
				filter: buildVectorFilter(modality, hints),
			}),
		])
	) as Record<SearchModality, Promise<VectorizeMatches>>)
}

async function runSimilarSearch(env: Env, smolId: string, hints: ParsedSearchHints): Promise<Record<SearchModality, VectorizeMatches>> {
	return await resolveQueryMap(Object.fromEntries(
		SEARCH_MODALITIES.map((modality) => [
			modality,
			getSearchIndex(env).queryById(buildVectorId(smolId, modality), {
				topK: SEARCH_TOP_K,
				returnMetadata: 'indexed',
				filter: buildVectorFilter(modality, hints),
			}),
		])
	) as Record<SearchModality, Promise<VectorizeMatches>>)
}

export function fuseMatches(matchesByModality: Record<SearchModality, VectorizeMatches>): Map<string, RankedCandidate> {
	const fused = new Map<string, RankedCandidate>()

	for (const modality of SEARCH_MODALITIES) {
		const matches = matchesByModality[modality]?.matches ?? []
		const weight = MODALITY_WEIGHTS[modality]

		for (const [index, match] of matches.entries()) {
			const smolId = extractSmolId(match)
			const existing = fused.get(smolId) ?? {
				smolId,
				score: 0,
				modalityScores: {},
			}
			const contribution = weight * (1 / (SEARCH_RRF_K + index + 1))

			existing.score += contribution
			existing.modalityScores[modality] = (existing.modalityScores[modality] ?? 0) + contribution
			fused.set(smolId, existing)
		}
	}

	return fused
}

export function blendCandidateMaps(
	base: Map<string, RankedCandidate>,
	refine: Map<string, RankedCandidate>,
	baseWeight: number,
	refineWeight: number
): Map<string, RankedCandidate> {
	const blended = new Map<string, RankedCandidate>()
	const ids = new Set([...base.keys(), ...refine.keys()])

	for (const id of ids) {
		const baseCandidate = base.get(id)
		const refineCandidate = refine.get(id)
		const modalityScores: Partial<Record<SearchModality, number>> = {}

		for (const modality of SEARCH_MODALITIES) {
			const score = ((baseCandidate?.modalityScores[modality] ?? 0) * baseWeight)
				+ ((refineCandidate?.modalityScores[modality] ?? 0) * refineWeight)
			if (score > 0) {
				modalityScores[modality] = score
			}
		}

		blended.set(id, {
			smolId: id,
			score: ((baseCandidate?.score ?? 0) * baseWeight) + ((refineCandidate?.score ?? 0) * refineWeight),
			modalityScores,
		})
	}

	return blended
}

export function sortCandidates(candidates: Iterable<RankedCandidate>): RankedCandidate[] {
	return [...candidates].sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score
		}

		return a.smolId.localeCompare(b.smolId)
	})
}

async function loadSmolRowsByIds(env: Env, ids: string[]): Promise<Map<string, SmolSearchRow>> {
	if (!ids.length) {
		return new Map()
	}

	const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ')
	const rows = await env.SMOL_D1.prepare(`
		SELECT Id, Title, Song_1, Mint_Token, Mint_Amm, Created_At, Public
		FROM Smols
		WHERE Id IN (${placeholders})
	`)
		.bind(...ids)
		.all<SmolSearchRow>()

	return new Map(rows.results.map((row) => [row.Id, row]))
}

async function hydrateRankedCandidates(env: Env, ranked: RankedCandidate[], limit: number): Promise<SearchResultItem[]> {
	const results: SearchResultItem[] = []

	for (let offset = 0; offset < ranked.length && results.length < limit; offset += SEARCH_HYDRATION_BATCH) {
		const slice = ranked.slice(offset, offset + SEARCH_HYDRATION_BATCH)
		const ids = slice.map((candidate) => candidate.smolId)
		const [rowMap, records] = await Promise.all([
			loadSmolRowsByIds(env, ids),
			Promise.all(ids.map(async (id) => [id, await getStoredSmolRecord(env, id)] as const)),
		])
		const recordMap = new Map(records)

		for (const candidate of slice) {
			if (results.length >= limit) {
				break
			}

			const row = rowMap.get(candidate.smolId)
			const record = recordMap.get(candidate.smolId)
			const search = record?.search

			if (!row || row.Public !== 1) {
				continue
			}

			if (!isSearchQueryableState(search)) {
				continue
			}

			const activeSearch = search

			const matchedFields = SEARCH_MODALITIES
				.filter((modality) => (candidate.modalityScores[modality] ?? 0) > 0)
				.sort((left, right) => (candidate.modalityScores[right] ?? 0) - (candidate.modalityScores[left] ?? 0))

			results.push({
				Id: row.Id,
				Title: row.Title,
				Song_1: row.Song_1,
				Mint_Token: row.Mint_Token,
				Mint_Amm: row.Mint_Amm,
				Created_At: row.Created_At,
				score: candidate.score,
				explanation: {
					matchedFields,
					style: activeSearch.metadata?.style_tags?.slice(0, 3),
					mood: activeSearch.metadata?.mood_primary,
					theme: activeSearch.metadata?.theme_primary,
				},
			})
		}
	}

	return results
}

export async function queueSearchIndexingById(env: Env, smolId: string): Promise<boolean> {
	const updated = await setSearchState(env, smolId, (existing) => ({
		...(existing ?? createQueuedSearchState()),
		status: 'queued',
		version: SEARCH_INDEX_VERSION,
		queued_at: nowIso(),
		indexed_at: existing?.indexed_at,
		source_hash: existing?.source_hash,
		last_error: undefined,
		mutation_id: undefined,
		mutation_requested_at: undefined,
	}))

	if (!updated) {
		return false
	}

	await env.SEARCH_QUEUE.send({
		type: 'upsert',
		smolId,
	})

	return true
}

function isSearchMutationStillPending(
	search: SearchState | undefined,
	progress: Pick<SearchMutationProgress, 'processedMutation' | 'processedAt'>
): boolean {
	if (!search || search.version !== SEARCH_INDEX_VERSION) {
		return false
	}

	if (search.status === 'queued' || search.status === 'processing') {
		return true
	}

	if (search.status !== 'failed') {
		return false
	}

	const mutationId = normalizeMutationTrackerValue(search.mutation_id)
	const requestedAt = normalizeMutationTimestamp(search.mutation_requested_at ?? search.queued_at)
	if (!mutationId || !requestedAt) {
		return false
	}

	if (progress.processedMutation && progress.processedMutation === mutationId) {
		return false
	}

	return progress.processedAt === undefined || requestedAt > progress.processedAt
}

export async function queueSearchIndexingBatchById(
	env: Env,
	smolIds: string[],
	options: { force?: boolean } = {}
): Promise<BatchQueueResult> {
	const uniqueSmolIds = uniqueStrings(smolIds)
	if (!uniqueSmolIds.length) {
		return {
			queuedIds: [],
			skipped: {
				current: 0,
				pending: 0,
				missing: 0,
			},
		}
	}

	const info = await getSearchIndex(env).describe()
	const progress = {
		processedMutation: normalizeMutationTrackerValue(info.processedUpToMutation),
		processedAt: normalizeMutationTimestamp(info.processedUpToDatetime),
	}
	const skipped: Record<BatchQueueSkipReason, number> = {
		current: 0,
		pending: 0,
		missing: 0,
	}

	const queuedIds = (await Promise.all(uniqueSmolIds.map(async (smolId) => {
		const record = await getStoredSmolRecord(env, smolId)
		if (!record) {
			skipped.missing += 1
			return null
		}

		if (!options.force) {
			if (isSearchQueryableState(record.search)) {
				skipped.current += 1
				return null
			}

			if (isSearchMutationStillPending(record.search, progress)) {
				skipped.pending += 1
				return null
			}
		}

		const updated = await setSearchState(env, smolId, (existing) => ({
			...(existing ?? createQueuedSearchState()),
			status: 'queued',
			version: SEARCH_INDEX_VERSION,
			queued_at: nowIso(),
			indexed_at: existing?.indexed_at,
			source_hash: existing?.source_hash,
			last_error: undefined,
			mutation_id: undefined,
			mutation_requested_at: undefined,
		}))

		return updated ? smolId : null
	}))).filter((smolId): smolId is string => Boolean(smolId))

	await Promise.all(chunkArray(queuedIds, SEARCH_BACKFILL_UPSERT_BATCH_SIZE).map(async (chunk) => {
		await env.SEARCH_QUEUE.send({
			type: 'upsert_batch',
			smolIds: chunk,
		})
	}))

	return {
		queuedIds,
		skipped,
	}
}

export async function hideSmolFromSearch(env: Env, smolId: string): Promise<boolean> {
	const updated = await setSearchState(env, smolId, (existing) => ({
		...(existing ?? createHiddenSearchState()),
		status: 'hidden',
		version: SEARCH_INDEX_VERSION,
		indexed_at: undefined,
		last_error: undefined,
		mutation_id: undefined,
		mutation_requested_at: undefined,
	}))

	await env.SEARCH_QUEUE.send({
		type: 'delete',
		smolId,
		vectorIds: updated?.search?.vector_ids ?? getVectorIdsForSmol(smolId),
	})

	return Boolean(updated)
}

export async function queueSearchDeletionById(env: Env, smolId: string): Promise<void> {
	await env.SEARCH_QUEUE.send({
		type: 'delete',
		smolId,
		vectorIds: getVectorIdsForSmol(smolId),
	})
}

export async function searchPublicSmols(
	env: Env,
	params: {
		query: string
		limit?: number
		instrumental?: boolean
	}
): Promise<SearchResponse> {
	const query = normalizeText(params.query)
	if (!query) {
		throw new HTTPException(400, { message: 'Missing search query' })
	}

	const hints = parseSearchHints(query)
	if (typeof params.instrumental === 'boolean') {
		hints.instrumental = params.instrumental
	}

	const ranked = sortCandidates(fuseMatches(await runQuerySearch(env, query, hints)).values())
	return {
		results: await hydrateRankedCandidates(env, ranked, clampSearchLimit(params.limit)),
	}
}

export async function searchSimilarSmols(
	env: Env,
	params: {
		id: string
		refine?: string
		limit?: number
	}
): Promise<SearchResponse> {
	const source = await env.SMOL_D1.prepare(`
		SELECT Id, Public
		FROM Smols
		WHERE Id = ?1
	`)
		.bind(params.id)
		.first<{ Id: string; Public: number }>()

	if (!source || source.Public !== 1) {
		throw new HTTPException(404, { message: 'Smol not found' })
	}

	const record = await getStoredSmolRecord(env, params.id)
	if (!isSearchQueryableState(record?.search)) {
		throw new HTTPException(409, { message: 'Search indexing still in progress for this smol' })
	}

	const refine = normalizeText(params.refine)
	const hints = parseSearchHints(refine)
	const baseCandidates = fuseMatches(await runSimilarSearch(env, params.id, hints))
	baseCandidates.delete(params.id)

	let ranked = baseCandidates
	if (refine) {
		const refinedCandidates = fuseMatches(await runQuerySearch(env, refine, hints))
		refinedCandidates.delete(params.id)
		ranked = blendCandidateMaps(baseCandidates, refinedCandidates, 0.7, 0.3)
	}

	return {
		results: await hydrateRankedCandidates(env, sortCandidates(ranked.values()), clampSearchLimit(params.limit)),
	}
}

async function handleQueueMessage(message: Message<SearchQueueMessage>, env: Env): Promise<SearchQueueDisposition> {
	logSearchEvent('search_queue_message_received', {
		type: message.body.type,
		smolId: 'smolId' in message.body ? message.body.smolId : undefined,
		smolCount: message.body.type === 'upsert_batch' ? message.body.smolIds.length : undefined,
		smolIds: message.body.type === 'upsert_batch' ? message.body.smolIds : undefined,
		attempts: message.attempts,
	})

	switch (message.body.type) {
		case 'upsert':
			return await upsertSmolVectors(env, message.body.smolId, message.attempts)

		case 'upsert_batch':
			return await upsertSmolVectorBatch(env, message.body.smolIds, message.attempts)

		case 'finalize': {
			const vectorIds = message.body.vectorIds
			const result = await finalizeSmolVectors(env, message.body.smolId, vectorIds)
			if (result.action === 'retry' && message.attempts >= SEARCH_FINALIZE_MAX_ATTEMPTS) {
				logSearchEvent('search_finalize_timeout', {
					smolId: message.body.smolId,
					attempts: message.attempts,
					vectorIds,
				})

				await setSearchState(env, message.body.smolId, (existing) => ({
					...(existing ?? createQueuedSearchState()),
					status: 'failed',
					version: SEARCH_INDEX_VERSION,
					indexed_at: existing?.indexed_at,
					vector_ids: vectorIds,
					metadata: existing?.metadata,
					last_error: 'Timed out waiting for Vectorize mutation processing',
					mutation_id: existing?.mutation_id,
					mutation_requested_at: existing?.mutation_requested_at,
				}))
				return ACK_QUEUE_MESSAGE
			}
			return result.action === 'retry'
				? {
					action: 'retry',
					delaySeconds: Math.min(60, result.delaySeconds * Math.max(1, message.attempts)),
				}
				: result
		}

		case 'delete':
			logSearchEvent('search_delete_requested', {
				smolId: message.body.smolId,
				vectorIds: message.body.vectorIds ?? getVectorIdsForSmol(message.body.smolId),
			})
			await deleteSmolVectors(env, message.body.smolId, message.body.vectorIds ?? getVectorIdsForSmol(message.body.smolId))
			return ACK_QUEUE_MESSAGE
	}
}

export async function processSearchQueue(batch: MessageBatch<SearchQueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
	for (const message of batch.messages) {
		try {
			const result = await handleQueueMessage(message, env)
			if (result.action === 'retry') {
				message.retry({
					delaySeconds: result.delaySeconds,
				})
				continue
			}

			message.ack()
		} catch (error) {
			console.warn('Search queue message failed:', message.body, error)

			if (message.attempts >= SEARCH_FINALIZE_MAX_ATTEMPTS) {
				if (message.body.type === 'upsert_batch') {
					await Promise.all(message.body.smolIds.map(async (smolId) => {
						await setSearchState(env, smolId, (existing) => ({
							...(existing ?? createQueuedSearchState()),
							status: 'failed',
							version: SEARCH_INDEX_VERSION,
							indexed_at: existing?.indexed_at,
							vector_ids: existing?.vector_ids ?? getVectorIdsForSmol(smolId),
							metadata: existing?.metadata,
							last_error: error instanceof Error ? error.message : 'Unknown search indexing failure',
							mutation_id: existing?.mutation_id,
							mutation_requested_at: existing?.mutation_requested_at,
						}))
					}))
				} else if (message.body.type !== 'delete') {
					const { smolId } = message.body
					await setSearchState(env, smolId, (existing) => ({
						...(existing ?? createQueuedSearchState()),
						status: 'failed',
						version: SEARCH_INDEX_VERSION,
						indexed_at: existing?.indexed_at,
						vector_ids: existing?.vector_ids ?? getVectorIdsForSmol(smolId),
						metadata: existing?.metadata,
						last_error: error instanceof Error ? error.message : 'Unknown search indexing failure',
						mutation_id: existing?.mutation_id,
						mutation_requested_at: existing?.mutation_requested_at,
					}))
				}
				message.ack()
				continue
			}

			message.retry({
				delaySeconds: Math.min(60, Math.max(5, message.attempts * 5)),
			})
		}
	}
}
