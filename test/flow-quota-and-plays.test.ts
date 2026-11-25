import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test, { after, before } from 'node:test'
import {
	createAuthToken,
	createMockDoNamespace,
	createMockEdgeCache,
	createMockExecutionContext,
	createMockR2Bucket,
	createMockUserQuotaNamespace,
	createSqliteBackedStorage,
	clefNsfwPayload,
	createWorkflowStep,
	FAKE_PNG_B64,
	installCloudflareStubs,
	type CloudflareStubHandle,
} from './helpers/harness'

let stubs: CloudflareStubHandle
let appModule: typeof import('../src/index')
let workflowModule: typeof import('../src/workflow')
let quotaUtilsModule: typeof import('../src/utils/quota')
let smolsApiModule: typeof import('../src/api/smols')

const TEST_SECRET = 'test-jwt-secret-32-chars-minimum!'
const USER_A = 'GUSERAADDRESS00000000000000'
const USER_B = 'GUSERBADDRESS00000000000000'
const FAKE_IMAGE_B64 = FAKE_PNG_B64

before(async () => {
	stubs = installCloudflareStubs()
	appModule = await import('../src/index')
	workflowModule = await import('../src/workflow')
	quotaUtilsModule = await import('../src/utils/quota')
	smolsApiModule = await import('../src/api/smols')
})

after(() => {
	stubs.cleanup()
	Reflect.deleteProperty(globalThis, 'caches')
})

function makeAudioBytes(seed: number, size = 16_384): Uint8Array {
	const out = new Uint8Array(size)
	for (let i = 0; i < size; i++) {
		out[i] = (seed + i * 19) & 0xff
	}
	return out
}

function buildQuotaFlowHarness(options: {
	dailyClassic?: string
	dailyElevenLabs?: string
	burstPerMinute?: string
	userQuotaOverrides?: string
	globalClassic?: string
	globalElevenLabs?: string
	fallbackEnabled?: string
	playCountMode?: string
	playRateLimitPerMinute?: string
	playCooldownSeconds?: string
	failWorkflowCreate?: boolean
	aisgFetch?: (url: string, init?: RequestInit) => Promise<Response>
} = {}) {
	const r2 = createMockR2Bucket()
	const doNs = createMockDoNamespace(r2.bucket)
	const quotaNs = createMockUserQuotaNamespace(appModule.UserQuotaDO)
	const kv = new Map<string, string>()
	const smolsTable = new Map<string, Record<string, unknown>>()
	const createdWorkflows: Array<{ id: string; params: WorkflowParams }> = []
	const workflowStatuses = new Map<string, string>()
	let playIncrements = 0
	let d1TotalCalls = 0
	let shouldFailCreate = Boolean(options.failWorkflowCreate)

	const d1 = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					const run = async () => {
						d1TotalCalls += 1
						if (sql.includes('SET Plays = Plays + 1')) {
							const musicId = String(args[0])
							let changes = 0
							for (const row of smolsTable.values()) {
								if (row.Song_1 === musicId || row.Song_2 === musicId) {
									row.Plays = Number(row.Plays ?? 0) + 1
									changes += 1
								}
							}
							if (changes > 0) {
								playIncrements += changes
							}
							return { success: true, meta: { changes } }
						}
						if (sql.includes('INSERT INTO Smols')) {
							const id = String(args[0])
							if (!smolsTable.has(id)) {
								smolsTable.set(id, {
									Id: id,
									Title: args[1],
									Song_1: args[2],
									Song_2: args[3],
									Address: args[4],
									Public: args[5] ? 1 : 0,
									Instrumental: args[6] ? 1 : 0,
									Requested_Provider: args[7] ?? null,
									Actual_Provider: args[8] ?? null,
									Plays: 0,
									Views: 0,
									Mint_Token: null,
									Mint_Amm: null,
								})
							}
							return { success: true, meta: { changes: 1 } }
						}
						return { success: true, meta: { changes: 0 } }
					}
					return {
						run,
						first: async () => {
							d1TotalCalls += 1
							if (/FROM\s+Smols\s+WHERE\s+Id\s*=\s*\?1/i.test(sql)) {
								return smolsTable.get(String(args[0])) ?? null
							}
							return null
						},
						all: async () => {
							d1TotalCalls += 1
							return { results: [] }
						},
					}
				},
			}
		},
		async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
			const out = []
			for (const s of stmts) out.push(await s.run())
			return out
		},
	}

	const env = {
		SECRET: TEST_SECRET,
		PIXELLAB_KEY: 'pixellab-test-key',
		CF_AI_GATEWAY_ID: 'smol-gw',
		CF_AIG_TOKEN: 'aig-token',
		CF_AIG_BYOK_ALIAS: 'default',
		ELEVENLABS_MUSIC_LENGTH_MS: '120000',
		ELEVENLABS_OUTPUT_FORMAT: 'mp3_44100_128',
		ELEVENLABS_FALLBACK_ENABLED: options.fallbackEnabled ?? 'true',
		DAILY_LIMIT_CLASSIC: options.dailyClassic ?? '10',
		DAILY_LIMIT_ELEVENLABS: options.dailyElevenLabs ?? '5',
		BURST_LIMIT_PER_MINUTE: options.burstPerMinute ?? '0',
		USER_QUOTA_OVERRIDES: options.userQuotaOverrides,
		GLOBAL_DAILY_LIMIT_CLASSIC: options.globalClassic ?? '100',
		GLOBAL_DAILY_LIMIT_ELEVENLABS: options.globalElevenLabs ?? '20',
		PLAY_COUNT_MODE: options.playCountMode ?? 'server',
		PLAY_BEACON_RATE_LIMIT_PER_MINUTE: options.playRateLimitPerMinute ?? '30',
		PLAY_BEACON_COOLDOWN_SECONDS: options.playCooldownSeconds ?? '30',
		DURABLE_OBJECT: doNs.namespace,
		USER_QUOTA: quotaNs.namespace,
		SMOL_BUCKET: r2.bucket,
		SMOL_D1: d1,
		SMOL_KV: {
			get: async (key: string, type?: string) => {
				const raw = kv.get(key)
				if (raw === undefined) return null
				return type === 'json' ? JSON.parse(raw) : raw
			},
			put: async (key: string, value: string) => {
				kv.set(key, value)
			},
			delete: async (key: string) => {
				kv.delete(key)
			},
		},
		SEARCH_QUEUE: {
			send: async () => {},
		},
		WORKFLOW: {
			create: async ({ id, params }: { id: string; params: WorkflowParams }) => {
				if (shouldFailCreate) {
					throw new Error('Injected WORKFLOW.create failure')
				}
				if (workflowStatuses.has(id)) {
					throw new Error('instance.already_exists')
				}
				createdWorkflows.push({ id, params })
				workflowStatuses.set(id, 'running')
				return { status: async () => ({ status: workflowStatuses.get(id)! }) }
			},
			get: async (id: string) => {
				if (!workflowStatuses.has(id)) {
					throw new Error('instance.not_found')
				}
				return { status: async () => ({ status: workflowStatuses.get(id)! }) }
			},
		},
		AI: {
			gateway: (gw: string) => ({
				getUrl: async (provider: string) => `https://gateway.ai.cloudflare.com/v1/acct-1/${gw}/${provider}`,
			}),
			run: async (model: string) => {
				if (model === '@cf/moondream/moondream3.1-9B-A2B') {
					return { result: { answer: 'Neon harbor skyline at twilight.', finish_reason: 'stop' } }
				}
				if (model === '@cf/meta/llama-guard-3-8b') {
					return { response: { safe: true, categories: [] } }
				}
				if (model === '@cf/cloudflare/clef') {
					return clefNsfwPayload()
				}
				throw new Error(`Unexpected AI model: ${model}`)
			},
		},
		AISONGGENERATOR: {
			fetch: async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
				if (urlStr.endsWith('/api/lyrics')) {
					return new Response(JSON.stringify({
						title: 'Midnight Signal',
						style: ['synthwave', 'indie electronic'],
						lyrics: '[Verse 1]\nNeon echoes down the bay\n[Chorus]\nHold the midnight signal tight',
					}), { status: 200, headers: { 'Content-Type': 'application/json' } })
				}
				if (options.aisgFetch) {
					return await options.aisgFetch(urlStr, init)
				}
				throw new Error(`Unexpected AISG call: ${urlStr}`)
			},
		},
	} as unknown as Env

	async function send(path: string, init: RequestInit = {}) {
		const mockCtx = createMockExecutionContext()
		const req = new Request(`https://api.smol.xyz${path}`, init)
		const res = await appModule.app.fetch(req, env, mockCtx.ctx)
		await mockCtx.flush()
		return res
	}

	return {
		env,
		r2,
		doNs,
		quotaNs,
		kv,
		smolsTable,
		createdWorkflows,
		workflowStatuses,
		send,
		setFailWorkflowCreate: (val: boolean) => {
			shouldFailCreate = val
		},
		getPlayIncrements: () => playIncrements,
		getD1TotalCalls: () => d1TotalCalls,
	}
}

test('User quota overrides merge with defaults for the matching address', () => {
	const { getGlobalQuotaLimits, getUserQuotaLimits } = quotaUtilsModule
	assert.deepEqual(getUserQuotaLimits({} as Env, USER_A), { classic: 10, elevenlabs: 5 })
	assert.deepEqual(getGlobalQuotaLimits({} as Env), { classic: 100, elevenlabs: 20 })

	const env = {
		DAILY_LIMIT_CLASSIC: '8',
		DAILY_LIMIT_ELEVENLABS: '3',
		BURST_LIMIT_PER_MINUTE: '5',
		USER_QUOTA_OVERRIDES: JSON.stringify({ [USER_A]: { classic: 20, elevenlabs: 10, burstPerMinute: 7 } }),
	} as Env
	assert.deepEqual(getUserQuotaLimits(env, USER_A), { classic: 20, elevenlabs: 10, burstPerMinute: 7 })
	assert.deepEqual(getUserQuotaLimits(env, USER_B), { classic: 8, elevenlabs: 3, burstPerMinute: 5 })

	env.USER_QUOTA_OVERRIDES = JSON.stringify({ [USER_A]: { elevenlabs: 0, burstPerMinute: 0 } })
	assert.deepEqual(getUserQuotaLimits(env, USER_A), { classic: 8, elevenlabs: 0 })
})

test('Invalid user quota overrides fall back per field and log once without addresses', (t) => {
	const warn = t.mock.method(console, 'warn', () => {})
	const { getUserQuotaLimits } = quotaUtilsModule
	const env = { BURST_LIMIT_PER_MINUTE: '5' } as Env
	const defaults = { classic: 10, elevenlabs: 5, burstPerMinute: 5 }

	for (const invalid of [`{"${USER_A}":`, 'null', '[]', JSON.stringify({ [USER_A]: [] })]) {
		env.USER_QUOTA_OVERRIDES = invalid
		assert.deepEqual(getUserQuotaLimits(env, USER_A), defaults)
	}

	env.USER_QUOTA_OVERRIDES = JSON.stringify({
		[USER_A]: { classic: -1, elevenlabs: 1.5, burstPerMinute: '2' },
		[USER_B]: { classic: 17, elevenlabs: null, burstPerMinute: 2 },
	})
	assert.deepEqual(getUserQuotaLimits(env, USER_A), defaults)
	assert.deepEqual(getUserQuotaLimits(env, USER_B), { classic: 17, elevenlabs: 5, burstPerMinute: 2 })
	assert.equal(warn.mock.callCount(), 1)
	assert.doesNotMatch(warn.mock.calls[0].arguments.join(' '), new RegExp(`${USER_A}|${USER_B}`))
})

test('GET /quota shows user overrides while admission enforces the global cap', async () => {
	const harness = buildQuotaFlowHarness({
		globalClassic: '1',
		userQuotaOverrides: JSON.stringify({ [USER_A]: { classic: 12, elevenlabs: 7 } }),
	})
	const params = { address: USER_A, provider: 'aisonggenerator' as const }
	const admitted = await quotaUtilsModule.reserveGenerationQuota(harness.env, { ...params, reservationId: 'override-1' })
	assert.ok(admitted.ok)
	assert.equal(admitted.quota.classic.limit, 12)
	const blocked = await quotaUtilsModule.reserveGenerationQuota(harness.env, { ...params, reservationId: 'override-2' })
	assert.ok(!blocked.ok && blocked.code === 'quota_exceeded')
	assert.equal(blocked.payload.scope, 'global')
	assert.equal(blocked.payload.limit, 1)

	const token = await createAuthToken(USER_A, TEST_SECRET)
	const response = await harness.send('/quota', { headers: { Authorization: `Bearer ${token}` } })
	assert.equal(response.status, 200)
	const snapshot = await response.json() as import('../src/quota-do').QuotaSnapshot
	assert.equal(snapshot.classic.limit, 12)
	assert.equal(snapshot.classic.remaining, 11)
	assert.equal(snapshot.elevenlabs.limit, 7)
})

test('UserQuotaDO SQLite: reserve/idempotency/commit/refund/ambiguous/fallback/burst/UTC-day-reset invariants', async () => {
	const quotaNs = createMockUserQuotaNamespace(appModule.UserQuotaDO)
	const stub = quotaNs.namespace.get(quotaNs.namespace.idFromName(`user:${USER_A}`))
	const limits = { classic: 2, elevenlabs: 1, burstPerMinute: 2 }

	const day1End = Date.parse('2026-11-23T23:59:50.000Z')
	const day1Later = Date.parse('2026-11-23T23:59:55.000Z')
	const day2Start = Date.parse('2026-11-24T00:00:01.000Z')
	const day2AfterBurst = Date.parse('2026-11-24T00:01:05.000Z')

	// 1. Reserve Classic #1 + idempotent repeat + provider conflict rejection
	const r1 = await stub.reserve('res-1', 'aisonggenerator', limits, day1End)
	assert.equal(r1.ok, true)
	assert.equal(r1.idempotent, false)
	assert.equal(r1.quota.classic.used, 1)
	assert.equal(r1.quota.classic.remaining, 1)
	assert.equal(r1.quota.classic.resetAt, '2026-11-24T00:00:00.000Z')

	const r1Dup = await stub.reserve('res-1', 'aisonggenerator', limits, day1End)
	assert.equal(r1Dup.ok, true)
	assert.equal(r1Dup.idempotent, true)
	assert.equal(r1Dup.quota.classic.used, 1, 'Idempotent reserve must not double-count')

	const r1Conflict = await stub.reserve('res-1', 'elevenlabs', limits, day1End)
	assert.equal(r1Conflict.ok, false)
	assert.equal(r1Conflict.code, 'reservation_conflict')

	// 2. Commit res-1 -> refund MUST be refused!
	const commit1 = await stub.settle('res-1', 'aisonggenerator', day1End + 100)
	assert.equal(commit1.committed, true)
	assert.equal(commit1.idempotent, false)
	const commit1Dup = await stub.commit('res-1', 'aisonggenerator', day1End + 200)
	assert.equal(commit1Dup.committed, true)
	assert.equal(commit1Dup.idempotent, true)

	const refundCommitted = await stub.refund('res-1', 'should_not_refund', day1End + 300)
	assert.equal(refundCommitted.refunded, false)
	assert.equal(refundCommitted.reason, 'already_committed')

	// 3. Reserve ElevenLabs #1 -> hits burst limit (2/2 in 60s), so a 3rd reserve within 60s fails with burst_limit!
	const r2 = await stub.reserve('res-2', 'elevenlabs', limits, day1Later)
	assert.equal(r2.ok, true)
	assert.equal(r2.quota.elevenlabs.used, 1)
	assert.equal(r2.quota.elevenlabs.remaining, 0)

	const r3Burst = await stub.reserve('res-3', 'aisonggenerator', limits, day1Later + 1000)
	assert.equal(r3Burst.ok, false)
	if (!r3Burst.ok && r3Burst.code === 'quota_exceeded') {
		assert.equal(r3Burst.reason, 'burst_limit')
		assert.equal(r3Burst.limit, 2)
		assert.equal(r3Burst.used, 2)
		assert.equal(r3Burst.remaining, 0)
	}

	// 4. Mark res-2 ambiguous -> refund MUST be refused!
	const amb = await stub.markAmbiguous('res-2', 'gateway_504', day1Later + 2000)
	assert.equal(amb.marked, true)
	assert.equal(amb.status, 'ambiguous')

	const refundAmbiguous = await stub.refund('res-2', 'should_not_refund', day1Later + 3000)
	assert.equal(refundAmbiguous.refunded, false)
	assert.equal(refundAmbiguous.reason, 'ambiguous_non_refundable')

	// 5. Daily cap check on day 1 (with burst disabled): ElevenLabs 1/1 -> blocked; Classic 1/2 -> allowed -> transitionFallback to ElevenLabs BLOCKED!
	const day1NoBurst = { classic: 2, elevenlabs: 1 }
	const r3 = await stub.reserve('res-3', 'aisonggenerator', day1NoBurst, day1Later + 3500)
	assert.equal(r3.ok, true)
	assert.equal(r3.quota.classic.used, 2)

	const fbBlocked = await stub.transitionFallback('res-3', 'aisonggenerator', 'elevenlabs', day1NoBurst, day1Later + 4000)
	assert.equal(fbBlocked.ok, false)
	if (!fbBlocked.ok && fbBlocked.code === 'quota_exceeded') {
		assert.equal(fbBlocked.provider, 'elevenlabs')
		assert.equal(fbBlocked.limit, 1)
		assert.equal(fbBlocked.used, 1)
		assert.equal(fbBlocked.remaining, 0)
	}

	// Refund unbilled res-3 -> restores Classic remaining to 1
	const refundRes3 = await stub.refund('res-3', 'provider_rejected', day1Later + 4500)
	assert.equal(refundRes3.refunded, true)
	const snapDay1 = await stub.getQuota(day1NoBurst, day1Later + 4600)
	assert.equal(snapDay1.classic.used, 1)
	assert.equal(snapDay1.classic.remaining, 1)
	assert.equal(snapDay1.elevenlabs.used, 1)
	assert.equal(snapDay1.elevenlabs.remaining, 0)

	// 6. UTC midnight rollover -> fresh day 2 resets daily counts to 0!
	const snapDay2 = await stub.getQuota(limits, day2Start)
	assert.equal(snapDay2.classic.used, 0)
	assert.equal(snapDay2.classic.remaining, 2)
	assert.equal(snapDay2.elevenlabs.used, 0)
	assert.equal(snapDay2.elevenlabs.remaining, 1)
	assert.equal(snapDay2.classic.resetAt, '2026-11-25T00:00:00.000Z')

	// After 60s burst window clears, day 2 allows fresh reservations + fallback transition!
	const r4 = await stub.reserve('res-4', 'aisonggenerator', limits, day2AfterBurst)
	assert.equal(r4.ok, true)
	const fbAllowed = await stub.transitionFallback('res-4', 'aisonggenerator', 'elevenlabs', limits, day2AfterBurst + 1000)
	assert.equal(fbAllowed.ok, true)
	if (fbAllowed.ok) {
		assert.equal(fbAllowed.quota.classic.used, 0)
		assert.equal(fbAllowed.quota.elevenlabs.used, 1)
		assert.equal(fbAllowed.quota.elevenlabs.remaining, 0)
	}
})

