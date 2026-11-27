import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import Module from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'

// Stub the workerd-only modules so the real Workflow.run can execute in Node.
const STUBS: Record<string, string> = {
	'cloudflare:workers': `
		class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
		class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
		module.exports = { WorkflowEntrypoint, DurableObject, env: {} }
	`,
	'cloudflare:workflows': `
		class NonRetryableError extends Error { constructor(message) { super(message); this.name = 'NonRetryableError' } }
		module.exports = { NonRetryableError }
	`,
}

// tsx loads this package as CommonJS, so redirect require() resolution of the
// stubbed specifiers to real files. Module._resolveFilename works on Node 18+,
// unlike module.registerHooks (Node >= 22.15).
type ResolveFilename = (request: string, ...rest: unknown[]) => string
const CjsModule = Module as unknown as { _resolveFilename: ResolveFilename }
let stubDir: string | undefined
let originalResolveFilename: ResolveFilename | undefined

before(() => {
	stubDir = mkdtempSync(join(tmpdir(), 'smol-workflow-stubs-'))
	const stubPaths = new Map(Object.entries(STUBS).map(([specifier, source]) => {
		const path = join(stubDir!, `${specifier.replace(':', '-')}.cjs`)
		writeFileSync(path, source)
		return [specifier, path] as const
	}))

	const resolveFilename = CjsModule._resolveFilename
	originalResolveFilename = resolveFilename
	CjsModule._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
		return stubPaths.get(request) ?? resolveFilename.call(this, request, ...rest)
	}
})

after(() => {
	if (originalResolveFilename) {
		CjsModule._resolveFilename = originalResolveFilename
	}
	if (stubDir) {
		rmSync(stubDir, { recursive: true, force: true })
	}
})

// Imported lazily (inside tests) so the resolver patch is active when workflow.ts loads.
let workflowModule: Promise<typeof import('../src/workflow')> | undefined
function loadWorkflow() {
	workflowModule ??= import('../src/workflow')
	return workflowModule
}

const RETRY_ID = 'a'.repeat(64)
const NEW_ID = 'b'.repeat(64)

class SuspendSignal extends Error {}

// Mirrors Workflows replay semantics: a completed step returns its persisted
// (serialized) result and its callback is NOT run again.
function createStep(cache: Map<string, unknown>, suspendBefore?: string) {
	const executed: string[] = []
	const counts = new Map<string, number>()

	function key(name: string) {
		const count = (counts.get(name) ?? 0) + 1
		counts.set(name, count)
		return `${name}#${count}`
	}

	const step = {
		do: async (name: string, configOrFn: unknown, maybeFn?: unknown) => {
			const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<unknown>
			const k = key(name)
			if (cache.has(k)) {
				return structuredClone(cache.get(k))
			}
			if (name === suspendBefore) {
				throw new SuspendSignal(name)
			}
			executed.push(name)
			const result = await fn()
			cache.set(k, result === undefined ? undefined : JSON.parse(JSON.stringify(result)))
			return structuredClone(cache.get(k))
		},
		sleep: async (name: string) => {
			const k = key(name)
			if (cache.has(k)) return
			if (name === suspendBefore) throw new SuspendSignal(name)
			cache.set(k, null)
		},
	}

	return { step, executed }
}

