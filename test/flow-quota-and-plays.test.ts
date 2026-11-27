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
	playCountMode?: string
	playRateLimitPerMinute?: string
	playCooldownSeconds?: string
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
	let shouldFailCreate = false

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
							playIncrements += changes
							return { success: true, meta: { changes } }
						}
						if (sql.includes('INSERT INTO Smols')) {
							const id = String(args[0])
							if (!smolsTable.has(id)) {
								smolsTable.set(id, { Id: id, Title: args[1], Song_1: args[2], Song_2: args[3], Address: args[4], Plays: 0 })
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
		ELEVENLABS_FALLBACK_ENABLED: 'true',
		DAILY_LIMIT_CLASSIC: options.dailyClassic ?? '10',
		DAILY_LIMIT_ELEVENLABS: options.dailyElevenLabs ?? '5',
		BURST_LIMIT_PER_MINUTE: options.burstPerMinute ?? '0',
		USER_QUOTA_OVERRIDES: options.userQuotaOverrides,
		GLOBAL_DAILY_LIMIT_CLASSIC: options.globalClassic ?? '100',
		GLOBAL_DAILY_LIMIT_ELEVENLABS: options.globalElevenLabs ?? '50',
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
				return raw === undefined ? null : type === 'json' ? JSON.parse(raw) : raw
			},
			put: async (key: string, value: string) => void kv.set(key, value),
			delete: async (key: string) => void kv.delete(key),
		},
		SEARCH_QUEUE: { send: async () => {} },
		WORKFLOW: {
			create: async ({ id, params }: { id: string; params: WorkflowParams }) => {
				if (shouldFailCreate) throw new Error('Injected WORKFLOW.create failure')
				if (workflowStatuses.has(id)) throw new Error('instance.already_exists')
				createdWorkflows.push({ id, params })
				workflowStatuses.set(id, 'running')
				return { status: async () => ({ status: workflowStatuses.get(id)! }) }
			},
			get: async (id: string) => {
				if (!workflowStatuses.has(id)) throw new Error('instance.not_found')
				return { status: async () => ({ status: workflowStatuses.get(id)! }) }
			},
		},
		AI: {
			gateway: (gw: string) => ({
				getUrl: async (provider: string) => `https://gateway.ai.cloudflare.com/v1/acct-1/${gw}/${provider}`,
			}),
			run: async (model: string) => {
				if (model === '@cf/moondream/moondream3.1-9B-A2B') return { result: { answer: 'Neon harbor skyline at twilight.', finish_reason: 'stop' } }
				if (model === '@cf/cloudflare/clef') return clefNsfwPayload()
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
				if (options.aisgFetch) return await options.aisgFetch(urlStr, init)
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
		env, r2, doNs, quotaNs, smolsTable, createdWorkflows, workflowStatuses, send,
		setFailWorkflowCreate: (val: boolean) => { shouldFailCreate = val },
		getPlayIncrements: () => playIncrements,
		getD1TotalCalls: () => d1TotalCalls,
	}
}

type Harness = ReturnType<typeof buildQuotaFlowHarness>
type QuotaView = import('../src/quota-do').QuotaSnapshot
type FlowWorkflow = InstanceType<typeof workflowModule.Workflow>

async function quotaOf(harness: Harness, token: string): Promise<QuotaView> {
	return await (await harness.send('/quota', { headers: { Authorization: `Bearer ${token}` } })).json() as QuotaView
}

function createSmol(harness: Harness, token: string, body: Record<string, unknown>) {
	return harness.send('/', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

function runWf(wf: FlowWorkflow, payload: WorkflowParams, instanceId: string) {
	return wf.run({ payload, instanceId, timestamp: new Date() } as never, createWorkflowStep(new Map()).step as never)
}

function userQuotaStub(harness: Harness, name = `user:${USER_A}`) {
	return harness.quotaNs.namespace.get(harness.quotaNs.namespace.idFromName(name))
}

/** Replace global fetch for the duration of `fn` (PixelLab, ElevenLabs, AISG audio CDNs). */
async function withFetch(handler: (url: string) => Response | Promise<Response>, fn: () => Promise<void>): Promise<void> {
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) =>
		handler(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)) as typeof fetch
	try {
		await fn()
	} finally {
		globalThis.fetch = originalFetch
	}
}

function pixellabOk(): Response {
	return new Response(JSON.stringify({ image: { base64: FAKE_IMAGE_B64 } }), { status: 200 })
}

function mp3Response(bytes: Uint8Array): Response {
	return new Response(bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.byteLength) } })
}