test('GET /quota, POST / 429 JSON, WORKFLOW.create refund, confirmed rejection refund vs ambiguous non-refund, and global:YYYY-MM-DD circuit breaker', async () => {
	const fakeMp3 = makeAudioBytes(42, 4096)
	let elMode: 'ok' | 'reject_401' | 'timeout_504' = 'ok'

	const harness = buildQuotaFlowHarness({
		dailyClassic: '2',
		dailyElevenLabs: '2',
		globalElevenLabs: '2',
	})

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('api.pixellab.ai')) {
			return new Response(JSON.stringify({ image: { base64: FAKE_IMAGE_B64 } }), { status: 200 })
		}
		if (url.includes('/elevenlabs/v1/music')) {
			if (elMode === 'reject_401') {
				return new Response(JSON.stringify({ detail: 'invalid api key' }), { status: 401 })
			}
			if (elMode === 'timeout_504') {
				return new Response('gateway timeout', { status: 504 })
			}
			return new Response(fakeMp3, {
				status: 200,
				headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(fakeMp3.byteLength) },
			})
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const tokenB = await createAuthToken(USER_B, TEST_SECRET)

		// Unauthenticated GET /quota -> 401
		const unauthQuota = await harness.send('/quota')
		assert.equal(unauthQuota.status, 401)

		// Authenticated GET /quota returns exact contract + Cache-Control: no-store
		const q0 = await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })
		assert.equal(q0.status, 200)
		assert.equal(q0.headers.get('Cache-Control'), 'no-store')
		const q0Json = await q0.json() as {
			classic: { limit: number; used: number; remaining: number; resetAt: string }
			elevenlabs: { limit: number; used: number; remaining: number; resetAt: string }
		}
		assert.equal(q0Json.classic.limit, 2)
		assert.equal(q0Json.classic.used, 0)
		assert.equal(q0Json.classic.remaining, 2)
		assert.equal(q0Json.elevenlabs.limit, 2)
		assert.equal(q0Json.elevenlabs.used, 0)
		assert.equal(q0Json.elevenlabs.remaining, 2)
		assert.match(q0Json.elevenlabs.resetAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)

		// WORKFLOW.create failure refunds reservation cleanly
		harness.setFailWorkflowCreate(true)
		const failedCreate = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'transient create err', provider: 'elevenlabs' }),
		})
		assert.equal(failedCreate.status, 500)
		harness.setFailWorkflowCreate(false)

		const qAfterCreateErr = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as typeof q0Json
		assert.equal(qAfterCreateErr.elevenlabs.used, 0, 'Failed WORKFLOW.create must refund quota')

		// 1. Confirmed ElevenLabs 401 rejection -> refunded!
		elMode = 'reject_401'
		const rejRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'rejected auth test', provider: 'elevenlabs' }),
		})
		assert.equal(rejRes.status, 200)
		const rejId = await rejRes.text()
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		await assert.rejects(() => wf.run(
			{ payload: harness.createdWorkflows.at(-1)!.params, instanceId: rejId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		))
		const qAfterRej = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as typeof q0Json
		assert.equal(qAfterRej.elevenlabs.used, 0, 'Provably rejected ElevenLabs call must refund quota')

		// 2. Ambiguous ElevenLabs 504 timeout -> NEVER refunded!
		elMode = 'timeout_504'
		const ambRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'ambiguous timeout test', provider: 'elevenlabs' }),
		})
		assert.equal(ambRes.status, 200)
		const ambId = await ambRes.text()
		await assert.rejects(() => wf.run(
			{ payload: harness.createdWorkflows.at(-1)!.params, instanceId: ambId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		))
		const qAfterAmb = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as typeof q0Json
		assert.equal(qAfterAmb.elevenlabs.used, 1, 'Ambiguous 504 ElevenLabs call MUST NOT refund quota')

		// 3. Successful ElevenLabs generation -> commits slot #2 (now at 2/2 user & 2/2 global!)
		elMode = 'ok'
		const okRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'great synth ballad', provider: 'elevenlabs' }),
		})
		assert.equal(okRes.status, 200)
		const okId = await okRes.text()
		await wf.run(
			{ payload: harness.createdWorkflows.at(-1)!.params, instanceId: okId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)

		// Verify internal quota fields are stripped from GET /:id detail JSON
		const detailRes = await harness.send(`/${okId}`, { headers: { Authorization: `Bearer ${tokenA}` } })
		const detailJson = await detailRes.json() as { kv_do: Record<string, unknown> }
		assert.equal('quota_reservation_id' in detailJson.kv_do, false)
		assert.equal('quota_day_key' in detailJson.kv_do, false)

		// 4. User A 3rd ElevenLabs create -> structured 429 JSON!
		const overLimit = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'over limit song', provider: 'elevenlabs' }),
		})
		assert.equal(overLimit.status, 429)
		assert.equal(overLimit.headers.get('Cache-Control'), 'no-store')
		assert.ok(overLimit.headers.get('Retry-After'))
		const overJson = await overLimit.json() as Record<string, unknown>
		assert.equal(overJson.code, 'quota_exceeded')
		assert.equal(overJson.provider, 'elevenlabs')
		assert.equal(overJson.limit, 2)
		assert.equal(overJson.used, 2)
		assert.equal(overJson.remaining, 0)
		assert.equal(typeof overJson.error, 'string')
		assert.match(String(overJson.resetAt), /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)

		// 5. User B hits global:YYYY-MM-DD circuit breaker (2/2 global used by User A) -> 429 AND User B's own quota stays 0!
		const globalBlocked = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'user b blocked globally', provider: 'elevenlabs' }),
		})
		assert.equal(globalBlocked.status, 429)
		const globalBlockedJson = await globalBlocked.json() as Record<string, unknown>
		assert.equal(globalBlockedJson.code, 'quota_exceeded')
		assert.equal(globalBlockedJson.scope, 'global')
		assert.equal(globalBlockedJson.provider, 'elevenlabs')

		const qUserB = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenB}` } })).json() as typeof q0Json
		assert.equal(qUserB.elevenlabs.used, 0, 'Global circuit breaker denial must refund user reservation')

		// Verify sharded DO naming: user:<addr> and global:YYYY-MM-DD (no single global singleton!)
		const doNames = harness.quotaNs.getNames()
		assert.ok(doNames.includes(`user:${USER_A}`))
		assert.ok(doNames.includes(`user:${USER_B}`))
		assert.ok(doNames.some((n) => /^global:\d{4}-\d{2}-\d{2}$/.test(n)))
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Automatic AISG -> ElevenLabs fallback enforces ElevenLabs cap, respects unbilled vs billed AISG accounting, and reverts unbilled ElevenLabs rejection', async () => {
	const fakeMp3 = makeAudioBytes(99, 4096)
	let aisgBehavior: 'reject_credits' | 'poll_fail' = 'reject_credits'
	let elBehavior: 'ok' | 'reject_401' = 'ok'
	let elCalls = 0

	const harness = buildQuotaFlowHarness({
		dailyClassic: '5',
		userQuotaOverrides: JSON.stringify({ [USER_A]: { elevenlabs: 1 } }),
		aisgFetch: async (url) => {
			if (url.endsWith('/api/tasks')) {
				if (aisgBehavior === 'reject_credits') {
					return new Response(JSON.stringify({ code: 'credits_exhausted', outcome: 'rejected', error: 'Out of credits' }), { status: 402 })
				}
				return new Response(JSON.stringify({ task_id: 'task-fb-1', workspace_id: 'ws-1' }), { status: 200 })
			}
			if (url.includes('/api/tasks/task-fb-1')) {
				return new Response(JSON.stringify({ task_id: 'task-fb-1', music_ids: ['fb-1', 'fb-2'] }), { status: 200 })
			}
			if (url.includes('/api/songs?ids=')) {
				return new Response(JSON.stringify([
					{ music_id: 'fb-1', status: -3, audio: '', service: 'aisonggenerator', error_message: 'upstream failed' },
					{ music_id: 'fb-2', status: -3, audio: '', service: 'aisonggenerator', error_message: 'upstream failed' },
				]), { status: 200 })
			}
			throw new Error(`Unexpected AISG URL: ${url}`)
		},
	})

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('api.pixellab.ai')) {
			return new Response(JSON.stringify({ image: { base64: FAKE_IMAGE_B64 } }), { status: 200 })
		}
		if (url.includes('/elevenlabs/v1/music')) {
			elCalls += 1
			if (elBehavior === 'reject_401') {
				return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 })
			}
			return new Response(fakeMp3, {
				status: 200,
				headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(fakeMp3.byteLength) },
			})
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)

		// Case 1: AISG poll fails (billed AISG) -> transitions to ElevenLabs -> ElevenLabs rejects 401 (unbilled EL)
		// Result: unbilled EL slot is freed (0/1), billed AISG slot stays consumed & non-refundable (1/5)!
		aisgBehavior = 'poll_fail'
		elBehavior = 'reject_401'
		const r1 = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'poll fail then el reject', provider: 'aisonggenerator' }),
		})
		const id1 = await r1.text()
		await assert.rejects(() => wf.run(
			{ payload: harness.createdWorkflows.at(-1)!.params, instanceId: id1, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		))
		assert.equal(elCalls, 1)
		const q1 = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			classic: { used: number; remaining: number }
			elevenlabs: { used: number; remaining: number }
		}
		assert.equal(q1.classic.used, 1, 'Accepted AISG job must remain charged after ElevenLabs fallback rejection')
		assert.equal(q1.elevenlabs.used, 0, 'Unbilled ElevenLabs rejection must release ElevenLabs slot')

		// Case 2: AISG submit rejects (unbilled) -> transitions to ElevenLabs (0/1 -> 1/1) -> ElevenLabs SUCCEEDS!
		aisgBehavior = 'reject_credits'
		elBehavior = 'ok'
		const r2 = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'aisg reject fallback ok', provider: 'aisonggenerator' }),
		})
		const id2 = await r2.text()
		await wf.run(
			{ payload: harness.createdWorkflows.at(-1)!.params, instanceId: id2, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)
		assert.equal(elCalls, 2)
		const q2 = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as typeof q1
		assert.equal(q2.classic.used, 1, 'Unbilled AISG slot moved to ElevenLabs')
		assert.equal(q2.elevenlabs.used, 1, 'Fallback must consume ElevenLabs daily cap')
		assert.equal(q2.elevenlabs.remaining, 0)

		// Case 3: Now ElevenLabs cap is FULL (1/1)! Classic create -> AISG submit rejects -> fallback MUST BE BLOCKED (0 new EL calls) AND unbilled Classic refunded!
		aisgBehavior = 'reject_credits'
		const r3 = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'cannot bypass elevenlabs cap via fallback', provider: 'aisonggenerator' }),
		})
		assert.equal(r3.status, 200)
		const id3 = await r3.text()
		await assert.rejects(
			() => wf.run(
				{ payload: harness.createdWorkflows.at(-1)!.params, instanceId: id3, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/ElevenLabs fallback blocked by quota/
		)
		assert.equal(elCalls, 2, 'Fallback MUST NOT call ElevenLabs when user ElevenLabs cap is exhausted')
		const q3 = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as typeof q1
		assert.equal(q3.classic.used, 1, 'Unbilled AISG submit rejection must be refunded when fallback is denied')
		assert.equal(q3.elevenlabs.used, 1)

		// Case 4: ElevenLabs cap STILL FULL (1/1)! Classic create -> AISG poll fails (billed AISG) -> fallback BLOCKED (0 new EL calls) AND accepted AISG stays charged (2/5)!
		aisgBehavior = 'poll_fail'
		const r4 = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'poll fail blocked fallback', provider: 'aisonggenerator' }),
		})
		const id4 = await r4.text()
		await assert.rejects(
			() => wf.run(
				{ payload: harness.createdWorkflows.at(-1)!.params, instanceId: id4, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/ElevenLabs fallback blocked by quota/
		)
		assert.equal(elCalls, 2, 'Poll-failure fallback MUST NOT call ElevenLabs when cap is exhausted')
		const q4 = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as typeof q1
		assert.equal(q4.classic.used, 2, 'Accepted AISG poll failure must NOT be refunded when fallback is denied')
		assert.equal(q4.elevenlabs.used, 1)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('POST /retry/:id: zero double-charge on paid/pending/complete reuse; strict 429 on fresh retry and override_provider', async () => {
	const audio1 = makeAudioBytes(11, 40_000)
	const audio2 = makeAudioBytes(22, 40_000)
	const harness = buildQuotaFlowHarness({
		dailyClassic: '1',
		dailyElevenLabs: '1',
		aisgFetch: async (url) => {
			if (url.includes('/api/songs?ids=')) {
				return new Response(JSON.stringify([
					{ music_id: 'pend-1', status: 4, audio: 'https://cdn.aisg.test/p1.mp3', service: 'aisonggenerator' },
					{ music_id: 'pend-2', status: 4, audio: 'https://cdn.aisg.test/p2.mp3', service: 'aisonggenerator' },
				]), { status: 200 })
			}
			throw new Error(`Unexpected AISG URL: ${url}`)
		},
	})

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.endsWith('/p1.mp3')) return new Response(audio1, { status: 200 })
		if (url.endsWith('/p2.mp3')) return new Response(audio2, { status: 200 })
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const quotaStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))

		// 1. Pending AISG smol (already reserved 1/1 Classic, failed polling window -> errored)
		const pendingSmolId = 'c'.repeat(64)
		const res1 = await quotaStub.reserve(pendingSmolId, 'aisonggenerator', { classic: 1, elevenlabs: 1 })
		assert.equal(res1.ok, true)
		harness.workflowStatuses.set(pendingSmolId, 'errored')
		harness.doNs.getStorage(pendingSmolId).set('payload', {
			address: USER_A,
			prompt: 'pending retry test',
			public: true,
			instrumental: false,
			provider: 'aisonggenerator',
		})
		harness.doNs.getStorage(pendingSmolId).set('image_base64', FAKE_IMAGE_B64)
		harness.doNs.getStorage(pendingSmolId).set('description', 'desc')
		harness.doNs.getStorage(pendingSmolId).set('lyrics', { title: 'Pending Track', style: ['a', 'b'], lyrics: 'hi' })
		harness.doNs.getStorage(pendingSmolId).set('nsfw', { safe: true, categories: [] })
		harness.doNs.getStorage(pendingSmolId).set('song_ids', ['pend-1', 'pend-2'])
		harness.doNs.getStorage(pendingSmolId).set('quota_reservation_id', pendingSmolId)
		harness.doNs.getStorage(pendingSmolId).set('provider_attempt', {
			provider: 'aisonggenerator',
			status: 'submitted',
			task_id: 't-pend',
			song_ids: ['pend-1', 'pend-2'],
			updated_at: new Date().toISOString(),
		})

		// User A is ALREADY at 1/1 Classic! Retrying pendingSmolId MUST SUCCEED without double-charging!
		const retryPending = await harness.send(`/retry/${pendingSmolId}`, { method: 'POST' })
		assert.equal(retryPending.status, 200, 'Retry reusing pending AISG attempt must NOT double-charge quota')
		const successorId = await retryPending.text()
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		await wf.run(
			{ payload: harness.createdWorkflows.at(-1)!.params, instanceId: successorId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)
		const qAfterReuse = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			classic: { used: number; remaining: number }
			elevenlabs: { used: number; remaining: number }
		}
		assert.equal(qAfterReuse.classic.used, 1, 'Total Classic usage across pending retry must remain 1')
		assert.equal((await quotaStub.getReservation(pendingSmolId))?.status, 'committed')

		// 1b. Retry reusing ALREADY-COMPLETE songs (e.g. failed during D1 publish) MUST SUCCEED at 0 remaining Classic!
		const completeUnpublishedId = 'e'.repeat(64)
		harness.workflowStatuses.set(completeUnpublishedId, 'errored')
		harness.doNs.getStorage(completeUnpublishedId).set('payload', {
			address: USER_A,
			prompt: 'complete songs retry test',
			public: true,
			instrumental: false,
			provider: 'aisonggenerator',
		})
		harness.doNs.getStorage(completeUnpublishedId).set('song_ids', ['pend-1', 'pend-2'])
		harness.doNs.getStorage(completeUnpublishedId).set('songs', [
			{ music_id: 'pend-1', status: 4, audio: 'https://cdn.aisg.test/p1.mp3', service: 'aisonggenerator' },
			{ music_id: 'pend-2', status: 4, audio: 'https://cdn.aisg.test/p2.mp3', service: 'aisonggenerator' },
		])
		const retryCompleteReuse = await harness.send(`/retry/${completeUnpublishedId}`, { method: 'POST' })
		assert.equal(retryCompleteReuse.status, 200, 'Retry reusing complete songs must NOT double-charge quota')
		const qAfterCompleteReuse = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as typeof qAfterReuse
		assert.equal(qAfterCompleteReuse.classic.used, 1)

		// 2. Failed smol needing a FRESH call (provider_attempt.status === 'failed'):
		// Classic is at 1/1 -> plain Classic retry gets 429!
		const failedSmolId = 'd'.repeat(64)
		harness.workflowStatuses.set(failedSmolId, 'errored')
		harness.doNs.getStorage(failedSmolId).set('payload', {
			address: USER_A,
			prompt: 'failed fresh retry test',
			public: true,
			instrumental: false,
			provider: 'aisonggenerator',
		})
		harness.doNs.getStorage(failedSmolId).set('provider_attempt', {
			provider: 'aisonggenerator',
			status: 'failed',
			error_code: 'content_policy',
			updated_at: new Date().toISOString(),
		})
		harness.doNs.getStorage(failedSmolId).set('songs', [{ music_id: failedSmolId, status: -1, audio: '', service: 'aisonggenerator' }])

		const retryClassic429 = await harness.send(`/retry/${failedSmolId}`, { method: 'POST' })
		assert.equal(retryClassic429.status, 429)
		const classic429Json = await retryClassic429.json() as Record<string, unknown>
		assert.equal(classic429Json.code, 'quota_exceeded')
		assert.equal(classic429Json.provider, 'aisonggenerator')

		// Now retry the SAME failed smol with override_provider='elevenlabs' (ElevenLabs is 0/1 -> allowed!)
		// Also verifies that the earlier 429 left the reserved successor DO empty & cleanly recoverable!
		const retryOverrideOk = await harness.send(`/retry/${failedSmolId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
			body: JSON.stringify({ override_provider: 'elevenlabs' }),
		})
		assert.equal(retryOverrideOk.status, 200)
		const elRetryId = await retryOverrideOk.text()
		assert.equal(harness.createdWorkflows.at(-1)?.params.override_provider, 'elevenlabs')
		const qAfterOverride = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as typeof qAfterReuse
		assert.equal(qAfterOverride.elevenlabs.used, 1, 'override_provider retry must consume ElevenLabs quota')

		// Mark elRetryId errored with failed attempt -> retrying again with ElevenLabs hits 429 (1/1)!
		harness.workflowStatuses.set(elRetryId, 'errored')
		harness.doNs.getStorage(elRetryId).set('provider_attempt', {
			provider: 'elevenlabs',
			status: 'failed',
			error_code: 'invalid_request',
			updated_at: new Date().toISOString(),
		})
		const retryEl429 = await harness.send(`/retry/${failedSmolId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
			body: JSON.stringify({ override_provider: 'elevenlabs' }),
		})
		assert.equal(retryEl429.status, 429)
		const el429Json = await retryEl429.json() as Record<string, unknown>
		assert.equal(el429Json.code, 'quota_exceeded')
		assert.equal(el429Json.provider, 'elevenlabs')

		// 3. Pre-music failure refunds fresh reservation cleanly
		const preMusicHarness = buildQuotaFlowHarness({ dailyClassic: '1', dailyElevenLabs: '1' })
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
			if (url.includes('api.pixellab.ai')) {
				return new Response('pixellab down', { status: 503 })
			}
			throw new Error(`Unexpected fetch: ${url}`)
		}) as typeof fetch

		const createPreFail = await preMusicHarness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'pixellab failure refund test', provider: 'elevenlabs' }),
		})
		assert.equal(createPreFail.status, 200)
		const preFailId = await createPreFail.text()
		const preWf = new workflowModule.Workflow({} as ExecutionContext, preMusicHarness.env)
		await assert.rejects(() => preWf.run(
			{ payload: preMusicHarness.createdWorkflows[0].params, instanceId: preFailId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		))
		const qPreFail = await (await preMusicHarness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as typeof qAfterReuse
		assert.equal(qPreFail.elevenlabs.used, 0, 'Pre-music step failure must refund fresh reservation')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Q11 PLAY_COUNT_MODE server vs beacon and POST /plays/:musicId idempotency, validation, and rate limiting', async () => {
	const audioBytes = makeAudioBytes(7, 2048)

	// --- PART A: PLAY_COUNT_MODE = 'server' (default while legacy smol.xyz is live) ---
	{
		const edgeCache = createMockEdgeCache()
		Reflect.set(globalThis, 'caches', { default: edgeCache.cache })

		const harness = buildQuotaFlowHarness({ playCountMode: 'server' })
		harness.smolsTable.set('smol-1', { Id: 'smol-1', Song_1: 'track-srv-1', Song_2: null, Plays: 0 })
		await harness.r2.bucket.put('track-srv-1.mp3', audioBytes, {
			httpMetadata: { contentType: 'audio/mpeg' },
			customMetadata: { smolId: 'smol-1', provider: 'elevenlabs' },
		})

		// GET /song/:id.mp3 increments Plays in server mode
		const getRes = await harness.send('/song/track-srv-1.mp3')
		assert.equal(getRes.status, 200)
		assert.equal(harness.getPlayIncrements(), 1)

		// POST /plays/:musicId in server mode returns 202 and performs ZERO D1 writes (no double-counting!)
		const d1Before = harness.getD1TotalCalls()
		const beaconRes = await harness.send('/plays/track-srv-1', { method: 'POST' })
		assert.equal(beaconRes.status, 202)
		assert.equal(beaconRes.headers.get('Cache-Control'), 'no-store')
		assert.deepEqual(await beaconRes.json(), { ok: true, counted: false, mode: 'server' })
		assert.equal(harness.getD1TotalCalls(), d1Before, 'Server mode beacon must not write to D1')
		assert.equal(harness.getPlayIncrements(), 1)
	}

	// --- PART B: PLAY_COUNT_MODE = 'beacon' (100% CDN-cacheable audio + rate-limited idempotent beacon) ---
	{
		const edgeCache = createMockEdgeCache()
		Reflect.set(globalThis, 'caches', { default: edgeCache.cache })

		const harness = buildQuotaFlowHarness({
			playCountMode: 'beacon',
			playRateLimitPerMinute: '2',
			playCooldownSeconds: '30',
		})
		harness.smolsTable.set('smol-b1', { Id: 'smol-b1', Song_1: 'track-bcn-1', Song_2: null, Plays: 0 })
		harness.smolsTable.set('smol-b2', { Id: 'smol-b2', Song_1: 'track-bcn-2', Song_2: null, Plays: 0 })
		harness.smolsTable.set('smol-b3', { Id: 'smol-b3', Song_1: 'track-bcn-3', Song_2: null, Plays: 0 })
		await harness.r2.bucket.put('track-bcn-1.mp3', audioBytes, {
			httpMetadata: { contentType: 'audio/mpeg' },
			customMetadata: { smolId: 'smol-b1', provider: 'elevenlabs' },
		})

		// 1. GET /song/:id.mp3 (cold full GET + warm full GET + warm bytes=0- range) performs ZERO D1 calls!
		const coldAudio = await harness.send('/song/track-bcn-1.mp3')
		assert.equal(coldAudio.status, 200)
		assert.equal(coldAudio.headers.get('Cache-Control'), 'public, max-age=2592000, stale-while-revalidate=86400')
		assert.equal(coldAudio.headers.get('Accept-Ranges'), 'bytes')
		assert.ok(coldAudio.headers.get('ETag'))

		const warmAudio = await harness.send('/song/track-bcn-1.mp3')
		assert.equal(warmAudio.status, 200)

		const warmRange = await harness.send('/song/track-bcn-1.mp3', { headers: { Range: 'bytes=0-' } })
		assert.equal(warmRange.status, 206)
		assert.equal(harness.getD1TotalCalls(), 0, 'Beacon mode GET /song/:id.mp3 must perform ZERO D1 queries')
		assert.equal(harness.getPlayIncrements(), 0)

		// 2. Invalid musicId -> 400; nonexistent musicId -> 404
		const badId = await harness.send('/plays/bad%20id!', { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.1' } })
		assert.equal(badId.status, 400)

		const missingId = await harness.send('/plays/nonexistent-song', { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.99' } })
		assert.equal(missingId.status, 404)

		// 3. Valid beacon (empty sendBeacon body) -> counts +1
		const play1 = await harness.send('/plays/track-bcn-1', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': '198.51.100.10' },
		})
		assert.equal(play1.status, 200)
		assert.equal(play1.headers.get('Cache-Control'), 'no-store')
		assert.deepEqual(await play1.json(), { ok: true, counted: true, mode: 'beacon' })
		assert.equal(harness.smolsTable.get('smol-b1')?.Plays, 1)

		// 4. Duplicate beacon from SAME caller within cooldown -> idempotent dedupe (0 D1 writes!)
		const d1BeforeDup = harness.getD1TotalCalls()
		const play1Dup = await harness.send('/plays/track-bcn-1', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': '198.51.100.10' },
		})
		assert.equal(play1Dup.status, 200)
		assert.deepEqual(await play1Dup.json(), { ok: true, counted: false, deduped: true, mode: 'beacon' })
		assert.equal(harness.getD1TotalCalls(), d1BeforeDup)
		assert.equal(harness.smolsTable.get('smol-b1')?.Plays, 1)

		// 5. Different caller (authenticated user) -> counts +1!
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const playAuth = await harness.send('/plays/track-bcn-1', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ playId: 'session-play-1' }),
		})
		assert.equal(playAuth.status, 200)
		assert.deepEqual(await playAuth.json(), { ok: true, counted: true, mode: 'beacon' })
		assert.equal(harness.smolsTable.get('smol-b1')?.Plays, 2)

		// 6. Rate limiting per caller (limit=2/min): caller 198.51.100.10 played track-bcn-1 (1/2), plays track-bcn-2 (2/2), then track-bcn-3 -> 429!
		const play2 = await harness.send('/plays/track-bcn-2', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': '198.51.100.10' },
		})
		assert.equal(play2.status, 200)
		assert.equal(harness.smolsTable.get('smol-b2')?.Plays, 1)

		const d1BeforeRateLimit = harness.getD1TotalCalls()
		const play3Limited = await harness.send('/plays/track-bcn-3', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': '198.51.100.10' },
		})
		assert.equal(play3Limited.status, 429)
		assert.ok(play3Limited.headers.get('Retry-After'))
		assert.equal(harness.getD1TotalCalls(), d1BeforeRateLimit, 'Rate-limited beacon must not hit D1')
	}
})

test('Post-review regression 1 (P1): never refund after WORKFLOW.create succeeds when status() throws, on uncertain create, or on losing concurrent retry', async () => {
	const tokenA = await createAuthToken(USER_A, TEST_SECRET)

	// 1a. POST /: WORKFLOW.create succeeds, instance.status() throws -> returns 200 ID and keeps reservation intact!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2' })
		;(harness.env.WORKFLOW as unknown as { create: unknown }).create = async ({ id, params }: { id: string; params: WorkflowParams }) => {
			harness.createdWorkflows.push({ id, params })
			harness.workflowStatuses.set(id, 'running')
			return {
				status: async () => {
					throw new Error('transient status read failure')
				},
			}
		}

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'status throw after create', provider: 'elevenlabs' }),
		})
		assert.equal(res.status, 200, 'Accepted workflow must return 200 even if instance.status() throws')
		const id = await res.text()
		assert.equal(id, harness.createdWorkflows[0].id)

		const q = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			elevenlabs: { used: number }
		}
		assert.equal(q.elevenlabs.used, 1, 'Accepted workflow reservation MUST NOT be refunded when status() throws')
	}

	// 1b. POST /: WORKFLOW.create throws an uncertain error AFTER Cloudflare accepted it (WORKFLOW.get reports active) -> returns 200 and keeps reservation!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2' })
		;(harness.env.WORKFLOW as unknown as { create: unknown }).create = async ({ id, params }: { id: string; params: WorkflowParams }) => {
			harness.createdWorkflows.push({ id, params })
			harness.workflowStatuses.set(id, 'running')
			throw new Error('network timeout after workflow accepted')
		}

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'uncertain create reconciled active', provider: 'elevenlabs' }),
		})
		assert.equal(res.status, 200)
		const q = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			elevenlabs: { used: number }
		}
		assert.equal(q.elevenlabs.used, 1, 'Reconciled active workflow must NOT refund reservation')
	}

	// 1c. POST /: WORKFLOW.create throws AND WORKFLOW.get is indeterminate -> fails closed (no refund)!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2' })
		;(harness.env.WORKFLOW as unknown as { create: unknown; get: unknown }).create = async () => {
			throw new Error('network timeout')
		}
		;(harness.env.WORKFLOW as unknown as { get: unknown }).get = async () => {
			throw new Error('service unavailable')
		}

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'indeterminate create no refund', provider: 'elevenlabs' }),
		})
		assert.equal(res.status, 503)
		const q = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			elevenlabs: { used: number }
		}
		assert.equal(q.elevenlabs.used, 1, 'Indeterminate create state must NOT refund reservation')
	}

	// 1d. POST /retry/:id: status() throws after WORKFLOW.create -> returns 200 ID and preserves quota;
	//     and a losing concurrent retry seeing an executed successor or shared reservation NEVER refunds winner's slot!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2' })
		const failedId = '1'.repeat(64)
		harness.workflowStatuses.set(failedId, 'errored')
		harness.doNs.getStorage(failedId).set('payload', {
			address: USER_A,
			prompt: 'retry status throw + shared ownership',
			public: true,
			instrumental: false,
			provider: 'elevenlabs',
		})
		harness.doNs.getStorage(failedId).set('provider_attempt', {
			provider: 'elevenlabs',
			status: 'failed',
			error_code: 'invalid_request',
			updated_at: new Date().toISOString(),
		})

		;(harness.env.WORKFLOW as unknown as { create: unknown }).create = async ({ id, params }: { id: string; params: WorkflowParams }) => {
			harness.createdWorkflows.push({ id, params })
			harness.workflowStatuses.set(id, 'running')
			return {
				status: async () => {
					throw new Error('transient retry status error')
				},
			}
		}

		const retryRes = await harness.send(`/retry/${failedId}`, { method: 'POST' })
		assert.equal(retryRes.status, 200)
		const succId = await retryRes.text()
		const quotaStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		assert.equal((await quotaStub.getReservation(succId))?.status, 'reserved')

		// Shared ownership protection: second caller attaches (claimCount=2); onlyIfUnshared refund MUST be refused!
		const sharedRes = await quotaStub.reserve(succId, 'elevenlabs', { classic: 2, elevenlabs: 2 })
		assert.equal(sharedRes.ok, true)
		if (sharedRes.ok) {
			assert.equal(sharedRes.shared, true)
			assert.equal(sharedRes.claimCount, 2)
		}
		const refusedSharedRefund = await quotaStub.refund(succId, 'loser_error', Date.now(), { onlyIfUnshared: true })
		assert.equal(refusedSharedRefund.refunded, false)
		assert.equal(refusedSharedRefund.reason, 'shared_reservation')
		assert.equal((await quotaStub.getReservation(succId))?.status, 'reserved')

		// Losing concurrent retry sees successor DO already marked executed -> must NOT refund winner's reservation!
		const failedId2 = '2'.repeat(64)
		const preclaimedSuccId = '3'.repeat(64)
		harness.workflowStatuses.set(failedId2, 'errored')
		harness.doNs.getStorage(failedId2).set('payload', {
			address: USER_A,
			prompt: 'loser sees executed successor',
			public: true,
			instrumental: false,
			provider: 'aisonggenerator',
		})
		harness.doNs.getStorage(failedId2).set('provider_attempt', {
			provider: 'aisonggenerator',
			status: 'failed',
			updated_at: new Date().toISOString(),
		})

		// Simulate loser seeing empty successor at claim time, reserving, then finding it executed at seed time
		const origGet = harness.env.DURABLE_OBJECT.get.bind(harness.env.DURABLE_OBJECT)
		;(harness.env.DURABLE_OBJECT as unknown as { get: unknown }).get = (doid: DurableObjectId) => {
			const stub = origGet(doid)
			const idStr = doid.toString()
			if (idStr === failedId2) {
				return {
					...stub,
					claimRetrySuccessor: async () => ({ successorId: preclaimedSuccId, predecessorId: failedId2, isNew: true }),
				}
			}
			if (idStr === preclaimedSuccId) {
				return {
					...stub,
					seedRetrySuccessorIfEmpty: async () => ({
						seeded: false,
						inspection: { state: 'executed' as const },
					}),
				}
			}
			return stub
		}

		const loserRes = await harness.send(`/retry/${failedId2}`, { method: 'POST' })
		assert.equal(loserRes.status, 503)
		assert.equal(
			(await quotaStub.getReservation(preclaimedSuccId))?.status,
			'reserved',
			'Losing concurrent retry seeing executed successor MUST NOT refund shared reservation'
		)
	}
})

test('Post-review regression 2 (P1): billed Classic poll-failure fallback retains Classic on original day and reserves ElevenLabs independently', async () => {
	const fakeMp3 = makeAudioBytes(88, 4096)
	let elMode: 'ok' | 'reject_401' = 'ok'

	const harness = buildQuotaFlowHarness({
		dailyClassic: '5',
		dailyElevenLabs: '2',
		aisgFetch: async (url) => {
			if (url.endsWith('/api/tasks')) {
				return new Response(JSON.stringify({ task_id: 'task-billed-fb', workspace_id: 'ws-b' }), { status: 200 })
			}
			if (url.includes('/api/tasks/task-billed-fb')) {
				return new Response(JSON.stringify({ task_id: 'task-billed-fb', music_ids: ['bf-1', 'bf-2'] }), { status: 200 })
			}
			if (url.includes('/api/songs?ids=')) {
				return new Response(JSON.stringify([
					{ music_id: 'bf-1', status: -3, audio: '', service: 'aisonggenerator', error_message: 'poll failed' },
					{ music_id: 'bf-2', status: -3, audio: '', service: 'aisonggenerator', error_message: 'poll failed' },
				]), { status: 200 })
			}
			throw new Error(`Unexpected AISG URL: ${url}`)
		},
	})

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('api.pixellab.ai')) {
			return new Response(JSON.stringify({ image: { base64: FAKE_IMAGE_B64 } }), { status: 200 })
		}
		if (url.includes('/elevenlabs/v1/music')) {
			if (elMode === 'reject_401') {
				return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 })
			}
			return new Response(fakeMp3, {
				status: 200,
				headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(fakeMp3.byteLength) },
			})
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		const userQuotaStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))

		// Case A: Billed Classic poll failure -> ElevenLabs fallback SUCCEEDS!
		// BOTH Classic (1/5, original reservation retained non-refundable) AND ElevenLabs (1/2, independent key committed) MUST remain counted!
		elMode = 'ok'
		const r1 = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'billed poll fail then el ok', provider: 'aisonggenerator' }),
		})
		const id1 = await r1.text()
		await wf.run(
			{ payload: harness.createdWorkflows.at(-1)!.params, instanceId: id1, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)

		const qAfterOk = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			classic: { used: number }
			elevenlabs: { used: number }
		}
		assert.equal(qAfterOk.classic.used, 1, 'Accepted Classic attempt MUST remain counted even when ElevenLabs fallback succeeds')
		assert.equal(qAfterOk.elevenlabs.used, 1, 'Independent ElevenLabs fallback reservation must also be counted')
		assert.equal((await userQuotaStub.getReservation(id1))?.status, 'ambiguous')
		assert.equal((await userQuotaStub.getReservation(id1))?.provider, 'aisonggenerator')
		assert.equal((await userQuotaStub.getReservation(`${id1}:fallback:elevenlabs`))?.status, 'committed')

		// Case B: Billed Classic poll failure across UTC midnight -> ElevenLabs rejects 401!
		// Classic stays retained on Day 1 (both user & global:Day1), while ONLY Day 2's independent ElevenLabs key is refunded!
		elMode = 'reject_401'
		const day1Ms = Date.parse('2026-11-23T23:59:50.000Z')
		const day1Key = '2026-11-23'
		const crossMidnightId = '4'.repeat(64)
		await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: crossMidnightId,
			provider: 'aisonggenerator',
			nowMs: day1Ms,
		})
		const paramsDay1: WorkflowParams = {
			address: USER_A,
			prompt: 'cross midnight poll fail then el reject',
			public: true,
			instrumental: false,
			provider: 'aisonggenerator',
			quota_reservation_id: crossMidnightId,
			quota_day_key: day1Key,
			quota_provider: 'aisonggenerator',
			quota_reuse_only: false,
			workflow_version: 2,
		}
		await assert.rejects(() => wf.run(
			{ payload: paramsDay1, instanceId: crossMidnightId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		))

		const day1UserRow = await userQuotaStub.getReservation(crossMidnightId)
		assert.equal(day1UserRow?.dayKey, day1Key, 'Billed Classic attempt must stay on its original UTC day')
		assert.equal(day1UserRow?.provider, 'aisonggenerator')
		assert.equal(day1UserRow?.status, 'ambiguous', 'Billed Classic attempt must stay non-refundable')
		const day1GlobalStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day1Key}`))
		const day1GlobalRow = await day1GlobalStub.getReservation(crossMidnightId)
		assert.equal(day1GlobalRow?.status, 'ambiguous', 'Day 1 global Classic row must stay retained and non-refundable')
		const fallbackElRow = await userQuotaStub.getReservation(`${crossMidnightId}:fallback:elevenlabs`)
		assert.equal(fallbackElRow?.status, 'refunded', 'Unbilled independent ElevenLabs fallback row must be refunded')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Post-review regression 3 (P1): R2 lookup error during retry admission returns 503; reuse-only workflow stops if R2 artifact disappears', async () => {
	let elApiCalls = 0
	const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2' })
	const tokenA = await createAuthToken(USER_A, TEST_SECRET)
	const prevFallbackId = '5'.repeat(64)

	harness.workflowStatuses.set(prevFallbackId, 'errored')
	harness.doNs.getStorage(prevFallbackId).set('payload', {
		address: USER_A,
		prompt: 'r2 artifact check test',
		public: true,
		instrumental: false,
		provider: 'aisonggenerator',
	})
	harness.doNs.getStorage(prevFallbackId).set('image_base64', FAKE_IMAGE_B64)
	harness.doNs.getStorage(prevFallbackId).set('description', 'desc')
	harness.doNs.getStorage(prevFallbackId).set('lyrics', { title: 'R2 Track', style: ['a', 'b'], lyrics: 'hi' })
	harness.doNs.getStorage(prevFallbackId).set('nsfw', { safe: true, categories: [] })
	harness.doNs.getStorage(prevFallbackId).set('active_provider', 'elevenlabs')
	harness.doNs.getStorage(prevFallbackId).set('fallback_from', 'aisonggenerator')
	harness.doNs.getStorage(prevFallbackId).set('provider_attempt', {
		provider: 'elevenlabs',
		status: 'failed',
		source_smol_id: prevFallbackId,
		updated_at: new Date().toISOString(),
	})

	// 3a. R2 head() throws transient error -> POST /retry/:id returns 503 (retryable) and consumes ZERO ElevenLabs quota!
	const origHead = harness.r2.bucket.head
	let failHead = true
	;(harness.r2.bucket as unknown as { head: typeof origHead }).head = async (key: string) => {
		if (failHead) {
			throw new Error('R2 transient timeout')
		}
		return origHead(key)
	}

	const r2ErrRes = await harness.send(`/retry/${prevFallbackId}`, { method: 'POST' })
	assert.equal(r2ErrRes.status, 503, 'R2 lookup failure must be retryable 503, not treated as missing artifact')
	const qAfterR2Err = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
		elevenlabs: { used: number }
	}
	assert.equal(qAfterR2Err.elevenlabs.used, 0, 'R2 lookup error must NOT reserve a fresh ElevenLabs slot')

	// 3b. Artifact exists at admission (classified reuse-only, 0 new quota reserved), then disappears before workflow executes -> workflow STOPS without calling ElevenLabs!
	failHead = false
	const r2Key = `el-${prevFallbackId}.mp3`
	await harness.r2.bucket.put(r2Key, makeAudioBytes(5, 4096), {
		httpMetadata: { contentType: 'audio/mpeg' },
	})

	const reuseRes = await harness.send(`/retry/${prevFallbackId}`, { method: 'POST' })
	assert.equal(reuseRes.status, 200)
	const reuseSuccessorId = await reuseRes.text()
	assert.equal(harness.createdWorkflows.at(-1)?.params.quota_reuse_only, true)

	// Artifact disappears before execution!
	await harness.r2.bucket.delete(r2Key)

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('api.pixellab.ai')) {
			return new Response(JSON.stringify({ image: { base64: FAKE_IMAGE_B64 } }), { status: 200 })
		}
		if (url.includes('/elevenlabs/v1/music')) {
			elApiCalls += 1
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		await assert.rejects(
			() => wf.run(
				{ payload: harness.createdWorkflows.at(-1)!.params, instanceId: reuseSuccessorId, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/refusing unreserved paid dispatch/
		)
		assert.equal(elApiCalls, 0, 'Reuse-only workflow MUST NOT dispatch paid ElevenLabs call when artifact disappears')

		// 3c. Even a direct unreserved workflow bypassing POST / must acquire a provider-specific reservation before paid dispatch!
		const quotaStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		await quotaStub.reserve('fill-el-1', 'elevenlabs', { classic: 2, elevenlabs: 2 })
		await quotaStub.reserve('fill-el-2', 'elevenlabs', { classic: 2, elevenlabs: 2 })
		const unreservedId = '8'.repeat(64)
		harness.doNs.getStorage(unreservedId).set('image_base64', FAKE_IMAGE_B64)
		await assert.rejects(
			() => wf.run(
				{
					payload: {
						address: USER_A,
						prompt: 'direct unreserved dispatch attempt',
						public: true,
						instrumental: true,
						provider: 'elevenlabs',
					},
					instanceId: unreservedId,
					timestamp: new Date(),
				} as never,
				createWorkflowStep(new Map()).step as never
			),
			/Paid elevenlabs dispatch blocked by quota/
		)
		assert.equal(elApiCalls, 0, 'Unreserved workflow must be blocked by provider-specific dispatch quota check')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Post-review regression 4 (P1): pre-Wave-5 seeded_unstarted successor missing quota_needs_reservation classifies predecessor + saved override and enforces quota', async () => {
	const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '1' })
	const tokenA = await createAuthToken(USER_A, TEST_SECRET)
	const predId = '6'.repeat(64)
	const legacySuccId = '7'.repeat(64)

	// Predecessor failed with AISG content policy (needs a fresh paid call on retry)
	harness.workflowStatuses.set(predId, 'errored')
	harness.doNs.getStorage(predId).set('payload', {
		address: USER_A,
		prompt: 'pre-wave-5 legacy seed test',
		public: true,
		instrumental: false,
		provider: 'aisonggenerator',
	})
	harness.doNs.getStorage(predId).set('provider_attempt', {
		provider: 'aisonggenerator',
		status: 'failed',
		error_code: 'content_policy',
		updated_at: new Date().toISOString(),
	})
	harness.doNs.getStorage(predId).set('retry_reservation', {
		successorId: legacySuccId,
		predecessorId: predId,
	})

	// Pre-Wave-5 seeded_unstarted successor: has retry_override_provider='elevenlabs' & retry_seed_pending=true,
	// but NO quota_needs_reservation field!
	harness.doNs.getStorage(legacySuccId).set('payload', {
		address: USER_A,
		prompt: 'pre-wave-5 legacy seed test',
		public: true,
		instrumental: false,
		provider: 'elevenlabs',
	})
	harness.doNs.getStorage(legacySuccId).set('retry_source_id', predId)
	harness.doNs.getStorage(legacySuccId).set('retry_override_provider', 'elevenlabs')
	harness.doNs.getStorage(legacySuccId).set('retry_seed_pending', true)

	// Exhaust User A's ElevenLabs quota first (1/1)
	const quotaStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
	await quotaStub.reserve('already-used-el', 'elevenlabs', { classic: 5, elevenlabs: 1 })

	// Recovery MUST classify predecessor + saved 'elevenlabs' override and return 429 (cannot bypass!)
	const blockedRes = await harness.send(`/retry/${predId}`, { method: 'POST' })
	assert.equal(blockedRes.status, 429, 'Pre-Wave-5 seeded_unstarted recovery must enforce ElevenLabs quota')
	const blockedJson = await blockedRes.json() as Record<string, unknown>
	assert.equal(blockedJson.code, 'quota_exceeded')
	assert.equal(blockedJson.provider, 'elevenlabs')
	assert.equal(harness.createdWorkflows.length, 0)

	// Refund the unrelated slot -> recovery now reserves legacySuccId under ElevenLabs and starts workflow!
	await quotaStub.refund('already-used-el', 'test_reset')
	const okRes = await harness.send(`/retry/${predId}`, { method: 'POST' })
	assert.equal(okRes.status, 200)
	assert.equal(await okRes.text(), legacySuccId)
	assert.equal(harness.createdWorkflows.length, 1)
	assert.equal(harness.createdWorkflows[0].params.override_provider, 'elevenlabs')
	assert.equal(harness.createdWorkflows[0].params.quota_reservation_id, legacySuccId)
	assert.equal(harness.createdWorkflows[0].params.quota_provider, 'elevenlabs')
	assert.equal(harness.createdWorkflows[0].params.quota_reuse_only, false)
	const q = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
		elevenlabs: { used: number }
	}
	assert.equal(q.elevenlabs.used, 1)
})

