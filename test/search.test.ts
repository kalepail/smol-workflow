import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
	getSearchBackfillCronStatus,
	isSearchQueryableState,
	processSearchQueue,
	queueSearchIndexingBatchById,
	queueSearchIndexingById,
	reconcileSearchIndexingBatchById,
	runSearchBackfillCron,
	TAG_EXTRACTION_MODEL,
	SEARCH_INDEX_VERSION,
} from '../src/utils/search'
import { requireOwnedVisibilityToggle } from '../src/utils/search-visibility'

type MockPreparedStatement = {
	bind: (...args: unknown[]) => {
		first: <T>() => Promise<T | null>
		all: <T>() => Promise<{ results: T[] }>
		run: () => Promise<unknown>
	}
}

function createQueueMessage(body: SearchQueueMessage, attempts = 1) {
	let acked = 0
	const retried: Array<{ delaySeconds: number }> = []

	return {
		message: {
			body,
			attempts,
			ack() {
				acked += 1
			},
			retry(options: { delaySeconds: number }) {
				retried.push(options)
			},
		} as unknown as Message<SearchQueueMessage>,
		get acked() {
			return acked
		},
		get retried() {
			return retried
		},
	}
}

function createFinalizeRetryEnv() {
	const record: WorkflowSteps = {
		payload: {},
		image_base64: undefined,
		description: 'A song',
		lyrics: {
			title: 'Song',
			style: ['dream pop'],
			lyrics: 'hello world',
		},
		nsfw: 'safe',
		song_ids: undefined,
		songs: undefined,
		search: {
			status: 'processing',
			version: SEARCH_INDEX_VERSION,
			queued_at: '2026-03-31T12:00:00.000Z',
			vector_ids: ['smol-1:style', 'smol-1:title', 'smol-1:lyrics', 'smol-1:description'],
			mutation_id: '101',
			mutation_requested_at: '2026-03-31T12:00:01.000Z',
		},
	}

	const env = {
		SMOL_KV: {
			get: async () => record,
		},
		SMOL_D1: {
			prepare(sql: string): MockPreparedStatement {
				return {
					bind() {
						return {
							first: async <T>() => {
								if (sql.includes('SELECT Id, Title, Public, Instrumental')) {
									return {
										Id: 'smol-1',
										Title: 'Song',
										Public: 1,
										Instrumental: 0,
									} as T
								}
								return null as T | null
							},
							all: async <T>() => ({ results: [] as T[] }),
							run: async () => ({ success: true }),
						}
					},
				}
			},
		},
		SMOL_SEARCH_INDEX: {
			describe: async () => ({
				vectorCount: 4,
				dimensions: 1024,
				processedUpToMutation: 100,
				processedUpToDatetime: Date.parse('2026-03-31T12:00:00.500Z'),
			}),
		},
	} as unknown as Env

	return env
}

function createFinalizeTimestampOnlyEnv() {
	let record: WorkflowSteps = {
		payload: {},
		image_base64: undefined,
		description: 'A song',
		lyrics: {
			title: 'Song',
			style: ['dream pop'],
			lyrics: 'hello world',
		},
		nsfw: 'safe',
		song_ids: undefined,
		songs: undefined,
		search: {
			status: 'processing',
			version: SEARCH_INDEX_VERSION,
			queued_at: '2026-03-31T12:00:00.000Z',
			vector_ids: ['smol-1:style', 'smol-1:title', 'smol-1:lyrics', 'smol-1:description'],
			mutation_id: '101',
			mutation_requested_at: '2026-03-31T12:00:01.000Z',
		},
	}

	const env = {
		SMOL_KV: {
			get: async () => record,
			put: async (_key: string, value: string) => {
				record = JSON.parse(value) as WorkflowSteps
			},
		},
		SMOL_D1: {
			prepare(sql: string): MockPreparedStatement {
				return {
					bind() {
						return {
							first: async <T>() => {
								if (sql.includes('SELECT Id, Title, Public, Instrumental')) {
									return {
										Id: 'smol-1',
										Title: 'Song',
										Public: 1,
										Instrumental: 0,
									} as T
								}
								return null as T | null
							},
							all: async <T>() => ({ results: [] as T[] }),
							run: async () => ({ success: true }),
						}
					},
				}
			},
		},
		SMOL_SEARCH_INDEX: {
			describe: async () => ({
				vectorCount: 4,
				dimensions: 1024,
				processedUpToMutation: 'other-mutation',
				processedUpToDatetime: '2026-03-31T12:05:00.000Z',
			}),
		},
	} as unknown as Env

	return {
		env,
		getRecord: () => record,
	}
}

