import assert from 'node:assert/strict'
import test from 'node:test'
import { processSearchQueue, SEARCH_INDEX_VERSION } from '../src/utils/search'
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
			send: async () => undefined,
		},
	} as unknown as Env

	return env
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
						data: texts.map((_text, index) => ({
							embedding: [index + 1, index + 2, index + 3],
						})),
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
	const env = createUpsertRetryEnv()
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