test('Post-review regression 5 (P1): strict commit preconditions, global conflict/invalid-state handling, and scheduled DO alarm pruning', async () => {
	const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '50' })
	const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
	const dayKey = '2026-11-23'
	const nowMs = Date.parse('2026-11-23T12:00:00.000Z')

	// 5a. commit() strictly refuses provider mismatch and strictly refuses reviving a refunded row!
	await userStub.reserve('strict-1', 'aisonggenerator', { classic: 5, elevenlabs: 5 }, nowMs)
	const mismatchCommit = await userStub.commit('strict-1', 'elevenlabs', nowMs + 100)
	assert.equal(mismatchCommit.committed, false)
	assert.equal(mismatchCommit.reason, 'provider_mismatch')
	assert.equal((await userStub.getReservation('strict-1'))?.provider, 'aisonggenerator')
	assert.equal((await userStub.getReservation('strict-1'))?.status, 'reserved')

	await userStub.refund('strict-1', 'rejected', nowMs + 200)
	const reviveCommit = await userStub.commit('strict-1', 'aisonggenerator', nowMs + 300)
	assert.equal(reviveCommit.committed, false)
	assert.equal(reviveCommit.reason, 'already_refunded')
	assert.equal((await userStub.getReservation('strict-1'))?.status, 'refunded')

	// 5b. Global DO reservation_conflict MUST NOT fall through as ok=true, and MUST compensate user DO!
	const globalStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${dayKey}`))
	await globalStub.reserve('conflict-res-1', 'elevenlabs', { classic: 50, elevenlabs: 50 }, nowMs)

	const resConflict = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
		address: USER_A,
		reservationId: 'conflict-res-1',
		provider: 'aisonggenerator',
		nowMs,
	})
	assert.equal(resConflict.ok, false)
	assert.equal(resConflict.code, 'reservation_conflict')
	assert.equal((await userStub.getReservation('conflict-res-1'))?.status, 'refunded', 'User DO must be compensated on global conflict')

	// 5c. Global DO invalid_state on transitionFallback MUST NOT fall through as ok=true, and MUST revert user DO!
	await userStub.reserve('fb-disagree-1', 'aisonggenerator', { classic: 5, elevenlabs: 5 }, nowMs)
	await globalStub.reserve('fb-disagree-1', 'aisonggenerator', { classic: 50, elevenlabs: 50 }, nowMs)
	await globalStub.markAmbiguous('fb-disagree-1', 'simulated_global_mismatch', nowMs + 10)

	const fbDisagree = await quotaUtilsModule.transitionFallbackQuota(harness.env, {
		address: USER_A,
		reservationId: 'fb-disagree-1',
		fromProvider: 'aisonggenerator',
		toProvider: 'elevenlabs',
		previousDayKey: dayKey,
		nowMs: nowMs + 20,
	})
	assert.equal(fbDisagree.ok, false)
	assert.equal(fbDisagree.code, 'invalid_state')
	const revertedUserRow = await userStub.getReservation('fb-disagree-1')
	assert.equal(revertedUserRow?.provider, 'aisonggenerator', 'User DO must revert fallback on global invalid_state')
	assert.equal(revertedUserRow?.status, 'reserved')

	// 5d. Scheduled alarm prunes inactive daily global bucket rows once past retention
	const oldDayMs = Date.now() - 20 * 86_400_000
	const oldDayKey = new Date(oldDayMs).toISOString().slice(0, 10)
	const oldGlobalName = `global:${oldDayKey}`
	const oldGlobalStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(oldGlobalName))
	await oldGlobalStub.reserve('old-global-1', 'aisonggenerator', { classic: 50, elevenlabs: 50 }, oldDayMs)
	await oldGlobalStub.commit('old-global-1', 'aisonggenerator', oldDayMs + 1000)
	assert.ok(harness.quotaNs.getAlarm(oldGlobalName) !== null, 'Daily global bucket must schedule cleanup alarm')
	await oldGlobalStub.alarm()
	assert.equal(await oldGlobalStub.getReservation('old-global-1'), null, 'Alarm must prune expired rows in inactive daily bucket')
})

test('Post-review regression 6 (P2): beacon mode bounds body size (413) and serializes concurrent duplicate & burst beacons atomically', async () => {
	const harness = buildQuotaFlowHarness({
		playCountMode: 'beacon',
		playRateLimitPerMinute: '2',
		playCooldownSeconds: '30',
	})
	harness.smolsTable.set('smol-c1', { Id: 'smol-c1', Song_1: 'track-conc-1', Song_2: null, Plays: 0 })
	harness.smolsTable.set('smol-c2', { Id: 'smol-c2', Song_1: 'track-conc-2', Song_2: null, Plays: 0 })
	harness.smolsTable.set('smol-c3', { Id: 'smol-c3', Song_1: 'track-conc-3', Song_2: null, Plays: 0 })
	harness.smolsTable.set('smol-c4', { Id: 'smol-c4', Song_1: 'track-conc-4', Song_2: null, Plays: 0 })

	// Inject artificial async latency into D1 UPDATE so overlapping requests maximally race
	const origPrepare = harness.env.SMOL_D1.prepare.bind(harness.env.SMOL_D1)
	;(harness.env.SMOL_D1 as unknown as { prepare: unknown }).prepare = (sql: string) => {
		const stmt = origPrepare(sql)
		return {
			bind: (...args: unknown[]) => {
				const bound = stmt.bind(...args)
				return {
					...bound,
					run: async () => {
						await new Promise((r) => setTimeout(r, 15))
						return await bound.run()
					},
				}
			},
		}
	}

	// 6a. Oversized Content-Length (>1024 bytes) -> 413 with ZERO D1 calls
	const d1Before413 = harness.getD1TotalCalls()
	const oversizedHeader = await harness.send('/plays/track-conc-1', {
		method: 'POST',
		headers: {
			'CF-Connecting-IP': '203.0.113.1',
			'Content-Type': 'application/json',
			'Content-Length': '2048',
		},
		body: JSON.stringify({ playId: 'x'.repeat(2000) }),
	})
	assert.equal(oversizedHeader.status, 413)
	assert.equal(harness.getD1TotalCalls(), d1Before413)

	// 6b. Oversized chunked JSON stream (>1024 bytes without Content-Length) -> 413 with ZERO D1 calls
	const bigStream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(`{"playId":"${'a'.repeat(600)}`))
			controller.enqueue(new TextEncoder().encode(`${'b'.repeat(600)}"}`))
			controller.close()
		},
	})
	const oversizedStreamRes = await appModule.app.fetch(
		new Request('https://api.smol.xyz/plays/track-conc-1', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': '203.0.113.1', 'Content-Type': 'application/json' },
			body: bigStream,
			duplex: 'half',
		} as RequestInit),
		harness.env,
		createMockExecutionContext().ctx
	)
	assert.equal(oversizedStreamRes.status, 413)
	assert.equal(harness.getD1TotalCalls(), d1Before413)

	// 6c. 10 concurrent overlapping duplicate beacons for the same (caller, musicId) -> EXACTLY 1 D1 increment!
	const dupResponses = await Promise.all(
		Array.from({ length: 10 }, () =>
			harness.send('/plays/track-conc-1', {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.50' },
			})
		)
	)
	const dupBodies = await Promise.all(dupResponses.map((r) => r.json() as Promise<{ counted: boolean; deduped?: boolean }>))
	assert.equal(dupResponses.every((r) => r.status === 200), true)
	assert.equal(dupBodies.filter((b) => b.counted).length, 1, 'Exactly 1 concurrent duplicate beacon may count')
	assert.equal(dupBodies.filter((b) => b.deduped).length, 9, 'Remaining 9 concurrent duplicates must be deduped')
	assert.equal(harness.smolsTable.get('smol-c1')?.Plays, 1, 'D1 Plays must increment exactly once under concurrency')

	// 6d. Concurrent burst across 4 distinct songs with rateLimitPerMinute=2 -> EXACTLY 2 counted, 2 rate-limited (429)!
	const burstResponses = await Promise.all(
		['track-conc-1', 'track-conc-2', 'track-conc-3', 'track-conc-4'].map((songId) =>
			harness.send(`/plays/${songId}`, {
				method: 'POST',
				headers: { 'CF-Connecting-IP': '203.0.113.77' },
			})
		)
	)
	assert.equal(burstResponses.filter((r) => r.status === 200).length, 2, 'Exactly 2 distinct plays admitted within 2/min cap')
	assert.equal(burstResponses.filter((r) => r.status === 429).length, 2, 'Remaining 2 distinct plays must get 429')
})