function createFinalizeReadyEnv() {
	let record: WorkflowSteps = {
		payload: {},
		image_base64: undefined,
		description: 'A song',
		lyrics: {
			title: 'Song',
			style: ['dream pop'],
			lyrics: 'hello world',
		},
		nsfw: 'safe',
		song_ids: undefined,
		songs: undefined,
		search: {
			status: 'processing',
			version: SEARCH_INDEX_VERSION,
			queued_at: '2026-03-31T12:00:00.000Z',
			vector_ids: ['smol-1:style', 'smol-1:title', 'smol-1:lyrics', 'smol-1:description'],
			mutation_id: '101',
			mutation_requested_at: '2026-03-31T12:00:01.000Z',
		},
	}

	const env = {
		SMOL_KV: {
			get: async () => record,
			put: async (_key: string, value: string) => {
				record = JSON.parse(value) as WorkflowSteps
			},
		},
		SMOL_D1: {
			prepare(sql: string): MockPreparedStatement {
				return {
					bind() {
						return {
							first: async <T>() => {
								if (sql.includes('SELECT Id, Title, Public, Instrumental')) {
									return {
										Id: 'smol-1',
										Title: 'Song',
										Public: 1,
										Instrumental: 0,
									} as T
								}
								return null as T | null
							},
							all: async <T>() => ({ results: [] as T[] }),
							run: async () => ({ success: true }),
						}
					},
				}
			},
		},
		SMOL_SEARCH_INDEX: {
			describe: async () => ({
				vectorCount: 4,
				dimensions: 1024,
				processedUpToMutation: '101',
				processedUpToDatetime: '2026-03-31T12:00:02.000Z',
			}),
		},
	} as unknown as Env

	return {
		env,
		getRecord: () => record,
	}
}

function createUpsertRetryEnv() {
	const queuedMessages: Array<{ message: SearchQueueMessage; delaySeconds?: number }> = []

	const env = {
		SMOL_KV: {
			get: async () => null,
		},
		SMOL_D1: {
			prepare(sql: string): MockPreparedStatement {
				return {
					bind() {
						return {
							first: async <T>() => {
								if (sql.includes('SELECT Id, Title, Public, Instrumental')) {
									return {
										Id: 'smol-2',
										Title: 'Song',
										Public: 1,
										Instrumental: 0,
									} as T
								}

								if (sql.includes('SELECT Id')) {
									return { Id: 'smol-2' } as T
								}

								return null as T | null
							},
							all: async <T>() => ({ results: [] as T[] }),
							run: async () => ({ success: true }),
						}
					},
				}
			},
		},
		SMOL_SEARCH_INDEX: {
			describe: async () => ({
				vectorCount: 0,
				dimensions: 1024,
				processedUpToMutation: 0,
				processedUpToDatetime: 0,
			}),
		},
		SEARCH_QUEUE: {
			send: async (message: SearchQueueMessage, options?: { delaySeconds?: number }) => {
				queuedMessages.push({ message, delaySeconds: options?.delaySeconds })
			},
		},
	} as unknown as Env

	return {
		env,
		getQueuedMessages: () => queuedMessages,
	}
}

function createInstrumentalUpsertEnv() {
	let record: WorkflowSteps = {
		payload: {
			prompt: 'Warm cinematic instrumental',
		},
		image_base64: undefined,
		description: 'A sweeping instrumental cue with warm strings',
		lyrics: undefined,
		nsfw: 'safe',
		song_ids: undefined,
		songs: undefined,
		search: {
			status: 'queued',
			version: SEARCH_INDEX_VERSION,
			queued_at: '2026-03-31T12:00:00.000Z',
		},
	}

	const finalizeMessages: SearchQueueMessage[] = []
	const upserts: VectorizeVector[][] = []

	const env = {
		AI: {
			run: async (model: string, payload: unknown) => {
				if (model === TAG_EXTRACTION_MODEL) {
					assert.deepEqual((payload as { chat_template_kwargs?: unknown }).chat_template_kwargs, { enable_thinking: false })
					return {
						object: 'chat.completion',
						choices: [{
							index: 0,
							message: {
								role: 'assistant',
								content: JSON.stringify({
									style_primary: 'cinematic',
									mood_primary: 'uplifting',
									theme_primary: 'journey',
									lyric_presence: 'instrumental',
									brightness_level: 'bright',
									energy_level: 'mid',
									modality_guess: 'unknown',
								}, null, 2),
							},
							finish_reason: 'stop',
						}],
					}
				}

				if (model === '@cf/baai/bge-m3') {
					const texts = (payload as { text: string[] }).text
					return {
						data: texts.map((_text, index) => [index + 1, index + 2, index + 3]),
					}
				}

				throw new Error(`Unexpected model: ${model}`)
			},
		},
		SMOL_KV: {
			get: async () => record,
			put: async (_key: string, value: string) => {
				record = JSON.parse(value) as WorkflowSteps
			},
		},
		SMOL_D1: {
			prepare(sql: string): MockPreparedStatement {
				return {
					bind() {
						return {
							first: async <T>() => {
								if (sql.includes('SELECT Id, Title, Public, Instrumental')) {
									return {
										Id: 'smol-inst',
										Title: 'Sunrise Theme',
										Public: 1,
										Instrumental: 1,
									} as T
								}

								if (sql.includes('SELECT Id')) {
									return { Id: 'smol-inst' } as T
								}

								return null as T | null
							},
							all: async <T>() => ({ results: [] as T[] }),
							run: async () => ({ success: true }),
						}
					},
				}
			},
		},
		SMOL_SEARCH_INDEX: {
			upsert: async (vectors: VectorizeVector[]) => {
				upserts.push(vectors)
				return { mutationId: '202' }
			},
		},
		SEARCH_QUEUE: {
			send: async (message: SearchQueueMessage) => {
				finalizeMessages.push(message)
			},
		},
	} as unknown as Env

	return {
		env,
		getRecord: () => record,
		getFinalizeMessages: () => finalizeMessages,
		getUpserts: () => upserts,
	}
}

