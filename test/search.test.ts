import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
	isSearchQueryableState,
	processSearchQueue,
	queueSearchIndexingBatchById,
	queueSearchIndexingById,
	SEARCH_INDEX_VERSION,
} from '../src/utils/search'
import { requireOwnedVisibilityToggle } from '../src/utils/search-visibility'

type MockPreparedStatement = {
	bind: (...args: unknown[]) => {
		first: <T>() => Promise<T | null>
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
				if (model === '@cf/meta/llama-3.2-3b-instruct') {
					return {
						response: {
							style_primary: 'cinematic',
							mood_primary: 'uplifting',
							theme_primary: 'journey',
							lyric_presence: 'instrumental',
							brightness_level: 'bright',
							energy_level: 'mid',
							modality_guess: 'unknown',
						},
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

	const env = {
		AI: {
			run: async (model: string, payload: unknown) => {
				if (model === '@cf/meta/llama-3.2-3b-instruct') {
					aiCalls.metadata += 1
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

test('upsert queue message retries when D1 exists but KV payload is not yet visible', async () => {
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

	assert.equal(queued.acked, 1)
	assert.equal(queued.retried.length, 0)
	assert.equal(getQueuedMessages().length, 1)
	assert.equal(getQueuedMessages()[0]?.message.type, 'upsert')
	assert.equal(getQueuedMessages()[0]?.delaySeconds, 5)
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

	records['smol-a'].search = {
		status: 'ready',
		version: SEARCH_INDEX_VERSION,
		indexed_at: '2026-03-31T12:05:00.000Z',
	}

	records['smol-b'].search = {
		status: 'failed',
		version: SEARCH_INDEX_VERSION,
		mutation_id: 'new-mutation',
		mutation_requested_at: '2026-03-31T12:10:00.000Z',
	}

	const batch = await queueSearchIndexingBatchById(env, ['smol-a', 'smol-b', 'missing'])

	assert.deepEqual(batch.queuedIds, [])
	assert.deepEqual(batch.skipped, { current: 1, pending: 1, missing: 1 })
	assert.equal(getQueuedMessages().length, 0)
})

test('batch queue helper force option overrides current and pending skips', async () => {
	const { env, getRecords, getQueuedMessages } = createBatchUpsertEnv()
	const records = getRecords()

	records['smol-a'].search = {
		status: 'ready',
		version: SEARCH_INDEX_VERSION,
		indexed_at: '2026-03-31T12:05:00.000Z',
	}

	records['smol-b'].search = {
		status: 'failed',
		version: SEARCH_INDEX_VERSION,
		mutation_id: 'new-mutation',
		mutation_requested_at: '2026-03-31T12:10:00.000Z',
	}

	const batch = await queueSearchIndexingBatchById(env, ['smol-a', 'smol-b'], { force: true })

	assert.deepEqual(batch.queuedIds, ['smol-a', 'smol-b'])
	assert.deepEqual(batch.skipped, { current: 0, pending: 0, missing: 0 })
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
