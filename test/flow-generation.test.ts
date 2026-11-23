import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import {
	createAuthToken,
	createMockDoNamespace,
	createMockExecutionContext,
	createMockR2Bucket,
	createWorkflowStep,
	installCloudflareStubs,
	SuspendSignal,
	type CloudflareStubHandle,
} from './helpers/harness'

let stubs: CloudflareStubHandle
let appModule: typeof import('../src/index')
let workflowModule: typeof import('../src/workflow')
let elevenLabsModule: typeof import('../src/ai/elevenlabs')
let nsfwModule: typeof import('../src/ai/nsfw')

const TEST_SECRET = 'test-jwt-secret-32-chars-minimum!'
const TEST_USER = 'GCREATORADDRESS1234567890'
const FAKE_IMAGE_B64 = Buffer.from('fake-png-bytes').toString('base64')

before(async () => {
	stubs = installCloudflareStubs()
	appModule = await import('../src/index')
	workflowModule = await import('../src/workflow')
	elevenLabsModule = await import('../src/ai/elevenlabs')
	nsfwModule = await import('../src/ai/nsfw')
})

after(() => {
	stubs.cleanup()
})

function buildMockEnv(options: {
	aisgFetch?: (url: string, init?: RequestInit) => Promise<Response>
	nsfwRaw?: unknown
	preMigrationD1?: boolean
	cfGatewayId?: string
	cfAigToken?: string
	fallbackEnabled?: string
} = {}) {
	const r2 = createMockR2Bucket()
	const doNs = createMockDoNamespace(r2.bucket)
	const kv = new Map<string, string>()
	const d1Smols = new Map<string, Record<string, unknown>>()
	const d1Playlists: Array<{ Id: string; Title: string }> = []
	const queueMessages: unknown[] = []
	const createdWorkflows: Array<{ id: string; params: WorkflowParams }> = []

	const d1 = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					const run = async () => {
						if (sql.includes('INSERT INTO Smols')) {
							const hasProviderCols = sql.includes('Requested_Provider')
							if (options.preMigrationD1 && hasProviderCols) {
								throw new Error('D1_ERROR: table Smols has no column named Requested_Provider')
							}
							const id = String(args[0])
							if (!d1Smols.has(id)) {
								if (hasProviderCols) {
									d1Smols.set(id, {
										Id: id,
										Title: args[1],
										Song_1: args[2],
										Song_2: args[3],
										Address: args[4],
										Public: args[5] ? 1 : 0,
										Instrumental: args[6] ? 1 : 0,
										Requested_Provider: args[7],
										Actual_Provider: args[8],
										Plays: 0,
										Views: 0,
										Mint_Token: null,
										Mint_Amm: null,
									})
								} else {
									if (args[3] === null || args[3] === undefined) {
										throw new Error('NOT NULL constraint failed: Smols.Song_2')
									}
									d1Smols.set(id, {
										Id: id,
										Title: args[1],
										Song_1: args[2],
										Song_2: args[3],
										Address: args[4],
										Public: args[5] ? 1 : 0,
										Instrumental: args[6] ? 1 : 0,
										Plays: 0,
										Views: 0,
										Mint_Token: null,
										Mint_Amm: null,
									})
								}
							}
							return { success: true, meta: { changes: 1 } }
						}
						if (sql.includes('INSERT OR IGNORE INTO Playlists')) {
							const id = String(args[0])
							const title = String(args[1])
							if (!d1Playlists.some((p) => p.Id === id && p.Title === title)) {
								d1Playlists.push({ Id: id, Title: title })
							}
							return { success: true, meta: { changes: 1 } }
						}
						if (sql.includes('UPDATE Smols SET Views = Views + 1')) {
							const row = d1Smols.get(String(args[0]))
							if (row) row.Views = Number(row.Views ?? 0) + 1
							return { success: true, meta: { changes: row ? 1 : 0 } }
						}
						return { success: true, meta: { changes: 0 } }
					}
					return {
						run,
						first: async () => {
							if (sql.includes('SELECT * FROM Smols WHERE Id = ?1')) {
								return d1Smols.get(String(args[0])) ?? null
							}
							if (sql.includes('SELECT Public') && sql.includes('FROM Smols')) {
								const row = d1Smols.get(String(args[0]))
								if (row && row.Address === args[1]) return { Public: row.Public }
								return null
							}
							if (sql.includes('FROM Likes')) return null
							return null
						},
						all: async () => ({ results: [] }),
					}
				},
			}
		},
		async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
			const results = []
			for (const s of stmts) {
				results.push(await s.run())
			}
			return results
		},
	}

	const env = {
		SECRET: TEST_SECRET,
		PIXELLAB_KEY: 'pixellab-test-key',
		CF_AI_GATEWAY_ID: options.cfGatewayId ?? 'smol',
		CF_AIG_TOKEN: options.cfAigToken ?? 'aig-test-token',
		CF_AIG_BYOK_ALIAS: 'default',
		ELEVENLABS_MUSIC_LENGTH_MS: '120000',
		ELEVENLABS_OUTPUT_FORMAT: 'mp3_44100_128',
		ELEVENLABS_FALLBACK_ENABLED: options.fallbackEnabled ?? 'true',
		DURABLE_OBJECT: doNs.namespace,
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
			send: async (msg: unknown) => {
				queueMessages.push(msg)
			},
		},
		WORKFLOW: {
			create: async ({ id, params }: { id: string; params: WorkflowParams }) => {
				createdWorkflows.push({ id, params })
				return { status: async () => ({ status: 'running' }) }
			},
			get: async (_id: string) => ({ status: async () => ({ status: 'running' }) }),
		},
		AI: {
			gateway: (gatewayId: string) => ({
				getUrl: async (provider: string) => `https://gateway.ai.cloudflare.com/v1/acct-1/${gatewayId}/${provider}`,
			}),
			run: async (model: string) => {
				if (model === '@cf/moondream/moondream3.1-9B-A2B') {
					return { result: { answer: 'Warm sunset skyline over calm ocean water.', finish_reason: 'stop' } }
				}
				if (model === '@cf/meta/llama-guard-3-8b') {
					return { response: options.nsfwRaw ?? { safe: true, categories: [] } }
				}
				throw new Error(`Unexpected AI model: ${model}`)
			},
		},
		AISONGGENERATOR: {
			fetch: async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
				if (urlStr.endsWith('/api/lyrics')) {
					return new Response(JSON.stringify({
						title: 'Sunset Harbor',
						style: ['dream pop', 'synthwave'],
						lyrics: '[Verse 1]\nGolden waves drift by the pier\n[Chorus]\nStay until the stars appear',
					}), { status: 200, headers: { 'Content-Type': 'application/json' } })
				}
				if (options.aisgFetch) {
					return await options.aisgFetch(urlStr, init)
				}
				throw new Error(`Unexpected AISG call: ${urlStr}`)
			},
		},
	} as unknown as Env

	return { env, r2, doNs, kv, d1Smols, d1Playlists, queueMessages, createdWorkflows }
}