function createBatchUpsertEnv() {
	let records: Record<string, WorkflowSteps> = {
		'smol-a': {
			payload: {
				prompt: 'Warm dream pop',
			},
			image_base64: undefined,
			description: 'A dreamy late-night pop song',
			lyrics: {
				title: 'Neon River',
				style: ['dream pop'],
				lyrics: 'city lights drift softly through the night',
			},
			nsfw: 'safe',
			song_ids: undefined,
			songs: undefined,
		},
		'smol-b': {
			payload: {
				prompt: 'Dusty desert folk',
			},
			image_base64: undefined,
			description: 'A desert folk ballad with slow percussion',
			lyrics: {
				title: 'Dust Prayer',
				style: ['folk'],
				lyrics: 'embers move slowly under the silver moon',
			},
			nsfw: 'safe',
			song_ids: undefined,
			songs: undefined,
		},
	}

	const finalizeMessages: SearchQueueMessage[] = []
	const queuedMessages: SearchQueueMessage[] = []
	const upserts: VectorizeVector[][] = []
	const aiCalls = {
		metadata: 0,
		embedding: 0,
	}

	let metadataReply: 'ok' | 'garbage' = 'ok'
	const env = {
		AI: {
			run: async (model: string, payload: unknown) => {
				if (model === TAG_EXTRACTION_MODEL) {
					aiCalls.metadata += 1
					if (metadataReply === 'garbage') {
						return { choices: [{ message: { role: 'assistant', content: 'sorry, no JSON today' }, finish_reason: 'stop' }] }
					}
					const title = (payload as { messages: Array<{ content: string }> }).messages[1]?.content ?? ''
					if (title.includes('Neon River')) {
						return {
							response: {
								style_primary: 'dream pop',
								mood_primary: 'dreamy',
								theme_primary: 'nightlife',
								lyric_presence: 'sparse',
								brightness_level: 'bright',
								energy_level: 'mid',
								modality_guess: 'major',
							},
						}
					}

					return {
						response: {
							style_primary: 'folk',
							mood_primary: 'melancholic',
							theme_primary: 'desert',
							lyric_presence: 'sparse',
							brightness_level: 'neutral',
							energy_level: 'low',
							modality_guess: 'minor',
						},
					}
				}

				if (model === '@cf/baai/bge-m3') {
					aiCalls.embedding += 1
					const texts = (payload as { text: string[] }).text
					return {
						data: texts.map((_text, index) => [index + 1, index + 2, index + 3]),
					}
				}

				throw new Error(`Unexpected model: ${model}`)
			},
		},
		SMOL_KV: {
			get: async (key: string) => records[key] ?? null,
			put: async (key: string, value: string) => {
				records[key] = JSON.parse(value) as WorkflowSteps
			},
		},
		SMOL_D1: {
			prepare(sql: string): MockPreparedStatement {
				return {
					bind(id: string) {
						return {
							first: async <T>() => {
								if (!records[id]) {
									return null as T | null
								}

								if (sql.includes('SELECT Id, Title, Public, Instrumental')) {
									return {
										Id: id,
										Title: records[id]?.lyrics?.title ?? 'Song',
										Public: 1,
										Instrumental: 0,
									} as T
								}

								if (sql.includes('SELECT Id')) {
									return { Id: id } as T
								}

								return null as T | null
							},
							all: async <T>() => ({ results: [] as T[] }),
							run: async () => ({ success: true }),
						}
					},
				}
			},
		},
		SMOL_SEARCH_INDEX: {
			describe: async () => ({
				vectorCount: 0,
				dimensions: 1024,
				processedUpToMutation: 'old-mutation',
				processedUpToDatetime: '2026-03-31T11:59:00.000Z',
			}),
			upsert: async (vectors: VectorizeVector[]) => {
				upserts.push(vectors)
				return { mutationId: 'batch-1' }
			},
		},
		SEARCH_QUEUE: {
			send: async (message: SearchQueueMessage) => {
				queuedMessages.push(message)
				if (message.type === 'finalize') {
					finalizeMessages.push(message)
				}
			},
		},
	} as unknown as Env

	return {
		env,
		getRecords: () => records,
		getFinalizeMessages: () => finalizeMessages,
		getQueuedMessages: () => queuedMessages,
		getUpserts: () => upserts,
		getAiCalls: () => aiCalls,
		setMetadataReply: (reply: 'ok' | 'garbage') => { metadataReply = reply },
	}
}