test('Pass-2 regression 1 (P1): ElevenLabs pre-claim R2 failure stays retryable & refunds fresh slot; late predecessor R2 reuse refunds instead of committing', async () => {
	// 1a. Pre-claim R2 HEAD failure in retryable step -> retries cleanly (0 ElevenLabs HTTP calls) and refunds fresh reservation if exhausted
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '2' })
		const smolId = 'c'.repeat(64)
		const reserve = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: smolId,
			provider: 'elevenlabs',
		})
		assert.equal(reserve.ok, true)

		let elevenLabsCalls = 0
		const origFetch = globalThis.fetch
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
			if (url.includes('api.pixellab.ai')) {
				return new Response(JSON.stringify({ image: { base64: FAKE_IMAGE_B64 } }), { status: 200 })
			}
			if (url.includes('ai.cloudflare.com')) {
				elevenLabsCalls++
			}
			throw new Error(`Unexpected fetch: ${url}`)
		}) as typeof fetch

		// R2 HEAD always fails before paid claim
		;(harness.env.SMOL_BUCKET as unknown as { head: unknown }).head = async () => {
			throw new Error('R2 head transient outage')
		}

		try {
			const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
			const { step } = createWorkflowStep(new Map())
			await assert.rejects(
				() => wf.run(
					{
						instanceId: smolId,
						timestamp: new Date(),
						payload: {
							address: USER_A,
							prompt: 'pre-claim r2 head outage',
							public: true,
							instrumental: true,
							provider: 'elevenlabs',
							quota_reservation_id: smolId,
							quota_day_key: reserve.ok ? reserve.dayKey : undefined,
							quota_provider: 'elevenlabs',
						},
					} as unknown as WorkflowEvent<WorkflowParams>,
					step
				),
				/R2 head transient outage/
			)
		} finally {
			globalThis.fetch = origFetch
		}

		assert.equal(elevenLabsCalls, 0, 'Pre-claim R2 failure must never invoke ElevenLabs')
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		assert.equal((await userStub.getReservation(smolId))?.status, 'refunded', 'Fresh reservation must be refunded when pre-claim R2 HEAD fails')
		assert.equal(harness.doNs.getStorage(smolId).get('provider_attempt'), undefined, 'Paid attempt must not be claimed before R2 check')
	}

	// 1b. Internal generateElevenLabsSong pre-dispatch R2 HEAD failure -> classified as rejected/retryable, marks failed & refunds (never ambiguous)
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '2' })
		const smolId = 'd'.repeat(64)
		const reserve = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: smolId,
			provider: 'elevenlabs',
		})
		assert.equal(reserve.ok, true)

		let headCount = 0
		const origHead1b = harness.env.SMOL_BUCKET.head.bind(harness.env.SMOL_BUCKET)
		;(harness.env.SMOL_BUCKET as unknown as { head: unknown }).head = async (key: string) => {
			if (!key.endsWith('.mp3')) {
				return await origHead1b(key)
			}
			headCount++
			if (headCount === 1) {
				// Retryable pre-claim check sees no artifact
				return null
			}
			// Second HEAD inside generateElevenLabsSong fails BEFORE any ElevenLabs HTTP request
			throw new Error('R2 internal pre-dispatch failure')
		}

		let elevenLabsCalls = 0
		const origFetch = globalThis.fetch
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
			if (url.includes('api.pixellab.ai')) {
				return new Response(JSON.stringify({ image: { base64: FAKE_IMAGE_B64 } }), { status: 200 })
			}
			if (url.includes('ai.cloudflare.com')) {
				elevenLabsCalls++
			}
			throw new Error(`Unexpected fetch: ${url}`)
		}) as typeof fetch

		try {
			const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
			const { step } = createWorkflowStep(new Map())
			await assert.rejects(
				() => wf.run(
					{
						instanceId: smolId,
						timestamp: new Date(),
						payload: {
							address: USER_A,
							prompt: 'provider helper pre-dispatch r2 error',
							public: true,
							instrumental: true,
							provider: 'elevenlabs',
							quota_reservation_id: smolId,
							quota_day_key: reserve.ok ? reserve.dayKey : undefined,
							quota_provider: 'elevenlabs',
						},
					} as unknown as WorkflowEvent<WorkflowParams>,
					step
				),
				/R2 pre-dispatch lookup failed/
			)
		} finally {
			globalThis.fetch = origFetch
		}

		assert.equal(elevenLabsCalls, 0)
		const attempt = harness.doNs.getStorage(smolId).get('provider_attempt') as { status?: string } | undefined
		assert.equal(attempt?.status, 'failed', 'Pre-dispatch R2 error must mark attempt failed, NOT ambiguous')
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		assert.equal((await userStub.getReservation(smolId))?.status, 'refunded', 'Pre-dispatch R2 error must refund fresh reservation')
	}

	// 1c. Late predecessor R2 artifact appears AFTER fresh reservation (both at retryable check AND inside provider helper reuse receipt)
	//     -> successor completes reusing predecessor audio with 0 ElevenLabs calls AND REFUNDS its fresh reservation (even with claim_count=2)!
	for (const lateAtProviderHelper of [false, true]) {
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '2' })
		const predId = (lateAtProviderHelper ? 'f' : 'e').repeat(64)
		const succId = (lateAtProviderHelper ? '7' : '6').repeat(64)
		const predMusicId = `el-${predId}`

		// Predecessor had failed elevenlabs attempt (so retry reserved a fresh ElevenLabs slot for succId)
		harness.doNs.getStorage(predId).set('payload', {
			address: USER_A,
			prompt: 'late predecessor r2 reuse',
			public: true,
			instrumental: true,
			provider: 'elevenlabs',
		})
		harness.doNs.getStorage(predId).set('active_provider', 'elevenlabs')
		harness.doNs.getStorage(predId).set('provider_attempt', {
			provider: 'elevenlabs',
			status: 'failed',
			source_smol_id: predId,
			updated_at: new Date().toISOString(),
		})
		harness.doNs.getStorage(predId).set('title', 'Late Reuse Title')
		harness.doNs.getStorage(predId).set('description', 'desc')
		harness.doNs.getStorage(predId).set('tags', ['lofi'])
		harness.doNs.getStorage(predId).set('lyrics', { title: 'Late Reuse Title', style: ['lofi'], lyrics: '' })
		harness.doNs.getStorage(predId).set('image_base64', FAKE_IMAGE_B64)

		const reserve = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: succId,
			provider: 'elevenlabs',
		})
		assert.equal(reserve.ok, true)
		// Also simulate a second concurrent retry caller attaching (claim_count = 2) before workflow runs
		await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: succId,
			provider: 'elevenlabs',
		})

		const fakeMp3 = makeAudioBytes(55, 40_000)
		let musicHeadCalls = 0
		const origHead = harness.env.SMOL_BUCKET.head.bind(harness.env.SMOL_BUCKET)
		;(harness.env.SMOL_BUCKET as unknown as { head: unknown }).head = async (key: string) => {
			if (key === `${predMusicId}.mp3`) {
				musicHeadCalls++
				if (lateAtProviderHelper && musicHeadCalls === 1) {
					// Miss at retryable step, THEN artifact appears just in time for generateElevenLabsSong()!
					await harness.env.SMOL_BUCKET.put(`${predMusicId}.mp3`, fakeMp3, {
						customMetadata: { smolId: predId, upstreamSongId: 'up-late-1', gatewayLogId: 'gw-late-1' },
					})
					return null
				}
			}
			return await origHead(key)
		}

		if (!lateAtProviderHelper) {
			await harness.env.SMOL_BUCKET.put(`${predMusicId}.mp3`, fakeMp3, {
				customMetadata: { smolId: predId, upstreamSongId: 'up-early-1', gatewayLogId: 'gw-early-1' },
			})
		}

		let elevenLabsCalls = 0
		const origFetch = globalThis.fetch
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
			if (url.includes('ai.cloudflare.com')) {
				elevenLabsCalls++
			}
			throw new Error(`Unexpected fetch: ${url}`)
		}) as typeof fetch

		try {
			const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
			const { step } = createWorkflowStep(new Map())
			await wf.run(
				{
					instanceId: succId,
					timestamp: new Date(),
					payload: {
						retry_id: predId,
						provider: 'elevenlabs',
						quota_reservation_id: succId,
						quota_day_key: reserve.ok ? reserve.dayKey : undefined,
						quota_provider: 'elevenlabs',
						quota_reuse_only: false,
					},
				} as unknown as WorkflowEvent<WorkflowParams>,
				step
			)
		} finally {
			globalThis.fetch = origFetch
		}

		assert.equal(elevenLabsCalls, 0, 'Late R2 reuse must NEVER make a paid ElevenLabs call')
		assert.equal(harness.smolsTable.get(succId)?.Song_1, predMusicId, 'Successor must publish reused predecessor track')

		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const userRow = await userStub.getReservation(succId)
		assert.equal(
			userRow?.status,
			'refunded',
			`Successor fresh reservation must be refunded (not committed) on late R2 reuse (lateAtProviderHelper=${lateAtProviderHelper})`
		)
		const snapshot = await userStub.getQuota({ classic: 5, elevenlabs: 2 })
		assert.equal(snapshot.elevenlabs.used, 0, 'Reused predecessor R2 audio must consume 0 ElevenLabs quota')
	}
})