function makeAudioBytes(seed: number, size = 40_000): Uint8Array {
	const out = new Uint8Array(size)
	for (let i = 0; i < size; i++) {
		out[i] = (seed + i * 17) & 0xff
	}
	return out
}

test('Gate 1a: default AISG v6 flow uses split /api/tasks submit + discovery, corrects swap before R2 commit, and publishes 2 tracks', async () => {
	const audioA = makeAudioBytes(11, 40_000)
	const audioB = makeAudioBytes(77, 40_000)
	let taskSubmitCalls = 0
	let taskDiscoverCalls = 0
	let songPollCalls = 0

	const harness = buildMockEnv({
		aisgFetch: async (url) => {
			if (url.endsWith('/api/tasks')) {
				taskSubmitCalls += 1
				return new Response(JSON.stringify({ task_id: 'task-123', workspace_id: 'ws-9' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes('/api/tasks/task-123')) {
				taskDiscoverCalls += 1
				// Simulate discovery returning 1 ID first, then both IDs
				const ids = taskDiscoverCalls === 1 ? ['aisg-1'] : ['aisg-1', 'aisg-2']
				return new Response(JSON.stringify({ task_id: 'task-123', music_ids: ids }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			}
			if (url.includes('/api/songs?ids=')) {
				songPollCalls += 1
				if (songPollCalls === 1) {
					// Streaming poll: aisg-1 has audioA, aisg-2 has audioB
					return new Response(JSON.stringify([
						{ music_id: 'aisg-1', status: 2, audio: 'https://cdn.aisg.test/stream-a.mp3', service: 'aisonggenerator' },
						{ music_id: 'aisg-2', status: 2, audio: 'https://cdn.aisg.test/stream-b.mp3', service: 'aisonggenerator' },
					]), { status: 200, headers: { 'Content-Type': 'application/json' } })
				}
				// Final poll: upstream SWAPPED audio URLs between aisg-1 and aisg-2!
				return new Response(JSON.stringify([
					{ music_id: 'aisg-1', status: 4, audio: 'https://cdn.aisg.test/final-b.mp3', service: 'aisonggenerator' },
					{ music_id: 'aisg-2', status: 4, audio: 'https://cdn.aisg.test/final-a.mp3', service: 'aisonggenerator' },
				]), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
		if (url.endsWith('stream-a.mp3') || url.endsWith('final-a.mp3')) {
			return new Response(audioA, { status: 200 })
		}
		if (url.endsWith('stream-b.mp3') || url.endsWith('final-b.mp3')) {
			return new Response(audioB, { status: 200 })
		}
		throw new Error(`Unexpected external fetch: ${url}`)
	}) as typeof fetch

	try {
		const token = await createAuthToken(TEST_USER, TEST_SECRET)
		const ctx = createMockExecutionContext()
		const createRes = await appModule.app.fetch(
			new Request('https://api.smol.xyz/', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: 'dreamy harbor night', public: true, playlist: 'night-drive' }),
			}),
			harness.env,
			ctx.ctx
		)
		assert.equal(createRes.status, 200)
		const instanceId = await createRes.text()

		// Immediate owner GET succeeds before workflow completes
		const earlyGet = await appModule.app.fetch(
			new Request(`https://api.smol.xyz/${instanceId}`, {
				headers: { Authorization: `Bearer ${token}` },
			}),
			harness.env,
			ctx.ctx
		)
		assert.equal(earlyGet.status, 200)
		const earlyJson = await earlyGet.json() as { kv_do: Record<string, any> }
		assert.equal(earlyJson.kv_do.payload.provider, 'aisonggenerator')
		assert.equal(earlyJson.kv_do.actual_provider, null)
		assert.equal('provider_attempt' in earlyJson.kv_do, false)

		// Run workflow with suspend/replay after paid submit to verify zero duplicate paid submits
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		const cache = new Map<string, unknown>()
		const event = { payload: harness.createdWorkflows[0].params, instanceId, timestamp: new Date() }

		const firstRun = createWorkflowStep(cache, { suspendBefore: 'discover aisonggenerator songs #1' })
		await assert.rejects(() => wf.run(event as never, firstRun.step as never), SuspendSignal)
		assert.equal(taskSubmitCalls, 1)
		const submitStep = firstRun.executed.find((s) => s.name === 'submit aisonggenerator task')
		assert.equal((submitStep?.config as { retries?: { limit: number } })?.retries?.limit, 0)

		const secondRun = createWorkflowStep(cache)
		await wf.run(event as never, secondRun.step as never)
		assert.equal(taskSubmitCalls, 1, 'Replay must never re-submit paid AISG task')
		assert.equal(taskDiscoverCalls, 2)
		assert.equal(songPollCalls, 2)

		// Verify R2 holds the swap-corrected audio under original IDs!
		assert.deepEqual(harness.r2.store.get('aisg-1.mp3')?.bytes, audioA)
		assert.deepEqual(harness.r2.store.get('aisg-2.mp3')?.bytes, audioB)
		assert.equal(harness.r2.store.get('aisg-1.mp3')?.httpMetadata?.contentType, 'audio/mpeg')

		// Verify D1 & detail endpoint
		const d1Row = harness.d1Smols.get(instanceId)
		assert.equal(d1Row?.Song_1, 'aisg-1')
		assert.equal(d1Row?.Song_2, 'aisg-2')
		assert.equal(d1Row?.Requested_Provider, 'aisonggenerator')
		assert.equal(d1Row?.Actual_Provider, 'aisonggenerator')
		assert.equal(harness.d1Playlists.length, 1)
		assert.equal(harness.queueMessages.length, 1)

		const detailRes = await appModule.app.fetch(
			new Request(`https://api.smol.xyz/${instanceId}`),
			harness.env,
			ctx.ctx
		)
		await ctx.flush()
		assert.equal(detailRes.status, 200)
		const detail = await detailRes.json() as { d1: Record<string, any>; kv_do: Record<string, any> }
		assert.equal(detail.kv_do.payload.provider, 'aisonggenerator')
		assert.equal(detail.kv_do.actual_provider, 'aisonggenerator')
		assert.equal(detail.kv_do.generation_meta.actual_provider, 'aisonggenerator')
		assert.equal('provider_attempt' in detail.kv_do, false)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Gate 1b: explicit ElevenLabs vocal & instrumental use BYOK AI Gateway, 1 track, canonical audio URL, 0 AISG music calls, and pre-migration D1 compat', async () => {
	let aisgMusicCalls = 0
	const elevenLabsRequests: Array<{ url: string; headers: Headers; body: Record<string, any> }> = []
	const fakeMp3 = makeAudioBytes(55, 8192)

	const harness = buildMockEnv({
		preMigrationD1: true, // Verify Song_2='' fallback works seamlessly on pre-migration D1!
		aisgFetch: async (url) => {
			aisgMusicCalls += 1
			throw new Error(`AISG music route must not be called for explicit ElevenLabs: ${url}`)
		},
	})

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('api.pixellab.ai')) {
			return new Response(JSON.stringify({ image: { base64: FAKE_IMAGE_B64 } }), { status: 200 })
		}
		if (url.includes('gateway.ai.cloudflare.com') && url.includes('/elevenlabs/v1/music')) {
			const headers = new Headers(init?.headers)
			elevenLabsRequests.push({
				url,
				headers,
				body: JSON.parse(String(init?.body ?? '{}')),
			})
			return new Response(fakeMp3, {
				status: 200,
				headers: {
					'Content-Type': 'audio/mpeg',
					'Content-Length': String(fakeMp3.byteLength),
					'song-id': 'el-upstream-789',
					'cf-aig-log-id': 'aig-log-123',
				},
			})
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const token = await createAuthToken(TEST_USER, TEST_SECRET)
		const ctx = createMockExecutionContext()

		// Vocal ElevenLabs request
		const vocalCreate = await appModule.app.fetch(
			new Request('https://api.smol.xyz/', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: 'uplifting synth ballad', provider: 'elevenlabs', instrumental: false }),
			}),
			harness.env,
			ctx.ctx
		)
		assert.equal(vocalCreate.status, 200)
		const vocalId = await vocalCreate.text()

		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		await wf.run(
			{ payload: harness.createdWorkflows[0].params, instanceId: vocalId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)

		// Instrumental ElevenLabs request (also test empty lyrics permitted for instrumentals)
		const instCreate = await appModule.app.fetch(
			new Request('https://api.smol.xyz/', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: 'lo-fi study beats', provider: 'elevenlabs', instrumental: true }),
			}),
			harness.env,
			ctx.ctx
		)
		assert.equal(instCreate.status, 200)
		const instId = await instCreate.text()
		await wf.run(
			{ payload: harness.createdWorkflows[1].params, instanceId: instId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)

		assert.equal(aisgMusicCalls, 0, 'Explicit ElevenLabs must make zero AISG music/poll calls')
		assert.equal(elevenLabsRequests.length, 2)

		// Verify vocal native music_v2_5 composition_plan request & BYOK headers
		const vocalReq = elevenLabsRequests[0]
		assert.match(vocalReq.url, /\/smol\/elevenlabs\/v1\/music\?output_format=mp3_44100_128$/)
		assert.equal(vocalReq.headers.get('user-agent'), 'smol-workflow/1.0')
		assert.equal(vocalReq.headers.get('cf-aig-authorization'), 'Bearer aig-test-token')
		assert.equal(vocalReq.headers.get('cf-aig-byok-alias'), 'default')
		assert.equal(vocalReq.headers.get('cf-aig-no-wholesale'), 'true')
		assert.equal(vocalReq.headers.get('cf-aig-skip-cache'), 'true')
		assert.equal(vocalReq.headers.get('cf-aig-collect-log-payload'), 'false')
		assert.equal(vocalReq.headers.get('xi-api-key'), null, 'Must never send xi-api-key in BYOK mode')
		assert.equal(vocalReq.body.model_id, 'music_v2_5')
		assert.equal('prompt' in vocalReq.body, false, 'Vocal composition_plan must not include top-level prompt')
		assert.equal('force_instrumental' in vocalReq.body, false)
		assert.equal('music_length_ms' in vocalReq.body, false)
		assert.ok(Array.isArray(vocalReq.body.composition_plan?.chunks))
		assert.equal(vocalReq.body.composition_plan.chunks.length, 2)
		assert.match(vocalReq.body.composition_plan.chunks[0].text, /^\[Verse 1\]/)
		assert.match(vocalReq.body.composition_plan.chunks[1].text, /^\[Chorus\]/)

		// Verify instrumental request
		const instReq = elevenLabsRequests[1]
		assert.equal(instReq.body.model_id, 'music_v2_5')
		assert.equal(instReq.body.force_instrumental, true)
		assert.equal(instReq.body.music_length_ms, 120000)
		assert.equal('composition_plan' in instReq.body, false)

		// Verify R2 storage, canonical audio URL, and normalized Song_2: null even on pre-migration D1!
		const expectedMusicId = `el-${vocalId}`
		assert.deepEqual(harness.r2.store.get(`${expectedMusicId}.mp3`)?.bytes, fakeMp3)
		assert.equal(harness.d1Smols.get(vocalId)?.Song_1, expectedMusicId)
		assert.equal(harness.d1Smols.get(vocalId)?.Song_2, '', 'Pre-migration D1 stores empty string fallback')

		const detailRes = await appModule.app.fetch(
			new Request(`https://api.smol.xyz/${vocalId}`),
			harness.env,
			ctx.ctx
		)
		await ctx.flush()
		const detail = await detailRes.json() as { d1: Record<string, any>; kv_do: Record<string, any> }
		assert.equal(detail.d1.Song_2, null, 'Detail JSON normalizes empty Song_2 to null')
		assert.equal(detail.kv_do.songs.length, 1)
		assert.equal(detail.kv_do.songs[0].audio, `https://api.smol.xyz/song/${expectedMusicId}.mp3`)
		assert.equal(detail.kv_do.songs[0].status, 4)
		assert.equal(detail.kv_do.songs[0].service, 'elevenlabs')
		assert.equal(detail.kv_do.actual_provider, 'elevenlabs')
		assert.equal(detail.kv_do.generation_meta.requested_provider, 'elevenlabs')
		assert.equal(detail.kv_do.generation_meta.actual_provider, 'elevenlabs')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Gate 1c: automatic fallback AISG -> ElevenLabs triggers on submit rejection and poll failure (preserving visibility), NEVER on content policy', async () => {
	const fakeMp3 = makeAudioBytes(33, 4096)
	let elevenLabsCalls = 0
	let mode: 'submit_503' | 'poll_outage' | 'content_policy' = 'submit_503'

	const harness = buildMockEnv({
		aisgFetch: async (url) => {
			if (url.endsWith('/api/tasks')) {
				if (mode === 'submit_503') {
					return new Response(JSON.stringify({ code: 'provider_unavailable', message: 'AISG outage', outcome: 'rejected' }), { status: 503 })
				}
				return new Response(JSON.stringify({ task_id: 'task-fb' }), { status: 200 })
			}
			if (url.includes('/api/tasks/task-fb')) {
				return new Response(JSON.stringify({ task_id: 'task-fb', music_ids: ['s-1', 's-2'] }), { status: 200 })
			}
			if (url.includes('/api/songs?ids=')) {
				if (mode === 'poll_outage') {
					return new Response(JSON.stringify([
						{ music_id: 's-1', status: -4, audio: '', error_message: 'Upstream render worker crashed' },
						{ music_id: 's-2', status: 2, audio: '' },
					]), { status: 200 })
				}
				return new Response(JSON.stringify([
					{ music_id: 's-1', status: -4, audio: '', error_message: 'Rejected by content policy moderation' },
					{ music_id: 's-2', status: 2, audio: '' },
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
			elevenLabsCalls += 1
			return new Response(fakeMp3, {
				status: 200,
				headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(fakeMp3.byteLength) },
			})
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)

		// 1. Submit 503 -> falls back to ElevenLabs and preserves public: false
		mode = 'submit_503'
		const id1 = '1'.repeat(64)
		await wf.run(
			{ payload: { address: TEST_USER, prompt: 'private synth track', public: false, provider: 'aisonggenerator' }, instanceId: id1, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)
		assert.equal(elevenLabsCalls, 1)
		const kv1 = JSON.parse(harness.kv.get(id1)!)
		assert.equal(kv1.requested_provider, 'aisonggenerator')
		assert.equal(kv1.actual_provider, 'elevenlabs')
		assert.equal(kv1.fallback_from, 'aisonggenerator')
		assert.equal(kv1.fallback_reason, 'provider_unavailable')
		assert.equal(harness.d1Smols.get(id1)?.Public, 0, 'Original private visibility must be preserved across fallback')
		assert.equal(harness.d1Smols.get(id1)?.Requested_Provider, 'aisonggenerator')
		assert.equal(harness.d1Smols.get(id1)?.Actual_Provider, 'elevenlabs')

		// 2. Poll terminal non-policy failure -> falls back to ElevenLabs
		mode = 'poll_outage'
		const id2 = '2'.repeat(64)
		await wf.run(
			{ payload: { address: TEST_USER, prompt: 'poll fallback track', public: true, provider: 'aisonggenerator' }, instanceId: id2, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)
		assert.equal(elevenLabsCalls, 2)
		const kv2 = JSON.parse(harness.kv.get(id2)!)
		assert.equal(kv2.fallback_from, 'aisonggenerator')
		assert.equal(kv2.fallback_reason, 'poll_failed')
		assert.equal(kv2.actual_provider, 'elevenlabs')

		// 3. Content policy rejection -> NEVER falls back to ElevenLabs!
		mode = 'content_policy'
		const id3 = '3'.repeat(64)
		await assert.rejects(
			() => wf.run(
				{ payload: { address: TEST_USER, prompt: 'policy test', public: true, provider: 'aisonggenerator' }, instanceId: id3, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/content_policy/
		)
		assert.equal(elevenLabsCalls, 2, 'Content policy rejection must NOT spend ElevenLabs credits')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Gate 1d: negative validation, credential fail-closed, chunked/overflow/truncated streams, and NSFW string fail-closed', async () => {
	const harness = buildMockEnv({ nsfwRaw: 'unsafe\nS12' })
	const token = await createAuthToken(TEST_USER, TEST_SECRET)
	const ctx = createMockExecutionContext()

	// Invalid provider returns 400 before creating DO or workflow
	const badProviderRes = await appModule.app.fetch(
		new Request('https://api.smol.xyz/', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'test', provider: 'suno' }),
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(badProviderRes.status, 400)
	assert.equal(harness.createdWorkflows.length, 0)

	// Missing CF_AIG_TOKEN fails closed without calling fetch
	const unconfiguredEnv = { ...harness.env, CF_AIG_TOKEN: '' } as unknown as Env
	await assert.rejects(
		() => elevenLabsModule.generateElevenLabsSong({
			env: unconfiguredEnv,
			smolId: 'smol-no-cred',
			prompt: 'ambient',
			isInstrumental: true,
		}),
		(err: unknown) => err instanceof elevenLabsModule.ElevenLabsProviderError && err.code === 'provider_misconfigured'
	)

	// Empty lyrics on vocal composition_plan throws invalid_composition_plan
	assert.throws(
		() => elevenLabsModule.buildElevenLabsRequestBody({
			prompt: 'vocal song',
			lyrics: { title: 'Empty', style: ['pop'], lyrics: '   ' },
			isInstrumental: false,
			musicLengthMs: 60_000,
		}),
		(err: unknown) => err instanceof elevenLabsModule.ElevenLabsProviderError && err.code === 'invalid_composition_plan'
	)

	const originalFetch = globalThis.fetch
	try {
		// Unknown-length chunked stream within cap succeeds
		globalThis.fetch = (async () => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3, 4]))
					controller.enqueue(new Uint8Array([5, 6, 7, 8]))
					controller.close()
				},
			})
			return new Response(stream, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
		}) as typeof fetch

		const chunkedResult = await elevenLabsModule.generateElevenLabsSong({
			env: harness.env,
			smolId: 'smol-chunked',
			prompt: 'ambient',
			isInstrumental: true,
			maxBytes: 1024,
		})
		assert.equal(chunkedResult.receipt.bytes, 8)
		assert.equal(harness.r2.store.get('el-smol-chunked.mp3')?.bytes.byteLength, 8)

		// Unknown-length stream exceeding cap cancels and does NOT commit to R2
		globalThis.fetch = (async () => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(64))
					controller.enqueue(new Uint8Array(64))
					controller.close()
				},
			})
			return new Response(stream, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
		}) as typeof fetch

		await assert.rejects(
			() => elevenLabsModule.generateElevenLabsSong({
				env: harness.env,
				smolId: 'smol-overflow',
				prompt: 'ambient',
				isInstrumental: true,
				maxBytes: 100,
			}),
			(err: unknown) => err instanceof elevenLabsModule.ElevenLabsProviderError && err.code === 'audio_too_large'
		)
		assert.equal(harness.r2.store.has('el-smol-overflow.mp3'), false)

		// Truncated body (declared Content-Length mismatch) fails and does NOT commit to R2
		globalThis.fetch = (async () => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(20))
					controller.close()
				},
			})
			return new Response(stream, {
				status: 200,
				headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '100' },
			})
		}) as typeof fetch

		await assert.rejects(
			() => elevenLabsModule.generateElevenLabsSong({
				env: harness.env,
				smolId: 'smol-truncated',
				prompt: 'ambient',
				isInstrumental: true,
				maxBytes: 1024,
			}),
			(err: unknown) => err instanceof elevenLabsModule.ElevenLabsProviderError && err.code === 'truncated_audio'
		)
		assert.equal(harness.r2.store.has('el-smol-truncated.mp3'), false)
	} finally {
		globalThis.fetch = originalFetch
	}

	// NSFW normalization: strings, JSON strings, contradictory lines, safe+unknown, and unknown/empty ALL fail closed!
	assert.deepEqual(nsfwModule.normalizeNsfwResult('safe'), { safe: true, categories: [] })
	assert.deepEqual(nsfwModule.normalizeNsfwResult('unsafe\nS12'), { safe: false, categories: ['S12'] })
	assert.deepEqual(nsfwModule.normalizeNsfwResult('{"safe":false,"categories":["S12"]}'), { safe: false, categories: ['S12'] })
	assert.deepEqual(nsfwModule.normalizeNsfwResult('safe\nunsafe\nS12'), { safe: false, categories: [], unknown: true })
	assert.deepEqual(nsfwModule.normalizeNsfwResult('safe\nS12'), { safe: false, categories: [], unknown: true })
	assert.deepEqual(nsfwModule.normalizeNsfwResult({ safe: true, unknown: true }), { safe: false, categories: [], unknown: true })
	assert.equal(nsfwModule.isNsfwBlocked('safe\nunsafe\nS12'), true)
	assert.equal(nsfwModule.isNsfwBlocked({ safe: true, unknown: true }), true)
	assert.equal(nsfwModule.isNsfwBlocked('unsafe\nS12'), true)
	assert.equal(nsfwModule.isNsfwBlocked('{"safe":false}'), true)
	assert.equal(nsfwModule.isNsfwBlocked('garbled-model-output'), true)
	assert.equal(nsfwModule.isNsfwBlocked(undefined), true)
	assert.equal(nsfwModule.isNsfwBlocked({ safe: true, categories: [] }), false)
})