test('User quota overrides merge with defaults for the matching address', () => {
	const { getGlobalQuotaLimits, getUserQuotaLimits } = quotaUtilsModule
	assert.deepEqual(getUserQuotaLimits({} as Env, USER_A), { classic: 10, elevenlabs: 5 })
	assert.deepEqual(getGlobalQuotaLimits({} as Env), { classic: 100, elevenlabs: 50 })

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

test('UserQuotaDO: idempotent reserve, provider conflict, commit/ambiguous never refund, burst, daily cap, fallback cap, UTC rollover', async () => {
	const quotaNs = createMockUserQuotaNamespace(appModule.UserQuotaDO)
	const stub = quotaNs.namespace.get(quotaNs.namespace.idFromName(`user:${USER_A}`))
	const limits = { classic: 2, elevenlabs: 1, burstPerMinute: 2 }
	const noBurst = { classic: 2, elevenlabs: 1 }
	const day1End = Date.parse('2026-11-23T23:59:50.000Z')
	const day1Later = Date.parse('2026-11-23T23:59:55.000Z')
	const day2Start = Date.parse('2026-11-24T00:00:01.000Z')
	const day2AfterBurst = Date.parse('2026-11-24T00:01:05.000Z')

	const r1 = await stub.reserve('res-1', 'aisonggenerator', limits, day1End)
	assert.ok(r1.ok && !r1.idempotent)
	assert.deepEqual(r1.quota.classic, { limit: 2, used: 1, remaining: 1, resetAt: '2026-11-24T00:00:00.000Z' })
	const r1Dup = await stub.reserve('res-1', 'aisonggenerator', limits, day1End)
	assert.ok(r1Dup.ok && r1Dup.idempotent)
	assert.equal(r1Dup.quota.classic.used, 1, 'Idempotent reserve must not double-count')
	const r1Conflict = await stub.reserve('res-1', 'elevenlabs', limits, day1End)
	assert.ok(!r1Conflict.ok && r1Conflict.code === 'reservation_conflict')

	// Committed and ambiguous (possibly billed) reservations are never refunded.
	assert.equal((await stub.settle('res-1', 'aisonggenerator', day1End + 100)).committed, true)
	assert.equal((await stub.commit('res-1', 'aisonggenerator', day1End + 200)).idempotent, true)
	assert.deepEqual(
		await stub.refund('res-1', 'should_not_refund', day1End + 300).then((r) => [r.refunded, r.reason]),
		[false, 'already_committed']
	)

	const r2 = await stub.reserve('res-2', 'elevenlabs', limits, day1Later)
	assert.ok(r2.ok)
	assert.equal(r2.quota.elevenlabs.remaining, 0)
	const burst = await stub.reserve('res-3', 'aisonggenerator', limits, day1Later + 1000)
	assert.ok(!burst.ok && burst.code === 'quota_exceeded')
	assert.deepEqual([burst.reason, burst.limit, burst.used], ['burst_limit', 2, 2])

	assert.equal((await stub.markAmbiguous('res-2', 'gateway_504', day1Later + 2000)).status, 'ambiguous')
	assert.deepEqual(
		await stub.refund('res-2', 'should_not_refund', day1Later + 3000).then((r) => [r.refunded, r.reason]),
		[false, 'ambiguous_non_refundable']
	)

	// Classic 2/2; fallback into an exhausted ElevenLabs cap is blocked; an unbilled refund frees the slot.
	const r3 = await stub.reserve('res-3', 'aisonggenerator', noBurst, day1Later + 3500)
	assert.ok(r3.ok)
	assert.equal(r3.quota.classic.used, 2)
	const fbBlocked = await stub.transitionFallback('res-3', 'aisonggenerator', 'elevenlabs', noBurst, day1Later + 4000)
	assert.ok(!fbBlocked.ok && fbBlocked.code === 'quota_exceeded')
	assert.deepEqual([fbBlocked.provider, fbBlocked.limit, fbBlocked.used], ['elevenlabs', 1, 1])
	assert.equal((await stub.refund('res-3', 'provider_rejected', day1Later + 4500)).refunded, true)
	const snapDay1 = await stub.getQuota(noBurst, day1Later + 4600)
	assert.deepEqual([snapDay1.classic.used, snapDay1.elevenlabs.used], [1, 1])

	// UTC midnight resets daily counts; a fallback moves the slot from Classic to ElevenLabs.
	const snapDay2 = await stub.getQuota(limits, day2Start)
	assert.deepEqual([snapDay2.classic.used, snapDay2.elevenlabs.used, snapDay2.classic.resetAt], [0, 0, '2026-11-25T00:00:00.000Z'])
	assert.ok((await stub.reserve('res-4', 'aisonggenerator', limits, day2AfterBurst)).ok)
	const fbAllowed = await stub.transitionFallback('res-4', 'aisonggenerator', 'elevenlabs', limits, day2AfterBurst + 1000)
	assert.ok(fbAllowed.ok)
	assert.deepEqual([fbAllowed.quota.classic.used, fbAllowed.quota.elevenlabs.used], [0, 1])
})

test('POST / quota contract: GET /quota, create-failure refund, rejected refund vs ambiguous retained, structured 429, global circuit breaker', async () => {
	const fakeMp3 = makeAudioBytes(42, 4096)
	let elMode: 'ok' | 'reject_401' | 'timeout_504' = 'ok'
	const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2', globalElevenLabs: '2' })

	await withFetch((url) => {
		if (url.includes('api.pixellab.ai')) return pixellabOk()
		if (url.includes('/elevenlabs/v1/music')) {
			if (elMode === 'reject_401') return new Response(JSON.stringify({ detail: 'invalid api key' }), { status: 401 })
			if (elMode === 'timeout_504') return new Response('gateway timeout', { status: 504 })
			return mp3Response(fakeMp3)
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}, async () => {
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const tokenB = await createAuthToken(USER_B, TEST_SECRET)
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		const generate = async (prompt: string) => {
			const res = await createSmol(harness, tokenA, { prompt, provider: 'elevenlabs' })
			assert.equal(res.status, 200)
			const id = await res.text()
			return { id, run: () => runWf(wf, harness.createdWorkflows.at(-1)!.params, id) }
		}

		assert.equal((await harness.send('/quota')).status, 401)
		const q0 = await harness.send('/quota', { headers: { Authorization: `Bearer ${tokenA}` } })
		assert.equal(q0.status, 200)
		assert.equal(q0.headers.get('Cache-Control'), 'no-store')
		const q0Json = await q0.json() as QuotaView
		assert.deepEqual([q0Json.classic.limit, q0Json.classic.used, q0Json.elevenlabs.limit, q0Json.elevenlabs.remaining], [2, 0, 2, 2])
		assert.match(q0Json.elevenlabs.resetAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)

		harness.setFailWorkflowCreate(true)
		assert.equal((await createSmol(harness, tokenA, { prompt: 'transient create err', provider: 'elevenlabs' })).status, 500)
		harness.setFailWorkflowCreate(false)
		assert.equal((await quotaOf(harness, tokenA)).elevenlabs.used, 0, 'Failed WORKFLOW.create must refund quota')

		elMode = 'reject_401'
		await assert.rejects((await generate('rejected auth test')).run)
		assert.equal((await quotaOf(harness, tokenA)).elevenlabs.used, 0, 'Provably rejected ElevenLabs call must refund quota')

		elMode = 'timeout_504'
		await assert.rejects((await generate('ambiguous timeout test')).run)
		assert.equal((await quotaOf(harness, tokenA)).elevenlabs.used, 1, 'Ambiguous 504 ElevenLabs call MUST NOT refund quota')

		elMode = 'ok'
		const ok = await generate('great synth ballad')
		await ok.run()
		const detailJson = await (await harness.send(`/${ok.id}`, { headers: { Authorization: `Bearer ${tokenA}` } })).json() as { kv_do: Record<string, unknown> }
		assert.equal('quota_reservation_id' in detailJson.kv_do, false)
		assert.equal('quota_day_key' in detailJson.kv_do, false)

		const overLimit = await createSmol(harness, tokenA, { prompt: 'over limit song', provider: 'elevenlabs' })
		assert.equal(overLimit.status, 429)
		assert.equal(overLimit.headers.get('Cache-Control'), 'no-store')
		assert.ok(overLimit.headers.get('Retry-After'))
		const overJson = await overLimit.json() as Record<string, unknown>
		assert.deepEqual(
			[overJson.code, overJson.provider, overJson.limit, overJson.used, overJson.remaining, overJson.scope, typeof overJson.error],
			['quota_exceeded', 'elevenlabs', 2, 2, 0, 'user', 'string']
		)
		assert.match(String(overJson.resetAt), /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)

		// User B is denied by global:YYYY-MM-DD (2/2 used by A) and keeps 0 user usage.
		const globalBlocked = await createSmol(harness, tokenB, { prompt: 'user b blocked globally', provider: 'elevenlabs' })
		assert.equal(globalBlocked.status, 429)
		const globalJson = await globalBlocked.json() as Record<string, unknown>
		assert.deepEqual([globalJson.code, globalJson.scope, globalJson.provider], ['quota_exceeded', 'global', 'elevenlabs'])
		assert.equal((await quotaOf(harness, tokenB)).elevenlabs.used, 0, 'Global denial must release the user reservation')

		const doNames = harness.quotaNs.getNames()
		assert.ok(doNames.includes(`user:${USER_A}`) && doNames.includes(`user:${USER_B}`))
		assert.ok(doNames.some((n) => /^global:\d{4}-\d{2}-\d{2}$/.test(n)))
	})
})

test('AISG -> ElevenLabs fallback: enforces the ElevenLabs cap, keeps billed AISG charged, refunds unbilled slots', async () => {
	const fakeMp3 = makeAudioBytes(99, 4096)
	let aisgBehavior: 'reject_credits' | 'poll_fail' = 'reject_credits'
	let elBehavior: 'ok' | 'reject_401' = 'ok'
	let elCalls = 0
	const harness = buildQuotaFlowHarness({
		dailyClassic: '5',
		userQuotaOverrides: JSON.stringify({ [USER_A]: { elevenlabs: 1 } }),
		aisgFetch: async (url) => {
			if (url.endsWith('/api/tasks')) {
				return aisgBehavior === 'reject_credits'
					? new Response(JSON.stringify({ code: 'credits_exhausted', outcome: 'rejected', error: 'Out of credits' }), { status: 402 })
					: new Response(JSON.stringify({ task_id: 'task-fb-1', workspace_id: 'ws-1' }), { status: 200 })
			}
			if (url.includes('/api/tasks/task-fb-1')) {
				return new Response(JSON.stringify({ task_id: 'task-fb-1', music_ids: ['fb-1', 'fb-2'] }), { status: 200 })
			}
			if (url.includes('/api/songs?ids=')) {
				return new Response(JSON.stringify(['fb-1', 'fb-2'].map((music_id) => (
					{ music_id, status: -3, audio: '', service: 'aisonggenerator', error_message: 'upstream failed' }
				))), { status: 200 })
			}
			throw new Error(`Unexpected AISG URL: ${url}`)
		},
	})

	await withFetch((url) => {
		if (url.includes('api.pixellab.ai')) return pixellabOk()
		if (url.includes('/elevenlabs/v1/music')) {
			elCalls += 1
			return elBehavior === 'reject_401'
				? new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 })
				: mp3Response(fakeMp3)
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}, async () => {
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		const generate = async (prompt: string) => {
			const id = await (await createSmol(harness, tokenA, { prompt, provider: 'aisonggenerator' })).text()
			return () => runWf(wf, harness.createdWorkflows.at(-1)!.params, id)
		}

		// Billed AISG poll failure -> ElevenLabs rejects 401: AISG stays charged, ElevenLabs is freed.
		aisgBehavior = 'poll_fail'
		elBehavior = 'reject_401'
		await assert.rejects(await generate('poll fail then el reject'))
		let q = await quotaOf(harness, tokenA)
		assert.deepEqual([elCalls, q.classic.used, q.elevenlabs.used], [1, 1, 0])

		// Unbilled AISG submit rejection -> ElevenLabs succeeds: the slot moves to ElevenLabs.
		aisgBehavior = 'reject_credits'
		elBehavior = 'ok'
		await (await generate('aisg reject fallback ok'))()
		q = await quotaOf(harness, tokenA)
		assert.deepEqual([elCalls, q.classic.used, q.elevenlabs.used], [2, 1, 1])

		// ElevenLabs cap full: unbilled rejection refunds Classic; billed poll failure keeps it. No new ElevenLabs calls.
		await assert.rejects(await generate('cannot bypass elevenlabs cap'), /ElevenLabs fallback blocked by quota/)
		q = await quotaOf(harness, tokenA)
		assert.deepEqual([elCalls, q.classic.used, q.elevenlabs.used], [2, 1, 1])
		aisgBehavior = 'poll_fail'
		await assert.rejects(await generate('poll fail blocked fallback'), /ElevenLabs fallback blocked by quota/)
		q = await quotaOf(harness, tokenA)
		assert.deepEqual([elCalls, q.classic.used, q.elevenlabs.used], [2, 2, 1])
	})
})

test('POST /retry/:id: reuse of a pending or complete paid attempt never double-charges; fresh retries and override_provider get strict 429', async () => {
	const audio1 = makeAudioBytes(11, 40_000)
	const audio2 = makeAudioBytes(22, 40_000)
	const pendingSongs = [
		{ music_id: 'pend-1', status: 4, audio: 'https://cdn.aisg.test/p1.mp3', service: 'aisonggenerator' },
		{ music_id: 'pend-2', status: 4, audio: 'https://cdn.aisg.test/p2.mp3', service: 'aisonggenerator' },
	]
	const harness = buildQuotaFlowHarness({
		dailyClassic: '1',
		dailyElevenLabs: '1',
		aisgFetch: async (url) => {
			if (url.includes('/api/songs?ids=')) return new Response(JSON.stringify(pendingSongs), { status: 200 })
			throw new Error(`Unexpected AISG URL: ${url}`)
		},
	})
	const seed = (id: string, values: Record<string, unknown>, provider = 'aisonggenerator') => {
		harness.workflowStatuses.set(id, 'errored')
		const storage = harness.doNs.getStorage(id)
		storage.set('payload', { address: USER_A, prompt: `retry ${id.slice(0, 4)}`, public: true, instrumental: false, provider })
		for (const [key, value] of Object.entries(values)) storage.set(key, value)
	}

	await withFetch((url) => {
		if (url.endsWith('/p1.mp3')) return new Response(audio1, { status: 200 })
		if (url.endsWith('/p2.mp3')) return new Response(audio2, { status: 200 })
		throw new Error(`Unexpected fetch: ${url}`)
	}, async () => {
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const quotaStub = userQuotaStub(harness)
		const elRetry = (id: string) => harness.send(`/retry/${id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
			body: JSON.stringify({ override_provider: 'elevenlabs' }),
		})

		// Pending AISG attempt already holds the user's only Classic slot: the retry reuses it.
		const pendingSmolId = 'c'.repeat(64)
		assert.ok((await quotaStub.reserve(pendingSmolId, 'aisonggenerator', { classic: 1, elevenlabs: 1 })).ok)
		seed(pendingSmolId, {
			image_base64: FAKE_IMAGE_B64,
			description: 'desc',
			lyrics: { title: 'Pending Track', style: ['a', 'b'], lyrics: 'hi' },
			nsfw: { safe: true, categories: [] },
			song_ids: ['pend-1', 'pend-2'],
			quota_reservation_id: pendingSmolId,
			provider_attempt: { provider: 'aisonggenerator', status: 'submitted', task_id: 't-pend', song_ids: ['pend-1', 'pend-2'], updated_at: new Date().toISOString() },
		})
		const retryPending = await harness.send(`/retry/${pendingSmolId}`, { method: 'POST' })
		assert.equal(retryPending.status, 200, 'Retry reusing pending AISG attempt must NOT double-charge quota')
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		await runWf(wf, harness.createdWorkflows.at(-1)!.params, await retryPending.text())
		assert.equal((await quotaOf(harness, tokenA)).classic.used, 1)
		assert.equal((await quotaStub.getReservation(pendingSmolId))?.status, 'committed')

		// Already-complete songs (failed during publish) are reused at 0 remaining Classic.
		const completeId = 'e'.repeat(64)
		seed(completeId, { song_ids: ['pend-1', 'pend-2'], songs: pendingSongs })
		assert.equal((await harness.send(`/retry/${completeId}`, { method: 'POST' })).status, 200)
		assert.equal((await quotaOf(harness, tokenA)).classic.used, 1)

		// A failed attempt needs a fresh paid call: Classic 1/1 -> 429; the ElevenLabs override is admitted once.
		const failedSmolId = 'd'.repeat(64)
		seed(failedSmolId, {
			provider_attempt: { provider: 'aisonggenerator', status: 'failed', error_code: 'content_policy', updated_at: new Date().toISOString() },
			songs: [{ music_id: failedSmolId, status: -1, audio: '', service: 'aisonggenerator' }],
		})
		const classic429 = await harness.send(`/retry/${failedSmolId}`, { method: 'POST' })
		assert.equal(classic429.status, 429)
		assert.deepEqual(await classic429.json().then((j) => [(j as Record<string, unknown>).code, (j as Record<string, unknown>).provider]), ['quota_exceeded', 'aisonggenerator'])

		const overrideOk = await elRetry(failedSmolId)
		assert.equal(overrideOk.status, 200)
		const elRetryId = await overrideOk.text()
		assert.equal(harness.createdWorkflows.at(-1)?.params.override_provider, 'elevenlabs')
		assert.equal((await quotaOf(harness, tokenA)).elevenlabs.used, 1)

		harness.workflowStatuses.set(elRetryId, 'errored')
		harness.doNs.getStorage(elRetryId).set('provider_attempt', { provider: 'elevenlabs', status: 'failed', error_code: 'invalid_request', updated_at: new Date().toISOString() })
		const el429 = await elRetry(failedSmolId)
		assert.equal(el429.status, 429)
		assert.equal((await el429.json() as Record<string, unknown>).provider, 'elevenlabs')
	})

	// A pre-music failure (PixelLab down) refunds the fresh reservation.
	const preMusic = buildQuotaFlowHarness({ dailyClassic: '1', dailyElevenLabs: '1' })
	await withFetch((url) => {
		if (url.includes('api.pixellab.ai')) return new Response('pixellab down', { status: 503 })
		throw new Error(`Unexpected fetch: ${url}`)
	}, async () => {
		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const res = await createSmol(preMusic, tokenA, { prompt: 'pixellab failure refund test', provider: 'elevenlabs' })
		assert.equal(res.status, 200)
		const wf = new workflowModule.Workflow({} as ExecutionContext, preMusic.env)
		await assert.rejects(() => runWf(wf, preMusic.createdWorkflows[0].params, preMusic.createdWorkflows[0].id))
		assert.equal((await quotaOf(preMusic, tokenA)).elevenlabs.used, 0, 'Pre-music step failure must refund fresh reservation')
	})
})

test('POST / and POST /retry never refund once WORKFLOW.create may have succeeded; a shared retry reservation survives the loser', async () => {
	const tokenA = await createAuthToken(USER_A, TEST_SECRET)
	const elUsed = async (harness: Harness) => (await quotaOf(harness, tokenA)).elevenlabs.used
	const statusThrowsCreate = (harness: Harness) => {
		;(harness.env.WORKFLOW as unknown as { create: unknown }).create = async ({ id, params }: { id: string; params: WorkflowParams }) => {
			harness.createdWorkflows.push({ id, params })
			harness.workflowStatuses.set(id, 'running')
			return { status: async () => { throw new Error('transient status read failure') } }
		}
	}

	// create() succeeded but status() throws -> 200 with the reservation kept.
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2' })
		statusThrowsCreate(harness)
		const res = await createSmol(harness, tokenA, { prompt: 'status throw after create', provider: 'elevenlabs' })
		assert.equal(res.status, 200)
		assert.equal(await res.text(), harness.createdWorkflows[0].id)
		assert.equal(await elUsed(harness), 1)
	}

	// create() throws but the instance exists -> 200; create() throws and get() is indeterminate -> 503. Neither refunds.
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2' })
		;(harness.env.WORKFLOW as unknown as { create: unknown }).create = async ({ id, params }: { id: string; params: WorkflowParams }) => {
			harness.createdWorkflows.push({ id, params })
			harness.workflowStatuses.set(id, 'running')
			throw new Error('network timeout after workflow accepted')
		}
		assert.equal((await createSmol(harness, tokenA, { prompt: 'uncertain create active', provider: 'elevenlabs' })).status, 200)
		assert.equal(await elUsed(harness), 1)
	}
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2' })
		;(harness.env.WORKFLOW as unknown as { create: unknown }).create = async () => { throw new Error('network timeout') }
		;(harness.env.WORKFLOW as unknown as { get: unknown }).get = async () => { throw new Error('service unavailable') }
		assert.equal((await createSmol(harness, tokenA, { prompt: 'indeterminate create', provider: 'elevenlabs' })).status, 503)
		assert.equal(await elUsed(harness), 1)
	}

	// Retry: status() throws after create -> 200; a second claimant shares the reservation, so an
	// onlyIfUnshared refund is refused, and a loser that finds the successor executed never refunds it.
	{
		const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2' })
		const failedId = '1'.repeat(64)
		harness.workflowStatuses.set(failedId, 'errored')
		harness.doNs.getStorage(failedId).set('payload', { address: USER_A, prompt: 'retry shared', public: true, instrumental: false, provider: 'elevenlabs' })
		harness.doNs.getStorage(failedId).set('provider_attempt', { provider: 'elevenlabs', status: 'failed', error_code: 'invalid_request', updated_at: new Date().toISOString() })
		statusThrowsCreate(harness)

		const retryRes = await harness.send(`/retry/${failedId}`, { method: 'POST' })
		assert.equal(retryRes.status, 200)
		const succId = await retryRes.text()
		const quotaStub = userQuotaStub(harness)
		assert.equal((await quotaStub.getReservation(succId))?.status, 'reserved')

		const sharedRes = await quotaStub.reserve(succId, 'elevenlabs', { classic: 2, elevenlabs: 2 })
		assert.ok(sharedRes.ok && sharedRes.shared && sharedRes.claimCount === 2)
		const refused = await quotaStub.refund(succId, 'loser_error', Date.now(), { onlyIfUnshared: true })
		assert.deepEqual([refused.refunded, refused.reason], [false, 'shared_reservation'])
		assert.equal((await quotaStub.getReservation(succId))?.status, 'reserved')

		const failedId2 = '2'.repeat(64)
		const preclaimedSuccId = '3'.repeat(64)
		harness.workflowStatuses.set(failedId2, 'errored')
		harness.doNs.getStorage(failedId2).set('payload', { address: USER_A, prompt: 'loser', public: true, instrumental: false, provider: 'aisonggenerator' })
		harness.doNs.getStorage(failedId2).set('provider_attempt', { provider: 'aisonggenerator', status: 'failed', updated_at: new Date().toISOString() })
		const origGet = harness.env.DURABLE_OBJECT.get.bind(harness.env.DURABLE_OBJECT)
		;(harness.env.DURABLE_OBJECT as unknown as { get: unknown }).get = (doid: DurableObjectId) => {
			const stub = origGet(doid)
			if (doid.toString() === failedId2) {
				return { ...stub, claimRetrySuccessor: async () => ({ successorId: preclaimedSuccId, predecessorId: failedId2, isNew: true }) }
			}
			if (doid.toString() === preclaimedSuccId) {
				return { ...stub, seedRetrySuccessorIfEmpty: async () => ({ seeded: false, inspection: { state: 'executed' as const } }) }
			}
			return stub
		}
		assert.equal((await harness.send(`/retry/${failedId2}`, { method: 'POST' })).status, 503)
		assert.equal((await quotaStub.getReservation(preclaimedSuccId))?.status, 'reserved')
	}
})

test('Retry admission: an R2 lookup error is a retryable 503 (not a miss); reuse-only and unreserved workflows never make a paid call', async () => {
	let elApiCalls = 0
	const harness = buildQuotaFlowHarness({ dailyClassic: '2', dailyElevenLabs: '2' })
	const tokenA = await createAuthToken(USER_A, TEST_SECRET)
	const prevFallbackId = '5'.repeat(64)
	harness.workflowStatuses.set(prevFallbackId, 'errored')
	const storage = harness.doNs.getStorage(prevFallbackId)
	storage.set('payload', { address: USER_A, prompt: 'r2 artifact check test', public: true, instrumental: false, provider: 'aisonggenerator' })
	storage.set('image_base64', FAKE_IMAGE_B64)
	storage.set('description', 'desc')
	storage.set('lyrics', { title: 'R2 Track', style: ['a', 'b'], lyrics: 'hi' })
	storage.set('nsfw', { safe: true, categories: [] })
	storage.set('active_provider', 'elevenlabs')
	storage.set('fallback_from', 'aisonggenerator')
	storage.set('provider_attempt', { provider: 'elevenlabs', status: 'failed', source_smol_id: prevFallbackId, updated_at: new Date().toISOString() })

	const origHead = harness.r2.bucket.head
	let failHead = true
	;(harness.r2.bucket as unknown as { head: typeof origHead }).head = async (key: string) => {
		if (failHead) throw new Error('R2 transient timeout')
		return origHead(key)
	}
	assert.equal((await harness.send(`/retry/${prevFallbackId}`, { method: 'POST' })).status, 503)
	assert.equal((await quotaOf(harness, tokenA)).elevenlabs.used, 0, 'R2 lookup error must NOT reserve a fresh ElevenLabs slot')

	// The artifact exists at admission (reuse-only, no new quota) and then disappears before execution.
	failHead = false
	const r2Key = `el-${prevFallbackId}.mp3`
	await harness.r2.bucket.put(r2Key, makeAudioBytes(5, 4096), { httpMetadata: { contentType: 'audio/mpeg' } })
	const reuseRes = await harness.send(`/retry/${prevFallbackId}`, { method: 'POST' })
	assert.equal(reuseRes.status, 200)
	const reuseSuccessorId = await reuseRes.text()
	assert.equal(harness.createdWorkflows.at(-1)?.params.quota_reuse_only, true)
	await harness.r2.bucket.delete(r2Key)

	await withFetch((url) => {
		if (url.includes('api.pixellab.ai')) return pixellabOk()
		if (url.includes('/elevenlabs/v1/music')) elApiCalls += 1
		throw new Error(`Unexpected fetch: ${url}`)
	}, async () => {
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		await assert.rejects(() => runWf(wf, harness.createdWorkflows.at(-1)!.params, reuseSuccessorId), /refusing unreserved paid dispatch/)

		// A direct workflow with no reservation must reserve before a paid dispatch (cap is full here).
		const quotaStub = userQuotaStub(harness)
		await quotaStub.reserve('fill-el-1', 'elevenlabs', { classic: 2, elevenlabs: 2 })
		await quotaStub.reserve('fill-el-2', 'elevenlabs', { classic: 2, elevenlabs: 2 })
		const unreservedId = '8'.repeat(64)
		harness.doNs.getStorage(unreservedId).set('image_base64', FAKE_IMAGE_B64)
		await assert.rejects(
			() => runWf(wf, { address: USER_A, prompt: 'direct unreserved dispatch', public: true, instrumental: true, provider: 'elevenlabs' }, unreservedId),
			/Paid elevenlabs dispatch blocked by quota/
		)
		assert.equal(elApiCalls, 0)
	})
})

test('Coordinated reserve: strict commit preconditions, global conflict and invalid_state compensate the user DO, alarm prunes old buckets', async () => {
	const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '50' })
	const userStub = userQuotaStub(harness)
	const dayKey = '2026-11-23'
	const nowMs = Date.parse('2026-11-23T12:00:00.000Z')
	const big = { classic: 50, elevenlabs: 50 }

	await userStub.reserve('strict-1', 'aisonggenerator', { classic: 5, elevenlabs: 5 }, nowMs)
	assert.equal((await userStub.commit('strict-1', 'elevenlabs', nowMs + 100)).reason, 'provider_mismatch')
	assert.equal((await userStub.getReservation('strict-1'))?.status, 'reserved')
	await userStub.refund('strict-1', 'rejected', nowMs + 200)
	assert.equal((await userStub.commit('strict-1', 'aisonggenerator', nowMs + 300)).reason, 'already_refunded')

	const globalStub = userQuotaStub(harness, `global:${dayKey}`)
	await globalStub.reserve('conflict-res-1', 'elevenlabs', big, nowMs)
	const conflict = await quotaUtilsModule.reserveGenerationQuota(harness.env, {
		address: USER_A, reservationId: 'conflict-res-1', provider: 'aisonggenerator', nowMs,
	})
	assert.ok(!conflict.ok && conflict.code === 'reservation_conflict')
	assert.equal((await userStub.getReservation('conflict-res-1'))?.status, 'refunded', 'User DO must be compensated on global conflict')

	await userStub.reserve('fb-disagree-1', 'aisonggenerator', { classic: 5, elevenlabs: 5 }, nowMs)
	await globalStub.reserve('fb-disagree-1', 'aisonggenerator', big, nowMs)
	await globalStub.markAmbiguous('fb-disagree-1', 'simulated_global_mismatch', nowMs + 10)
	const fbDisagree = await quotaUtilsModule.transitionFallbackQuota(harness.env, {
		address: USER_A, reservationId: 'fb-disagree-1', fromProvider: 'aisonggenerator', toProvider: 'elevenlabs', previousDayKey: dayKey, nowMs: nowMs + 20,
	})
	assert.ok(!fbDisagree.ok && fbDisagree.code === 'invalid_state')
	const reverted = await userStub.getReservation('fb-disagree-1')
	assert.deepEqual([reverted?.provider, reverted?.status], ['aisonggenerator', 'reserved'])

	const oldDayMs = Date.now() - 20 * 86_400_000
	const oldGlobalName = `global:${new Date(oldDayMs).toISOString().slice(0, 10)}`
	const oldGlobalStub = userQuotaStub(harness, oldGlobalName)
	await oldGlobalStub.reserve('old-global-1', 'aisonggenerator', big, oldDayMs)
	await oldGlobalStub.commit('old-global-1', 'aisonggenerator', oldDayMs + 1000)
	assert.ok(harness.quotaNs.getAlarm(oldGlobalName) !== null)
	await oldGlobalStub.alarm()
	assert.equal(await oldGlobalStub.getReservation('old-global-1'), null)
})

test('Coordinated reserve under RPC failures: lost user reply releases by claimId, global outage fails open, explicit denial releases via a fresh stub, rejected confirmation releases both', async (t) => {
	t.mock.method(console, 'warn', () => {})
	const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '1' })
	const nowMs = Date.parse('2026-11-23T12:00:00.000Z')
	const dayKey = '2026-11-23'
	const userStub = userQuotaStub(harness)
	const globalStub = userQuotaStub(harness, `global:${dayKey}`)
	const reserve = (reservationId: string) => quotaUtilsModule.reserveGenerationQuota(harness.env, {
		address: USER_A, reservationId, provider: 'aisonggenerator', nowMs,
	})
	const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
	// Wrap the next `count` stubs handed out for `name` so `method` writes and then throws (a lost reply).
	const breakNext = (name: string, method: string, count = 1) => {
		;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
			const stub = origGet(id)
			if (id.toString() !== name || count <= 0) return stub
			count -= 1
			return new Proxy(stub, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver)
					if (prop !== method || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value
					return async (...args: unknown[]) => {
						await value.apply(target, args)
						throw new Error(`lost ${method} reply`)
					}
				},
			})
		}
	}
	const restore = () => { (harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet }

	// Lost user reserve reply: the write landed, then the fresh-stub release by claimId refunds it.
	breakNext(`user:${USER_A}`, 'reserve')
	await assert.rejects(() => reserve('lost-user-reply'), /lost reserve reply/)
	restore()
	assert.equal((await userStub.getReservation('lost-user-reply'))?.status, 'refunded')

	// Global outage (reply lost after write) fails open: the caller is admitted.
	breakNext(`global:${dayKey}`, 'reserve')
	const failOpen = await reserve('global-outage')
	restore()
	assert.ok(failOpen.ok)
	assert.equal((await userStub.getReservation('global-outage'))?.admitted, true)

	// Global cap (1) is now full: explicit denial releases the user claim even if the first release stub disconnects.
	let releaseFailures = 1
	;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
		const stub = origGet(id)
		if (id.toString() !== `user:${USER_A}`) return stub
		return new Proxy(stub, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver)
				if (prop === 'releaseClaim' && releaseFailures > 0) {
					releaseFailures -= 1
					return async () => { throw new Error('stub disconnected') }
				}
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
	}
	const denied = await reserve('global-denied')
	restore()
	assert.ok(!denied.ok && denied.code === 'quota_exceeded' && denied.payload.scope === 'global')
	assert.equal(releaseFailures, 0)
	assert.equal((await userStub.getReservation('global-denied'))?.status, 'refunded')

	// A rejected confirmation (claim already released) releases the caller's user and global claims, then throws.
	const confirmHarness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5' })
	const confirmOrigGet = confirmHarness.env.USER_QUOTA.get.bind(confirmHarness.env.USER_QUOTA)
	;(confirmHarness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
		const stub = confirmOrigGet(id)
		if (id.toString() !== `user:${USER_A}`) return stub
		return new Proxy(stub, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver)
				if (prop === 'confirmAdmission') return async () => false
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
	}
	await assert.rejects(
		() => quotaUtilsModule.reserveGenerationQuota(confirmHarness.env, { address: USER_A, reservationId: 'confirm-rejected', provider: 'elevenlabs', nowMs }),
		/confirmation rejected/
	)
	assert.equal((await userQuotaStub(confirmHarness).getReservation('confirm-rejected'))?.status, 'refunded')
	assert.equal((await userQuotaStub(confirmHarness, `global:${dayKey}`).getReservation('confirm-rejected'))?.status, 'refunded')

	// Legacy outbox rows written by the previous release still drain via alarm().
	await globalStub.enqueuePendingUserRelease({
		userKey: `user:${USER_A}`, reservationId: 'legacy-outbox', generation: 0, dayKey: '', claimId: 'none',
		rollbackUnsharedAdmitted: false, reason: 'legacy', nowMs,
	})
	assert.equal(await globalStub.getPendingUserReleaseCount(), 1)
	await globalStub.alarm()
	assert.equal(await globalStub.getPendingUserReleaseCount(), 0)
})

test('Plays: server mode counts on GET and ignores beacons; beacon mode keeps audio D1-free, validates, dedupes, and rate-limits', async () => {
	const audioBytes = makeAudioBytes(7, 2048)
	const putTrack = (harness: Harness, track: string, smolId: string) => harness.r2.bucket.put(`${track}.mp3`, audioBytes, {
		httpMetadata: { contentType: 'audio/mpeg' },
		customMetadata: { smolId, provider: 'elevenlabs' },
	})
	const beacon = (harness: Harness, track: string, ip: string) =>
		harness.send(`/plays/${track}`, { method: 'POST', headers: { 'CF-Connecting-IP': ip } })

	{
		Reflect.set(globalThis, 'caches', { default: createMockEdgeCache().cache })
		const harness = buildQuotaFlowHarness({ playCountMode: 'server' })
		harness.smolsTable.set('smol-1', { Id: 'smol-1', Song_1: 'track-srv-1', Song_2: null, Plays: 0 })
		await putTrack(harness, 'track-srv-1', 'smol-1')
		assert.equal((await harness.send('/song/track-srv-1.mp3')).status, 200)
		assert.equal(harness.getPlayIncrements(), 1)

		const d1Before = harness.getD1TotalCalls()
		const res = await harness.send('/plays/track-srv-1', { method: 'POST' })
		assert.equal(res.status, 202)
		assert.equal(res.headers.get('Cache-Control'), 'no-store')
		assert.deepEqual(await res.json(), { ok: true, counted: false, mode: 'server' })
		assert.equal(harness.getD1TotalCalls(), d1Before, 'Server mode beacon must not write to D1')
	}

	{
		Reflect.set(globalThis, 'caches', { default: createMockEdgeCache().cache })
		const harness = buildQuotaFlowHarness({ playCountMode: 'beacon', playRateLimitPerMinute: '2', playCooldownSeconds: '30' })
		for (const n of [1, 2, 3]) harness.smolsTable.set(`smol-b${n}`, { Id: `smol-b${n}`, Song_1: `track-bcn-${n}`, Song_2: null, Plays: 0 })
		await putTrack(harness, 'track-bcn-1', 'smol-b1')

		const cold = await harness.send('/song/track-bcn-1.mp3')
		assert.equal(cold.status, 200)
		assert.equal(cold.headers.get('Cache-Control'), 'public, max-age=2592000, stale-while-revalidate=86400')
		assert.equal(cold.headers.get('Accept-Ranges'), 'bytes')
		assert.ok(cold.headers.get('ETag'))
		assert.equal((await harness.send('/song/track-bcn-1.mp3')).status, 200)
		assert.equal((await harness.send('/song/track-bcn-1.mp3', { headers: { Range: 'bytes=0-' } })).status, 206)
		assert.equal(harness.getD1TotalCalls(), 0, 'Beacon mode audio GETs must perform zero D1 queries')

		assert.equal((await beacon(harness, 'bad%20id!', '198.51.100.1')).status, 400)
		assert.equal((await beacon(harness, 'nonexistent-song', '198.51.100.99')).status, 404)

		const play1 = await beacon(harness, 'track-bcn-1', '198.51.100.10')
		assert.equal(play1.status, 200)
		assert.equal(play1.headers.get('Cache-Control'), 'no-store')
		assert.deepEqual(await play1.json(), { ok: true, counted: true, mode: 'beacon' })

		const d1BeforeDup = harness.getD1TotalCalls()
		assert.deepEqual(await (await beacon(harness, 'track-bcn-1', '198.51.100.10')).json(), { ok: true, counted: false, deduped: true, mode: 'beacon' })
		assert.equal(harness.getD1TotalCalls(), d1BeforeDup)

		const tokenA = await createAuthToken(USER_A, TEST_SECRET)
		const playAuth = await harness.send('/plays/track-bcn-1', {
			method: 'POST',
			headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ playId: 'session-play-1' }),
		})
		assert.deepEqual(await playAuth.json(), { ok: true, counted: true, mode: 'beacon' })
		assert.equal(harness.smolsTable.get('smol-b1')?.Plays, 2)

		// 2 plays/min per caller: the third distinct song is rate-limited without touching D1.
		assert.equal((await beacon(harness, 'track-bcn-2', '198.51.100.10')).status, 200)
		const d1BeforeLimit = harness.getD1TotalCalls()
		const limited = await beacon(harness, 'track-bcn-3', '198.51.100.10')
		assert.equal(limited.status, 429)
		assert.ok(limited.headers.get('Retry-After'))
		assert.equal(harness.getD1TotalCalls(), d1BeforeLimit)
	}
})

test('Plays: beacon body is capped at 1 KiB (413, even with X-Play-Id) and concurrent duplicates/bursts are serialized', async () => {
	const harness = buildQuotaFlowHarness({ playCountMode: 'beacon', playRateLimitPerMinute: '2', playCooldownSeconds: '30' })
	for (const n of [1, 2, 3, 4]) harness.smolsTable.set(`smol-c${n}`, { Id: `smol-c${n}`, Song_1: `track-conc-${n}`, Song_2: null, Plays: 0 })

	// Slow D1 writes so overlapping requests race.
	const origPrepare = harness.env.SMOL_D1.prepare.bind(harness.env.SMOL_D1)
	;(harness.env.SMOL_D1 as unknown as { prepare: unknown }).prepare = (sql: string) => ({
		bind: (...args: unknown[]) => {
			const bound = origPrepare(sql).bind(...args)
			return {
				...bound,
				run: async () => {
					await new Promise((r) => setTimeout(r, 15))
					return await bound.run()
				},
			}
		},
	})
	const beacon = (track: string, ip: string) => harness.send(`/plays/${track}`, { method: 'POST', headers: { 'CF-Connecting-IP': ip } })

	const d1Before = harness.getD1TotalCalls()
	const oversized = await harness.send('/plays/track-conc-1', {
		method: 'POST',
		headers: { 'CF-Connecting-IP': '203.0.113.1', 'Content-Type': 'application/json', 'Content-Length': '2048' },
		body: JSON.stringify({ playId: 'x'.repeat(2000) }),
	})
	assert.equal(oversized.status, 413)
	const chunked = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(`{"playId":"${'a'.repeat(600)}`))
			controller.enqueue(new TextEncoder().encode(`${'b'.repeat(600)}"}`))
			controller.close()
		},
	})
	const oversizedStream = await appModule.app.fetch(
		new Request('https://api.smol.xyz/plays/track-conc-1', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': '203.0.113.1', 'X-Play-Id': 'valid-header-play-id-123', 'Content-Type': 'application/json' },
			body: chunked,
			duplex: 'half',
		} as RequestInit),
		harness.env,
		createMockExecutionContext().ctx
	)
	assert.equal(oversizedStream.status, 413)
	assert.equal(harness.getD1TotalCalls(), d1Before)

	const dupBodies = await Promise.all(Array.from({ length: 10 }, () =>
		beacon('track-conc-1', '203.0.113.50').then((r) => r.json() as Promise<{ counted: boolean; deduped?: boolean }>)))
	assert.equal(dupBodies.filter((b) => b.counted).length, 1)
	assert.equal(dupBodies.filter((b) => b.deduped).length, 9)
	assert.equal(harness.smolsTable.get('smol-c1')?.Plays, 1)

	const burst = await Promise.all([1, 2, 3, 4].map((n) => beacon(`track-conc-${n}`, '203.0.113.77')))
	assert.equal(burst.filter((r) => r.status === 200).length, 2)
	assert.equal(burst.filter((r) => r.status === 429).length, 2)
})

test('Overlapping global denials on a shared retry release cleanly; UTC-midnight recovery keeps each global bucket on its own day', async () => {
	const harness = buildQuotaFlowHarness({ dailyClassic: '5', dailyElevenLabs: '5', globalClassic: '50', globalElevenLabs: '1' })
	const day1Ms = Date.parse('2026-11-23T23:59:30.000Z')
	const day2Ms = Date.parse('2026-11-24T00:01:00.000Z')
	const [day1Key, day2Key] = ['2026-11-23', '2026-11-24']
	const userStub = userQuotaStub(harness)
	const globalDay1 = userQuotaStub(harness, `global:${day1Key}`)
	const globalDay2 = userQuotaStub(harness, `global:${day2Key}`)
	const reserve = (address: string, reservationId: string, provider: 'elevenlabs' | 'aisonggenerator', nowMs: number) =>
		quotaUtilsModule.reserveGenerationQuota(harness.env, { address, reservationId, provider, nowMs })

	assert.ok((await reserve(USER_B, 'other-user-day1', 'elevenlabs', day1Ms)).ok)

	// Caller 1 pauses inside global:day1 while caller 2 attaches to the same user reservation; both are denied.
	let releaseFirst!: () => void
	let firstEntered!: () => void
	const entered = new Promise<void>((r) => { firstEntered = r })
	const hold = new Promise<void>((r) => { releaseFirst = r })
	const origGet = harness.env.USER_QUOTA.get.bind(harness.env.USER_QUOTA)
	let globalReserveCalls = 0
	;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = (id: DurableObjectId) => {
		const stub = origGet(id)
		if (id.toString() !== `global:${day1Key}`) return stub
		return new Proxy(stub, {
			get(target, prop, receiver) {
				if (prop === 'reserve') {
					return async (...args: Parameters<typeof target.reserve>) => {
						if (++globalReserveCalls === 1) {
							firstEntered()
							await hold
						}
						return await target.reserve(...args)
					}
				}
				const val = Reflect.get(target, prop, receiver)
				return typeof val === 'function' ? val.bind(target) : val
			},
		})
	}
	const sharedId = 'shared-retry-global-denied'
	const caller1 = reserve(USER_A, sharedId, 'elevenlabs', day1Ms)
	await entered
	const res2 = await reserve(USER_A, sharedId, 'elevenlabs', day1Ms)
	releaseFirst()
	const res1 = await caller1
	;(harness.env.USER_QUOTA as unknown as { get: unknown }).get = origGet
	assert.ok(!res1.ok && res1.code === 'quota_exceeded')
	assert.ok(!res2.ok && res2.code === 'quota_exceeded')
	assert.equal((await userStub.getReservation(sharedId))?.status, 'refunded', 'The last denied claimant refunds the shared reservation')
	assert.equal((await userStub.getQuota({ classic: 5, elevenlabs: 5 }, day1Ms)).elevenlabs.used, 0)

	// Next-day recovery reserves in user (day 2) and global:day2, never global:day1; day 2's cap then applies.
	const recovered = await reserve(USER_A, sharedId, 'elevenlabs', day2Ms)
	assert.ok(recovered.ok && recovered.dayKey === day2Key)
	assert.equal(await globalDay1.getReservation(sharedId), null)
	const g2Row = await globalDay2.getReservation(sharedId)
	assert.deepEqual([g2Row?.dayKey, g2Row?.admitted], [day2Key, true])
	assert.ok(!(await reserve(USER_B, 'second-day2-blocked', 'elevenlabs', day2Ms + 1000)).ok)

	// An unadmitted day-1 row stranded by a crash rolls forward to day 2.
	await userStub.reserve('stranded-day1', 'aisonggenerator', { classic: 5, elevenlabs: 5 }, day1Ms)
	assert.equal((await userStub.getReservation('stranded-day1'))?.admitted, false)
	const rolled = await reserve(USER_A, 'stranded-day1', 'aisonggenerator', day2Ms + 2000)
	assert.ok(rolled.ok && rolled.dayKey === day2Key)
	assert.equal(await globalDay1.getReservation('stranded-day1'), null)
	assert.equal((await globalDay2.getReservation('stranded-day1'))?.dayKey, day2Key)

	// An admitted day-1 row retried on day 2 stays on day 1 in both ledgers.
	await userStub.reserve('admitted-day1', 'aisonggenerator', { classic: 5, elevenlabs: 5 }, day1Ms)
	assert.equal(await userStub.confirmAdmission('admitted-day1', 1, day1Key, day1Ms), true)
	assert.ok((await reserve(USER_A, 'admitted-day1', 'aisonggenerator', day2Ms + 3000)).ok)
	assert.equal((await globalDay1.getReservation('admitted-day1'))?.dayKey, day1Key)
	assert.equal(await globalDay2.getReservation('admitted-day1'), null)
})

test('UserQuotaDO upgrades a persisted v2 schema in place: admitted/generation backfilled, rows kept, reserve/confirm work', async () => {
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