function createReadyRequeueEnv() {
	let record: WorkflowSteps = {
		payload: {},
		image_base64: undefined,
		description: 'A searchable song',
		lyrics: {
			title: 'Song',
			style: ['dream pop'],
			lyrics: 'hello world',
		},
		nsfw: 'safe',
		song_ids: undefined,
		songs: undefined,
		search: {
			status: 'ready',
			version: SEARCH_INDEX_VERSION,
			queued_at: '2026-03-31T12:00:00.000Z',
			indexed_at: '2026-03-31T12:05:00.000Z',
			vector_ids: ['smol-ready:style', 'smol-ready:title', 'smol-ready:lyrics', 'smol-ready:description'],
			metadata: {
				style_primary: 'dream pop',
				mood_primary: 'dreamy',
				theme_primary: 'night',
				lyric_presence: 'lyric-heavy',
				brightness_level: 'neutral',
				energy_level: 'mid',
				modality_guess: 'mixed',
				style_tags: ['dream pop'],
				title: 'Song',
			},
		},
	}

	const queueMessages: SearchQueueMessage[] = []

	const env = {
		SMOL_KV: {
			get: async () => record,
			put: async (_key: string, value: string) => {
				record = JSON.parse(value) as WorkflowSteps
			},
		},
		SEARCH_QUEUE: {
			send: async (message: SearchQueueMessage) => {
				queueMessages.push(message)
			},
		},
	} as unknown as Env

	return {
		env,
		getRecord: () => record,
		getQueueMessages: () => queueMessages,
	}
}

function createReconcileEnv() {
	let records: Record<string, WorkflowSteps> = {
		'smol-ready': {
			payload: {},
			image_base64: undefined,
			description: 'Timed out but now processed',
			lyrics: {
				title: 'Recovered Song',
				style: ['dream pop'],
				lyrics: 'hello world',
			},
			nsfw: 'safe',
			song_ids: undefined,
			songs: undefined,
			search: {
				status: 'failed',
				version: SEARCH_INDEX_VERSION,
				queued_at: '2026-03-31T12:00:00.000Z',
				mutation_id: 'mutation-ready',
				mutation_requested_at: '2026-03-31T12:00:05.000Z',
				vector_ids: ['smol-ready:style'],
			},
		},
		'smol-requeue': {
			payload: {},
			image_base64: undefined,
			description: 'Failed long ago',
			lyrics: {
				title: 'Retry Song',
				style: ['folk'],
				lyrics: 'hello world',
			},
			nsfw: 'safe',
			song_ids: undefined,
			songs: undefined,
			search: {
				status: 'failed',
				version: SEARCH_INDEX_VERSION,
				queued_at: '2026-03-31T11:00:00.000Z',
			},
		},
	}

	const queuedMessages: SearchQueueMessage[] = []

	const env = {
		SMOL_KV: {
			get: async (key: string) => records[key] ?? null,
			put: async (key: string, value: string) => {
				records[key] = JSON.parse(value) as WorkflowSteps
			},
		},
		SMOL_SEARCH_INDEX: {
			describe: async () => ({
				vectorCount: 10,
				dimensions: 1024,
				processedUpToMutation: 'mutation-other',
				processedUpToDatetime: '2026-03-31T12:30:00.000Z',
			}),
		},
		SEARCH_QUEUE: {
			send: async (message: SearchQueueMessage) => {
				queuedMessages.push(message)
			},
		},
	} as unknown as Env

	return {
		env,
		getRecords: () => records,
		getQueuedMessages: () => queuedMessages,
	}
}

