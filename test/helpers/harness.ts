import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import Module from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sign } from 'hono/jwt'

type ResolveFilename = (request: string, ...rest: unknown[]) => string
const CjsModule = Module as unknown as { _resolveFilename: ResolveFilename }

export interface CloudflareStubHandle {
	env: Record<string, unknown>
	cleanup: () => void
}

/**
 * Stub workerd-only modules (`cloudflare:workers`, `cloudflare:workflows`) so real
 * Workflows, Durable Objects, and Hono routes can run in Node tests.
 */
export function installCloudflareStubs(initialEnv: Record<string, unknown> = {}): CloudflareStubHandle {
	const stubDir = mkdtempSync(join(tmpdir(), 'smol-wf-test-stubs-'))
	const sharedEnv: Record<string, unknown> = { ...initialEnv }
	const envKey = `__smolTestEnv_${Date.now()}_${Math.random().toString(36).slice(2)}`
	Reflect.set(globalThis, envKey, sharedEnv)

	const stubs: Record<string, string> = {
		'cloudflare:workers': `
			class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
			class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
			const env = globalThis[${JSON.stringify(envKey)}]
			module.exports = { WorkflowEntrypoint, DurableObject, env }
		`,
		'cloudflare:workflows': `
			class NonRetryableError extends Error {
				constructor(message) { super(message); this.name = 'NonRetryableError' }
			}
			module.exports = { NonRetryableError }
		`,
	}

	const stubPaths = new Map(
		Object.entries(stubs).map(([specifier, source]) => {
			const filePath = join(stubDir, `${specifier.replace(':', '-')}.cjs`)
			writeFileSync(filePath, source)
			return [specifier, filePath] as const
		})
	)

	const originalResolveFilename = CjsModule._resolveFilename
	CjsModule._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
		return stubPaths.get(request) ?? originalResolveFilename.call(this, request, ...rest)
	}

	return {
		env: sharedEnv,
		cleanup: () => {
			CjsModule._resolveFilename = originalResolveFilename
			Reflect.deleteProperty(globalThis, envKey)
			rmSync(stubDir, { recursive: true, force: true })
		},
	}
}

export class SuspendSignal extends Error {
	constructor(stepName: string) {
		super(`Suspended before step: ${stepName}`)
		this.name = 'SuspendSignal'
	}
}

export interface RecordedStep {
	name: string
	config?: unknown
}

/**
 * Mirrors Cloudflare Workflows step replay semantics:
 * - Completed steps return their JSON-serialized cached result without re-running callbacks.
 * - `suspendBefore` throws SuspendSignal before executing that step so tests can verify replay.
 * - Records step configs so tests can assert `retries.limit === 0` on paid submit steps.
 */
export function createWorkflowStep(
	cache: Map<string, unknown>,
	options: { suspendBefore?: string; failOnceOn?: Set<string> } = {}
) {
	const executed: RecordedStep[] = []
	const counts = new Map<string, number>()

	function key(name: string) {
		const count = (counts.get(name) ?? 0) + 1
		counts.set(name, count)
		return `${name}#${count}`
	}

	const step = {
		do: async (name: string, configOrFn: unknown, maybeFn?: unknown) => {
			const hasConfig = typeof configOrFn !== 'function'
			const stepConfig = hasConfig ? configOrFn : undefined
			const fn = (hasConfig ? maybeFn : configOrFn) as () => Promise<unknown>
			const k = key(name)
			if (cache.has(k)) {
				return structuredClone(cache.get(k))
			}
			if (options.suspendBefore && name === options.suspendBefore) {
				throw new SuspendSignal(name)
			}
			executed.push({ name, config: stepConfig })
			if (options.failOnceOn?.has(name)) {
				options.failOnceOn.delete(name)
				throw new Error(`Injected transient failure on step: ${name}`)
			}
			const result = await fn()
			cache.set(k, result === undefined ? undefined : JSON.parse(JSON.stringify(result)))
			return structuredClone(cache.get(k))
		},
		sleep: async (name: string) => {
			const k = key(name)
			if (cache.has(k)) return
			if (options.suspendBefore && name === options.suspendBefore) {
				throw new SuspendSignal(name)
			}
			executed.push({ name })
			cache.set(k, null)
		},
	}

	return { step, executed }
}

export interface MockR2StoredObject {
	bytes: Uint8Array
	httpMetadata?: R2HTTPMetadata
	customMetadata?: Record<string, string>
	etag: string
	uploaded: Date
}