test('Pass-2 regression 2 (P1): overlapping global denials release shared user reservation cleanly and cross-UTC-midnight recovery keeps global bucket & SQL day consistent', async () => {
	const harness = buildQuotaFlowHarness({
		dailyClassic: '5',
		dailyElevenLabs: '5',
		globalClassic: '50',
		globalElevenLabs: '1',
	})

	const day1Ms = Date.parse('2026-11-23T23:59:30.000Z')
	const day1Key = '2026-11-23'
	const day2Ms = Date.parse('2026-11-24T00:01:00.000Z')
	const day2Key = '2026-11-24'

	const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
	const globalDay1Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day1Key}`))
	const globalDay2Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day2Key}`))

	// Fill Day 1 global ElevenLabs circuit breaker (limit = 1) via another user
	const otherFill = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
		address: USER_B,
		reservationId: 'other-user-day1',
		provider: 'elevenlabs',
		nowMs: day1Ms,
	})
	assert.equal(otherFill.ok, true)

	// 2a. Two overlapping callers attempt to reserve the SAME shared retry reservationId while global Day 1 is full:
	//     Force maximal overlap by pausing the first globalStub.reserve call until the second caller attaches to userStub!
	const sharedRetryId = 'shared-retry-global-denied'
	let releaseFirstGlobal!: () => void
	let firstEnteredGlobal!: () => void
	const firstInGlobal = new Promise<void>((resolve) => {
		firstEnteredGlobal = resolve
	})
	const holdFirstGlobal = new Promise<void>((resolve) => {
		releaseFirstGlobal = resolve
	})

	const origNamespaceGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
	let globalReserveCalls = 0
	;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
		const stub = origNamespaceGet(id)
		if (id.toString() === `global:${day1Key}`) {
			return new Proxy(stub, {
				get(target, prop, receiver) {
					if (prop === 'reserve') {
						return async (...args: Parameters<typeof target.reserve>) => {
							globalReserveCalls++
							if (globalReserveCalls === 1) {
								firstEnteredGlobal()
								await holdFirstGlobal
							}
							return await target.reserve(...args)
						}
					}
					const val = Reflect.get(target, prop, receiver)
					return typeof val === 'function' ? val.bind(target) : val
				},
			})
		}
		return stub
	}

	const caller1Promise = quotaUtilsModule.reserveGenerationQuota(harness.env, {
		address: USER_A,
		reservationId: sharedRetryId,
		provider: 'elevenlabs',
		nowMs: day1Ms,
	})
	await firstInGlobal

	// Caller 2 attaches while Caller 1 is paused at global:day1 (user claim_count becomes 2!)
	const caller2Promise = quotaUtilsModule.reserveGenerationQuota(harness.env, {
		address: USER_A,
		reservationId: sharedRetryId,
		provider: 'elevenlabs',
		nowMs: day1Ms,
	})
	// Wait briefly for Caller 2 to complete its global denial & releaseClaim, then unblock Caller 1
	const res2 = await caller2Promise
	releaseFirstGlobal()
	const res1 = await caller1Promise
	;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origNamespaceGet

	assert.equal(res1.ok, false)
	assert.equal(res2.ok, false)
	assert.equal(res1.code, 'quota_exceeded')
	assert.equal(res2.code, 'quota_exceeded')

	// CRITICAL: Neither caller may strand user usage incremented!
	const userRowAfterDualDenial = await userStub.getReservation(sharedRetryId)
	assert.equal(userRowAfterDualDenial?.status, 'refunded', 'Final failing claimant must refund shared user reservation')
	const day1UserSnap = await userStub.getQuota({ classic: 5, elevenlabs: 5 }, day1Ms)
	assert.equal(day1UserSnap.elevenlabs.used, 0, 'User Day-1 ElevenLabs usage must be 0 after overlapping global denials')

	// 2b. Next-day recovery after UTC midnight: must reserve cleanly in user:<A> (Day 2) AND global:<Day 2> (SQL day_key = Day 2)
	const day2Recovery = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
		address: USER_A,
		reservationId: sharedRetryId,
		provider: 'elevenlabs',
		nowMs: day2Ms,
	})
	assert.equal(day2Recovery.ok, true)
	if (day2Recovery.ok) {
		assert.equal(day2Recovery.dayKey, day2Key)
	}
	assert.equal((await userStub.getReservation(sharedRetryId))?.dayKey, day2Key)
	assert.equal((await globalDay1Stub.getReservation(sharedRetryId)), null, 'Day-1 global DO must NOT receive Day-2 recovery row')
	const g2Row = await globalDay2Stub.getReservation(sharedRetryId)
	assert.equal(g2Row?.dayKey, day2Key, 'Day-2 global DO SQL day_key MUST match its DO name global:2026-11-24')
	assert.equal(g2Row?.admitted, true)

	// Day-2 global circuit breaker (limit = 1) must now block a second ElevenLabs reservation on Day 2!
	const day2Blocked = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
		address: USER_B,
		reservationId: 'second-day2-blocked',
		provider: 'elevenlabs',
		nowMs: day2Ms + 1000,
	})
	assert.equal(day2Blocked.ok, false)
	assert.equal(day2Blocked.code, 'quota_exceeded')

	// 2c. Even if a prior-day unadmitted user row (admitted=0) was stranded by an isolate crash before releaseClaim,
	//     Day-2 recovery rolls it forward to Day 2 so global:Day 2 enforces Day 2 limits with SQL day_key = Day 2!
	const strandedId = 'stranded-unadmitted-day1'
	await userStub.reserve(strandedId, 'aisonggenerator', { classic: 5, elevenlabs: 5 }, day1Ms)
	assert.equal((await userStub.getReservation(strandedId))?.admitted, false)
	assert.equal((await userStub.getReservation(strandedId))?.dayKey, day1Key)

	const recoveredStranded = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
		address: USER_A,
		reservationId: strandedId,
		provider: 'aisonggenerator',
		nowMs: day2Ms + 2000,
	})
	assert.equal(recoveredStranded.ok, true)
	if (recoveredStranded.ok) {
		assert.equal(recoveredStranded.dayKey, day2Key)
	}
	assert.equal((await globalDay1Stub.getReservation(strandedId)), null, 'Stranded Day-1 unadmitted row must NOT insert into global:Day 1 on Day 2')
	const g2Stranded = await globalDay2Stub.getReservation(strandedId)
	assert.equal(g2Stranded?.dayKey, day2Key)
	assert.equal(g2Stranded?.admitted, true)

	// 2d. Conversely, if an ADMITTED Day-1 row (admitted=1) is retried on Day 2 before global had it (e.g. Day-1 soft fallback),
	//     passing explicit bucketDayKey ensures global:Day 1 STILL writes SQL day_key = Day 1 (NEVER Day 2 inside global:Day 1)!
	const admittedDay1Id = 'admitted-day1-soft-fallback'
	await userStub.reserve(admittedDay1Id, 'aisonggenerator', { classic: 5, elevenlabs: 5 }, day1Ms)
	assert.equal(await userStub.confirmAdmission(admittedDay1Id, 1, day1Key, day1Ms), true)
	const admittedRetryDay2 = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
		address: USER_A,
		reservationId: admittedDay1Id,
		provider: 'aisonggenerator',
		nowMs: day2Ms + 3000,
	})
	assert.equal(admittedRetryDay2.ok, true)
	const g1Row = await globalDay1Stub.getReservation(admittedDay1Id)
	assert.equal(g1Row?.dayKey, day1Key, 'global:2026-11-23 must ALWAYS record SQL day_key=2026-11-23, never 2026-11-24')
	assert.equal(await globalDay2Stub.getReservation(admittedDay1Id), null)
})

test('Pass-2 regression 3 (P1): uncertain workflow create rejects explicit unknown status (503, no 200) and refuses generic 404/not-found refunds', async () => {
	const tokenA = await createAuthToken(USER_A, TEST_SECRET)

	// 3a. POST / with create failure + WORKFLOW.get().status() === 'unknown' -> 503 (NOT 200) & preserves quota!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '3', dailyElevenLabs: '3' })
		;(harness.env.WORKFLOW as unknown as { create: unknown; get: unknown }).create = async () => {
			throw new Error('uncertain create timeout')
		}
		;(harness.env.WORKFLOW as unknown as { get: unknown }).get = async () => ({
			status: async () => ({ status: 'unknown' }),
		})

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'create unknown status', provider: 'elevenlabs' }),
		})
		assert.equal(res.status, 503, 'Explicit Workflows unknown status must return 503, NEVER 200')
		const q = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			elevenlabs: { used: number }
		}
		assert.equal(q.elevenlabs.used, 1, 'Explicit Workflows unknown status must preserve quota (no refund)')
	}

	// 3b. POST / with create failure + generic 404 / "not found" error from WORKFLOW.get() -> 503 & preserves quota!
	for (const errMsg of ['HTTP 404 Not Found', 'upstream route not found', '404']) {
		const harness = buildQuotaFlowHarness({ dailyClassic: '3', dailyElevenLabs: '3' })
		;(harness.env.WORKFLOW as unknown as { create: unknown; get: unknown }).create = async () => {
			throw new Error('create failed')
		}
		;(harness.env.WORKFLOW as unknown as { get: unknown }).get = async () => {
			throw new Error(errMsg)
		}

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: `generic error: ${errMsg}`, provider: 'elevenlabs' }),
		})
		assert.equal(res.status, 503, `Generic error "${errMsg}" must return 503, not treat as missing`)
		const q = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			elevenlabs: { used: number }
		}
		assert.equal(q.elevenlabs.used, 1, `Generic error "${errMsg}" must NEVER authorize a quota refund`)
	}

	// 3c. POST / with create failure + recognized instance-specific absence error ('instance.not_found') -> refunds cleanly!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '3', dailyElevenLabs: '3' })
		;(harness.env.WORKFLOW as unknown as { create: unknown; get: unknown }).create = async () => {
			throw new Error('create rejected upstream')
		}
		;(harness.env.WORKFLOW as unknown as { get: unknown }).get = async () => {
			throw new Error('instance.not_found')
		}

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'recognized instance.not_found refunds', provider: 'elevenlabs' }),
		})
		assert.equal(res.status, 500)
		const q = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			elevenlabs: { used: number }
		}
		assert.equal(q.elevenlabs.used, 0, 'Recognized instance.not_found must cleanly refund unshared reservation')
	}

	// 3d. POST /retry/:id with create failure + explicit 'unknown' status AND generic 'HTTP 404 Not Found' -> both return 503 & preserve quota!
	for (const mode of ['unknown_status', 'generic_404'] as const) {
		const harness = buildQuotaFlowHarness({ dailyClassic: '3', dailyElevenLabs: '3' })
		const failedId = (mode === 'unknown_status' ? '8' : '9').repeat(64)
		harness.workflowStatuses.set(failedId, 'errored')
		harness.doNs.getStorage(failedId).set('payload', {
			address: USER_A,
			prompt: `retry ${mode}`,
			public: true,
			instrumental: false,
			provider: 'elevenlabs',
		})
		harness.doNs.getStorage(failedId).set('provider_attempt', {
			provider: 'elevenlabs',
			status: 'failed',
			updated_at: new Date().toISOString(),
		})

		;(harness.env.WORKFLOW as unknown as { create: unknown; get: unknown }).create = async () => {
			throw new Error('retry create uncertain timeout')
		}
		const origGet = harness.env.WORKFLOW.get.bind(harness.env.WORKFLOW)
		;(harness.env.WORKFLOW as unknown as { get: unknown }).get = async (id: string) => {
			if (id === failedId) {
				return await origGet(id)
			}
			if (mode === 'unknown_status') {
				return { status: async () => ({ status: 'unknown' }) }
			}
			throw new Error('HTTP 404 Not Found')
		}

		const retryRes = await harness.send(`/retry/${failedId}`, { method: 'POST' })
		assert.equal(retryRes.status, 503, `POST /retry/:id (${mode}) must return 503, NEVER 200`)
		const q = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			elevenlabs: { used: number }
		}
		assert.equal(q.elevenlabs.used, 1, `POST /retry/:id (${mode}) must preserve quota (no refund)`)
	}
})

test('Pass-2 regression 4 (P2): POST /plays/:musicId enforces 1 KiB body cap (413) even when valid X-Play-Id header is present', async () => {
	const harness = buildQuotaFlowHarness({ playCountMode: 'beacon' })
	harness.smolsTable.set('smol-hdr-413', { Id: 'smol-hdr-413', Song_1: 'track-hdr-413', Song_2: null, Plays: 0 })

	const d1Before = harness.getD1TotalCalls()
	const chunkedOversized = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"pad":"' + 'x'.repeat(600)))
			controller.enqueue(new TextEncoder().encode('y'.repeat(600) + '"}'))
			controller.close()
		},
	})

	const res = await appModule.app.fetch(
		new Request('https://api.smol.xyz/plays/track-hdr-413', {
			method: 'POST',
			headers: {
				'CF-Connecting-IP': '203.0.113.99',
				'X-Play-Id': 'valid-header-play-id-123',
				'Content-Type': 'application/json',
			},
			body: chunkedOversized,
			duplex: 'half',
		} as RequestInit),
		harness.env,
		createMockExecutionContext().ctx
	)
	assert.equal(res.status, 413, 'Oversized chunked body MUST return 413 even when valid X-Play-Id header is present')
	assert.equal(harness.getD1TotalCalls(), d1Before, 'Oversized beacon must NOT write to D1')
	assert.equal(harness.smolsTable.get('smol-hdr-413')?.Plays, 0)
})