function createCronBackfillEnv(options: {
	savedState?: Record<string, unknown>
	records: Record<string, WorkflowSteps>
	pages?: Array<Array<{ Id: string; Created_At: string }>>
}) {
	const kv = new Map<string, WorkflowSteps | Record<string, unknown>>(Object.entries(options.records))
	const queueMessages: SearchQueueMessage[] = []
	const pages = options.pages ?? [[
		{ Id: 'smol-a', Created_At: '2026-03-31 12:00:00' },
		{ Id: 'smol-b', Created_At: '2026-03-31 11:00:00' },
	]]
	let pageReads = 0
	if (options.savedState) {
		kv.set('__internal:search-backfill:v2', options.savedState)
	}

	const env = {
		SEARCH_BACKFILL_CRON_ENABLED: 'true',
		SMOL_KV: {
			get: async (key: string) => kv.get(key) ?? null,
			put: async (key: string, value: string) => {
				kv.set(key, JSON.parse(value) as WorkflowSteps)
			},
		},
		SMOL_D1: {
			prepare(sql: string): MockPreparedStatement {
				return {
					bind() {
						return {
							first: async <T>() => null as T | null,
							all: async <T>() => {
								if (!sql.includes('SELECT Id, Created_At')) return { results: [] as T[] }
								const rows = pages[pageReads] ?? []
								pageReads += 1
								// The page query reads LIMIT + 1, so pad a page with later pages up to the limit plus a probe row.
								const filler = pageReads < pages.length
									? Array.from({ length: 21 - rows.length }, (_, i) => ({ Id: `smol-pad-${pageReads}-${i}`, Created_At: '2000-01-01 00:00:00' }))
									: []
								return { results: [...rows, ...filler].slice(0, 21) as T[] }
							},
							run: async () => ({ success: true }),
						}
					},
				}
			},
		},
		SMOL_SEARCH_INDEX: {
			describe: async () => ({
				vectorCount: 10,
				dimensions: 1024,
				processedUpToMutation: 'mutation-other',
				processedUpToDatetime: '2026-03-31T12:30:00.000Z',
			}),
		},
		SEARCH_QUEUE: {
			send: async (message: SearchQueueMessage) => {
				queueMessages.push(message)
			},
		},
	} as unknown as Env

	return {
		env,
		getQueueMessages: () => queueMessages,
		getState: () => kv.get('__internal:search-backfill:v2') as Record<string, unknown> | undefined,
		getPageReads: () => pageReads,
	}
}

function cronRecord(title: string, search?: WorkflowSteps['search']): WorkflowSteps {
	return {
		payload: {},
		image_base64: undefined,
		description: `${title} description`,
		lyrics: { title, style: ['dream pop'], lyrics: `${title} lyrics` },
		nsfw: 'safe',
		song_ids: undefined,
		songs: undefined,
		...(search ? { search } : {}),
	} as WorkflowSteps
}

const READY_SEARCH = { status: 'ready', version: SEARCH_INDEX_VERSION, indexed_at: '2026-03-31T12:05:00.000Z' } as WorkflowSteps['search']

test('visibility toggle requires an owned row before any search sync can run', () => {
	assert.throws(
		() => requireOwnedVisibilityToggle(null),
		(error: unknown) => error instanceof Error && 'status' in error && (error as { status: number }).status === 404
	)
})

test('finalize queue message retries without ack while mutation is still processing', async () => {
	const env = createFinalizeRetryEnv()
	const queued = createQueueMessage({
		type: 'finalize',
		smolId: 'smol-1',
		vectorIds: ['smol-1:style', 'smol-1:title', 'smol-1:lyrics', 'smol-1:description'],
	})

	await processSearchQueue(
		{ messages: [queued.message] } as unknown as MessageBatch<SearchQueueMessage>,
		env,
		{} as ExecutionContext
	)

	assert.equal(queued.acked, 0)
	assert.equal(queued.retried.length, 1)
	assert.equal(queued.retried[0]?.delaySeconds, 8)
})

test('finalize queue message marks a smol ready once the Vectorize mutation is processed', async () => {
	const { env, getRecord } = createFinalizeReadyEnv()
	const queued = createQueueMessage({
		type: 'finalize',
		smolId: 'smol-1',
		vectorIds: ['smol-1:style', 'smol-1:title', 'smol-1:lyrics', 'smol-1:description'],
	})

	await processSearchQueue(
		{ messages: [queued.message] } as unknown as MessageBatch<SearchQueueMessage>,
		env,
		{} as ExecutionContext
	)

	assert.equal(queued.acked, 1)
	assert.equal(queued.retried.length, 0)
	assert.equal(getRecord().search?.status, 'ready')
	assert.equal(getRecord().search?.version, SEARCH_INDEX_VERSION)
	assert.ok(getRecord().search?.indexed_at)
})