async function toBytes(value: unknown): Promise<Uint8Array> {
	if (value instanceof Uint8Array) return new Uint8Array(value)
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
	if (typeof value === 'string') return new TextEncoder().encode(value)
	if (value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function') {
		const reader = (value as ReadableStream<Uint8Array>).getReader()
		const chunks: Uint8Array[] = []
		let total = 0
		while (true) {
			const { done, value: chunk } = await reader.read()
			if (done) break
			if (chunk) {
				chunks.push(chunk)
				total += chunk.byteLength
			}
		}
		const out = new Uint8Array(total)
		let offset = 0
		for (const chunk of chunks) {
			out.set(chunk, offset)
			offset += chunk.byteLength
		}
		return out
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
	}
	throw new Error(`Unsupported mock R2 value type: ${typeof value}`)
}

function makeReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.byteLength > 0) {
				controller.enqueue(new Uint8Array(bytes))
			}
			controller.close()
		},
	})
}

export function createMockR2Bucket() {
	const store = new Map<string, MockR2StoredObject>()
	const stats = {
		headCalls: 0,
		getCalls: 0,
		putCalls: 0,
		deleteCalls: 0,
		deletedKeys: [] as string[],
	}

	function toR2ObjectMeta(key: string, obj: MockR2StoredObject) {
		return {
			key,
			size: obj.bytes.byteLength,
			etag: obj.etag.replace(/^"|"$/g, ''),
			httpEtag: obj.etag,
			uploaded: obj.uploaded,
			httpMetadata: obj.httpMetadata,
			customMetadata: obj.customMetadata,
			writeHttpMetadata(headers: Headers) {
				if (obj.httpMetadata?.contentType) {
					headers.set('Content-Type', obj.httpMetadata.contentType)
				}
			},
		}
	}

	const bucket = {
		async head(key: string) {
			stats.headCalls += 1
			const obj = store.get(key)
			if (!obj) return null
			return toR2ObjectMeta(key, obj)
		},
		async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }) {
			stats.getCalls += 1
			const obj = store.get(key)
			if (!obj) return null

			let slice = obj.bytes
			let resolvedRange: { offset: number; length: number } | undefined
			if (options?.range) {
				const offset = options.range.offset ?? 0
				const length = options.range.length ?? Math.max(0, obj.bytes.byteLength - offset)
				slice = obj.bytes.subarray(offset, offset + length)
				resolvedRange = { offset, length: slice.byteLength }
			}

			return {
				...toR2ObjectMeta(key, obj),
				range: resolvedRange,
				body: makeReadableStream(slice),
				async arrayBuffer() {
					return slice.slice().buffer
				},
			}
		},
		async put(key: string, value: unknown, options?: R2PutOptions) {
			stats.putCalls += 1
			const bytes = await toBytes(value)
			const etag = `"etag-${key}-${bytes.byteLength}-${stats.putCalls}"`
			const stored: MockR2StoredObject = {
				bytes,
				httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined,
				customMetadata: options?.customMetadata,
				etag,
				uploaded: new Date('2026-11-23T12:00:00.000Z'),
			}
			store.set(key, stored)
			return toR2ObjectMeta(key, stored)
		},
		async delete(keys: string | string[]) {
			const list = Array.isArray(keys) ? keys : [keys]
			for (const key of list) {
				stats.deleteCalls += 1
				stats.deletedKeys.push(key)
				store.delete(key)
			}
		},
	}

	return { bucket, store, stats }
}

/**
 * Mock Cloudflare Cache API (`caches.default`) returning immutable-header cloned responses
 * just like workerd so handlers are tested against immutable cached headers.
 */
