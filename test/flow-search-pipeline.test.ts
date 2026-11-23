import assert from 'node:assert/strict'
import test from 'node:test'
import {
	processSearchDLQ,
	processSearchQueue,
	SEARCH_INDEX_VERSION,
	TAG_EXTRACTION_MODEL,
} from '../src/utils/search'

function makeQueueMessage(body: SearchQueueMessage, attempts = 1) {
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

test('Gate 4a: missing KV with present D1 retries on the SAME message up to limit (no infinite re-send), then routes to DLQ', async () => {
	const sentMessages: SearchQueueMessage[] = []
	const env = {
		SMOL_KV: {
			get: async () => null,
		},
		SMOL_D1: {
			prepare(sql: string) {
				return {
					bind() {
						return {
							first: async () => {
								if (sql.includes('SELECT Id, Title, Public, Instrumental')) {
									return { Id: 'orphan-1', Title: 'Orphan', Public: 1, Instrumental: 0 }
								}
								if (sql.includes('SELECT Id')) {
									return { Id: 'orphan-1' }
								}
								return null
							},
						}
					},
				}
			},
		},
		SEARCH_QUEUE: {
			send: async (msg: SearchQueueMessage) => {
				sentMessages.push(msg)
			},
		},
	} as unknown as Env

	// Attempt 1: retries the original message itself without enqueueing a fresh attempt=1 message
	const attempt1 = makeQueueMessage({ type: 'upsert', smolId: 'orphan-1' }, 1)
	await processSearchQueue({ messages: [attempt1.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)
	assert.equal(attempt1.acked, 0)
	assert.equal(attempt1.retried.length, 1)
	assert.equal(sentMessages.length, 0, 'Must NOT re-send a brand new upsert message (breaks infinite loop)')

	// Attempt 12 (terminal, D1 exists without KV): routes to DLQ by calling retry without acking
	const attempt12 = makeQueueMessage({ type: 'upsert', smolId: 'orphan-1' }, 12)
	await processSearchQueue({ messages: [attempt12.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)
	assert.equal(attempt12.acked, 0, 'Terminal missing-KV orphan should route to DLQ, not silently ack')
	assert.equal(attempt12.retried.length, 1)
	assert.equal(sentMessages.length, 0)
})

test('Gate 4b: mixed upsert_batch embeds ready item ONCE and splits only the missing item to a single upsert', async () => {
	const sentMessages: Array<{ msg: SearchQueueMessage; delaySeconds?: number }> = []
	let embedCalls = 0
	const records: Record<string, WorkflowSteps> = {
		'ready-1': {
			payload: { prompt: 'bright synth pop' },
			image_base64: undefined,
			description: 'Neon city',
			lyrics: { title: 'Bright Lights', style: ['synthpop'], lyrics: 'shine tonight' },
			nsfw: { safe: true, categories: [] },
			song_ids: undefined,
			songs: undefined,
		},
	}

	const env = {
		AI: {
			run: async (model: string, payload: unknown) => {
				if (model === TAG_EXTRACTION_MODEL) {
					return {
						response: {
							style_primary: 'synthpop',
							mood_primary: 'bright',
							theme_primary: 'city',
							lyric_presence: 'sparse',
							brightness_level: 'bright',
							energy_level: 'high',
							modality_guess: 'major',
						},
					}
				}
				if (model === '@cf/baai/bge-m3') {
					embedCalls += 1
					const texts = (payload as { text: string[] }).text
					return { data: texts.map((_, i) => [i + 1, i + 2]) }
				}
				throw new Error(`Unexpected model: ${model}`)
			},
		},
		SMOL_KV: {
			get: async (key: string) => records[key] ?? null,
			put: async (key: string, val: string) => { records[key] = JSON.parse(val) },
		},
		SMOL_D1: {
			prepare(sql: string) {
				return {
					bind(id: string) {
						return {
							first: async () => {
								if (sql.includes('SELECT Id, Title, Public, Instrumental')) {
									return { Id: id, Title: id === 'ready-1' ? 'Bright Lights' : 'Missing KV', Public: 1, Instrumental: 0 }
								}
								if (sql.includes('SELECT Id')) return { Id: id }
								return null
							},
						}
					},
				}
			},
		},
		SMOL_SEARCH_INDEX: {
			upsert: async () => ({ mutationId: 'mut-mixed-1' }),
		},
		SEARCH_QUEUE: {
			send: async (msg: SearchQueueMessage, opts?: { delaySeconds?: number }) => {
				sentMessages.push({ msg, delaySeconds: opts?.delaySeconds })
			},
		},
	} as unknown as Env

	const batchMsg = makeQueueMessage({ type: 'upsert_batch', smolIds: ['ready-1', 'missing-kv-1'] }, 1)
	await processSearchQueue({ messages: [batchMsg.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)

	assert.equal(batchMsg.acked, 1, 'Mixed batch ACKs after processing ready rows and splitting missing row')
	assert.equal(embedCalls, 1)
	const splitUpserts = sentMessages.filter((m) => m.msg.type === 'upsert')
	assert.equal(splitUpserts.length, 1)
	assert.equal((splitUpserts[0].msg as Extract<SearchQueueMessage, { type: 'upsert' }>).smolId, 'missing-kv-1')

	const finalizes = sentMessages.filter((m) => m.msg.type === 'finalize')
	assert.equal(finalizes.length, 1)
	const finMsg = finalizes[0].msg as Extract<SearchQueueMessage, { type: 'finalize' }>
	assert.equal(finMsg.smolId, 'ready-1')
	assert.equal(finMsg.mutationId, 'mut-mixed-1')
	assert.ok(finMsg.sourceHash)
})

test('Gate 4c: advanced watermark verifies all 4 vectors + source_hash via getByIds, and stale finalize never clobbers hidden/newer state', async () => {
	const vectorIds = ['smol-1:s', 'smol-1:t', 'smol-1:l', 'smol-1:d']
	let record: WorkflowSteps = {
		payload: { prompt: 'ocean' },
		image_base64: undefined,
		description: 'Ocean',
		lyrics: { title: 'Ocean', style: ['ambient'], lyrics: 'waves' },
		nsfw: { safe: true, categories: [] },
		song_ids: undefined,
		songs: undefined,
		search: {
			status: 'processing',
			version: SEARCH_INDEX_VERSION,
			queued_at: '2026-11-23T12:00:00.000Z',
			vector_ids: vectorIds,
			source_hash: 'rev-hash-1',
			mutation_id: 'M1',
			mutation_requested_at: '2026-11-23T12:00:01.000Z',
		},
	}

	let storedVectors: Array<{ id: string; metadata: Record<string, unknown> }> = vectorIds.map((id) => ({
		id,
		metadata: {
			smol_id: 'smol-1',
			search_version: SEARCH_INDEX_VERSION,
			public: true,
			source_hash: 'rev-hash-1',
		},
	}))

	const env = {
		SMOL_KV: {
			get: async () => record,
			put: async (_k: string, val: string) => { record = JSON.parse(val) },
		},
		SMOL_D1: {
			prepare() {
				return {
					bind() {
						return {
							first: async () => ({ Id: 'smol-1', Title: 'Ocean', Public: 1, Instrumental: 0 }),
						}
					},
				}
			},
		},
		SMOL_SEARCH_INDEX: {
			describe: async () => ({
				vectorCount: 8,
				dimensions: 1024,
				// Another concurrent write M2 advanced the watermark past M1!
				processedUpToMutation: 'M2',
				processedUpToDatetime: '2026-11-23T12:00:10.000Z',
			}),
			getByIds: async (ids: string[]) => storedVectors.filter((v) => ids.includes(v.id)),
		},
	} as unknown as Env

	// 1. If a vector has an older/mismatched source_hash, finalize keeps retrying
	storedVectors[3].metadata.source_hash = 'stale-hash'
	const mismatchMsg = makeQueueMessage({
		type: 'finalize',
		smolId: 'smol-1',
		vectorIds,
		mutationId: 'M1',
		sourceHash: 'rev-hash-1',
	})
	await processSearchQueue({ messages: [mismatchMsg.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)
	assert.equal(mismatchMsg.acked, 0)
	assert.equal(mismatchMsg.retried.length, 1)
	assert.equal(record.search?.status, 'processing')

	// 2. When all 4 vectors match smol_id + version + public + source_hash, finalize marks READY!
	storedVectors[3].metadata.source_hash = 'rev-hash-1'
	const readyMsg = makeQueueMessage({
		type: 'finalize',
		smolId: 'smol-1',
		vectorIds,
		mutationId: 'M1',
		sourceHash: 'rev-hash-1',
	})
	await processSearchQueue({ messages: [readyMsg.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)
	assert.equal(readyMsg.acked, 1)
	assert.equal(record.search?.status, 'ready')

	// 3. Stale finalize message arriving at timeout (attempts=12) after a hide or newer reindex cannot mark failed!
	record.search = {
		status: 'hidden',
		version: SEARCH_INDEX_VERSION,
	}
	const staleHiddenTimeout = makeQueueMessage({
		type: 'finalize',
		smolId: 'smol-1',
		vectorIds,
		mutationId: 'M1',
		sourceHash: 'rev-hash-1',
	}, 12)
	await processSearchQueue({ messages: [staleHiddenTimeout.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)
	assert.equal(staleHiddenTimeout.acked, 1)
	assert.equal(record.search?.status, 'hidden', 'Stale finalize must not overwrite hidden status')

	record.search = {
		status: 'processing',
		version: SEARCH_INDEX_VERSION,
		mutation_id: 'M3-newer',
		source_hash: 'rev-hash-2',
	}
	const staleReindexTimeout = makeQueueMessage({
		type: 'finalize',
		smolId: 'smol-1',
		vectorIds,
		mutationId: 'M1',
		sourceHash: 'rev-hash-1',
	}, 12)
	await processSearchQueue({ messages: [staleReindexTimeout.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)
	assert.equal(staleReindexTimeout.acked, 1)
	assert.equal(record.search?.status, 'processing', 'Stale finalize timeout must not mark newer reindex failed')
	assert.equal(record.search?.mutation_id, 'M3-newer')
})

test('Gate 4d: permanently failing delete routes to DLQ; DLQ preserves failure record and retries on delete failure; exhausted upsert_batch preserves DLQ failure record', async () => {
	let failDelete = true
	const deletedBatches: string[][] = []
	const kvStore = new Map<string, string>()

	const env = {
		SMOL_KV: {
			get: async (key: string, type?: string) => {
				const raw = kvStore.get(key)
				if (raw === undefined) return null
				return type === 'json' ? JSON.parse(raw) : raw
			},
			put: async (key: string, val: string) => { kvStore.set(key, val) },
			delete: async (key: string) => { kvStore.delete(key) },
		},
		SMOL_D1: {
			prepare(sql: string) {
				return {
					bind(id: string) {
						return {
							first: async () => {
								if (sql.includes('SELECT Id')) return { Id: id }
								return null
							},
						}
					},
				}
			},
		},
		SMOL_SEARCH_INDEX: {
			deleteByIds: async (ids: string[]) => {
				if (failDelete) {
					throw new Error('Vectorize temporary outage')
				}
				deletedBatches.push(ids)
			},
		},
		SEARCH_QUEUE: {
			send: async () => {},
		},
	} as unknown as Env

	const deleteMsg = makeQueueMessage({ type: 'delete', smolId: 'del-1' }, 12)
	await processSearchQueue({ messages: [deleteMsg.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)
	assert.equal(deleteMsg.acked, 0, 'Exhausted delete MUST NOT ack so Cloudflare Queues routes it to DLQ')
	assert.equal(deleteMsg.retried.length, 1)

	// DLQ delete failure must NOT ack blindly — preserves KV failure marker and calls retry!
	const dlqFailMsg = makeQueueMessage({ type: 'delete', smolId: 'del-1' }, 1)
	await processSearchDLQ({ messages: [dlqFailMsg.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)
	assert.equal(dlqFailMsg.acked, 0, 'Failed DLQ delete recovery must NOT silently ack')
	assert.equal(dlqFailMsg.retried.length, 1)
	assert.ok(kvStore.has('__internal:search-dlq:delete:del-1'), 'Failed DLQ delete must preserve recoverable record')

	// DLQ consumer recovers the delete when Vectorize comes back and clears marker
	failDelete = false
	const dlqRecoverMsg = makeQueueMessage({ type: 'delete', smolId: 'del-1' }, 2)
	await processSearchDLQ({ messages: [dlqRecoverMsg.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)
	assert.equal(dlqRecoverMsg.acked, 1)
	assert.equal(deletedBatches.length, 1)
	assert.equal(deletedBatches[0].length, 4)
	assert.equal(kvStore.has('__internal:search-dlq:delete:del-1'), false)

	// Exhausted upsert_batch with missing KV item preserves recoverable failure record instead of silently dropping
	const exhaustedBatch = makeQueueMessage({ type: 'upsert_batch', smolIds: ['batch-orphan-1'] }, 12)
	await processSearchQueue({ messages: [exhaustedBatch.message] } as unknown as MessageBatch<SearchQueueMessage>, env, {} as ExecutionContext)
	assert.equal(exhaustedBatch.acked, 1)
	assert.ok(kvStore.has('__internal:search-dlq:upsert:batch-orphan-1'), 'Exhausted batch item DLQ disposition must preserve recoverable record')
})