test('finalize queue message keeps retrying when only the processed timestamp has advanced', async () => {
	const { env, getRecord } = createFinalizeTimestampOnlyEnv()
	const queued = createQueueMessage({
		type: 'finalize',
		smolId: 'smol-1',
		vectorIds: ['smol-1:style', 'smol-1:title', 'smol-1:lyrics', 'smol-1:description'],
	})

	await processSearchQueue(
		{ messages: [queued.message] } as unknown as MessageBatch<SearchQueueMessage>,
		env,
		{} as ExecutionContext
	)

	assert.equal(queued.acked, 0)
	assert.equal(queued.retried.length, 1)
	assert.equal(getRecord().search?.status, 'processing')
})

test('upsert queue message retries on the same message when D1 exists but KV payload is not yet visible', async () => {
	const { env, getQueuedMessages } = createUpsertRetryEnv()
	const queued = createQueueMessage({
		type: 'upsert',
		smolId: 'smol-2',
	})

	await processSearchQueue(
		{ messages: [queued.message] } as unknown as MessageBatch<SearchQueueMessage>,
		env,
		{} as ExecutionContext
	)

	assert.equal(queued.acked, 0)
	assert.equal(queued.retried.length, 1)
	assert.equal(queued.retried[0]?.delaySeconds, 5)
	assert.equal(getQueuedMessages().length, 0)
})

test('upsert queue message indexes an instrumental smol even when lyrics are missing', async () => {
	const { env, getRecord, getFinalizeMessages, getUpserts } = createInstrumentalUpsertEnv()
	const queued = createQueueMessage({
		type: 'upsert',
		smolId: 'smol-inst',
	})

	await processSearchQueue(
		{ messages: [queued.message] } as unknown as MessageBatch<SearchQueueMessage>,
		env,
		{} as ExecutionContext
	)

	assert.equal(queued.acked, 1)
	assert.equal(queued.retried.length, 0)
	assert.equal(getUpserts().length, 1)
	assert.equal(getUpserts()[0]?.length, 4)
	assert.equal(new Set(getUpserts()[0]?.map((vector) => vector.id)).size, 4)
	assert.ok(getUpserts()[0]?.every((vector) => vector.id.length <= 64))
	assert.ok(getUpserts()[0]?.every((vector) => vector.metadata?.style_primary === 'cinematic'))
	assert.equal(getRecord().search?.status, 'processing')
	assert.equal(getRecord().search?.mutation_id, '202')
	assert.equal(getFinalizeMessages().length, 1)
	assert.equal(getFinalizeMessages()[0]?.type, 'finalize')
})

test('batch queue helper marks songs queued and sends a batched upsert message', async () => {
	const { env, getRecords, getQueuedMessages } = createBatchUpsertEnv()

	const batch = await queueSearchIndexingBatchById(env, ['smol-a', 'smol-b'])

	assert.deepEqual(batch.queuedIds, ['smol-a', 'smol-b'])
	assert.deepEqual(batch.skipped, { current: 0, pending: 0, missing: 0 })
	assert.equal(getRecords()['smol-a']?.search?.status, 'queued')
	assert.equal(getRecords()['smol-b']?.search?.status, 'queued')
	assert.equal(getQueuedMessages().length, 1)
	assert.equal(getQueuedMessages()[0]?.type, 'upsert_batch')
	assert.deepEqual((getQueuedMessages()[0] as Extract<SearchQueueMessage, { type: 'upsert_batch' }>).smolIds, ['smol-a', 'smol-b'])
})

test('upsert_batch queue message indexes multiple smols in one Vectorize request', async () => {
	const { env, getRecords, getFinalizeMessages, getUpserts } = createBatchUpsertEnv()
	const queued = createQueueMessage({
		type: 'upsert_batch',
		smolIds: ['smol-a', 'smol-b'],
	})

	await processSearchQueue(
		{ messages: [queued.message] } as unknown as MessageBatch<SearchQueueMessage>,
		env,
		{} as ExecutionContext
	)

	assert.equal(queued.acked, 1)
	assert.equal(queued.retried.length, 0)
	assert.equal(getUpserts().length, 1)
	assert.equal(getUpserts()[0]?.length, 8)
	assert.equal(getFinalizeMessages().length, 2)
	assert.deepEqual(getFinalizeMessages().map((message) => message.smolId).sort(), ['smol-a', 'smol-b'])
	assert.equal(getRecords()['smol-a']?.search?.status, 'processing')
	assert.equal(getRecords()['smol-b']?.search?.status, 'processing')
	assert.equal(getRecords()['smol-a']?.search?.mutation_id, 'batch-1')
	assert.equal(getRecords()['smol-b']?.search?.mutation_id, 'batch-1')
})