export function createMockEdgeCache() {
	const entries = new Map<string, { status: number; headers: Array<[string, string]>; body: Uint8Array }>()
	const stats = {
		matchCalls: 0,
		putCalls: 0,
		hits: 0,
		misses: 0,
	}

	const cache: Cache = {
		async match(request: RequestInfo | URL) {
			stats.matchCalls += 1
			const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
			const entry = entries.get(key)
			if (!entry) {
				stats.misses += 1
				return undefined
			}
			stats.hits += 1
			const headers = new Headers(entry.headers)
			// Simulate immutable response headers from Cache API
			const originalSet = headers.set.bind(headers)
			Object.defineProperty(headers, 'set', {
				value: () => {
					throw new TypeError("Can't modify immutable headers.")
				},
			})
			void originalSet
			return new Response(new Uint8Array(entry.body), {
				status: entry.status,
				headers,
			})
		},
		async put(request: RequestInfo | URL, response: Response) {
			stats.putCalls += 1
			if (response.status === 206) {
				throw new TypeError('Cache API does not support caching 206 Partial Content')
			}
			const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
			const body = new Uint8Array(await response.arrayBuffer())
			entries.set(key, {
				status: response.status,
				headers: [...response.headers.entries()],
				body,
			})
		},
		async delete(request: RequestInfo | URL) {
			const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
			return entries.delete(key)
		},
	} as unknown as Cache

	return { cache, entries, stats }
}

export function createMockExecutionContext() {
	const pending: Promise<unknown>[] = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise)
		},
		passThroughOnException() {},
	} as unknown as ExecutionContext

	return {
		ctx,
		async flush() {
			await Promise.allSettled(pending.splice(0, pending.length))
		},
	}
}