function createEnv(options: { flushedDurableObject?: boolean; coverPng?: Uint8Array | null } = {}) {
	const retryState = {
		payload: {
			address: 'GORIGINALCREATOR',
			prompt: 'a pixel parrot at dusk',
			playlist: 'playlist-1',
			public: true,
			instrumental: false,
		},
		image_base64: 'aW1hZ2UtYnl0ZXM=',
		description: 'A parrot at dusk.',
		lyrics: { title: 'Parrot Dusk', lyrics: 'fly away', style: ['chiptune', 'synthwave'] },
		nsfw: { safe: true, categories: [] },
		song_ids: ['song-1', 'song-2'],
		songs: [
			{ music_id: 'song-1', status: 4, audio: 'https://example.com/1.mp3' },
			{ music_id: 'song-2', status: 4, audio: 'https://example.com/2.mp3' },
		],
		streaming_fingerprints: { 'song-1': { hash: 'x', byteLength: 1, audioUrl: 'u' } },
		search: { status: 'failed' },
	}

	const calls = {
		retryGetSteps: 0,
		saveStep: [] as Array<{ step: string; data: unknown }>,
		d1: [] as Array<{ sql: string; args: unknown[] }>,
		kvPut: [] as string[],
		kvDelete: [] as string[],
		r2Delete: [] as string[],
		r2Get: [] as string[],
		queue: [] as unknown[],
	}
	const coverPng = options.coverPng === undefined ? Buffer.from('image-bytes') : options.coverPng
	const kv = new Map<string, string>()
	if (options.flushedDurableObject) {
		// Published KV detail carries `image: true`; the cover bytes live in R2 as `${id}.png`.
		const { image_base64: _bytes, ...detail } = retryState
		kv.set(RETRY_ID, JSON.stringify({ ...detail, image: true }))
	}

	const retryStub = {
		getSteps: async () => {
			calls.retryGetSteps += 1
			return options.flushedDurableObject ? {} : structuredClone(retryState)
		},
		setToFlush: async () => {},
	}
	const newStub = {
		saveStep: async (step: string, data: unknown) => {
			calls.saveStep.push({ step, data })
		},
		setToFlush: async () => {},
	}

	const env = {
		DURABLE_OBJECT: {
			idFromString: (id: string) => ({ id }),
			get: ({ id }: { id: string }) => (id === RETRY_ID ? retryStub : newStub),
		},
		SMOL_KV: {
			get: async (key: string, type?: string) => {
				const value = kv.get(key)
				if (value === undefined) return null
				return type === 'json' ? JSON.parse(value) : value
			},
			put: async (key: string, value: string) => {
				calls.kvPut.push(key)
				kv.set(key, value)
			},
			delete: async (key: string) => {
				calls.kvDelete.push(key)
				kv.delete(key)
			},
		},
		SMOL_D1: {
			prepare: (sql: string) => ({
				bind: (...args: unknown[]) => ({
					run: async () => {
						calls.d1.push({ sql, args })
					},
					first: async () => null,
				}),
			}),
		},
		SMOL_BUCKET: {
			head: async (key: string) => ({
				key,
				size: 1234,
				customMetadata: { sourceUrl: key === 'song-1.mp3' ? 'https://example.com/1.mp3' : 'https://example.com/2.mp3' },
			}),
			get: async (key: string) => {
				calls.r2Get.push(key)
				if (key !== `${RETRY_ID}.png` || !coverPng) return null
				return { size: coverPng.byteLength, arrayBuffer: async () => new Uint8Array(coverPng).buffer }
			},
			delete: async (key: string) => {
				calls.r2Delete.push(key)
			},
		},
		SEARCH_QUEUE: {
			send: async (message: unknown) => {
				calls.queue.push(message)
			},
		},
		AI: {
			run: async () => {
				throw new Error('AI should not be called when retry state is reused')
			},
		},
	}

	return { env, calls }
}

test('retry workflow restores payload and reused state when the cached retry step is replayed', async () => {
	const { Workflow } = await loadWorkflow()
	const { env, calls } = createEnv()
	const cache = new Map<string, unknown>()
	const event = { payload: { retry_id: RETRY_ID }, instanceId: NEW_ID, timestamp: new Date() }
	const workflow = new Workflow({} as ExecutionContext, env as unknown as Env)
	const originalWarn = console.warn
	console.warn = () => {}

	try {
		// First execution hibernates before the publish step.
		const first = createStep(cache, 'publish smol')
		await assert.rejects(
			workflow.run(event as never, first.step as never),
			SuspendSignal
		)
		assert.ok(first.executed.includes('retry workflow'))

		// Replay: every earlier step comes from cache, including 'retry workflow'.
		const replay = createStep(cache)
		const result = await workflow.run(event as never, replay.step as never) as [WorkflowParams, string]

		assert.deepEqual(replay.executed, ['publish smol', 'enqueue search indexing', 'cleanup retry state', 'finalize workflow'])
		assert.equal(calls.retryGetSteps, 1, 'retry state must not be re-read on replay')

		const [payload, image_base64] = result
		assert.equal(payload.address, 'GORIGINALCREATOR')
		assert.equal(payload.prompt, 'a pixel parrot at dusk')
		assert.equal(payload.playlist, 'playlist-1')
		assert.equal(image_base64, 'aW1hZ2UtYnl0ZXM=')

		const insert = calls.d1.find((call) => call.sql.includes('INSERT INTO Smols'))
		assert.deepEqual(insert?.args, [NEW_ID, 'Parrot Dusk', 'song-1', 'song-2', 'GORIGINALCREATOR', true, false, 'aisonggenerator', null, JSON.stringify(['chiptune', 'synthwave'])])

		const playlistInsert = calls.d1.find((call) => call.sql.includes('INSERT OR IGNORE INTO Playlists'))
		assert.deepEqual(playlistInsert?.args, [NEW_ID, 'playlist-1'])

		assert.equal(calls.d1.some((call) => call.sql.includes('DELETE FROM Smols')), false, 'retry cleanup must never delete D1 Smols rows')
		assert.deepEqual(calls.kvDelete, [RETRY_ID])
		assert.deepEqual(calls.r2Delete, [`${RETRY_ID}.png`], 'reused complete songs must not be deleted')

		const cachedSnapshot = cache.get('retry workflow#1') as Record<string, unknown>
		assert.equal('search' in cachedSnapshot, false)
		assert.equal('streaming_fingerprints' in cachedSnapshot, false)
	} finally {
		console.warn = originalWarn
	}
})