test('batch queue helper skips current, pending, and missing records unless forced', async () => {
	const { env, getRecords, getQueuedMessages } = createBatchUpsertEnv()
	const records = getRecords()
	records['smol-a'].search = { status: 'ready', version: SEARCH_INDEX_VERSION, indexed_at: '2026-03-31T12:05:00.000Z' }
	records['smol-b'].search = {
		status: 'failed',
		version: SEARCH_INDEX_VERSION,
		mutation_id: 'new-mutation',
		mutation_requested_at: '2026-03-31T12:10:00.000Z',
	}

	const skipped = await queueSearchIndexingBatchById(env, ['smol-a', 'smol-b', 'missing'])
	assert.deepEqual(skipped.queuedIds, [])
	assert.deepEqual(skipped.skipped, { current: 1, pending: 1, missing: 1 })
	assert.equal(getQueuedMessages().length, 0)

	const forced = await queueSearchIndexingBatchById(env, ['smol-a', 'smol-b'], { force: true })
	assert.deepEqual(forced.queuedIds, ['smol-a', 'smol-b'])
	assert.deepEqual(forced.skipped, { current: 0, pending: 0, missing: 0 })
	assert.equal(getQueuedMessages().length, 1)
})

test('upsert reuses cached metadata when the source hash is unchanged', async () => {
	const { env, getRecords, getAiCalls } = createBatchUpsertEnv()
	const record = getRecords()['smol-a']
	if (!record) {
		throw new Error('Expected smol-a record')
	}

	record.search = {
		status: 'queued',
		version: SEARCH_INDEX_VERSION,
		metadata: {
		style_primary: 'cached style',
		mood_primary: 'cached mood',
		theme_primary: 'cached theme',
		lyric_presence: 'sparse',
		brightness_level: 'neutral',
		energy_level: 'mid',
		modality_guess: 'mixed',
		style_tags: ['cached'],
		title: 'Neon River',
		},
		source_hash: createHash('sha256')
		.update(JSON.stringify({
			id: 'smol-a',
			title: 'Neon River',
			public: true,
			instrumental: false,
			prompt: 'Warm dream pop',
			description: 'A dreamy late-night pop song',
			lyrics_title: 'Neon River',
			lyrics: 'city lights drift softly through the night',
			style: ['dream pop'],
		}))
		.digest('hex'),
	}

	const queued = createQueueMessage({
		type: 'upsert',
		smolId: 'smol-a',
	})

	await processSearchQueue(
		{ messages: [queued.message] } as unknown as MessageBatch<SearchQueueMessage>,
		env,
		{} as ExecutionContext
	)

	assert.equal(queued.acked, 1)
	assert.equal(getAiCalls().metadata, 0)
	assert.equal(getAiCalls().embedding, 1)
})