export function createMockDoNamespace(r2Bucket?: ReturnType<typeof createMockR2Bucket>['bucket']) {
	const instances = new Map<string, Map<string, unknown>>()
	const flushedIds: string[] = []
	let counter = 1

	function getStorage(id: string) {
		let storage = instances.get(id)
		if (!storage) {
			storage = new Map<string, unknown>()
			instances.set(id, storage)
		}
		return storage
	}

	function createStub(id: string) {
		const storage = getStorage(id)
		return {
			id,
			async saveStep(step: string, data: unknown, options?: { persistMedia?: boolean }) {
				storage.set(step, structuredClone(data))
				if (step !== 'retry_chain_root_id') {
					storage.set('workflow_executed', true)
					storage.delete('retry_seed_pending')
				}
				if (options?.persistMedia !== false && step === 'image_base64' && r2Bucket && typeof data === 'string') {
					await r2Bucket.put(`${id}.png`, Buffer.from(data, 'base64'), {
						httpMetadata: { contentType: 'image/png' },
						customMetadata: { smolId: id },
					})
				}
			},
			async saveSteps(entries: Record<string, unknown>) {
				const sanitized = { ...entries }
				if ('provider_attempt' in sanitized) {
					const existingAttempt = storage.get('provider_attempt') as ProviderAttemptState | undefined
					const incomingAttempt = sanitized.provider_attempt as ProviderAttemptState | undefined
					if (existingAttempt && existingAttempt.status !== 'failed' && (!incomingAttempt || incomingAttempt.status === 'failed')) {
						sanitized.provider_attempt = existingAttempt
					}
				}
				for (const [k, v] of Object.entries(sanitized)) {
					storage.set(k, structuredClone(v))
				}
			},
			async inspectRetrySuccessorState(): Promise<RetrySuccessorInspection> {
				if (storage.size === 0) {
					return { state: 'empty' }
				}
				const existingAttempt = storage.get('provider_attempt') as ProviderAttemptState | undefined
				const retrySeedPending = storage.get('retry_seed_pending') === true
				const workflowExecuted = storage.get('workflow_executed') === true
				const hasOwnAttempt = Boolean(
					existingAttempt
					&& (
						existingAttempt.source_smol_id === id
						|| existingAttempt.attempt_id === `smol-${id}-aisg`
					)
				)
				const hasExecutionArtifacts = Boolean(
					workflowExecuted
					|| hasOwnAttempt
					|| storage.has('image_base64')
					|| storage.has('description')
					|| storage.has('lyrics')
					|| storage.has('nsfw')
					|| storage.has('retry_reservation')
					|| storage.has('retry_successor_id')
				)
				if (retrySeedPending && !hasExecutionArtifacts) {
					const seededPayload = storage.get('payload') as WorkflowParams | undefined
					const seededOverride = storage.get('retry_override_provider') as MusicProvider | undefined
					return {
						state: 'seeded_unstarted',
						retrySourceId: typeof storage.get('retry_source_id') === 'string'
							? storage.get('retry_source_id') as string
							: undefined,
						provider: seededPayload?.provider,
						overrideProvider: seededOverride,
						...(existingAttempt ? { existingAttempt: structuredClone(existingAttempt) } : {}),
					}
				}
				return {
					state: 'executed',
					retrySourceId: typeof storage.get('retry_source_id') === 'string'
						? storage.get('retry_source_id') as string
						: undefined,
					...(existingAttempt ? { existingAttempt: structuredClone(existingAttempt) } : {}),
				}
			},
			async seedRetrySuccessorIfEmpty(entries: Record<string, unknown>) {
				if (storage.size === 0) {
					for (const [k, v] of Object.entries(entries)) {
						storage.set(k, structuredClone(v))
					}
					storage.set('retry_seed_pending', true)
					return { seeded: true, inspection: { state: 'seeded_unstarted' as const } }
				}
				const inspection = await this.inspectRetrySuccessorState()
				return { seeded: false, inspection }
			},
			async getStep<T = unknown>(step: string): Promise<T | undefined> {
				return storage.has(step) ? structuredClone(storage.get(step)) as T : undefined
			},
			async getSteps() {
				return Object.fromEntries([...storage.entries()].map(([k, v]) => [k, structuredClone(v)]))
			},
			async claimPaidAttempt(provider: MusicProvider, meta?: Partial<ProviderAttemptState>) {
				const existing = storage.get('provider_attempt') as ProviderAttemptState | undefined
				if (existing && existing.status !== 'failed') {
					return { claimed: false, attempt: structuredClone(existing) }
				}
				const next: ProviderAttemptState = {
					...meta,
					provider,
					status: 'claimed',
					updated_at: new Date().toISOString(),
				}
				storage.set('provider_attempt', next)
				storage.set('workflow_executed', true)
				storage.delete('retry_seed_pending')
				return { claimed: true, attempt: structuredClone(next) }
			},
			async updatePaidAttempt(attempt: ProviderAttemptState) {
				storage.set('provider_attempt', structuredClone(attempt))
				storage.set('workflow_executed', true)
				storage.delete('retry_seed_pending')
			},
			async getRetryReservation() {
				const reservation = storage.get('retry_reservation') as RetryReservation | undefined
				if (reservation?.successorId) {
					return {
						successorId: reservation.successorId,
						predecessorId: reservation.predecessorId || id,
					}
				}
				const legacy = storage.get('retry_successor_id') as string | undefined
				if (legacy) {
					return { successorId: legacy, predecessorId: id }
				}
				return null
			},
			async claimRetrySuccessor(candidateId: string, predecessorId?: string) {
				const reservation = storage.get('retry_reservation') as RetryReservation | undefined
				const legacy = storage.get('retry_successor_id') as string | undefined
				const existing = reservation?.successorId
					? { successorId: reservation.successorId, predecessorId: reservation.predecessorId || id }
					: legacy
						? { successorId: legacy, predecessorId: id }
						: null
				if (existing) {
					return { ...existing, isNew: false }
				}
				const next: RetryReservation = {
					successorId: candidateId,
					predecessorId: predecessorId || id,
				}
				storage.set('retry_reservation', next)
				storage.set('retry_successor_id', candidateId)
				return { ...next, isNew: true }
			},
			async replaceRetrySuccessor(previousId: string, candidateId: string, predecessorId?: string) {
				const reservation = storage.get('retry_reservation') as RetryReservation | undefined
				const legacy = storage.get('retry_successor_id') as string | undefined
				const existing = reservation?.successorId
					? { successorId: reservation.successorId, predecessorId: reservation.predecessorId || id }
					: legacy
						? { successorId: legacy, predecessorId: id }
						: null
				if (existing && existing.successorId !== previousId) {
					return { ...existing, isNew: false }
				}
				const next: RetryReservation = {
					successorId: candidateId,
					predecessorId: predecessorId || previousId || id,
				}
				storage.set('retry_reservation', next)
				storage.set('retry_successor_id', candidateId)
				return { ...next, isNew: true }
			},
			async setToFlush() {
				flushedIds.push(id)
			},
		}
	}

	const namespace = {
		newUniqueId() {
			const hex = (counter++).toString(16).padStart(64, 'a')
			return { toString: () => hex }
		},
		idFromString(id: string) {
			return { toString: () => id }
		},
		get(doid: { toString: () => string }) {
			return createStub(doid.toString())
		},
	}

	return { namespace, instances, flushedIds, getStorage }
}

export async function createAuthToken(sub: string, secret: string, usr = 'tester') {
	return await sign(
		{
			sub,
			key: 'test-key-id',
			usr,
			exp: Math.floor(Date.now() / 1000) + 3600,
		},
		secret,
		'HS256'
	)
}