test('Pass-3 regression 1 (P1): generation+dayKey binding prevents delayed prior-day global responses from corrupting today rollover, reconciles superseded global buckets, and requires user confirmation', async () => {
	const day1Ms = Date.parse('2026-11-23T23:59:55.000Z')
	const day1Key = '2026-11-23'
	const day2Ms = Date.parse('2026-11-24T00:00:05.000Z')
	const day2Key = '2026-11-24'

	// 1a. Overlapping UTC midnight race: Day-1 global denial arrives AFTER Day-2 rollover starts,
	//     BEFORE Day-2 confirms user admission -> Day-1 releaseClaim(gen=1, day1) MUST be a no-op!
	{
		const harness = buildQuotaFlowHarness({
			dailyClassic: '5',
			dailyElevenLabs: '5',
			globalClassic: '50',
			globalElevenLabs: '1',
		})
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalDay1Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day1Key}`))
		const globalDay2Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day2Key}`))

		// Fill Day 1 global ElevenLabs cap so Day-1 caller will be denied
		const fill = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_B,
			reservationId: 'fill-day1-cap',
			provider: 'elevenlabs',
			nowMs: day1Ms,
		})
		assert.equal(fill.ok, true)

		const retryId = 'midnight-overlap-denial'
		let day1EnteredGlobal!: () => void
		let releaseDay1Global!: () => void
		let day2EnteredConfirm!: () => void
		let releaseDay2Confirm!: () => void
		const pDay1Entered = new Promise<void>((r) => { day1EnteredGlobal = r })
		const pHoldDay1 = new Promise<void>((r) => { releaseDay1Global = r })
		const pDay2EnteredConfirm = new Promise<void>((r) => { day2EnteredConfirm = r })
		const pHoldDay2Confirm = new Promise<void>((r) => { releaseDay2Confirm = r })

		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			const name = id.toString()
			if (name === `global:${day1Key}`) {
				return new Proxy(stub, {
					get(target, prop, receiver) {
						if (prop === 'reserve') {
							return async (...args: Parameters<typeof target.reserve>) => {
								if (args[0] === retryId) {
									day1EnteredGlobal()
									await pHoldDay1
								}
								return await target.reserve(...args)
							}
						}
						const v = Reflect.get(target, prop, receiver)
						return typeof v === 'function' ? v.bind(target) : v
					},
				})
			}
			if (name === `user:${USER_A}`) {
				return new Proxy(stub, {
					get(target, prop, receiver) {
						if (prop === 'confirmAdmission') {
							return async (...args: Parameters<typeof target.confirmAdmission>) => {
								if (args[0] === retryId && args[2] === day2Key) {
									day2EnteredConfirm()
									await pHoldDay2Confirm
								}
								return await target.confirmAdmission(...args)
							}
						}
						const v = Reflect.get(target, prop, receiver)
						return typeof v === 'function' ? v.bind(target) : v
					},
				})
			}
			return stub
		}

		// Start Day-1 caller -> reserves user:A (gen=1, day1) and pauses inside global:day1.reserve
		const day1Promise = quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: retryId,
			provider: 'elevenlabs',
			nowMs: day1Ms,
		})
		await pDay1Entered

		// Start Day-2 caller -> rolls user:A forward to (gen=2, day2), reserves global:day2, pauses BEFORE user confirmAdmission
		const day2Promise = quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: retryId,
			provider: 'elevenlabs',
			nowMs: day2Ms,
		})
		await pDay2EnteredConfirm

		// Now let Day-1's delayed denial arrive and run releaseClaim(retryId, 1, day1Key)!
		releaseDay1Global()
		const day1Result = await day1Promise
		assert.equal(day1Result.ok, false)
		assert.equal(day1Result.code, 'quota_exceeded')

		// Verify Day-2's pending user row was NOT touched or refunded by Day-1's delayed denial!
		const midRow = await userStub.getReservation(retryId)
		assert.equal(midRow?.status, 'reserved', 'Delayed Day-1 denial MUST NOT refund Day-2 replacement claim')
		assert.equal(midRow?.dayKey, day2Key)
		assert.equal(midRow?.generation, 2)
		assert.equal(midRow?.claimCount, 1)

		// Now let Day-2 finish user & global confirmation!
		releaseDay2Confirm()
		const day2Result = await day2Promise
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal(day2Result.ok, true)
		if (day2Result.ok) {
			assert.equal(day2Result.dayKey, day2Key)
		}
		const finalUserRow = await userStub.getReservation(retryId)
		assert.equal(finalUserRow?.status, 'reserved')
		assert.equal(finalUserRow?.admitted, true)
		assert.equal(finalUserRow?.dayKey, day2Key)
		assert.equal(finalUserRow?.generation, 2)
		assert.equal((await globalDay2Stub.getReservation(retryId))?.admitted, true)
		assert.equal(await globalDay1Stub.getReservation(retryId), null)
	}

	// 1b. Delayed Day-1 global APPROVAL arriving after Day-2 rollover -> user confirmAdmission(gen=1, day1) returns false,
	//     reconciles/refunds global:day1, and fails closed (throws), leaving Day-2 intact!
	{
		const harness = buildQuotaFlowHarness({
			dailyClassic: '5',
			dailyElevenLabs: '5',
			globalClassic: '50',
			globalElevenLabs: '5',
		})
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalDay1Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day1Key}`))
		const globalDay2Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day2Key}`))

		const retryId = 'midnight-delayed-approval'
		let day1EnteredGlobal!: () => void
		let releaseDay1Global!: () => void
		const pDay1Entered = new Promise<void>((r) => { day1EnteredGlobal = r })
		const pHoldDay1 = new Promise<void>((r) => { releaseDay1Global = r })

		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `global:${day1Key}`) {
				return new Proxy(stub, {
					get(target, prop, receiver) {
						if (prop === 'reserve') {
							return async (...args: Parameters<typeof target.reserve>) => {
								if (args[0] === retryId) {
									day1EnteredGlobal()
									await pHoldDay1
								}
								return await target.reserve(...args)
							}
						}
						const v = Reflect.get(target, prop, receiver)
						return typeof v === 'function' ? v.bind(target) : v
					},
				})
			}
			return stub
		}

		const day1Promise = quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: retryId,
			provider: 'elevenlabs',
			nowMs: day1Ms,
		})
		await pDay1Entered

		// Day-2 recovers & completes admission cleanly
		const day2Result = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: retryId,
			provider: 'elevenlabs',
			nowMs: day2Ms,
		})
		assert.equal(day2Result.ok, true)

		// Now Day-1's delayed global:day1.reserve SUCCEEDS -> user confirmAdmission(gen=1, day1) returns false
		// -> coordinator refunds global:day1 and fails closed!
		releaseDay1Global()
		await assert.rejects(
			() => day1Promise,
			/User quota admission confirmation rejected/
		)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal((await globalDay1Stub.getReservation(retryId))?.status, 'refunded', 'Stale Day-1 global claim must be refunded on rejected user confirm')
		assert.equal((await globalDay2Stub.getReservation(retryId))?.admitted, true)
		assert.equal((await userStub.getReservation(retryId))?.dayKey, day2Key)
		assert.equal((await userStub.getReservation(retryId))?.admitted, true)
	}

	// 1c. Crash after global:day1 wrote row but before user:A confirmed admitted=1 -> Day-2 rollover reconciles/refunds
	//     superseded global:day1 so BOTH daily global buckets NEVER count the same retry!
	{
		const harness = buildQuotaFlowHarness({
			dailyClassic: '5',
			dailyElevenLabs: '5',
			globalClassic: '50',
			globalElevenLabs: '5',
		})
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalDay1Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day1Key}`))
		const globalDay2Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day2Key}`))

		const crashId = 'crash-before-user-confirm'
		await userStub.reserve(crashId, 'elevenlabs', { classic: 5, elevenlabs: 5 }, day1Ms)
		await globalDay1Stub.reserve(crashId, 'elevenlabs', { classic: 50, elevenlabs: 5 }, day1Ms, day1Key)
		// (Simulated worker crash before userStub.confirmAdmission!)
		assert.equal((await globalDay1Stub.getQuota({ classic: 50, elevenlabs: 5 }, day1Ms)).elevenlabs.used, 1)

		const recovered = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: crashId,
			provider: 'elevenlabs',
			nowMs: day2Ms,
		})
		assert.equal(recovered.ok, true)
		assert.equal((await globalDay1Stub.getReservation(crashId))?.status, 'refunded', 'Superseded Day-1 global row must be refunded on Day-2 rollover')
		assert.equal((await globalDay1Stub.getQuota({ classic: 50, elevenlabs: 5 }, day1Ms)).elevenlabs.used, 0)
		assert.equal((await globalDay2Stub.getQuota({ classic: 50, elevenlabs: 5 }, day2Ms)).elevenlabs.used, 1)
		assert.equal((await globalDay2Stub.getReservation(crashId))?.admitted, true)
	}

	// 1d. Coordinator requires confirmAdmission === true: if user confirm returns false, refunds global and POST / returns 503!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const todayKey = new Date().toISOString().slice(0, 10)
		const globalTodayStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${todayKey}`))

		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `user:${USER_A}`) {
				return new Proxy(stub, {
					get(target, prop, receiver) {
						if (prop === 'confirmAdmission') {
							return async () => false
						}
						const v = Reflect.get(target, prop, receiver)
						return typeof v === 'function' ? v.bind(target) : v
					},
				})
			}
			return stub
		}

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'confirm returns false fails closed', provider: 'elevenlabs' }),
		})
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal(res.status, 503, 'Rejected user confirmAdmission MUST fail closed with 503, never 200')
		assert.equal(harness.createdWorkflows.length, 0)
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 5 })).elevenlabs.used, 0, 'User claim must be released when confirmAdmission returns false')
		assert.equal((await globalTodayStub.getQuota({ classic: 50, elevenlabs: 5 })).elevenlabs.used, 0, 'Global claim must be released when user confirmation fails')
	}
})

test('Pass-3 regression 2 (P1): strict Workflows error classifiers reject ambiguous create/lookup strings on POST / and POST /retry/:id', async () => {
	// 2a. Direct classifier assertions on exact codes, anchored formats, and Astra's synthetic ambiguous messages
	assert.equal(smolsApiModule.isWorkflowAlreadyExistsError(new Error('instance.already_exists')), true)
	assert.equal(smolsApiModule.isWorkflowAlreadyExistsError(Object.assign(new Error('conflict'), { code: 'instance.already_exists' })), true)
	assert.equal(smolsApiModule.isWorkflowAlreadyExistsError(new Error('Workflow instance abc123 already exists')), true)
	assert.equal(smolsApiModule.isWorkflowAlreadyExistsError(new Error('Could not determine whether the instance exists')), false)
	assert.equal(smolsApiModule.isWorkflowAlreadyExistsError(new Error('Failed to check if workflow instance already exists')), false)
	assert.equal(smolsApiModule.isWorkflowAlreadyExistsError(new Error('Duplicate upstream proxy header')), false)

	assert.equal(smolsApiModule.isWorkflowNotFoundError(new Error('instance.not_found')), true)
	assert.equal(smolsApiModule.isWorkflowNotFoundError(Object.assign(new Error('missing'), { code: 'instance.not_found' })), true)
	assert.equal(smolsApiModule.isWorkflowNotFoundError(new Error('Workflow instance abc123 not found')), true)
	assert.equal(smolsApiModule.isWorkflowNotFoundError(new Error('Instance lookup failed: upstream route not found')), false)
	assert.equal(smolsApiModule.isWorkflowNotFoundError(new Error('Instance lookup not found')), false)
	assert.equal(smolsApiModule.isWorkflowNotFoundError(new Error('HTTP 404 Not Found')), false)

	const tokenA = await createAuthToken(USER_A, TEST_SECRET)

	// 2b. POST /: WORKFLOW.create throws "Could not determine whether the instance exists" AND WORKFLOW.get throws
	//     "Instance lookup failed: upstream route not found" -> MUST NOT skip reconciliation, MUST return 503 & preserve quota!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '3', dailyElevenLabs: '3' })
		;(harness.env.WORKFLOW as unknown as { create: unknown; get: unknown }).create = async () => {
			throw new Error('Could not determine whether the instance exists')
		}
		;(harness.env.WORKFLOW as unknown as { get: unknown }).get = async () => {
			throw new Error('Instance lookup failed: upstream route not found')
		}

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'synthetic ambiguous create+lookup', provider: 'elevenlabs' }),
		})
		assert.equal(res.status, 503, 'Ambiguous create+lookup messages MUST return 503 (never 200 or refund)')
		const q = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			elevenlabs: { used: number }
		}
		assert.equal(q.elevenlabs.used, 1, 'Ambiguous lookup message MUST preserve quota (no refund)')
	}

	// 2c. POST /retry/:id with the exact same two synthetic strings -> MUST return 503 & preserve quota!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '3', dailyElevenLabs: '3' })
		const failedId = 'a'.repeat(63) + '7'
		harness.workflowStatuses.set(failedId, 'errored')
		harness.doNs.getStorage(failedId).set('payload', {
			address: USER_A,
			prompt: 'retry synthetic ambiguous',
			public: true,
			instrumental: false,
			provider: 'elevenlabs',
		})
		harness.doNs.getStorage(failedId).set('provider_attempt', {
			provider: 'elevenlabs',
			status: 'failed',
			updated_at: new Date().toISOString(),
		})

		;(harness.env.WORKFLOW as unknown as { create: unknown; get: unknown }).create = async () => {
			throw new Error('Could not determine whether the instance exists')
		}
		const origGet = harness.env.WORKFLOW.get.bind(harness.env.WORKFLOW)
		;(harness.env.WORKFLOW as unknown as { get: unknown }).get = async (id: string) => {
			if (id === failedId) {
				return await origGet(id)
			}
			throw new Error('Instance lookup failed: upstream route not found')
		}

		const retryRes = await harness.send(`/retry/${failedId}`, { method: 'POST' })
		assert.equal(retryRes.status, 503, 'POST /retry/:id must return 503 on ambiguous create+lookup strings')
		const q = await (await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })).json() as {
			elevenlabs: { used: number }
		}
		assert.equal(q.elevenlabs.used, 1, 'POST /retry/:id must preserve quota on ambiguous lookup string')
	}
})

test('Pass-3 regression 3 (P2): internal SQLite schema upgrades cleanly from persisted v2 layout (without admitted/generation) to v3', async () => {
	const db = new DatabaseSync(':memory:')
	const dayKey = '2026-11-23'
	const nowMs = Date.parse('2026-11-23T12:00:00.000Z')

	// Seed the EXACT prior Pass-1 v2 schema (recorded migration id=1,2; quota_reservations WITHOUT admitted or generation!)
	db.exec(`
		CREATE TABLE _sql_schema_migrations (
			id INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE quota_reservations (
			reservation_id TEXT PRIMARY KEY,
			day_key TEXT NOT NULL,
			provider TEXT NOT NULL CHECK(provider IN ('aisonggenerator', 'elevenlabs')),
			initial_provider TEXT NOT NULL CHECK(initial_provider IN ('aisonggenerator', 'elevenlabs')),
			status TEXT NOT NULL CHECK(status IN ('reserved', 'committed', 'ambiguous', 'refunded')),
			claim_count INTEGER NOT NULL DEFAULT 1,
			created_at_ms INTEGER NOT NULL,
			updated_at_ms INTEGER NOT NULL,
			fallback_from TEXT CHECK(fallback_from IS NULL OR fallback_from IN ('aisonggenerator', 'elevenlabs')),
			reason TEXT
		);
		CREATE TABLE play_beacon_dedupe (
			dedupe_key TEXT PRIMARY KEY,
			expires_at_ms INTEGER NOT NULL
		);
		CREATE TABLE play_beacon_rate (
			bucket_key TEXT PRIMARY KEY,
			count INTEGER NOT NULL,
			expires_at_ms INTEGER NOT NULL
		);
		INSERT INTO _sql_schema_migrations (id) VALUES (1), (2);
		INSERT INTO quota_reservations (
			reservation_id, day_key, provider, initial_provider, status, claim_count, created_at_ms, updated_at_ms
		) VALUES
			('legacy-v2-committed', '${dayKey}', 'elevenlabs', 'elevenlabs', 'committed', 1, ${nowMs}, ${nowMs}),
			('legacy-v2-reserved', '${dayKey}', 'aisonggenerator', 'aisonggenerator', 'reserved', 1, ${nowMs}, ${nowMs});
	`)

	const { storage } = createSqliteBackedStorage(db)
	const ctx = {
		storage,
		blockConcurrencyWhile: <R>(fn: () => Promise<R>) => fn(),
		waitUntil: () => {},
	} as unknown as DurableObjectState

	// Instantiating UserQuotaDO must upgrade v2 -> v3 cleanly without "no such column: admitted"
	const migratedDo = new appModule.UserQuotaDO(ctx, {} as Env)

	const versionRow = db.prepare(`SELECT MAX(id) AS v FROM _sql_schema_migrations`).get() as { v: number }
	assert.equal(versionRow.v, 7, 'Internal schema version must advance from 2 to 7')
	assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'mint_prefix_locks'`).get(), 'v7 adds the mint prefix lock table')

	const committedRow = await migratedDo.getReservation('legacy-v2-committed')
	assert.equal(committedRow?.status, 'committed')
	assert.equal(committedRow?.admitted, true, 'Existing v2 committed row must backfill admitted=true')
	assert.equal(committedRow?.generation, 1)
	assert.equal(committedRow?.supersededDayKey, null)

	const reservedRow = await migratedDo.getReservation('legacy-v2-reserved')
	assert.equal(reservedRow?.status, 'reserved')
	assert.equal(reservedRow?.admitted, false)
	assert.equal(reservedRow?.generation, 1)
	assert.equal(reservedRow?.supersededDayKey, null)

	// Verify fresh reserve, confirmAdmission, releaseClaim, and getQuota all work on the upgraded DB
	const fresh = await migratedDo.reserve('post-v3-upgrade', 'elevenlabs', { classic: 5, elevenlabs: 5 }, nowMs + 1000)
	assert.equal(fresh.ok, true)
	if (fresh.ok) {
		assert.equal(fresh.generation, 1)
		assert.equal(fresh.dayKey, dayKey)
		assert.equal(await migratedDo.confirmAdmission('post-v3-upgrade', fresh.generation, fresh.dayKey, nowMs + 1100), true)
	}
	const snap = await migratedDo.getQuota({ classic: 5, elevenlabs: 5 }, nowMs + 2000)
	assert.equal(snap.elevenlabs.used, 2)
	assert.equal(snap.classic.used, 1)
})

test('Pass-4 regression 1 (P1): confirmAdmission RPC throw (failed write OR lost response) reconciles user=0, global=0 on solo 503 while preserving concurrent winner', async () => {
	const tokenA = await createAuthToken(USER_A, TEST_SECRET)
	const todayKey = new Date().toISOString().slice(0, 10)

	// 1a. confirmAdmission disconnects BEFORE writing on POST / -> THAT stub instance is permanently broken!
	//     Coordinator MUST acquire a fresh stub to release the user claim -> 503, 0 workflows, BOTH user=0 AND global=0!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalTodayStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${todayKey}`))

		let userStubIssuedCount = 0
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `user:${USER_A}`) {
				userStubIssuedCount++
				const stubSeq = userStubIssuedCount
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) {
								throw new Error(`Durable Object stub #${stubSeq} is permanently broken after disconnect`)
							}
							if (prop === 'confirmAdmission' && stubSeq === 1) {
								broken = true
								throw new Error('DO transport disconnect before write')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'confirmAdmission disconnects before write', provider: 'elevenlabs' }),
		})
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal(res.status, 503)
		assert.equal(harness.createdWorkflows.length, 0)
		assert.ok(userStubIssuedCount >= 2, 'Coordinator MUST acquire a fresh user DO stub for rollback after disconnect')
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 5 })).elevenlabs.used, 0, 'User ledger MUST be 0 after broken-stub pre-write disconnect 503')
		assert.equal((await globalTodayStub.getQuota({ classic: 50, elevenlabs: 5 })).elevenlabs.used, 0, 'Global ledger MUST be 0 after broken-stub pre-write disconnect 503')
	}

	// 1b. confirmAdmission WRITES admitted=1 on DO, THEN disconnects (permanently breaking THAT stub!) for solo POST /
	//     -> coordinator acquires fresh stub, rolls back BOTH ledgers to user=0 AND global=0 on 503!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalTodayStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${todayKey}`))

		let userStubIssuedCount = 0
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `user:${USER_A}`) {
				userStubIssuedCount++
				const stubSeq = userStubIssuedCount
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) {
								throw new Error(`Durable Object stub #${stubSeq} is permanently broken after disconnect`)
							}
							if (prop === 'confirmAdmission' && stubSeq === 1) {
								// Write SUCCEEDS on DO, THEN stub disconnects permanently!
								const ok = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
								assert.equal(ok, true)
								broken = true
								throw new Error('DO disconnect after commit (stub broken)')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'confirmAdmission lost response solo broken stub', provider: 'elevenlabs' }),
		})
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal(res.status, 503)
		assert.equal(harness.createdWorkflows.length, 0)
		assert.ok(userStubIssuedCount >= 2, 'Coordinator MUST acquire a fresh user DO stub after post-write disconnect')
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 5 })).elevenlabs.used, 0, 'Solo post-write disconnect 503 MUST roll back user ledger to 0 via fresh stub')
		assert.equal((await globalTodayStub.getQuota({ classic: 50, elevenlabs: 5 })).elevenlabs.used, 0, 'Solo post-write disconnect 503 MUST roll back global ledger to 0 via fresh stub')
	}

	// 1c. Post-write confirmAdmission disconnect (permanently breaking Caller 1's stub) while a CONCURRENT WINNER ALSO
	//     holds the shared reservation (claim_count=2) -> fresh-stub rollback decrements claim_count without refunding!
	//     BOTH user=1 AND global=1 remain intact & admitted for the winner!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const nowMs = Date.parse('2026-11-23T12:00:00.000Z')
		const dayKey = '2026-11-23'
		const sharedId = 'shared-lost-response-winner'
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${dayKey}`))

		let caller1EnteredConfirm!: () => void
		let releaseCaller1Confirm!: () => void
		const pCaller1EnteredConfirm = new Promise<void>((r) => { caller1EnteredConfirm = r })
		const pHoldCaller1Confirm = new Promise<void>((r) => { releaseCaller1Confirm = r })
		let userStubIssuedCount = 0

		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `user:${USER_A}`) {
				userStubIssuedCount++
				const stubSeq = userStubIssuedCount
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) {
								throw new Error(`Durable Object stub #${stubSeq} is permanently broken after disconnect`)
							}
							if (prop === 'confirmAdmission' && stubSeq === 1) {
								await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
								caller1EnteredConfirm()
								await pHoldCaller1Confirm
								broken = true
								throw new Error('Caller 1 response lost after write (stub broken)')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		const caller1Promise = quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: sharedId,
			provider: 'elevenlabs',
			nowMs,
		})
		await pCaller1EnteredConfirm

		// Caller 2 attaches (claim_count=2 in both user & global), confirms both, and wins!
		const caller2Result = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: sharedId,
			provider: 'elevenlabs',
			nowMs,
		})
		assert.equal(caller2Result.ok, true)

		// Now Caller 1's broken-stub disconnect runs fresh-stub releaseClaim(..., { rollbackUnsharedAdmitted: true })
		releaseCaller1Confirm()
		await assert.rejects(() => caller1Promise, /Caller 1 response lost after write/)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		// Concurrent winner's reservation MUST stay intact & admitted in BOTH user and global DOs!
		const userRow = await userStub.getReservation(sharedId)
		const globalRow = await globalStub.getReservation(sharedId)
		assert.equal(userRow?.status, 'reserved')
		assert.equal(userRow?.admitted, true, 'Concurrent winner user admission must stay intact')
		assert.equal(userRow?.claimCount, 1)
		assert.equal(globalRow?.status, 'reserved')
		assert.equal(globalRow?.admitted, true, 'Concurrent winner global admission must stay intact')
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 5 }, nowMs)).elevenlabs.used, 1)
		assert.equal((await globalStub.getQuota({ classic: 50, elevenlabs: 5 }, nowMs)).elevenlabs.used, 1)
	}
})