test('upsert falls back to heuristic metadata after one unparseable model reply (no second LLM call)', async () => {
	const { env, getRecords, getAiCalls, setMetadataReply } = createBatchUpsertEnv()
	setMetadataReply('garbage')
	const queued = createQueueMessage({ type: 'upsert', smolId: 'smol-a' })
	await processSearchQueue({ messages: [queued.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)

	assert.equal(queued.acked, 1)
	assert.equal(getAiCalls().metadata, 1)
	assert.equal(getRecords()['smol-a']?.search?.metadata?.style_primary, 'dream pop')
})

test('reconcile marks failed records ready once the processed watermark has moved past them', async () => {
	const { env, getRecords, getQueuedMessages } = createReconcileEnv()

	const result = await reconcileSearchIndexingBatchById(env, ['smol-ready'])

	assert.deepEqual(result.readyIds, ['smol-ready'])
	assert.deepEqual(result.requeuedIds, [])
	assert.equal(getRecords()['smol-ready']?.search?.status, 'ready')
	assert.ok(getRecords()['smol-ready']?.search?.indexed_at)
	assert.equal(getQueuedMessages().length, 0)
})

test('reconcile requeues failed records whose old mutation is no longer pending', async () => {
	const { env, getRecords, getQueuedMessages } = createReconcileEnv()

	const result = await reconcileSearchIndexingBatchById(env, ['smol-requeue'])

	assert.deepEqual(result.readyIds, [])
	assert.deepEqual(result.requeuedIds, ['smol-requeue'])
	assert.equal(getRecords()['smol-requeue']?.search?.status, 'queued')
	assert.equal(getQueuedMessages().length, 1)
	assert.equal(getQueuedMessages()[0]?.type, 'upsert')
})

test('search state remains queryable while a previously indexed smol is being refreshed', async () => {
	const { env, getRecord, getQueueMessages } = createReadyRequeueEnv()

	const queued = await queueSearchIndexingById(env, 'smol-ready')

	assert.equal(queued, true)
	assert.equal(getRecord().search?.status, 'queued')
	assert.equal(getRecord().search?.indexed_at, '2026-03-31T12:05:00.000Z')
	assert.equal(isSearchQueryableState(getRecord().search), true)
	assert.equal(getQueueMessages().length, 1)
	assert.equal(getQueueMessages()[0]?.type, 'upsert')
})

test('search state is not queryable before the first successful index', () => {
	assert.equal(isSearchQueryableState(undefined), false)
	assert.equal(isSearchQueryableState({
		status: 'processing',
		version: SEARCH_INDEX_VERSION,
	}), false)
	assert.equal(isSearchQueryableState({
		status: 'hidden',
		version: SEARCH_INDEX_VERSION,
		indexed_at: '2026-03-31T12:05:00.000Z',
	}), false)
})

test('scheduled backfill cron holds its cursor while the page has queued or pending work (legacy saved state is tolerated)', async () => {
	const { env, getQueueMessages, getState } = createCronBackfillEnv({
		// The pre-simplification state shape (stall history, nested reconcile stats) still lives in KV.
		savedState: {
			version: SEARCH_INDEX_VERSION,
			status: 'waiting',
			health: 'watching',
			cursor: 'cursor-1',
			updated_at: '2026-03-31T12:00:00.000Z',
			consecutive_stalled_runs: 3,
			last_stats: { page_size: 2, queued: 0, reconcile: { ready: 0, requeued: 0, skipped: { pending: 2 } }, has_more: true },
			recent_runs: [],
		},
		records: { 'smol-a': cronRecord('Song A'), 'smol-b': cronRecord('Song B') },
	})

	assert.deepEqual(await getSearchBackfillCronStatus(env).then((r) => [r.status, r.cursor, r.pending]), ['waiting', 'cursor-1', 2])
	const result = await runSearchBackfillCron(env)
	assert.deepEqual([result.status, result.cursor, result.queued, result.pending], ['waiting', 'cursor-1', 2, 2])
	assert.deepEqual(getQueueMessages().map((m) => m.type), ['upsert_batch'])
	assert.deepEqual([getState()?.status, getState()?.cursor, 'recent_runs' in getState()!], ['waiting', 'cursor-1', false])
})

test('scheduled backfill cron advances across stable pages, stops on a pending page, and is a no-op once complete', async () => {
	const { env, getQueueMessages, getState, getPageReads } = createCronBackfillEnv({
		savedState: { version: SEARCH_INDEX_VERSION, status: 'idle', cursor: 'cursor-1', updated_at: '2026-03-31T12:00:00.000Z' },
		pages: [
			[{ Id: 'smol-a', Created_At: '2026-03-31 12:00:00' }, { Id: 'smol-b', Created_At: '2026-03-31 11:00:00' }],
			[{ Id: 'smol-c', Created_At: '2026-03-31 10:00:00' }, { Id: 'smol-d', Created_At: '2026-03-31 09:00:00' }],
		],
		records: {
			'smol-a': cronRecord('Song A', READY_SEARCH),
			'smol-b': cronRecord('Song B', READY_SEARCH),
			'smol-c': cronRecord('Song C'),
			'smol-d': cronRecord('Song D'),
			...Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`smol-pad-1-${i}`, cronRecord(`Pad ${i}`, READY_SEARCH)])),
		},
	})

	const waiting = await runSearchBackfillCron(env)
	assert.equal(getPageReads(), 2)
	assert.equal(waiting.status, 'waiting')
	assert.equal(waiting.queued, 2)
	assert.equal(waiting.pending, 2)
	assert.ok(waiting.cursor && waiting.cursor !== 'cursor-1', 'cursor advanced past the stable page and holds on the pending one')
	assert.equal(getQueueMessages().length, 1)
	assert.equal(getState()?.cursor, waiting.cursor)

	// Once the pending page is indexed and no later page exists, the sweep completes and then stays idle.
	const stable = createCronBackfillEnv({
		records: { 'smol-a': cronRecord('Song A', READY_SEARCH), 'smol-b': cronRecord('Song B', READY_SEARCH) },
	})
	const complete = await runSearchBackfillCron(stable.env)
	assert.deepEqual([complete.status, complete.cursor, complete.hasMore], ['complete', undefined, false])
	assert.equal(stable.getQueueMessages().length, 0)
	await runSearchBackfillCron(stable.env)
	assert.equal(stable.getPageReads(), 1, 'a complete sweep reads no more pages')
})

test('scheduled backfill cron and its status are inert when SEARCH_BACKFILL_CRON_ENABLED is not "true"', async () => {
	const { env, getPageReads } = createCronBackfillEnv({ records: {} })
	;(env as unknown as Record<string, unknown>).SEARCH_BACKFILL_CRON_ENABLED = 'false'
	assert.equal((await runSearchBackfillCron(env)).status, 'disabled')
	assert.equal((await getSearchBackfillCronStatus(env)).status, 'disabled')
	assert.equal(getPageReads(), 0)
})