test('retry workflow falls back to KV when the durable object has flushed, and survives replay', async () => {
	const { Workflow } = await loadWorkflow()
	const { env, calls } = createEnv({ flushedDurableObject: true })
	const cache = new Map<string, unknown>()
	const event = { payload: { retry_id: RETRY_ID }, instanceId: NEW_ID, timestamp: new Date() }
	const workflow = new Workflow({} as ExecutionContext, env as unknown as Env)
	const originalWarn = console.warn
	console.warn = () => {}

	try {
		await assert.rejects(
			workflow.run(event as never, createStep(cache, 'publish smol').step as never),
			SuspendSignal
		)
		const [payload, image_base64] = await workflow.run(event as never, createStep(cache).step as never) as [WorkflowParams, string]

		assert.equal(calls.retryGetSteps, 1)
		assert.equal(payload.address, 'GORIGINALCREATOR')
		assert.equal(payload.playlist, 'playlist-1')
		assert.equal(image_base64, 'aW1hZ2UtYnl0ZXM=', 'cover restored from the predecessor PNG in R2')
		assert.deepEqual(calls.r2Get, [`${RETRY_ID}.png`], 'R2 read once; replay reuses the checkpointed snapshot')
		const published = JSON.parse(await env.SMOL_KV.get(NEW_ID) as string) as Record<string, unknown>
		assert.equal(published.image, true)
		assert.equal('image_base64' in published, false, 'KV detail no longer stores cover bytes')
	} finally {
		console.warn = originalWarn
	}
})

test('retry from KV with no predecessor PNG regenerates the cover and re-derives description and NSFW', async () => {
	const { Workflow } = await loadWorkflow()
	const { env } = createEnv({ flushedDurableObject: true, coverPng: null })
	const cache = new Map<string, unknown>()
	const event = { payload: { retry_id: RETRY_ID }, instanceId: NEW_ID, timestamp: new Date() }
	const workflow = new Workflow({} as ExecutionContext, env as unknown as Env)
	const originalWarn = console.warn
	console.warn = () => {}
	try {
		// No PixelLab key in this env, so reaching the image step proves the cover is regenerated.
		await assert.rejects(workflow.run(event as never, createStep(cache).step as never), /Missing Pixellab API key/)
		const snapshot = cache.get('retry workflow#1') as WorkflowSteps
		assert.equal(snapshot.image_base64, undefined)
		assert.equal(snapshot.description, undefined)
		assert.equal(snapshot.nsfw, undefined)
		assert.ok(snapshot.lyrics, 'lyrics are independent of the cover and stay reused')
	} finally {
		console.warn = originalWarn
	}
})

test('toRetrySnapshot returns null without a saved payload', async () => {
	const { toRetrySnapshot } = await loadWorkflow()
	assert.equal(toRetrySnapshot(null, RETRY_ID), null)
	assert.equal(toRetrySnapshot({} as WorkflowSteps, RETRY_ID), null)
})

test('toRetrySnapshot drops an oversized image (with its description and NSFW verdict) so the step result stays under 1 MiB', async () => {
	const { toRetrySnapshot } = await loadWorkflow()
	const originalWarn = console.warn
	console.warn = () => {}
	try {
		const snapshot = toRetrySnapshot({
			payload: { address: 'G', prompt: 'p' },
			image_base64: 'A'.repeat(1024 * 1024),
			description: 'd',
			nsfw: { safe: true, categories: [] },
		} as WorkflowSteps, RETRY_ID)

		assert.equal(snapshot?.image_base64, undefined)
		assert.equal(snapshot?.nsfw, undefined, 'a verdict never outlives the cover it judged')
		assert.equal(snapshot?.description, undefined, 'the description is re-derived from the regenerated cover')
		assert.ok(JSON.stringify(snapshot).length < 1024 * 1024)
	} finally {
		console.warn = originalWarn
	}
})