test('Pass-4 regression 2 (P1): forward-only rollover rejects reversed-arrival yesterday reserve RPC and persists superseded_day_key across interruption until global cleanup succeeds', async () => {
	const day1Ms = Date.parse('2026-11-23T23:59:58.000Z')
	const day1Key = '2026-11-23'
	const day2Ms = Date.parse('2026-11-24T00:00:02.000Z')
	const day2Key = '2026-11-24'

	// 2a. Reversed arrival across UTC midnight: Day-2 reserve arrives FIRST (pending confirmation),
	//     THEN delayed Day-1 reserve RPC arrives -> MUST return stale_day (throw), MUST NOT overwrite Day-2 row
	//     or refund global:Day 2! Day-2 completes cleanly with user=1, global:Day 2=1!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalDay1Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day1Key}`))
		const globalDay2Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day2Key}`))
		const retryId = 'reversed-arrival-midnight'

		let day2EnteredConfirm!: () => void
		let releaseDay2Confirm!: () => void
		const pDay2AtConfirm = new Promise<void>((r) => { day2EnteredConfirm = r })
		const pHoldDay2Confirm = new Promise<void>((r) => { releaseDay2Confirm = r })

		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `user:${USER_A}`) {
				return new Proxy(stub, {
					get(target, prop, receiver) {
						if (prop === 'confirmAdmission') {
							return async (...args: Parameters<typeof target.confirmAdmission>) => {
								if (args[0] === retryId && args[2] === day2Key) {
									day2EnteredConfirm()
									await pHoldDay2Confirm
								}
								return await target.confirmAdmission(...args)
							}
						}
						const v = Reflect.get(target, prop, receiver)
						return typeof v === 'function' ? v.bind(target) : v
					},
				})
			}
			return stub
		}

		// Day-2 arrives FIRST: reserves user:A (Day 2, gen=1, admitted=0) and global:Day 2, pauses before user confirm
		const day2Promise = quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: retryId,
			provider: 'elevenlabs',
			nowMs: day2Ms,
		})
		await pDay2AtConfirm

		// Delayed Day-1 initial reserve RPC now arrives AFTER Day-2!
		const directStaleCheck = await userStub.reserve(retryId, 'elevenlabs', { classic: 5, elevenlabs: 5 }, day1Ms)
		assert.equal(directStaleCheck.ok, false)
		assert.equal(directStaleCheck.code, 'stale_day', 'Older day reserve MUST return stale_day, never roll backward')

		await assert.rejects(
			() => quotaUtilsModule.reserveGenerationQuota(harness.env, {
				address: USER_A,
				reservationId: retryId,
				provider: 'elevenlabs',
				nowMs: day1Ms,
			}),
			/Stale day quota reservation rejected/
		)

		// Verify Day-2's pending row & global:Day 2 were NOT displaced or refunded!
		const midUser = await userStub.getReservation(retryId)
		assert.equal(midUser?.dayKey, day2Key)
		assert.equal(midUser?.generation, 1)
		assert.equal(midUser?.supersededDayKey, null)
		assert.equal((await globalDay2Stub.getReservation(retryId))?.status, 'reserved')
		assert.equal(await globalDay1Stub.getReservation(retryId), null)

		// Unblock Day-2 confirmation -> completes cleanly!
		releaseDay2Confirm()
		const day2Res = await day2Promise
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal(day2Res.ok, true)
		assert.equal((await userStub.getReservation(retryId))?.admitted, true)
		assert.equal((await globalDay2Stub.getReservation(retryId))?.admitted, true)
		assert.equal((await globalDay2Stub.getQuota({ classic: 50, elevenlabs: 5 }, day2Ms)).elevenlabs.used, 1)
	}

	// 2b. Interruption between rollover write and superseded global cleanup:
	//     Day-1 leaves unadmitted user:A + global:Day 1 (used=1). Day-2 Caller 1 rolls user:A forward
	//     (persisting superseded_day_key=Day 1), then global:Day 1 cleanup FAILS transiently (interruption!).
	//     On Day-2 Caller 2 recovery, persisted superseded_day_key is STILL returned -> refunds global:Day 1 (used=0)
	//     and clears superseded_day_key=null!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalDay1Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day1Key}`))
		const globalDay2Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day2Key}`))
		const interruptedId = 'interrupted-rollover-cleanup'

		// Simulate Day-1 crash after writing global:Day 1 (before user confirmation)
		await userStub.reserve(interruptedId, 'elevenlabs', { classic: 5, elevenlabs: 5 }, day1Ms)
		await globalDay1Stub.reserve(interruptedId, 'elevenlabs', { classic: 50, elevenlabs: 5 }, day1Ms, day1Key)
		assert.equal((await globalDay1Stub.getQuota({ classic: 50, elevenlabs: 5 }, day1Ms)).elevenlabs.used, 1)

		// Day-2 Caller 1 triggers rollover on user:A, persisting superseded_day_key=Day 1, then interrupts BEFORE
		// global:Day 1 refund completes (simulate global:Day 1 unavailable during Caller 1 so Caller 1 cannot clear it)
		let failDay1Refund = true
		let failDay2Once = true
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `global:${day1Key}`) {
				return new Proxy(stub, {
					get(target, prop, receiver) {
						if (prop === 'refund' && failDay1Refund) {
							return async () => {
								throw new Error('Transient RPC drop during superseded global cleanup')
							}
						}
						const v = Reflect.get(target, prop, receiver)
						return typeof v === 'function' ? v.bind(target) : v
					},
				})
			}
			if (id.toString() === `user:${USER_A}`) {
				return new Proxy(stub, {
					get(target, prop, receiver) {
						if (prop === 'confirmAdmission' && failDay2Once) {
							failDay2Once = false
							return async () => {
								throw new Error('Caller 1 interrupted before confirmation')
							}
						}
						const v = Reflect.get(target, prop, receiver)
						return typeof v === 'function' ? v.bind(target) : v
					},
				})
			}
			return stub
		}

		await assert.rejects(
			() => quotaUtilsModule.reserveGenerationQuota(harness.env, {
				address: USER_A,
				reservationId: interruptedId,
				provider: 'elevenlabs',
				nowMs: day2Ms,
			}),
			/Caller 1 interrupted before confirmation/
		)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		// After interruption, superseded_day_key MUST still be durably persisted on user:A!
		assert.equal((await userStub.getReservation(interruptedId))?.supersededDayKey, day1Key, 'superseded_day_key must remain persisted until global cleanup succeeds')
		assert.equal((await globalDay1Stub.getQuota({ classic: 50, elevenlabs: 5 }, day1Ms)).elevenlabs.used, 1)

		// Day-2 Caller 2 recovers -> receives persisted supersededDayKey=Day 1 -> refunds global:Day 1 -> clears superseded_day_key!
		const recovered = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: interruptedId,
			provider: 'elevenlabs',
			nowMs: day2Ms + 1000,
		})
		assert.equal(recovered.ok, true)
		assert.equal((await userStub.getReservation(interruptedId))?.supersededDayKey, null, 'superseded_day_key must be cleared once global cleanup succeeds')
		assert.equal((await globalDay1Stub.getReservation(interruptedId))?.status, 'refunded')
		assert.equal((await globalDay1Stub.getQuota({ classic: 50, elevenlabs: 5 }, day1Ms)).elevenlabs.used, 0, 'Day-1 global bucket must be 0 after durable recovery cleanup')
		assert.equal((await globalDay2Stub.getQuota({ classic: 50, elevenlabs: 5 }, day2Ms)).elevenlabs.used, 1)
		assert.equal((await globalDay2Stub.getReservation(interruptedId))?.admitted, true)
	}

	// 2c. Multi-day (3-day) rollover: Day 1 (Nov 23) pending user + global -> Day 2 (Nov 24) rollover interrupted
	//     before global refund (even leaving Day 2 global pending too!) -> Day 3 (Nov 25) admission cleans up BOTH
	//     Day 1 AND Day 2 -> global usage across the 3 days is 0, 0, 1 with zero remaining markers!
	{
		const day3Ms = Date.parse('2026-11-25T00:05:00.000Z')
		const day3Key = '2026-11-25'
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalDay1Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day1Key}`))
		const globalDay2Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day2Key}`))
		const globalDay3Stub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${day3Key}`))
		const multiDayId = 'three-day-rollover-cleanup'

		// Day 1: pending user + global (interrupted before confirmation)
		await userStub.reserve(multiDayId, 'elevenlabs', { classic: 5, elevenlabs: 5 }, day1Ms)
		await globalDay1Stub.reserve(multiDayId, 'elevenlabs', { classic: 50, elevenlabs: 5 }, day1Ms, day1Key)

		// Day 2: rollover updates user row to Day 2 (superseded=['2026-11-23']), writes global:Day 2,
		//        and is interrupted BEFORE Day 1 global refund and BEFORE Day 2 confirmation!
		const day2Roll = await userStub.reserve(multiDayId, 'elevenlabs', { classic: 5, elevenlabs: 5 }, day2Ms)
		assert.equal(day2Roll.ok, true)
		if (day2Roll.ok) {
			assert.deepEqual(day2Roll.supersededDayKeys, [day1Key])
		}
		await globalDay2Stub.reserve(multiDayId, 'elevenlabs', { classic: 50, elevenlabs: 5 }, day2Ms, day2Key)

		assert.equal((await globalDay1Stub.getQuota({ classic: 50, elevenlabs: 5 }, day1Ms)).elevenlabs.used, 1)
		assert.equal((await globalDay2Stub.getQuota({ classic: 50, elevenlabs: 5 }, day2Ms)).elevenlabs.used, 1)

		// Day 3: normal coordinator runs -> rolls to Day 3 preserving BOTH ['2026-11-23', '2026-11-24'],
		//        refunds BOTH Day 1 and Day 2 global buckets, clears all markers, and admits Day 3!
		const day3Recovered = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: multiDayId,
			provider: 'elevenlabs',
			nowMs: day3Ms,
		})
		assert.equal(day3Recovered.ok, true)
		if (day3Recovered.ok) {
			assert.equal(day3Recovered.dayKey, day3Key)
		}

		const finalUser = await userStub.getReservation(multiDayId)
		assert.equal(finalUser?.dayKey, day3Key)
		assert.equal(finalUser?.admitted, true)
		assert.equal(finalUser?.supersededDayKey, null, 'All superseded day markers must be cleared after Day-3 recovery')
		assert.deepEqual(finalUser?.supersededDayKeys, [])

		// Exact 3-day global ledger verification: 0, 0, 1!
		assert.equal((await globalDay1Stub.getQuota({ classic: 50, elevenlabs: 5 }, day1Ms)).elevenlabs.used, 0, 'Nov 23 global bucket must be 0')
		assert.equal((await globalDay2Stub.getQuota({ classic: 50, elevenlabs: 5 }, day2Ms)).elevenlabs.used, 0, 'Nov 24 global bucket must be 0')
		assert.equal((await globalDay3Stub.getQuota({ classic: 50, elevenlabs: 5 }, day3Ms)).elevenlabs.used, 1, 'Nov 25 global bucket must be 1')
		assert.equal((await globalDay3Stub.getReservation(multiDayId))?.admitted, true)
	}
})

test('Pass-6 regression (P1): per-caller idempotent claimId prevents lost-reply release replays from refunding concurrent winner (Row 4) and durable deferred global outbox drains stranded user releases via alarm() (Row 5)', async () => {
	// Row 4: Concurrent winner + losing caller's confirmation disconnects + first user releaseClaim WRITES
	//        then its reply is LOST -> fresh-stub retry replays releaseClaim(losingClaimId) -> winner's
	//        admission state, claimCount (1), and usage (user 1 / global 1) MUST stay completely intact!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const nowMs = Date.parse('2026-11-23T12:00:00.000Z')
		const dayKey = '2026-11-23'
		const sharedId = 'row4-lost-release-reply-concurrent-winner'
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${dayKey}`))

		let loserAtConfirm!: () => void
		let releaseLoserConfirm!: () => void
		const pLoserAtConfirm = new Promise<void>((r) => { loserAtConfirm = r })
		const pHoldLoserConfirm = new Promise<void>((r) => { releaseLoserConfirm = r })
		let userStubSeq = 0
		let loserReleaseAttempts = 0

		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `user:${USER_A}`) {
				userStubSeq++
				const seq = userStubSeq
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) {
								throw new Error(`User DO stub #${seq} is permanently broken after disconnect`)
							}
							if (prop === 'confirmAdmission' && seq === 1) {
								// Loser pauses before confirm while Winner attaches & completes admission, then Loser disconnects!
								loserAtConfirm()
								await pHoldLoserConfirm
								broken = true
								throw new Error('Loser confirmAdmission disconnect')
							}
							if (prop === 'releaseClaim') {
								loserReleaseAttempts++
								if (loserReleaseAttempts === 1) {
									// First user releaseClaim WRITES to storage, THEN its reply is LOST (stub permanently broken)!
									await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
									broken = true
									throw new Error('First user releaseClaim reply lost after storage sync')
								}
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		// Start Loser -> reserves user:A + global:dayKey, pauses at confirmAdmission
		const loserPromise = quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: sharedId,
			provider: 'elevenlabs',
			nowMs,
		})
		await pLoserAtConfirm

		// Winner attaches with its own distinct claimId, confirms user & global, and succeeds!
		const winnerResult = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: sharedId,
			provider: 'elevenlabs',
			nowMs,
		})
		assert.equal(winnerResult.ok, true)

		// Now unblock Loser: confirmAdmission disconnects -> fresh-stub releaseClaim #1 writes & loses reply
		// -> fresh-stub releaseClaim #2 replays the SAME losing claimId!
		releaseLoserConfirm()
		await assert.rejects(() => loserPromise, /Loser confirmAdmission disconnect/)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal(loserReleaseAttempts, 2, 'Loser must have replayed releaseClaim on a fresh stub after lost reply')

		// Winner's admission state, claimCount=1, and BOTH ledgers (1 / 1) MUST remain completely intact!
		const userRow = await userStub.getReservation(sharedId)
		const globalRow = await globalStub.getReservation(sharedId)
		assert.equal(userRow?.status, 'reserved', 'Replayed losing releaseClaim MUST NOT refund concurrent winner')
		assert.equal(userRow?.admitted, true, 'Concurrent winner admitted state MUST remain true')
		assert.equal(userRow?.claimCount, 1, 'Concurrent winner claimCount MUST remain 1 (NOT decremented to 0!)')
		assert.equal(globalRow?.status, 'reserved')
		assert.equal(globalRow?.admitted, true)
		assert.equal(globalRow?.claimCount, 1)
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 5 }, nowMs)).elevenlabs.used, 1, 'User usage MUST stay 1')
		assert.equal((await globalStub.getQuota({ classic: 50, elevenlabs: 5 }, nowMs)).elevenlabs.used, 1, 'Global usage MUST stay 1')
	}

	// Row 5: Solo rejected admission where confirmAdmission writes then disconnects AND BOTH fresh-stub user
	//        release attempts disconnect before writing -> deferred release persisted durably in global DO ->
	//        first alarm while user DO still unreachable retains job & reschedules -> once user DO is reachable
	//        and alarm() fires, both ledgers settle cleanly to user 0 / global 0 with 0 pending jobs!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const todayKey = new Date().toISOString().slice(0, 10)
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalTodayStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${todayKey}`))

		let userOutage = false
		let userStubSeq = 0
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `user:${USER_A}`) {
				userStubSeq++
				const seq = userStubSeq
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) {
								throw new Error(`User DO stub #${seq} permanently broken`)
							}
							if (userOutage) {
								broken = true
								throw new Error('User DO temporarily unreachable (disconnect before write)')
							}
							if (prop === 'confirmAdmission' && seq === 1) {
								// Write succeeds on user DO, THEN user DO goes down (all release attempts disconnect before write!)
								await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
								broken = true
								userOutage = true
								throw new Error('User DO confirmAdmission disconnect after write')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		const res = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'row5 dual release disconnect deferred alarm recovery', provider: 'elevenlabs' }),
		})
		assert.equal(res.status, 503, 'Create handler MUST return 503 before starting any workflow')
		assert.equal(harness.createdWorkflows.length, 0)

		// While user DO is still down: global is already 0, deferred release is persisted on global DO, alarm is scheduled!
		assert.equal(await globalTodayStub.getPendingUserReleaseCount(), 1, 'Global DO must durably enqueue pending user release')
		assert.ok(harness.quotaNs.getAlarm(`global:${todayKey}`) !== null, 'Global DO must schedule alarm to drain deferred user release')
		assert.equal((await globalTodayStub.getQuota({ classic: 50, elevenlabs: 5 })).elevenlabs.used, 0, 'Global usage must already be 0')

		// First alarm while user DO is STILL unreachable -> keeps deferred job queued and reschedules backed-off alarm!
		await globalTodayStub.alarm()
		assert.equal(await globalTodayStub.getPendingUserReleaseCount(), 1, 'Failed alarm drain must keep job queued for retry')
		const rescheduledAlarmMs = harness.quotaNs.getAlarm(`global:${todayKey}`)
		assert.ok(rescheduledAlarmMs !== null && rescheduledAlarmMs > Date.now(), 'Failed alarm drain must schedule a future backoff alarm')

		// Now user DO becomes reachable again!
		userOutage = false
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		// Check user usage BEFORE the rescheduled alarm fires (proves it was stranded at 1 before deferred recovery)
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 5 })).elevenlabs.used, 1)

		// When the rescheduled backoff alarm fires at `rescheduledAlarmMs`, it drains pending_user_releases -> 0 / 0!
		const drainedAtAlarm = await globalTodayStub.drainPendingUserReleases(rescheduledAlarmMs!)
		assert.equal(drainedAtAlarm.drained, 1)
		assert.equal(drainedAtAlarm.remaining, 0)
		assert.equal(await globalTodayStub.getPendingUserReleaseCount(), 0, 'Pending user release must be removed once acknowledged')
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 5 })).elevenlabs.used, 0, 'User usage MUST settle to 0 after deferred alarm recovery')
		assert.equal((await globalTodayStub.getQuota({ classic: 50, elevenlabs: 5 })).elevenlabs.used, 0, 'Global usage MUST stay 0')
	}
})