test('Gate 1e (post-review P1 regressions): paginated AISG discovery accumulates 2 IDs across pages; pending/singleton/untyped-5xx NEVER trigger paid ElevenLabs fallback', async () => {
	const audio1 = makeAudioBytes(19, 40_000)
	const audio2 = makeAudioBytes(23, 40_000)
	let elevenLabsCalls = 0
	let scenario: 'paginated' | 'deeper_503' | 'singleton_exhaust' | 'poll_exhaust' | 'untyped_502' | 'untyped_504_auth_text' = 'paginated'
	const seenDiscoveryPages: number[] = []
	const seenIdempotencyKeys: string[] = []
	let deeper503Page1Calls = 0

	const harness = buildMockEnv({
		aisgFetch: async (url, init) => {
			if (url.endsWith('/api/tasks')) {
				const hdrs = new Headers(init?.headers)
				const key = hdrs.get('idempotency-key')
				if (key) seenIdempotencyKeys.push(key)
				if (scenario === 'untyped_502') {
					return new Response('<html>502 Bad Gateway</html>', { status: 502 })
				}
				if (scenario === 'untyped_504_auth_text') {
					return new Response('upstream authorization cookie timeout', { status: 504 })
				}
				return new Response(JSON.stringify({ task_id: `task-${scenario}`, workspace_id: 'ws-p' }), { status: 200 })
			}
			if (url.includes('/api/tasks/task-paginated')) {
				const parsedUrl = new URL(url)
				const page = Number(parsedUrl.searchParams.get('page') ?? '1')
				seenDiscoveryPages.push(page)
				// Track 1 is on page 1 (with continuation next_page=2), track 2 is on page 2!
				if (page === 1) {
					return new Response(JSON.stringify({ task_id: 'task-paginated', music_ids: ['pg-1'], next_page: 2 }), { status: 200 })
				}
				return new Response(JSON.stringify({ task_id: 'task-paginated', music_ids: ['pg-2'] }), { status: 200 })
			}
			if (url.includes('/api/tasks/task-deeper_503')) {
				const parsedUrl = new URL(url)
				const page = Number(parsedUrl.searchParams.get('page') ?? '1')
				if (page === 1) {
					deeper503Page1Calls += 1
					if (deeper503Page1Calls === 1) {
						return new Response(JSON.stringify({ task_id: 'task-deeper_503', music_ids: [], next_page: 2 }), { status: 200 })
					}
					return new Response(JSON.stringify({ task_id: 'task-deeper_503', music_ids: ['pg-1', 'pg-2'] }), { status: 200 })
				}
				// Optional deeper page returns transient retryable 503
				return new Response(JSON.stringify({ code: 'aisg_upstream_error', retryable: true, outcome: 'rejected', error: 'Upstream 503' }), { status: 503 })
			}
			if (url.includes('/api/tasks/task-singleton_exhaust')) {
				return new Response(JSON.stringify({ task_id: 'task-singleton_exhaust', music_ids: ['only-one'] }), { status: 200 })
			}
			if (url.includes('/api/tasks/task-poll_exhaust')) {
				return new Response(JSON.stringify({ task_id: 'task-poll_exhaust', music_ids: ['pend-1', 'pend-2'] }), { status: 200 })
			}
			if (url.includes('/api/songs?ids=pg-1%2Cpg-2')) {
				return new Response(JSON.stringify([
					{ music_id: 'pg-1', status: 4, audio: 'https://cdn.aisg.test/pg1.mp3', service: 'aisonggenerator' },
					{ music_id: 'pg-2', status: 4, audio: 'https://cdn.aisg.test/pg2.mp3', service: 'aisonggenerator' },
				]), { status: 200 })
			}
			if (url.includes('/api/songs?ids=pend-1%2Cpend-2')) {
				return new Response(JSON.stringify([
					{ music_id: 'pend-1', status: 2, audio: '', service: 'aisonggenerator' },
					{ music_id: 'pend-2', status: 2, audio: '', service: 'aisonggenerator' },
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
		if (url.endsWith('pg1.mp3')) return new Response(audio1, { status: 200 })
		if (url.endsWith('pg2.mp3')) return new Response(audio2, { status: 200 })
		if (url.includes('/elevenlabs/v1/music')) {
			elevenLabsCalls += 1
			return new Response(audio1, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)

		// 1. Paginated discovery honors next_page=2 and accumulates BOTH IDs across pages
		scenario = 'paginated'
		const idPag = '4'.repeat(64)
		await wf.run(
			{ payload: { address: TEST_USER, prompt: 'paginated test', public: true, provider: 'aisonggenerator' }, instanceId: idPag, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)
		assert.deepEqual(seenDiscoveryPages, [1, 2])
		assert.equal(harness.d1Smols.get(idPag)?.Song_1, 'pg-1')
		assert.equal(harness.d1Smols.get(idPag)?.Song_2, 'pg-2')
		assert.ok(seenIdempotencyKeys.some((k) => k.includes(idPag) && /^[A-Za-z0-9._:-]{16,128}$/.test(k)), 'POST /api/tasks must send valid 16-128 char Idempotency-Key')

		// 1b. Transient 503 on optional deeper page does NOT abort discovery; iteration 2 rechecks page 1 and succeeds!
		scenario = 'deeper_503'
		const idDeeper = '8'.repeat(64)
		await wf.run(
			{ payload: { address: TEST_USER, prompt: 'deeper 503 test', public: true, provider: 'aisonggenerator' }, instanceId: idDeeper, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)
		assert.equal(deeper503Page1Calls, 2)
		assert.equal(harness.d1Smols.get(idDeeper)?.Song_1, 'pg-1')
		assert.equal(harness.d1Smols.get(idDeeper)?.Song_2, 'pg-2')

		// 2. Singleton discovery exhaustion keeps accepted task receipt, refuses 1-track publish AND refuses paid ElevenLabs fallback
		scenario = 'singleton_exhaust'
		const idSing = '5'.repeat(64)
		await assert.rejects(
			() => wf.run(
				{ payload: { address: TEST_USER, prompt: 'singleton test', public: true, provider: 'aisonggenerator' }, instanceId: idSing, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/still pending discovery \(1\/2 IDs\)/
		)
		assert.equal(harness.d1Smols.has(idSing), false, 'Must NOT publish a 1-track AISG singleton')
		const singAttempt = harness.doNs.getStorage(idSing).get('provider_attempt') as ProviderAttemptState | undefined
		assert.equal(singAttempt?.status, 'submitted')
		assert.equal(singAttempt?.task_id, 'task-singleton_exhaust')

		// 3. Ordinary polling exhaustion on still-pending songs NEVER triggers paid ElevenLabs fallback
		scenario = 'poll_exhaust'
		const idPend = '6'.repeat(64)
		await assert.rejects(
			() => wf.run(
				{ payload: { address: TEST_USER, prompt: 'pending poll test', public: true, provider: 'aisonggenerator' }, instanceId: idPend, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/still pending after the polling window/
		)

		// 4. Untyped gateway 502 on paid submit is treated as outcome='unknown' (ambiguous), NEVER confirmed rejection / fallback!
		scenario = 'untyped_502'
		const id502 = '7'.repeat(64)
		await assert.rejects(
			() => wf.run(
				{ payload: { address: TEST_USER, prompt: 'gateway 502 test', public: true, provider: 'aisonggenerator' }, instanceId: id502, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/outcome unknown/i
		)
		const attempt502 = harness.doNs.getStorage(id502).get('provider_attempt') as ProviderAttemptState | undefined
		assert.equal(attempt502?.status, 'ambiguous')

		// 5. Untyped HTTP 504 containing "upstream authorization cookie timeout" MUST be outcome='unknown', NEVER provider_auth_error/fallback!
		scenario = 'untyped_504_auth_text'
		const id504 = '9'.repeat(64)
		await assert.rejects(
			() => wf.run(
				{ payload: { address: TEST_USER, prompt: 'gateway 504 auth text test', public: true, provider: 'aisonggenerator' }, instanceId: id504, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/outcome unknown/i
		)
		const attempt504 = harness.doNs.getStorage(id504).get('provider_attempt') as ProviderAttemptState | undefined
		assert.equal(attempt504?.status, 'ambiguous')

		assert.equal(elevenLabsCalls, 0, 'Pending discovery, pending poll exhaustion, untyped 502, and 504 timeout text must make ZERO paid ElevenLabs calls')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Gate 1f (Pass-2 P1 regressions): ElevenLabs 504, zero-byte 200, oversize 200, and JSON 200 ALL record outcome=unknown (ambiguous) so retries never double-charge', async () => {
	const harness = buildMockEnv()
	const cases: Array<{ name: string; response: () => Response; expectedCode: string }> = [
		{
			name: 'gateway 504 timeout',
			response: () => new Response('upstream gateway timeout', { status: 504 }),
			expectedCode: 'submit_outcome_unknown',
		},
		{
			name: '200 with zero declared Content-Length',
			response: () => new Response(new Uint8Array(0), {
				status: 200,
				headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '0' },
			}),
			expectedCode: 'empty_audio',
		},
		{
			name: '200 with declared oversize Content-Length',
			response: () => new Response(new Uint8Array(16), {
				status: 200,
				headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(20 * 1024 * 1024) },
			}),
			expectedCode: 'audio_too_large',
		},
		{
			name: '200 with unexpected application/json body',
			response: () => new Response(JSON.stringify({ ok: false }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
			expectedCode: 'invalid_audio_response',
		},
	]

	const originalFetch = globalThis.fetch
	let currentCase = cases[0]
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('api.pixellab.ai')) {
			return new Response(JSON.stringify({ image: { base64: FAKE_IMAGE_B64 } }), { status: 200 })
		}
		if (url.includes('/elevenlabs/v1/music')) {
			return currentCase.response()
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		for (let i = 0; i < cases.length; i++) {
			currentCase = cases[i]

			// Direct adapter check: outcome MUST be 'unknown' (never 'rejected')
			await assert.rejects(
				() => elevenLabsModule.generateElevenLabsSong({
					env: harness.env,
					smolId: `direct-${i}`,
					prompt: 'ambient synth',
					isInstrumental: true,
				}),
				(err: unknown) =>
					err instanceof elevenLabsModule.ElevenLabsProviderError
					&& err.code === currentCase.expectedCode
					&& err.outcome === 'unknown',
				`${currentCase.name} must return outcome='unknown'`
			)

			// Workflow check: DO must record provider_attempt.status === 'ambiguous' (blocking duplicate paid claim!)
			const smolId = `${(i + 1).toString(16)}e`.repeat(32)
			await assert.rejects(
				() => wf.run(
					{ payload: { address: TEST_USER, prompt: 'ambient synth', public: true, instrumental: true, provider: 'elevenlabs' }, instanceId: smolId, timestamp: new Date() } as never,
					createWorkflowStep(new Map()).step as never
				)
			)
			const storedAttempt = harness.doNs.getStorage(smolId).get('provider_attempt') as ProviderAttemptState | undefined
			assert.equal(storedAttempt?.provider, 'elevenlabs', `${currentCase.name}: provider`)
			assert.equal(storedAttempt?.status, 'ambiguous', `${currentCase.name}: workflow must record ambiguous attempt so claim is NOT released`)
		}
	} finally {
		globalThis.fetch = originalFetch
	}
})