test('Pass-7 regression (P1 + 2 P2s): symmetric deferred global-release outbox on User DO, committed/ambiguous replay confirmation, and fair per-row backoff preventing head-of-line starvation', async () => {
	// 1. P1 — Symmetric deferred global-release outbox on reachable User DO:
	//    Global limit = 1, user confirmation disconnects, user rollback succeeds (user=0), BOTH global release
	//    attempts disconnect before writing -> global release job is durably persisted on user DO -> once global DO
	//    recovers and user DO alarm drains, global drops to 0 and a fresh request from USER_B is cleanly admitted!
	{
		const harness = buildQuotaFlowHarness({
			dailyClassic: '5',
			dailyElevenLabs: '5',
			globalClassic: '50',
			globalElevenLabs: '1',
		})
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const tokenB = await createAuthToken(USER_B, TEST_SECRET)
		const todayKey = new Date().toISOString().slice(0, 10)
		const userAStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalTodayStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${todayKey}`))

		let globalReleaseOutage = false
		let userStubSeq = 0
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			const name = id.toString()
			if (name === `user:${USER_A}`) {
				userStubSeq++
				const seq = userStubSeq
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) {
								throw new Error(`User A stub #${seq} permanently broken`)
							}
							if (prop === 'confirmAdmission' && seq === 1) {
								broken = true
								globalReleaseOutage = true
								throw new Error('User A confirmAdmission disconnect')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			if (name === `global:${todayKey}`) {
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) {
								throw new Error('Global DO stub permanently broken')
							}
							if (prop === 'releaseClaim' && globalReleaseOutage) {
								broken = true
								throw new Error('Global DO unreachable during releaseClaim')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		const failRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'global release outage deferred on user DO', provider: 'elevenlabs' }),
		})
		assert.equal(failRes.status, 503)
		assert.equal(harness.createdWorkflows.length, 0)

		// User A is already 0, deferred global-release job is durably persisted on User A DO with alarm scheduled,
		// and global is temporarily stuck at 1 while outage persists!
		assert.equal(await userAStub.getPendingUserReleaseCount(), 1, 'User DO must durably enqueue deferred global release')
		assert.ok(harness.quotaNs.getAlarm(`user:${USER_A}`) !== null, 'User DO must schedule alarm to drain deferred global release')
		assert.equal((await globalTodayStub.getQuota({ classic: 50, elevenlabs: 1 })).elevenlabs.used, 1)

		// Global DO becomes reachable again!
		globalReleaseOutage = false
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		// User A DO alarm fires -> drains deferred global release -> global drops to 0!
		await userAStub.alarm()
		assert.equal(await userAStub.getPendingUserReleaseCount(), 0)
		assert.equal((await userAStub.getQuota({ classic: 5, elevenlabs: 5 })).elevenlabs.used, 0)
		assert.equal((await globalTodayStub.getQuota({ classic: 50, elevenlabs: 1 })).elevenlabs.used, 0, 'Global usage MUST drop to 0 after user DO alarm drain')

		// Fresh request from a DIFFERENT user (USER_B) is now cleanly admitted against global limit=1!
		const userBRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'user B admitted after global recovery', provider: 'elevenlabs' }),
		})
		assert.equal(userBRes.status, 200, 'Different user MUST be admitted once deferred global release drains')
		assert.equal(harness.createdWorkflows.length, 1)
	}

	// 2. P2 — Replaying an already-settled (committed OR ambiguous) reservation through reserveGenerationQuota()
	//    succeeds idempotently while preserving the terminal paid state on BOTH user and global ledgers!
	for (const terminalState of ['committed', 'ambiguous'] as const) {
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const nowMs = Date.parse('2026-11-23T12:00:00.000Z')
		const dayKey = '2026-11-23'
		const resId = `replay-settled-${terminalState}`
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${dayKey}`))

		const initial = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: resId,
			provider: 'elevenlabs',
			nowMs,
		})
		assert.equal(initial.ok, true)

		if (terminalState === 'committed') {
			await quotaUtilsModule.commitGenerationQuota(harness.env, {
				address: USER_A,
				reservationId: resId,
				actualProvider: 'elevenlabs',
				dayKey,
				nowMs: nowMs + 1000,
			})
		} else {
			await quotaUtilsModule.markAmbiguousGenerationQuota(harness.env, {
				address: USER_A,
				reservationId: resId,
				dayKey,
				reason: 'upstream_timeout',
				nowMs: nowMs + 1000,
			})
		}

		// Replay the SAME reservation ID and provider through the coordinator -> MUST succeed idempotently!
		const replayed = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
			address: USER_A,
			reservationId: resId,
			provider: 'elevenlabs',
			nowMs: nowMs + 2000,
		})
		assert.equal(replayed.ok, true, `Replay of ${terminalState} reservation MUST succeed idempotently`)
		if (replayed.ok) {
			assert.equal(replayed.idempotent, true)
			assert.equal(replayed.dayKey, dayKey)
		}

		// Terminal paid state MUST remain preserved on BOTH user and global ledgers!
		assert.equal((await userStub.getReservation(resId))?.status, terminalState)
		assert.equal((await globalStub.getReservation(resId))?.status, terminalState)
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 5 }, nowMs)).elevenlabs.used, 1)
		assert.equal((await globalStub.getQuota({ classic: 50, elevenlabs: 5 }, nowMs)).elevenlabs.used, 1)
	}

	// 3. P2 — Fair per-row backoff in outbox drain: 50 older unavailable jobs MUST NOT starve job #51 for a reachable user!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '50' })
		const baseMs = Date.parse('2026-11-23T12:00:00.000Z')
		const dayKey = '2026-11-23'
		const deadUserKey = 'user:GDEADUSER000000000000000000'
		const healthyUserKey = `user:${USER_B}`
		const globalStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${dayKey}`))
		const healthyUserStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(healthyUserKey))

		// Reserve a real stranded slot on healthy USER_B that job #51 must release!
		const strandedReserve = await healthyUserStub.reserve('healthy-job-51', 'elevenlabs', { classic: 5, elevenlabs: 5 }, baseMs, undefined, 'claim-51')
		assert.equal(strandedReserve.ok, true)
		assert.equal((await healthyUserStub.getQuota({ classic: 5, elevenlabs: 5 }, baseMs)).elevenlabs.used, 1)

		// Enqueue 50 older jobs targeting an unreachable user DO + job #51 targeting healthy USER_B
		for (let i = 0; i < 50; i++) {
			await globalStub.enqueuePendingUserRelease({
				userKey: deadUserKey,
				reservationId: `dead-res-${i}`,
				generation: 1,
				dayKey,
				claimId: `dead-claim-${i}`,
				rollbackUnsharedAdmitted: true,
				reason: 'user_confirm_rpc_failed',
				nowMs: baseMs + i,
			})
		}
		await globalStub.enqueuePendingUserRelease({
			userKey: healthyUserKey,
			reservationId: 'healthy-job-51',
			generation: 1,
			dayKey,
			claimId: 'claim-51',
			rollbackUnsharedAdmitted: true,
			reason: 'user_confirm_rpc_failed',
			nowMs: baseMs + 100,
		})
		assert.equal(await globalStub.getPendingUserReleaseCount(), 51)

		// Intercept deadUserKey so it always fails, while healthyUserKey succeeds!
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === deadUserKey) {
				return new Proxy(stub, {
					get(target, prop, receiver) {
						if (prop === 'releaseClaim') {
							return async () => {
								throw new Error('Dead user DO unavailable')
							}
						}
						const v = Reflect.get(target, prop, receiver)
						return typeof v === 'function' ? v.bind(target) : v
					},
				})
			}
			return stub
		}

		// Drain pass 1 (at baseMs + 200): tries 50 older dead jobs -> backs them off to next_retry_at_ms > 0
		const pass1 = await globalStub.drainPendingUserReleases(baseMs + 200)
		assert.equal(pass1.drained, 0)
		assert.equal(pass1.remaining, 51)

		// Drain pass 2 (1 full minute later, baseMs + 60_200 — even when all 51 are due again!):
		// Job #51 has next_retry_at_ms=0 & attempts=0, so it sorts FIRST ahead of the 50 failed jobs and settles cleanly!
		const pass2 = await globalStub.drainPendingUserReleases(baseMs + 60_200)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal(pass2.drained, 1, 'Job #51 for reachable user MUST drain without being starved by 50 failed jobs')
		assert.equal(pass2.remaining, 50, 'The 50 unreachable jobs must remain queued and backed off')
		assert.equal((await healthyUserStub.getReservation('healthy-job-51'))?.status, 'refunded')
		assert.equal((await healthyUserStub.getQuota({ classic: 5, elevenlabs: 5 }, baseMs)).elevenlabs.used, 0, 'Reachable user slot MUST settle to 0')
	}
})

test('Pass-8 regression (P1 + P2): lost initial user/global reserve replies reconcile strictly by claimId, and overlapping release failures preserve BOTH pending releases', async () => {
	const tokenA = await createAuthToken(USER_A, TEST_SECRET)
	const tokenB = await createAuthToken(USER_B, TEST_SECRET)
	const todayKey = new Date().toISOString().slice(0, 10)

	// 1a. P1 — Lost initial userStub.reserve() reply after writing (user limit = 1):
	//     Coordinator releases strictly by claimId via fresh stub -> user=0 / global=0 & fresh create succeeds!
	//     Also verifies a concurrent caller owning another claimId on the SAME reservation is NEVER released!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '1', globalClassic: '50', globalElevenLabs: '5' })
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalTodayStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${todayKey}`))

		let userStubSeq = 0
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `user:${USER_A}`) {
				userStubSeq++
				const seq = userStubSeq
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) {
								throw new Error(`User stub #${seq} permanently broken`)
							}
							if (prop === 'reserve' && seq === 1) {
								// Write SUCCEEDS to SQLite, THEN reply is lost (stub permanently broken)!
								await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
								broken = true
								throw new Error('User DO disconnect after initial reserve write')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		const failRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'lost user reserve reply', provider: 'elevenlabs' }),
		})
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal(failRes.status, 503)
		assert.equal(harness.createdWorkflows.length, 0)
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 1 })).elevenlabs.used, 0, 'Lost user reserve reply MUST be reconciled to user=0')
		assert.equal((await globalTodayStub.getQuota({ classic: 50, elevenlabs: 5 })).elevenlabs.used, 0)

		// Fresh create at user limit=1 MUST now succeed!
		const okRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'fresh create after lost reserve reply', provider: 'elevenlabs' }),
		})
		assert.equal(okRes.status, 200, 'Fresh create at user limit=1 MUST succeed after lost reserve reconciliation')

		// Concurrent caller preservation: Winner already holds a claim on sharedId; Loser's reserve writes then
		// loses reply -> Loser's fresh-stub claimId release leaves Winner's claim (admitted=true, claimCount=1) intact!
		const sharedId = 'lost-reserve-reply-shared-winner'
		const harness2 = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const user2Stub = harness2.quotaNs.namespace.get(harness2.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const win = await quotaUtilsModule.reserveGenerationQuota(harness2.env, {
			address: USER_A,
			reservationId: sharedId,
			provider: 'elevenlabs',
		})
		assert.equal(win.ok, true)

		let seq2 = 0
		const origGet2 = harness2.env.USER_QUOTA.get.bind(harness2.env.USER_QUOTA)
		;(harness2.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet2(id)
			if (id.toString() === `user:${USER_A}`) {
				seq2++
				const s = seq2
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) throw new Error('broken')
							if (prop === 'reserve' && s === 1) {
								await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
								broken = true
								throw new Error('Loser reserve reply lost after attaching')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		await assert.rejects(
			() => quotaUtilsModule.reserveGenerationQuota(harness2.env, {
				address: USER_A,
				reservationId: sharedId,
				provider: 'elevenlabs',
			}),
			/Loser reserve reply lost after attaching/
		)
		;(harness2.env.USER_QUOTA as unknown as { get: unknown }).get = origGet2

		const winnerRow = await user2Stub.getReservation(sharedId)
		assert.equal(winnerRow?.status, 'reserved')
		assert.equal(winnerRow?.admitted, true)
		assert.equal(winnerRow?.claimCount, 1, 'Loser lost-reserve rollback must NOT consume winner claim')
	}

	// 1b. P1 — Lost globalStub.reserve() reply after writing + subsequent user confirmation failure (global limit = 1):
	//     Coordinator tracks globalReserveAttempted=true and releases global strictly by claimId -> user=0 / global=0
	//     and a different user (USER_B) is admitted at global limit=1!
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '1' })
		const userAStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalTodayStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${todayKey}`))

		let globalStubSeq = 0
		let userStubSeq = 0
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			const name = id.toString()
			if (name === `global:${todayKey}`) {
				globalStubSeq++
				const seq = globalStubSeq
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) throw new Error(`Global stub #${seq} broken`)
							if (prop === 'reserve' && seq === 1) {
								// Global reserve WRITES to SQLite, THEN reply is lost!
								await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
								broken = true
								throw new Error('Global DO disconnect after reserve write')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			if (name === `user:${USER_A}`) {
				userStubSeq++
				const seq = userStubSeq
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) throw new Error(`User stub #${seq} broken`)
							if (prop === 'confirmAdmission' && seq === 1) {
								broken = true
								throw new Error('User confirmAdmission disconnect after lost global reserve')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		const failRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'lost global reserve + confirm fail', provider: 'elevenlabs' }),
		})
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal(failRes.status, 503)
		assert.equal(harness.createdWorkflows.length, 0)
		assert.equal((await userAStub.getQuota({ classic: 5, elevenlabs: 5 })).elevenlabs.used, 0)
		assert.equal((await globalTodayStub.getQuota({ classic: 50, elevenlabs: 1 })).elevenlabs.used, 0, 'Global write whose reply was lost MUST be released by claimId to global=0')

		// Different user (USER_B) MUST now be admitted at global limit=1!
		const userBRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'user B admitted at global limit 1', provider: 'elevenlabs' }),
		})
		assert.equal(userBRes.status, 200, 'Different user MUST be admitted at global limit=1 after lost global reserve reconciliation')
	}

	// 2. P2 — Overlapping release failures on BOTH user and global DOs:
	//    User confirmation disconnects, BOTH immediate release attempts fail on BOTH user and global before writing,
	//    user DO becomes reachable for recovery -> BOTH ledgers settle cleanly to 0/0 with empty queues after alarm,
	//    AND a concurrent winner stays intact at 1/1!
	for (const withConcurrentWinner of [false, true]) {
		const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '5' })
		const nowMs = Date.parse('2026-11-23T12:00:00.000Z')
		const dayKey = '2026-11-23'
		const resId = `overlap-dual-fail-${withConcurrentWinner ? 'winner' : 'solo'}`
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${dayKey}`))

		if (withConcurrentWinner) {
			const winner = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
				address: USER_A,
				reservationId: resId,
				provider: 'elevenlabs',
				nowMs,
			})
			assert.equal(winner.ok, true)
		}

		// Fail confirmAdmission, then fail the first 2 immediate releaseClaim attempts on user DO AND the first 2
		// immediate releaseClaim attempts on global DO, while user DO becomes reachable for recovery!
		let userReleaseFailuresLeft = 2
		let globalReleaseFailuresLeft = 2
		let userStubSeq = 0
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			const name = id.toString()
			if (name === `user:${USER_A}`) {
				userStubSeq++
				const seq = userStubSeq
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) throw new Error(`User stub #${seq} broken`)
							if (prop === 'confirmAdmission' && seq === 1) {
								broken = true
								throw new Error('User confirmAdmission disconnect')
							}
							if (prop === 'releaseClaim' && userReleaseFailuresLeft > 0) {
								userReleaseFailuresLeft--
								broken = true
								throw new Error('Immediate user releaseClaim disconnect before write')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			if (name === `global:${dayKey}`) {
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) throw new Error('Global stub broken')
							if (prop === 'releaseClaim' && globalReleaseFailuresLeft > 0) {
								globalReleaseFailuresLeft--
								broken = true
								throw new Error('Immediate global releaseClaim disconnect before write')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		await assert.rejects(
			() => quotaUtilsModule.reserveGenerationQuota(harness.env, {
				address: USER_A,
				reservationId: resId,
				provider: 'elevenlabs',
				nowMs,
			}),
			/User confirmAdmission disconnect/
		)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		// Drain scheduled alarm on user DO (and global DO if any)
		await userStub.alarm()
		await globalStub.alarm()

		assert.equal(await userStub.getPendingUserReleaseCount(), 0, 'User outbox must be empty after alarm drain')
		assert.equal(await globalStub.getPendingUserReleaseCount(), 0, 'Global outbox must be empty after alarm drain')

		const expectedUsage = withConcurrentWinner ? 1 : 0
		assert.equal(
			(await userStub.getQuota({ classic: 5, elevenlabs: 5 }, nowMs)).elevenlabs.used,
			expectedUsage,
			`User usage must settle to ${expectedUsage} (withConcurrentWinner=${withConcurrentWinner})`
		)
		assert.equal(
			(await globalStub.getQuota({ classic: 50, elevenlabs: 5 }, nowMs)).elevenlabs.used,
			expectedUsage,
			`Global usage must settle to ${expectedUsage} (withConcurrentWinner=${withConcurrentWinner})`
		)
		if (withConcurrentWinner) {
			const uRow = await userStub.getReservation(resId)
			const gRow = await globalStub.getReservation(resId)
			assert.equal(uRow?.admitted, true)
			assert.equal(uRow?.claimCount, 1)
			assert.equal(gRow?.admitted, true)
			assert.equal(gRow?.claimCount, 1)
		}
	}
})

test('Pass-9 regression (P2 + P3): lost user reserve reply recovers even with global caps off or global enqueue outage, and self-targeted drain uses DO ID equality in-process', async () => {
	const tokenA = await createAuthToken(USER_A, TEST_SECRET)
	const todayKey = new Date().toISOString().slice(0, 10)

	// 1a. P2 — Global caps = 'off' + user limit = 1 + lost initial user reserve reply + 2 failed immediate user releases:
	//     MUST STILL enqueue deferred user release onto global:<todayKey>, and alarm drains user back to 0 so next create succeeds!
	{
		const harness = buildQuotaFlowHarness({
			dailyClassic: '5',
			dailyElevenLabs: '1',
			globalClassic: 'off',
			globalElevenLabs: 'off',
		})
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))
		const globalTodayStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`global:${todayKey}`))

		let userOutage = false
		let userStubSeq = 0
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() === `user:${USER_A}`) {
				userStubSeq++
				const seq = userStubSeq
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) throw new Error(`User stub #${seq} broken`)
							if (userOutage) {
								broken = true
								throw new Error('User DO unreachable during releaseClaim')
							}
							if (prop === 'reserve' && seq === 1) {
								await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
								broken = true
								userOutage = true
								throw new Error('User DO disconnect after reserve write (global caps off)')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		const failRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'lost reserve reply with global caps off', provider: 'elevenlabs' }),
		})
		assert.equal(failRes.status, 503)
		assert.equal(harness.createdWorkflows.length, 0)
		assert.equal(await globalTodayStub.getPendingUserReleaseCount(), 1, 'Global DO must queue deferred user release even when global caps are off')

		// Restore user DO reachability and fire global DO alarm -> user drops to 0!
		userOutage = false
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet
		await globalTodayStub.alarm()

		assert.equal(await globalTodayStub.getPendingUserReleaseCount(), 0)
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 1 })).elevenlabs.used, 0)

		// Next create at user limit=1 MUST succeed!
		const okRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'next create after global-off alarm recovery', provider: 'elevenlabs' }),
		})
		assert.equal(okRes.status, 200)
	}

	// 1b. P2 — Global caps enabled, lost initial user reserve reply + 2 failed user releases + 2 failed global enqueues,
	//     then user DO becomes reachable for final fallback -> user settles to 0 and next create at limit=1 succeeds!
	{
		const harness = buildQuotaFlowHarness({
			dailyClassic: '5',
			dailyElevenLabs: '1',
			globalClassic: '50',
			globalElevenLabs: '5',
		})
		const userStub = harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(`user:${USER_A}`))

		let userReleaseFailuresLeft = 2
		let globalEnqueueFailuresLeft = 2
		let userStubSeq = 0
		const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			const name = id.toString()
			if (name === `user:${USER_A}`) {
				userStubSeq++
				const seq = userStubSeq
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) throw new Error('broken')
							if (prop === 'reserve' && seq === 1) {
								await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
								broken = true
								throw new Error('User DO disconnect after reserve write')
							}
							if (prop === 'releaseClaim' && userReleaseFailuresLeft > 0) {
								userReleaseFailuresLeft--
								broken = true
								throw new Error('Immediate user releaseClaim failed')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			if (name === `global:${todayKey}`) {
				let broken = false
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const v = Reflect.get(target, prop, receiver)
						if (typeof v !== 'function') return v
						return async (...args: unknown[]) => {
							if (broken) throw new Error('broken')
							if (prop === 'enqueuePendingUserRelease' && globalEnqueueFailuresLeft > 0) {
								globalEnqueueFailuresLeft--
								broken = true
								throw new Error('Global enqueue unavailable')
							}
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args)
						}
					},
				})
			}
			return stub
		}

		const failRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'lost reserve + global enqueue fail fallback', provider: 'elevenlabs' }),
		})
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet

		assert.equal(failRes.status, 503)
		assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 1 })).elevenlabs.used, 0, 'User fallback must release slot when global enqueue fails')
		const okRes = await harness.send('/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'next create after user fallback', provider: 'elevenlabs' }),
		})
		assert.equal(okRes.status, 200)
	}

	// 2. P3 — Self-targeted drain uses derived DO ID `.equals(this.ctx.id)` (like workerd where ctx.id.name is absent
	//    and toString() is an encoded hex ID!) and runs in-process with ZERO `USER_QUOTA.get()` RPC calls!
	{
		const db = new DatabaseSync(':memory:')
		const { storage } = createSqliteBackedStorage(db)
		const encodedSelfHex = 'deadbeef'.repeat(8)
		const selfLogicalName = `user:${USER_A}`
		let getRpcCalls = 0

		const makeEncodedId = (hex: string) => ({
			toString: () => hex,
			equals(other: { toString(): string }) {
				return Boolean(other) && other.toString() === hex
			},
		})

		const fakeEnv = {
			USER_QUOTA: {
				idFromName(name: string) {
					// Simulate real workerd: logical name maps to encoded hex ID, ctx.id has NO `.name`!
					return makeEncodedId(name === selfLogicalName ? encodedSelfHex : '0'.repeat(64))
				},
				get() {
					getRpcCalls++
					throw new Error('Self-targeted drain MUST NOT invoke USER_QUOTA.get() RPC!')
				},
			},
		} as unknown as Env

		const ctx = {
			id: makeEncodedId(encodedSelfHex),
			storage,
			blockConcurrencyWhile: <R>(fn: () => Promise<R>) => fn(),
		} as unknown as DurableObjectState

		const selfDo = new appModule.UserQuotaDO(ctx, fakeEnv)
		const nowMs = Date.parse('2026-11-23T12:00:00.000Z')
		const dayKey = '2026-11-23'
		const res = await selfDo.reserve('self-drain-res', 'elevenlabs', { classic: 5, elevenlabs: 5 }, nowMs, undefined, 'self-claim-1')
		assert.equal(res.ok, true)

		await selfDo.enqueuePendingUserRelease({
			userKey: selfLogicalName,
			reservationId: 'self-drain-res',
			generation: 1,
			dayKey,
			claimId: 'self-claim-1',
			rollbackUnsharedAdmitted: true,
			reason: 'test_self_drain',
			nowMs,
		})

		const drain = await selfDo.drainPendingUserReleases(nowMs + 1000)
		assert.equal(drain.drained, 1)
		assert.equal(drain.remaining, 0)
		assert.equal(getRpcCalls, 0, 'Self-targeted drain MUST match via DO ID .equals() and execute in-process without RPC')
		assert.equal((await selfDo.getReservation('self-drain-res'))?.status, 'refunded')
	}
})
