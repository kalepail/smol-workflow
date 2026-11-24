import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after, before } from 'node:test'
import {
	createAuthToken,
	createMockDoNamespace,
	createMockExecutionContext,
	createMockR2Bucket,
	createMockUserQuotaNamespace,
	createWorkflowStep,
	installCloudflareStubs,
	type CloudflareStubHandle,
} from './helpers/harness'

let stubs: CloudflareStubHandle
let appModule: typeof import('../src/index')
let workflowModule: typeof import('../src/workflow')

const TEST_SECRET = 'test-jwt-secret-32-chars-minimum!'
const OWNER = 'GOWNERADDRESS000000000000'
const OLD_ID = 'a'.repeat(64)
const NEW_ID = 'b'.repeat(64)

before(async () => {
	stubs = installCloudflareStubs({
		CF_API_TOKEN: 'test-cf-token',
		CF_ZONE_ID: 'test-zone-id',
	})
	appModule = await import('../src/index')
	workflowModule = await import('../src/workflow')
})

after(() => {
	stubs.cleanup()
})

function createRetryCrudHarness() {
	const r2 = createMockR2Bucket()
	const doNs = createMockDoNamespace(r2.bucket)
	const quotaNs = createMockUserQuotaNamespace(appModule.UserQuotaDO)
	const kv = new Map<string, string>()
	const smolsTable = new Map<string, Record<string, unknown>>()
	const playlistsTable: Array<{ Id: string; Title: string }> = []
	const likesTable: Array<{ Id: string; Address: string }> = []
	const createdWorkflows: Array<{ id: string; params: WorkflowParams }> = []
	const workflowStatuses = new Map<string, string>()
	const purgedTagBatches: string[][] = []
	const queueMessages: unknown[] = []

	const d1 = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					const run = async () => {
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
									Mint_Token: null,
									Mint_Amm: null,
								})
							}
							return { success: true, meta: { changes: 1 } }
						}
						if (sql.includes('INSERT OR IGNORE INTO Playlists')) {
							const id = String(args[0])
							const title = String(args[1])
							if (!playlistsTable.some((p) => p.Id === id && p.Title === title)) {
								playlistsTable.push({ Id: id, Title: title })
								return { success: true, meta: { changes: 1 } }
							}
							return { success: true, meta: { changes: 0 } }
						}
						if (sql.includes('UPDATE Smols SET') && sql.includes('Song_1 = Song_2')) {
							const [smolId, songId, address] = args.map(String)
							const row = smolsTable.get(smolId)
							if (
								row
								&& row.Address === address
								&& typeof row.Song_2 === 'string'
								&& row.Song_2 !== ''
								&& row.Song_2 === songId
							) {
								const prev1 = row.Song_1
								row.Song_1 = row.Song_2
								row.Song_2 = prev1
								return { success: true, meta: { changes: 1 } }
							}
							return { success: true, meta: { changes: 0 } }
						}
						if (sql.includes('DELETE FROM Playlists WHERE Id = ?1')) {
							const id = String(args[0])
							for (let i = playlistsTable.length - 1; i >= 0; i--) {
								if (playlistsTable[i].Id === id) playlistsTable.splice(i, 1)
							}
							return { success: true, meta: { changes: 1 } }
						}
						if (sql.includes('DELETE FROM Likes WHERE Id = ?1')) {
							const id = String(args[0])
							for (let i = likesTable.length - 1; i >= 0; i--) {
								if (likesTable[i].Id === id) likesTable.splice(i, 1)
							}
							return { success: true, meta: { changes: 1 } }
						}
						if (sql.includes('DELETE FROM Smols WHERE Id = ?1')) {
							const id = String(args[0])
							const row = smolsTable.get(id)
							if (!row) return { success: true, meta: { changes: 0 } }
							if (sql.includes('Mint_Token IS NULL') && (row.Mint_Token || row.Mint_Amm)) {
								return { success: true, meta: { changes: 0 } }
							}
							if (sql.includes('"Address" = ?2') && row.Address !== args[1]) {
								return { success: true, meta: { changes: 0 } }
							}
							smolsTable.delete(id)
							return { success: true, meta: { changes: 1 } }
						}
						return { success: true, meta: { changes: 0 } }
					}

					return {
						run,
						first: async () => {
							if (sql.includes('SELECT 1 FROM Smols WHERE Song_1 = ?1 OR Song_2 = ?1')) {
								const musicId = String(args[0])
								for (const row of smolsTable.values()) {
									if (row.Song_1 === musicId || row.Song_2 === musicId) return { 1: 1 }
								}
								return null
							}
							if (/FROM\s+Smols\s+WHERE\s+Id\s*=\s*\?1/i.test(sql)) {
								const row = smolsTable.get(String(args[0]))
								if (!row) return null
								if (sql.includes('"Address" = ?2') && row.Address !== args[1]) return null
								return row
							}
							return null
						},
						all: async () => {
							if (sql.includes('SELECT Title FROM Playlists WHERE Id = ?1')) {
								const id = String(args[0])
								return { results: playlistsTable.filter((p) => p.Id === id).map((p) => ({ Title: p.Title })) }
							}
							if (sql.includes('SELECT "Address" as Address FROM Likes WHERE Id = ?1')) {
								const id = String(args[0])
								return { results: likesTable.filter((l) => l.Id === id).map((l) => ({ Address: l.Address })) }
							}
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
		CF_AI_GATEWAY_ID: 'smol-gateway',
		CF_AIG_TOKEN: 'aig-test-token',
		CF_AIG_BYOK_ALIAS: 'default',
		ELEVENLABS_FALLBACK_ENABLED: 'true',
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
			send: async (msg: unknown) => {
				queueMessages.push(msg)
			},
		},
		WORKFLOW: {
			create: async ({ id, params }: { id: string; params: WorkflowParams }) => {
				if (workflowStatuses.has(id)) {
					throw new Error('instance.already_exists')
				}
				createdWorkflows.push({ id, params })
				workflowStatuses.set(id, 'running')
				return { status: async () => ({ status: workflowStatuses.get(id) ?? 'running' }) }
			},
			get: async (id: string) => {
				if (!workflowStatuses.has(id)) {
					throw new Error('instance.not_found')
				}
				return {
					status: async () => ({ status: workflowStatuses.get(id)! }),
				}
			},
		},
		AI: {
			gateway: (gw: string) => ({
				getUrl: async (provider: string) => `https://gateway.ai.cloudflare.com/v1/acct-1/${gw}/${provider}`,
			}),
			run: async () => {
				throw new Error('AI should not run when state is reused')
			},
		},
		AISONGGENERATOR: {
			fetch: async () => {
				throw new Error('Unexpected AISG call')
			},
		},
	} as unknown as Env

	return {
		env,
		r2,
		doNs,
		kv,
		smolsTable,
		playlistsTable,
		likesTable,
		createdWorkflows,
		workflowStatuses,
		purgedTagBatches,
		queueMessages,
	}
}

test('Gate 2a: POST /retry/:id seeds DO immediately (no owner 404), preserves provider, deduplicates concurrent retries, and protects healthy/minted rows', async () => {
	const harness = createRetryCrudHarness()
	const token = await createAuthToken(OWNER, TEST_SECRET)
	const ctx = createMockExecutionContext()

	// Seed a failed ElevenLabs attempt in OLD_ID DO
	const oldStorage = harness.doNs.getStorage(OLD_ID)
	oldStorage.set('payload', {
		address: OWNER,
		prompt: 'midnight jazz',
		public: true,
		instrumental: false,
		provider: 'elevenlabs',
	})
	oldStorage.set('requested_provider', 'elevenlabs')

	// Two concurrent callers retry OLD_ID without auth -> both receive the SAME deduplicated successor ID!
	const [r1, r2] = await Promise.all([
		appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${OLD_ID}`, { method: 'POST' }), harness.env, ctx.ctx),
		appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${OLD_ID}`, { method: 'POST' }), harness.env, ctx.ctx),
	])
	assert.equal(r1.status, 200)
	assert.equal(r2.status, 200)
	const successorId1 = await r1.text()
	const successorId2 = await r2.text()
	assert.equal(successorId1, successorId2, 'Concurrent retries of same failed ID must deduplicate to one successor')
	assert.equal(harness.createdWorkflows.length, 1)
	assert.equal(harness.createdWorkflows[0].params.provider, 'elevenlabs', 'Original provider must be preserved on retry')

	// Immediate owner GET /:newId succeeds (seeded DO payload BEFORE WORKFLOW.create)
	const ownerGet = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/${successorId1}`, {
			headers: { Authorization: `Bearer ${token}` },
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(ownerGet.status, 200)
	const ownerBody = await ownerGet.json() as { kv_do: Record<string, any> }
	assert.equal(ownerBody.kv_do.payload.address, OWNER)
	assert.equal(ownerBody.kv_do.payload.provider, 'elevenlabs')

	// Optional override_provider switches engine on retry (after previous successor errored)
	harness.workflowStatuses.set(successorId1, 'errored')
	const overrideRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${OLD_ID}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({ override_provider: 'aisonggenerator' }),
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(overrideRes.status, 200)
	assert.equal(harness.createdWorkflows.length, 2)
	assert.equal(harness.createdWorkflows[1].params.override_provider, 'aisonggenerator')
	assert.equal(harness.createdWorkflows[1].params.provider, 'aisonggenerator')

	// Healthy completed/minted row returns its existing ID without starting a new workflow
	const healthyId = 'c'.repeat(64)
	harness.smolsTable.set(healthyId, {
		Id: healthyId,
		Title: 'Minted Hit',
		Song_1: 'song-m1',
		Song_2: 'song-m2',
		Address: OWNER,
		Public: 1,
		Mint_Token: 'CTOKEN',
		Mint_Amm: 'CAMM',
	})
	const retryHealthy = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${healthyId}`, { method: 'POST' }),
		harness.env,
		ctx.ctx
	)
	assert.equal(retryHealthy.status, 200)
	assert.equal(await retryHealthy.text(), healthyId)
	assert.equal(harness.createdWorkflows.length, 2, 'Healthy/minted smol must not spawn replacement workflow')
})

test('Gate 2b: retry PATH 2 with partially complete [A complete, B pending] preserves A.mp3 in R2, handles playlist replay idempotency, and flushes DO last', async () => {
	const harness = createRetryCrudHarness()
	const bytesA = new Uint8Array([1, 2, 3, 4, 5, 6])
	const bytesB = new Uint8Array([9, 8, 7, 6, 5, 4])
	await harness.r2.bucket.put('song-a.mp3', bytesA, {
		httpMetadata: { contentType: 'audio/mpeg' },
		customMetadata: { sourceUrl: 'https://cdn.aisg.test/a.mp3' },
	})
	await harness.r2.bucket.put(`${OLD_ID}.png`, new Uint8Array([10, 20]))

	// Seed OLD_ID with song-a ALREADY complete (status 4) and song-b pending (status 2)
	const oldStorage = harness.doNs.getStorage(OLD_ID)
	oldStorage.set('payload', {
		address: OWNER,
		prompt: 'sunset synth',
		playlist: 'chill-vibes',
		public: true,
		instrumental: false,
		provider: 'aisonggenerator',
	})
	oldStorage.set('image_base64', Buffer.from('img').toString('base64'))
	oldStorage.set('description', 'Warm ocean')
	oldStorage.set('lyrics', { title: 'Sunset Synth', style: ['synthwave', 'pop'], lyrics: '[Verse 1]\nGlow' })
	oldStorage.set('nsfw', { safe: true, categories: [] })
	oldStorage.set('song_ids', ['song-a', 'song-b'])
	oldStorage.set('songs', [
		{ music_id: 'song-a', status: 4, audio: 'https://cdn.aisg.test/a.mp3', service: 'aisonggenerator' },
		{ music_id: 'song-b', status: 2, audio: '', service: 'aisonggenerator' },
	])

	// Quick check returns both song-a and song-b complete!
	;(harness.env as any).AISONGGENERATOR = {
		fetch: async (url: string) => {
			if (url.includes('/api/songs?ids=song-a%2Csong-b')) {
				return new Response(JSON.stringify([
					{ music_id: 'song-a', status: 4, audio: 'https://cdn.aisg.test/a.mp3', service: 'aisonggenerator' },
					{ music_id: 'song-b', status: 4, audio: 'https://cdn.aisg.test/b.mp3', service: 'aisonggenerator' },
				]), { status: 200 })
			}
			throw new Error(`Unexpected AISG call: ${url}`)
		},
	}

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.endsWith('/b.mp3')) return new Response(bytesB, { status: 200 })
		if (url.includes('/purge_cache')) return new Response(JSON.stringify({ success: true }), { status: 200 })
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		const cache = new Map<string, unknown>()
		const event = { payload: { retry_id: OLD_ID }, instanceId: NEW_ID, timestamp: new Date() }

		// Inject a failure once on publish smol to verify playlist INSERT OR IGNORE replay safety & DO flush ordering
		const failOnce = new Set(['publish smol'])
		await assert.rejects(
			() => wf.run(event as never, createWorkflowStep(cache, { failOnceOn: failOnce }).step as never),
			/Injected transient failure/
		)
		assert.equal(harness.doNs.flushedIds.length, 0, 'DO must NOT schedule flush before completion succeeds')

		// Replay completes cleanly
		await wf.run(event as never, createWorkflowStep(cache).step as never)

		// CRITICAL: song-a.mp3 MUST still exist in R2 (was previously deleted by PATH 2 bug!)
		assert.equal(harness.r2.store.has('song-a.mp3'), true, 'Reused song-a.mp3 must NOT be deleted from R2!')
		assert.equal(harness.r2.store.has('song-b.mp3'), true)
		assert.equal(harness.r2.store.has(`${OLD_ID}.png`), false, 'Orphaned retry PNG should be cleaned')
		assert.equal(harness.playlistsTable.length, 1, 'Exactly one playlist row despite replay')
		assert.ok(harness.doNs.flushedIds.includes(NEW_ID), 'New DO flush scheduled at the end')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Gate 2c: legacy non-AISG/service-less completed snapshot reuses verified R2 audio without polling AISG, IDs-only retry works, and ambiguous submit enters reconciliation', async () => {
	const harness = createRetryCrudHarness()
	const legacyAudio = new Uint8Array([4, 5, 6, 7])
	await harness.r2.bucket.put('legacy-uid-1.mp3', legacyAudio)

	let aisgCalls = 0
	;(harness.env as any).AISONGGENERATOR = {
		fetch: async (url: string) => {
			aisgCalls += 1
			if (url.includes('/api/songs?ids=ids-only-1%2Cids-only-2')) {
				return new Response(JSON.stringify([
					{ music_id: 'ids-only-1', status: 4, audio: 'https://cdn.aisg.test/io1.mp3', service: 'aisonggenerator' },
					{ music_id: 'ids-only-2', status: 4, audio: 'https://cdn.aisg.test/io2.mp3', service: 'aisonggenerator' },
				]), { status: 200 })
			}
			if (url.endsWith('/api/tasks')) {
				throw new Error('connection reset after dispatch')
			}
			throw new Error(`Unexpected AISG call: ${url}`)
		},
	}

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('/io1.mp3') || url.includes('/io2.mp3')) return new Response(legacyAudio, { status: 200 })
		if (url.includes('/purge_cache')) return new Response(JSON.stringify({ success: true }), { status: 200 })
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)

		// 1. Legacy 1-track service-less snapshot with verified R2 object -> zero AISG calls!
		const legacyOldId = 'd'.repeat(64)
		const legacyNewId = 'e'.repeat(64)
		harness.kv.set(legacyOldId, JSON.stringify({
			payload: { address: OWNER, prompt: 'retro wave', public: true },
			image_base64: Buffer.from('img').toString('base64'),
			description: 'Retro',
			lyrics: { title: 'Retro Wave', style: ['retro', 'synth'], lyrics: 'la la' },
			nsfw: 'safe',
			song_ids: ['legacy-uid-1'],
			songs: [{ music_id: 'legacy-uid-1', status: 4, audio: 'https://api.smol.xyz/song/legacy-uid-1.mp3' }],
		}))
		await wf.run(
			{ payload: { retry_id: legacyOldId }, instanceId: legacyNewId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)
		assert.equal(aisgCalls, 0, 'Legacy completed R2 snapshot must never poll AISG')
		assert.equal(harness.smolsTable.get(legacyNewId)?.Song_1, 'legacy-uid-1')
		assert.equal(harness.smolsTable.get(legacyNewId)?.Song_2, null)

		// 2. IDs-only retry (song_ids present, songs missing) enters PATH 2 quick-check cleanly
		const idsOldId = 'f'.repeat(64)
		const idsNewId = '0'.repeat(64)
		harness.kv.set(idsOldId, JSON.stringify({
			payload: { address: OWNER, prompt: 'ids only', public: true, provider: 'aisonggenerator' },
			image_base64: Buffer.from('img').toString('base64'),
			description: 'IDs only',
			lyrics: { title: 'IDs Only', style: ['pop', 'rock'], lyrics: 'verse' },
			nsfw: { safe: true, categories: [] },
			song_ids: ['ids-only-1', 'ids-only-2'],
		}))
		await wf.run(
			{ payload: { retry_id: idsOldId }, instanceId: idsNewId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)
		assert.equal(aisgCalls, 1)
		assert.equal(harness.smolsTable.get(idsNewId)?.Song_1, 'ids-only-1')
		assert.equal(harness.smolsTable.get(idsNewId)?.Song_2, 'ids-only-2')

		// 3. Unknown submission outcome marks attempt ambiguous and refuses silent fallback/double-charge
		const ambigOldId = '8'.repeat(64)
		const ambigNewId = '9'.repeat(64)
		harness.kv.set(ambigOldId, JSON.stringify({
			payload: { address: OWNER, prompt: 'ambiguous', public: true, provider: 'aisonggenerator' },
			image_base64: Buffer.from('img').toString('base64'),
			description: 'Ambiguous test',
			lyrics: { title: 'Ambiguous', style: ['pop', 'synth'], lyrics: 'verse' },
			nsfw: { safe: true, categories: [] },
		}))
		await assert.rejects(
			() => wf.run(
				{
					payload: { retry_id: ambigOldId },
					instanceId: ambigNewId,
					timestamp: new Date(),
				} as never,
				createWorkflowStep(new Map()).step as never
			),
			/outcome unknown/i
		)
		const ambigAttempt = harness.doNs.getStorage(ambigNewId).get('provider_attempt') as ProviderAttemptState | undefined
		assert.equal(ambigAttempt?.status, 'ambiguous', 'Unknown submit outcome must record ambiguous attempt for reconciliation')
		assert.equal(ambigAttempt?.provider, 'aisonggenerator')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Gate 5 swap & delete: 2-track swap purges list/mixtape/playlist tags, 1-track swap leaves Song_1 intact, delete cleans Playlists & protects shared MP3s', async () => {
	const harness = createRetryCrudHarness()
	const token = await createAuthToken(OWNER, TEST_SECRET)
	const ctx = createMockExecutionContext()

	const twoTrackId = '2'.repeat(64)
	const oneTrackId = '1'.repeat(64)
	const sharedSongId = 'shared-mp3'
	harness.smolsTable.set(twoTrackId, {
		Id: twoTrackId,
		Title: 'Two Track',
		Song_1: sharedSongId,
		Song_2: 'alt-mp3',
		Address: OWNER,
		Public: 1,
		Mint_Token: null,
	})
	harness.smolsTable.set(oneTrackId, {
		Id: oneTrackId,
		Title: 'One Track',
		Song_1: sharedSongId,
		Song_2: null,
		Address: OWNER,
		Public: 1,
		Mint_Token: null,
	})
	harness.playlistsTable.push({ Id: twoTrackId, Title: 'favorites' })
	await harness.r2.bucket.put(`${sharedSongId}.mp3`, new Uint8Array([1, 2, 3]))
	await harness.r2.bucket.put('alt-mp3.mp3', new Uint8Array([4, 5, 6]))

	const purgePayloads: string[][] = []
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('/purge_cache')) {
			const parsed = JSON.parse(String(init?.body ?? '{}')) as { tags: string[] }
			purgePayloads.push(parsed.tags)
			return new Response(JSON.stringify({ success: true }), { status: 200 })
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		// 1. One-track swap returns 404 and leaves Song_1 intact
		const oneTrackSwap = await appModule.app.fetch(
			new Request(`https://api.smol.xyz/${oneTrackId}/alt-mp3`, {
				method: 'PUT',
				headers: { Authorization: `Bearer ${token}` },
			}),
			harness.env,
			ctx.ctx
		)
		assert.equal(oneTrackSwap.status, 404)
		assert.equal(harness.smolsTable.get(oneTrackId)?.Song_1, sharedSongId)

		// 2. Two-track swap succeeds and purges detail + list + artist + mixtapes + playlist tags
		const twoTrackSwap = await appModule.app.fetch(
			new Request(`https://api.smol.xyz/${twoTrackId}/alt-mp3`, {
				method: 'PUT',
				headers: { Authorization: `Bearer ${token}` },
			}),
			harness.env,
			ctx.ctx
		)
		await ctx.flush()
		assert.equal(twoTrackSwap.status, 204)
		assert.equal(harness.smolsTable.get(twoTrackId)?.Song_1, 'alt-mp3')
		assert.equal(harness.smolsTable.get(twoTrackId)?.Song_2, sharedSongId)
		const swapTags = purgePayloads.flat()
		for (const expectedTag of ['public-smols', 'mixtapes', 'playlist:favorites', `smol:${twoTrackId}:anonymous`, `artist:${OWNER}:smols`]) {
			assert.ok(swapTags.includes(expectedTag), `Missing swap purge tag ${expectedTag} in ${JSON.stringify(swapTags)}`)
		}

		// 3. Deleting twoTrackId cleans Playlists row, deletes unshared alt-mp3.mp3, and PROTECTS shared-mp3.mp3!
		const delRes = await appModule.app.fetch(
			new Request(`https://api.smol.xyz/${twoTrackId}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` },
			}),
			harness.env,
			ctx.ctx
		)
		await ctx.flush()
		assert.equal(delRes.status, 204)
		assert.equal(harness.playlistsTable.length, 0, 'DELETE must remove orphaned Playlists rows')
		assert.equal(harness.r2.store.has('alt-mp3.mp3'), false, 'Unreferenced MP3 should be deleted')
		assert.equal(harness.r2.store.has(`${sharedSongId}.mp3`), true, 'Shared MP3 still referenced by oneTrackId must NOT be deleted')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('D1 migration 0001 rehearsal preserves live column values, indexes, nullable Song_2, provider CHECK, and 1-track swap safety', () => {
	const db = new DatabaseSync(':memory:')
	try {
		// Recreate LIVE production Smols DDL where Instrumental was added via ALTER TABLE (different column order!)
		db.exec(`
			CREATE TABLE Smols (
				Id TEXT PRIMARY KEY,
				Title TEXT NOT NULL,
				Song_1 TEXT NOT NULL,
				Song_2 TEXT NOT NULL,
				Created_At DATETIME DEFAULT CURRENT_TIMESTAMP,
				Public BOOLEAN DEFAULT 1,
				Plays INTEGER DEFAULT 0,
				Views INTEGER DEFAULT 0,
				"Address" TEXT NOT NULL,
				Mint_Token TEXT DEFAULT NULL,
				Mint_Amm TEXT DEFAULT NULL,
				Instrumental BOOLEAN DEFAULT 0
			);
			CREATE INDEX idx_smols_public_created ON Smols(Public, Created_At DESC, Id DESC);
			CREATE INDEX idx_smols_address_created ON Smols("Address", Created_At DESC, Id DESC);
			CREATE INDEX idx_smols_artist_public_created ON Smols("Address", Public, Created_At DESC, Id DESC);
			CREATE INDEX idx_smols_song_1 ON Smols(Song_1);
			CREATE INDEX idx_smols_song_2 ON Smols(Song_2);
		`)

		db.prepare(`
			INSERT INTO Smols (Id, Title, Song_1, Song_2, Created_At, Public, Plays, Views, "Address", Mint_Token, Mint_Amm, Instrumental)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run('smol-minted', 'Minted Song', 's1', 's2', '2026-01-01 00:00:00', 1, 42, 99, 'GUSER1', 'CTOK1', 'CAMM1', 1)

		db.prepare(`
			INSERT INTO Smols (Id, Title, Song_1, Song_2, Created_At, Public, Plays, Views, "Address", Mint_Token, Mint_Amm, Instrumental)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run('smol-empty-s2', 'Compat 1-Track', 's3', '', '2026-01-02 00:00:00', 1, 1, 2, 'GUSER2', null, null, 0)

		const migrationSql = readFileSync(
			new URL('../migrations/0001_smol_music_providers.sql', import.meta.url),
			'utf8'
		)
		db.exec('BEGIN TRANSACTION;')
		db.exec(migrationSql)
		db.exec('COMMIT;')

		// Verify all 12 original values preserved despite column order difference
		const minted = db.prepare(`SELECT * FROM Smols WHERE Id = 'smol-minted'`).get() as Record<string, unknown>
		assert.equal(minted.Title, 'Minted Song')
		assert.equal(minted.Song_1, 's1')
		assert.equal(minted.Song_2, 's2')
		assert.equal(minted.Plays, 42)
		assert.equal(minted.Views, 99)
		assert.equal(minted.Instrumental, 1)
		assert.equal(minted.Mint_Token, 'CTOK1')
		assert.equal(minted.Mint_Amm, 'CAMM1')
		assert.equal(minted.Requested_Provider, null, 'Historical rows must not be backfilled')
		assert.equal(minted.Actual_Provider, null)

		// Empty Song_2 normalized to SQL NULL
		const compatRow = db.prepare(`SELECT * FROM Smols WHERE Id = 'smol-empty-s2'`).get() as Record<string, unknown>
		assert.equal(compatRow.Song_2, null)

		// All 5 explicit indexes recreated
		const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'Smols' AND name NOT LIKE 'sqlite_autoindex%'`).all() as Array<{ name: string }>)
			.map((r) => r.name)
			.sort()
		assert.deepEqual(indexes, [
			'idx_smols_address_created',
			'idx_smols_artist_public_created',
			'idx_smols_public_created',
			'idx_smols_song_1',
			'idx_smols_song_2',
		])

		// 1-track ElevenLabs insert with Song_2 = NULL succeeds
		db.prepare(`
			INSERT INTO Smols (Id, Title, Song_1, Song_2, "Address", Public, Instrumental, Requested_Provider, Actual_Provider)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run('smol-el', 'ElevenLabs Hit', 'el-1', null, 'GUSER3', 1, 0, 'elevenlabs', 'elevenlabs')

		// Guarded swap predicate updates 0 rows on 1-track row
		const swapResult = db.prepare(`
			UPDATE Smols SET Song_1 = Song_2, Song_2 = Song_1
			WHERE Id = ? AND Song_2 = ? AND Song_2 IS NOT NULL AND Song_2 != '' AND "Address" = ?
		`).run('smol-el', '', 'GUSER3')
		assert.equal(swapResult.changes, 0)

		// Invalid provider rejected by CHECK constraint
		assert.throws(() => {
			db.prepare(`
				INSERT INTO Smols (Id, Title, Song_1, Song_2, "Address", Requested_Provider)
				VALUES ('bad', 'Bad', 's9', NULL, 'GUSER3', 'suno')
			`).run()
		}, /CHECK constraint failed/)
	} finally {
		db.close()
	}
})

test('Post-review P0/P1 regressions: published smol protected even with override & D1 error, retry carries attempt/fallback/pending without double charge, successor claim recovery, failed ref-check preserves MP3, publication replay preserves search, and NSFW hide allowed', async () => {
	const harness = createRetryCrudHarness()
	const token = await createAuthToken(OWNER, TEST_SECRET)
	const ctx = createMockExecutionContext()

	// --- 1. P0: Published unminted smol is protected EVEN WITH override_provider ---
	const pubId = 'a1'.repeat(32)
	harness.smolsTable.set(pubId, {
		Id: pubId,
		Title: 'Published Unminted',
		Song_1: 'pub-s1',
		Song_2: 'pub-s2',
		Address: OWNER,
		Public: 1,
		Mint_Token: null,
		Mint_Amm: null,
	})
	harness.playlistsTable.push({ Id: pubId, Title: 'top-hits' })
	harness.kv.set(pubId, JSON.stringify({
		payload: { address: OWNER, prompt: 'pub track', public: true },
		nsfw: { safe: false, categories: [], unknown: true }, // also used below for NSFW hide test
		songs: [{ music_id: 'pub-s1', status: 4, audio: 'https://api.smol.xyz/song/pub-s1.mp3' }],
	}))
	await harness.r2.bucket.put(`${pubId}.png`, new Uint8Array([7, 8, 9]))

	const retryOverridePublished = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${pubId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({ override_provider: 'elevenlabs' }),
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(retryOverridePublished.status, 409, 'Override retry on published smol must be rejected (409)')
	assert.equal(harness.createdWorkflows.length, 0)
	assert.equal(harness.smolsTable.has(pubId), true)
	assert.equal(harness.playlistsTable.length, 1)

	// D1 read error during retry publication check fails closed (503)
	const failingD1Env = {
		...harness.env,
		SMOL_D1: {
			prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 read timeout') } }) }),
		},
	} as unknown as Env
	const d1ErrRetry = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${pubId}`, { method: 'POST' }),
		failingD1Env,
		ctx.ctx
	)
	assert.equal(d1ErrRetry.status, 503, 'D1 read failure on retry must fail closed (503)')

	// --- 2. NSFW toggle: owner CAN hide (Public 1->0) unclassified legacy row, CANNOT re-publish (0->1) ---
	const hideEnv = createRetryCrudHarness()
	hideEnv.smolsTable.set(pubId, {
		Id: pubId,
		Title: 'Legacy Unclassified Public',
		Song_1: 'pub-s1',
		Song_2: null,
		Address: OWNER,
		Public: 1,
	})
	hideEnv.kv.set(pubId, JSON.stringify({
		payload: { address: OWNER, prompt: 'legacy' },
		nsfw: 'safe\nunsafe\nS12',
	}))
	// Add compare-and-set UPDATE Public support + 2-request barrier on initial SELECT Public
	// so two concurrent hide requests BOTH observe Public = 1 before either UPDATE executes!
	let barrierPending = 2
	let releaseBarrier: (() => void) | null = null
	const selectBarrier = new Promise<void>((resolve) => {
		releaseBarrier = resolve
	})
	let selectCount = 0
	const origPrepare = hideEnv.env.SMOL_D1.prepare.bind(hideEnv.env.SMOL_D1)
	;(hideEnv.env.SMOL_D1 as any).prepare = (sql: string) => {
		if (sql.includes('SELECT Public') && sql.includes('WHERE Id = ?1 AND "Address" = ?2')) {
			return {
				bind: (id: string, addr: string) => ({
					first: async () => {
						const row = hideEnv.smolsTable.get(id)
						const snapshot = row && row.Address === addr ? { Public: row.Public } : null
						selectCount += 1
						// Hold the first two initial SELECTs until both have read Public = 1 simultaneously
						if (id === pubId && selectCount <= 2) {
							barrierPending -= 1
							if (barrierPending <= 0) {
								releaseBarrier?.()
							}
							await selectBarrier
						}
						return snapshot
					},
				}),
			}
		}
		if (sql.includes('SET Public = ?1') && sql.includes('AND Public = ?4')) {
			return {
				bind: (targetPublic: number, id: string, addr: string, expectedPublic: number) => ({
					run: async () => {
						const row = hideEnv.smolsTable.get(id)
						if (row && row.Address === addr && (row.Public === 1 ? 1 : 0) === expectedPublic) {
							row.Public = targetPublic
							return { success: true, meta: { changes: 1 } }
						}
						return { success: true, meta: { changes: 0 } }
					},
				}),
			}
		}
		return origPrepare(sql)
	}

	// Concurrent hide requests on an unsafe Public=1 row MUST stay hidden (Public=0), never double-toggle back to 1!
	const [hideRes1, hideRes2] = await Promise.all([
		appModule.app.fetch(
			new Request(`https://api.smol.xyz/${pubId}`, {
				method: 'PUT',
				headers: { Authorization: `Bearer ${token}` },
			}),
			hideEnv.env,
			ctx.ctx
		),
		appModule.app.fetch(
			new Request(`https://api.smol.xyz/${pubId}`, {
				method: 'PUT',
				headers: { Authorization: `Bearer ${token}` },
			}),
			hideEnv.env,
			ctx.ctx
		),
	])
	await ctx.flush()
	assert.equal(hideRes1.status, 204, 'Owner must always be able to hide a currently public unclassified smol')
	assert.equal(hideRes2.status, 204, 'Concurrent hide must also succeed idempotently')
	assert.equal(hideEnv.smolsTable.get(pubId)?.Public, 0, 'Concurrent hides must NEVER republish unsafe content')

	const republishRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/${pubId}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${token}` },
		}),
		hideEnv.env,
		ctx.ctx
	)
	assert.equal(republishRes.status, 400, 'Re-publishing an unclassified/contradictory NSFW smol must be blocked')
	assert.equal(hideEnv.smolsTable.get(pubId)?.Public, 0)

	// Missing KV MUST still allow hiding (Public 1->0) while blocking re-publishing (0->1)
	const missingKvId = 'a2'.repeat(32)
	hideEnv.smolsTable.set(missingKvId, {
		Id: missingKvId,
		Title: 'Missing KV Public Row',
		Song_1: 'pub-s1',
		Song_2: null,
		Address: OWNER,
		Public: 1,
	})
	const hideMissingKv = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/${missingKvId}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${token}` },
		}),
		hideEnv.env,
		ctx.ctx
	)
	await ctx.flush()
	assert.equal(hideMissingKv.status, 204, 'Missing KV must still allow hiding a public row')
	assert.equal(hideEnv.smolsTable.get(missingKvId)?.Public, 0)
	const publishMissingKv = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/${missingKvId}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${token}` },
		}),
		hideEnv.env,
		ctx.ctx
	)
	assert.equal(publishMissingKv.status, 400, 'Publishing with missing KV must be blocked')
	assert.equal(hideEnv.smolsTable.get(missingKvId)?.Public, 0)

	// --- 3. P1: Retry successor recovery under same claimed ID + claim RPC error propagates (503) ---
	const recOldId = 'b2'.repeat(32)
	const recStorage = harness.doNs.getStorage(recOldId)
	recStorage.set('payload', { address: OWNER, prompt: 'recover me', public: true, provider: 'elevenlabs' })
	recStorage.set('provider_attempt', {
		provider: 'elevenlabs',
		status: 'ambiguous',
		source_smol_id: recOldId,
		updated_at: '2026-11-23T12:00:00.000Z',
	})

	// Simulate first attempt crashing on WORKFLOW.create AFTER claiming successorId
	let failNextCreate = true
	const createdIds = new Set<string>()
	;(harness.env as any).WORKFLOW = {
		create: async ({ id, params }: { id: string; params: WorkflowParams }) => {
			if (failNextCreate) {
				failNextCreate = false
				throw new Error('transient workflow create outage')
			}
			createdIds.add(id)
			harness.createdWorkflows.push({ id, params })
			return { status: async () => ({ status: 'running' }) }
		},
		get: async (id: string) => {
			if (!createdIds.has(id)) {
				// Exact Cloudflare workerd error string for a missing Workflow instance
				throw new Error('instance.not_found')
			}
			return { status: async () => ({ status: 'running' }) }
		},
	}

	const firstAttemptRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${recOldId}`, { method: 'POST' }),
		harness.env,
		ctx.ctx
	)
	assert.equal(firstAttemptRes.status, 500)
	const claimedId = recStorage.get('retry_successor_id') as string
	assert.ok(claimedId)

	// Second retry MUST recover under the EXACT same claimedId (not return ghost or duplicate!)
	const secondAttemptRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${recOldId}`, { method: 'POST' }),
		harness.env,
		ctx.ctx
	)
	assert.equal(secondAttemptRes.status, 200)
	const recoveredId = await secondAttemptRes.text()
	assert.equal(recoveredId, claimedId, 'Retry must recover under the same claimed successor ID')
	assert.equal(createdIds.has(claimedId), true, 'Recovered successor workflow must actually be created')

	// Verify predecessor's ambiguous ElevenLabs attempt was carried into successor DO!
	const carriedAttempt = harness.doNs.getStorage(recoveredId).get('provider_attempt') as ProviderAttemptState | undefined
	assert.equal(carriedAttempt?.provider, 'elevenlabs')
	assert.equal(carriedAttempt?.status, 'ambiguous')

	// --- 4. P1: Explicit ElevenLabs retry with carried ambiguous attempt refuses 2nd paid call! ---
	let elevenLabsPaidCalls = 0
	let aisgPaidSubmitCalls = 0
	const origFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('/elevenlabs/v1/music')) {
			elevenLabsPaidCalls += 1
			return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
		}
		if (url.includes('/purge_cache')) return new Response(JSON.stringify({ success: true }), { status: 200 })
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		recStorage.set('image_base64', Buffer.from('img').toString('base64'))
		recStorage.set('description', 'desc')
		recStorage.set('lyrics', { title: 'Amb EL', style: ['pop', 'synth'], lyrics: 'hello' })
		recStorage.set('nsfw', { safe: true, categories: [] })

		await assert.rejects(
			() => wf.run(
				{ payload: { retry_id: recOldId, provider: 'elevenlabs' }, instanceId: recoveredId, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/requires reconciliation before authorizing another charge/i
		)
		assert.equal(elevenLabsPaidCalls, 0, 'Ambiguous ElevenLabs retry MUST NOT issue a second paid call')

		// --- 5. P1: Prior AISG->ElevenLabs fallback retry resumes ElevenLabs (never restarts AISG!) ---
		const fbOldId = 'c3'.repeat(32)
		const fbNewId = 'c4'.repeat(32)
		await harness.r2.bucket.put(`el-${fbOldId}.mp3`, new Uint8Array([5, 6, 7, 8]))
		const fbStorage = harness.doNs.getStorage(fbOldId)
		fbStorage.set('payload', { address: OWNER, prompt: 'fallback resume', public: true, provider: 'aisonggenerator' })
		fbStorage.set('requested_provider', 'aisonggenerator')
		fbStorage.set('active_provider', 'elevenlabs')
		fbStorage.set('fallback_from', 'aisonggenerator')
		fbStorage.set('fallback_reason', 'provider_unavailable')
		fbStorage.set('image_base64', Buffer.from('img').toString('base64'))
		fbStorage.set('description', 'desc')
		fbStorage.set('lyrics', { title: 'Fallback Resume', style: ['pop', 'synth'], lyrics: 'hello' })
		fbStorage.set('nsfw', { safe: true, categories: [] })

		;(harness.env as any).AISONGGENERATOR = {
			fetch: async (url: string) => {
				if (url.endsWith('/api/tasks') || url.endsWith('/api/songs')) {
					aisgPaidSubmitCalls += 1
					throw new Error('Must NOT restart AISG when retrying prior ElevenLabs fallback')
				}
				if (url.includes('/api/songs?ids=pend-a%2Cpend-b')) {
					return new Response(JSON.stringify([
						{ music_id: 'pend-a', status: 2, audio: '', service: 'aisonggenerator' },
						{ music_id: 'pend-b', status: 2, audio: '', service: 'aisonggenerator' },
					]), { status: 200 })
				}
				throw new Error(`Unexpected AISG call: ${url}`)
			},
		}

		await wf.run(
			{ payload: { retry_id: fbOldId }, instanceId: fbNewId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)
		assert.equal(aisgPaidSubmitCalls, 0, 'Retry of prior fallback must NOT restart AISG')
		assert.equal(elevenLabsPaidCalls, 0, 'Retry of prior fallback with R2 artifact must reuse without re-charging')
		assert.equal(harness.smolsTable.get(fbNewId)?.Song_1, `el-${fbOldId}`)

		// --- 6. P1: Pending AISG IDs on retry resume polling instead of falling through to fresh paid submit ---
		const pendOldId = 'd4'.repeat(32)
		const pendNewId = 'd5'.repeat(32)
		const pendStorage = harness.doNs.getStorage(pendOldId)
		pendStorage.set('payload', { address: OWNER, prompt: 'still pending', public: true, provider: 'aisonggenerator' })
		pendStorage.set('image_base64', Buffer.from('img').toString('base64'))
		pendStorage.set('description', 'desc')
		pendStorage.set('lyrics', { title: 'Pending', style: ['pop', 'synth'], lyrics: 'hello' })
		pendStorage.set('nsfw', { safe: true, categories: [] })
		pendStorage.set('song_ids', ['pend-a', 'pend-b'])
		pendStorage.set('songs', [
			{ music_id: 'pend-a', status: 2, audio: '', service: 'aisonggenerator' },
			{ music_id: 'pend-b', status: 2, audio: '', service: 'aisonggenerator' },
		])

		await assert.rejects(
			() => wf.run(
				{ payload: { retry_id: pendOldId }, instanceId: pendNewId, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/still pending after the polling window/
		)
		assert.equal(aisgPaidSubmitCalls, 0, 'Pending AISG retry must resume polling, NEVER issue a second paid submit')
		assert.equal(elevenLabsPaidCalls, 0, 'Pending AISG retry exhaustion must NOT buy ElevenLabs')

		// --- 7. Publication replay: failure on finalize/cleanup does NOT rewrite KV or reset search.status='ready' ---
		const repOldId = 'e5'.repeat(32)
		const repNewId = 'e6'.repeat(32)
		await harness.r2.bucket.put(`el-${repOldId}.mp3`, new Uint8Array([1, 2, 3]))
		const repStorage = harness.doNs.getStorage(repOldId)
		repStorage.set('payload', { address: OWNER, prompt: 'replay check', public: true, provider: 'elevenlabs' })
		repStorage.set('image_base64', Buffer.from('img').toString('base64'))
		repStorage.set('description', 'desc')
		repStorage.set('lyrics', { title: 'Replay', style: ['pop', 'synth'], lyrics: 'hello' })
		repStorage.set('nsfw', { safe: true, categories: [] })
		repStorage.set('song_ids', [`el-${repOldId}`])
		repStorage.set('songs', [{ music_id: `el-${repOldId}`, status: 4, audio: `https://api.smol.xyz/song/el-${repOldId}.mp3`, service: 'elevenlabs' }])

		const repCache = new Map<string, unknown>()
		const failCleanupOnce = new Set(['finalize workflow'])
		await assert.rejects(
			() => wf.run(
				{ payload: { retry_id: repOldId }, instanceId: repNewId, timestamp: new Date() } as never,
				createWorkflowStep(repCache, { failOnceOn: failCleanupOnce }).step as never
			),
			/Injected transient failure/
		)
		// Simulate search worker having already progressed the published KV record to 'ready' before finalize replays
		const publishedKv = JSON.parse(harness.kv.get(repNewId)!)
		publishedKv.search = { status: 'ready', version: 'v2', indexed_at: '2026-11-23T12:10:00.000Z' }
		harness.kv.set(repNewId, JSON.stringify(publishedKv))

		await wf.run(
			{ payload: { retry_id: repOldId }, instanceId: repNewId, timestamp: new Date() } as never,
			createWorkflowStep(repCache).step as never
		)
		const kvAfterReplay = JSON.parse(harness.kv.get(repNewId)!)
		assert.equal(kvAfterReplay.search?.status, 'ready', 'Replay of finalize step must NOT overwrite detail KV or reset search status')

		// --- 8. P1: Failed reference lookup on DELETE preserves the R2 MP3 (fail-closed) ---
		const delId = 'f6'.repeat(32)
		const delHarness = createRetryCrudHarness()
		delHarness.smolsTable.set(delId, {
			Id: delId,
			Title: 'Shared Audio Track',
			Song_1: 'protected-shared-mp3',
			Song_2: null,
			Address: OWNER,
			Public: 1,
		})
		await delHarness.r2.bucket.put('protected-shared-mp3.mp3', new Uint8Array([9, 9, 9]))
		const basePrepare = delHarness.env.SMOL_D1.prepare.bind(delHarness.env.SMOL_D1)
		;(delHarness.env.SMOL_D1 as any).prepare = (sql: string) => {
			if (sql.includes('SELECT 1 FROM Smols WHERE Song_1 = ?1 OR Song_2 = ?1')) {
				return {
					bind: () => ({
						first: async () => { throw new Error('D1 transient lookup error') },
					}),
				}
			}
			return basePrepare(sql)
		}

		const delRes = await appModule.app.fetch(
			new Request(`https://api.smol.xyz/${delId}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` },
			}),
			delHarness.env,
			ctx.ctx
		)
		await ctx.flush()
		assert.equal(delRes.status, 204)
		assert.equal(delHarness.r2.store.has('protected-shared-mp3.mp3'), true, 'Failed D1 reference lookup MUST preserve R2 MP3')

		// --- 8b. P1: Failed reference lookup on DELETE /admin/bulk also preserves the R2 MP3 ---
		const bulkId = 'f7'.repeat(32)
		delHarness.smolsTable.set(bulkId, {
			Id: bulkId,
			Title: 'Bulk Protected Track',
			Song_1: 'bulk-shared-mp3',
			Song_2: null,
			Address: OWNER,
			Public: 0,
			Mint_Token: null,
		})
		await delHarness.r2.bucket.put('bulk-shared-mp3.mp3', new Uint8Array([3, 4, 5]))
		const testAdminSecret = 'bulk-admin-secret-distinct'
		;(delHarness.env as unknown as Record<string, unknown>).ADMIN_SECRET = testAdminSecret
		const bulkRes = await appModule.app.fetch(
			new Request('https://api.smol.xyz/admin/bulk', {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${testAdminSecret}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids: [bulkId] }),
			}),
			delHarness.env,
			ctx.ctx
		)
		await ctx.flush()
		assert.equal(bulkRes.status, 200)
		assert.equal(delHarness.r2.store.has('bulk-shared-mp3.mp3'), true, 'DELETE /admin/bulk must preserve R2 MP3 on lookup error')

		// --- 9. P1: Retry chain follows terminal successor's ambiguous attempt when caller re-retries OLD_ID ---
		const chainOldId = '7a'.repeat(32)
		const chainS1Id = '7b'.repeat(32)
		const chainHarness = createRetryCrudHarness()
		chainHarness.doNs.getStorage(chainOldId).set('payload', { address: OWNER, prompt: 'chain test', public: true, provider: 'elevenlabs' })
		chainHarness.doNs.getStorage(chainOldId).set('retry_successor_id', chainS1Id)
		chainHarness.doNs.getStorage(chainS1Id).set('payload', { address: OWNER, prompt: 'chain test', public: true, provider: 'elevenlabs' })
		chainHarness.doNs.getStorage(chainS1Id).set('provider_attempt', {
			provider: 'elevenlabs',
			status: 'ambiguous',
			source_smol_id: chainS1Id,
			updated_at: '2026-11-23T12:00:00.000Z',
		})
		;(chainHarness.env as any).WORKFLOW = {
			create: async ({ id, params }: { id: string; params: WorkflowParams }) => {
				chainHarness.createdWorkflows.push({ id, params })
				return { status: async () => ({ status: 'running' }) }
			},
			get: async () => ({ status: async () => ({ status: 'errored' }) }),
		}
		const chainRetryRes = await appModule.app.fetch(
			new Request(`https://api.smol.xyz/retry/${chainOldId}`, { method: 'POST' }),
			chainHarness.env,
			ctx.ctx
		)
		assert.equal(chainRetryRes.status, 200)
		const chainS2Id = await chainRetryRes.text()
		assert.equal(chainHarness.createdWorkflows[0].params.retry_id, chainS1Id, 'Retry chain must promote terminal successor as retry_id')
		const s2Attempt = chainHarness.doNs.getStorage(chainS2Id).get('provider_attempt') as ProviderAttemptState | undefined
		assert.equal(s2Attempt?.provider, 'elevenlabs')
		assert.equal(s2Attempt?.status, 'ambiguous')

		// --- 10. P1: claimRetrySuccessor RPC error propagates as 503 (never spawns duplicate!) ---
		const rpcErrId = '8c'.repeat(32)
		const rpcErrHarness = createRetryCrudHarness()
		rpcErrHarness.doNs.getStorage(rpcErrId).set('payload', { address: OWNER, prompt: 'rpc err', public: true })
		const origGetStub = rpcErrHarness.env.DURABLE_OBJECT.get.bind(rpcErrHarness.env.DURABLE_OBJECT)
		;(rpcErrHarness.env.DURABLE_OBJECT as any).get = (doid: DurableObjectId) => {
			const stub = origGetStub(doid) as any
			if (doid.toString() === rpcErrId) {
				return {
					...stub,
					claimRetrySuccessor: async () => { throw new Error('DO storage unavailable') },
				}
			}
			return stub
		}
		const rpcErrRes = await appModule.app.fetch(
			new Request(`https://api.smol.xyz/retry/${rpcErrId}`, { method: 'POST' }),
			rpcErrHarness.env,
			ctx.ctx
		)
		assert.equal(rpcErrRes.status, 503, 'Indeterminate claimRetrySuccessor error must return 503')
		assert.equal(rpcErrHarness.createdWorkflows.length, 0)

		// --- 11. P1: Transient getSongs 503 during quick-check throws instead of falling through to paid submit ---
		const qcOldId = '9d'.repeat(32)
		const qcNewId = '9e'.repeat(32)
		const qcHarness = createRetryCrudHarness()
		qcHarness.doNs.getStorage(qcOldId).set('payload', { address: OWNER, prompt: 'qc transient', public: true, provider: 'aisonggenerator' })
		qcHarness.doNs.getStorage(qcOldId).set('image_base64', Buffer.from('img').toString('base64'))
		qcHarness.doNs.getStorage(qcOldId).set('description', 'desc')
		qcHarness.doNs.getStorage(qcOldId).set('lyrics', { title: 'QC', style: ['pop', 'synth'], lyrics: 'hi' })
		qcHarness.doNs.getStorage(qcOldId).set('nsfw', { safe: true, categories: [] })
		qcHarness.doNs.getStorage(qcOldId).set('song_ids', ['qc-1', 'qc-2'])
		let qcPaidSubmits = 0
		;(qcHarness.env as any).AISONGGENERATOR = {
			fetch: async (url: string) => {
				if (url.endsWith('/api/tasks') || url.endsWith('/api/songs')) {
					qcPaidSubmits += 1
					throw new Error('Must NOT submit fresh paid job after transient quick-check error')
				}
				if (url.includes('/api/songs?ids=')) {
					return new Response('upstream 503', { status: 503 })
				}
				throw new Error(`Unexpected AISG call: ${url}`)
			},
		}
		const qcWf = new workflowModule.Workflow({} as ExecutionContext, qcHarness.env)
		await assert.rejects(
			() => qcWf.run(
				{ payload: { retry_id: qcOldId }, instanceId: qcNewId, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/503|failed/i
		)
		assert.equal(qcPaidSubmits, 0, 'Transient quick-check error must NEVER fall through to fresh paid submit')

		// --- 12. Publication enqueue failure throws (not swallowed) & succeeds cleanly on replay ---
		const enqOldId = '6a'.repeat(32)
		const enqNewId = '6b'.repeat(32)
		const enqHarness = createRetryCrudHarness()
		await enqHarness.r2.bucket.put(`el-${enqOldId}.mp3`, new Uint8Array([1, 2, 3]))
		enqHarness.doNs.getStorage(enqOldId).set('payload', { address: OWNER, prompt: 'enq test', public: true, provider: 'elevenlabs' })
		enqHarness.doNs.getStorage(enqOldId).set('image_base64', Buffer.from('img').toString('base64'))
		enqHarness.doNs.getStorage(enqOldId).set('description', 'desc')
		enqHarness.doNs.getStorage(enqOldId).set('lyrics', { title: 'Enq', style: ['pop', 'synth'], lyrics: 'hi' })
		enqHarness.doNs.getStorage(enqOldId).set('nsfw', { safe: true, categories: [] })
		enqHarness.doNs.getStorage(enqOldId).set('song_ids', [`el-${enqOldId}`])
		enqHarness.doNs.getStorage(enqOldId).set('songs', [{ music_id: `el-${enqOldId}`, status: 4, audio: `https://api.smol.xyz/song/el-${enqOldId}.mp3`, service: 'elevenlabs' }])
		let failQueueOnce = true
		const deliveredSearchMessages: unknown[] = []
		;(enqHarness.env as any).SEARCH_QUEUE = {
			send: async (msg: unknown) => {
				if (failQueueOnce) {
					failQueueOnce = false
					throw new Error('SEARCH_QUEUE transient outage')
				}
				deliveredSearchMessages.push(msg)
			},
		}
		const enqWf = new workflowModule.Workflow({} as ExecutionContext, enqHarness.env)
		const enqCache = new Map<string, unknown>()
		await assert.rejects(
			() => enqWf.run(
				{ payload: { retry_id: enqOldId }, instanceId: enqNewId, timestamp: new Date() } as never,
				createWorkflowStep(enqCache).step as never
			),
			/SEARCH_QUEUE transient outage/
		)
		assert.equal(deliveredSearchMessages.length, 0, 'Enqueue error must propagate rather than silently completing')
		await enqWf.run(
			{ payload: { retry_id: enqOldId }, instanceId: enqNewId, timestamp: new Date() } as never,
			createWorkflowStep(enqCache).step as never
		)
		assert.equal(deliveredSearchMessages.length, 1, 'Replay of enqueue search indexing step delivers the message')
	} finally {
		globalThis.fetch = origFetch
	}
})

test('Pass-2 P1 & gap regressions: active source cannot be forked or cleaned up, unreadable terminal successor fails closed (503), historical AISG singletons refused, and KV-lag search enqueue retries', async () => {
	const ctx = createMockExecutionContext()

	// --- 1. P1: First retry on a still-running source returns source ID without claiming or creating a successor ---
	const runHarness = createRetryCrudHarness()
	const runningSourceId = '5a'.repeat(32)
	runHarness.doNs.getStorage(runningSourceId).set('payload', {
		address: OWNER,
		prompt: 'still generating image',
		public: true,
		provider: 'aisonggenerator',
	})
	runHarness.workflowStatuses.set(runningSourceId, 'running')

	const retryActiveRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${runningSourceId}`, { method: 'POST' }),
		runHarness.env,
		ctx.ctx
	)
	assert.equal(retryActiveRes.status, 200)
	assert.equal(await retryActiveRes.text(), runningSourceId, 'Retry of running source must return existing source ID')
	assert.equal(runHarness.createdWorkflows.length, 0, 'Must NOT spawn a successor while source workflow is still running')
	assert.equal(runHarness.doNs.getStorage(runningSourceId).has('retry_successor_id'), false, 'Must NOT claim a successor while source is running')

	// Indeterminate source status read fails closed with 503
	const origWorkflowGet = runHarness.env.WORKFLOW.get
	;(runHarness.env.WORKFLOW as any).get = async () => {
		throw new Error('Workflows control plane timeout')
	}
	const retryIndeterminateRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${runningSourceId}`, { method: 'POST' }),
		runHarness.env,
		ctx.ctx
	)
	assert.equal(retryIndeterminateRes.status, 503, 'Indeterminate source status must fail closed with 503')
	assert.equal(runHarness.createdWorkflows.length, 0)
	;(runHarness.env.WORKFLOW as any).get = origWorkflowGet

	// Cleanup step in Workflow.run MUST NOT delete KV/image/DO of a still-running source
	const runSuccessorId = '5b'.repeat(32)
	runHarness.kv.set(runningSourceId, JSON.stringify({ payload: { address: OWNER, prompt: 'still running' } }))
	await runHarness.r2.bucket.put(`${runningSourceId}.png`, new Uint8Array([1, 2, 3]))
	await runHarness.r2.bucket.put(`el-${runningSourceId}.mp3`, new Uint8Array([4, 5, 6]))
	runHarness.doNs.getStorage(runningSourceId).set('image_base64', Buffer.from('img').toString('base64'))
	runHarness.doNs.getStorage(runningSourceId).set('description', 'desc')
	runHarness.doNs.getStorage(runningSourceId).set('lyrics', { title: 'Active Src', style: ['pop', 'synth'], lyrics: 'hi' })
	runHarness.doNs.getStorage(runningSourceId).set('nsfw', { safe: true, categories: [] })
	runHarness.doNs.getStorage(runningSourceId).set('song_ids', [`el-${runningSourceId}`])
	runHarness.doNs.getStorage(runningSourceId).set('songs', [{
		music_id: `el-${runningSourceId}`,
		status: 4,
		audio: `https://api.smol.xyz/song/el-${runningSourceId}.mp3`,
		service: 'elevenlabs',
	}])
	const runWf = new workflowModule.Workflow({} as ExecutionContext, runHarness.env)
	await runWf.run(
		{ payload: { retry_id: runningSourceId }, instanceId: runSuccessorId, timestamp: new Date() } as never,
		createWorkflowStep(new Map()).step as never
	)
	assert.equal(runHarness.kv.has(runningSourceId), true, 'Cleanup must NOT delete KV of a still-running source')
	assert.equal(runHarness.r2.store.has(`${runningSourceId}.png`), true, 'Cleanup must NOT delete PNG of a still-running source')
	assert.equal(runHarness.doNs.flushedIds.includes(runningSourceId), false, 'Cleanup must NOT flush DO of a still-running source')

	// --- 2. P1: Terminal successor with unreadable DO and no KV fails closed (503) instead of falling back to older ancestor ---
	const unavailHarness = createRetryCrudHarness()
	const ancestorId = '4a'.repeat(32)
	const unreadableSuccId = '4b'.repeat(32)
	unavailHarness.doNs.getStorage(ancestorId).set('payload', {
		address: OWNER,
		prompt: 'older ancestor without paid receipt',
		public: true,
		provider: 'elevenlabs',
	})
	unavailHarness.doNs.getStorage(ancestorId).set('retry_successor_id', unreadableSuccId)
	unavailHarness.workflowStatuses.set(ancestorId, 'errored')
	unavailHarness.workflowStatuses.set(unreadableSuccId, 'errored')
	const baseDoGet = unavailHarness.env.DURABLE_OBJECT.get.bind(unavailHarness.env.DURABLE_OBJECT)
	;(unavailHarness.env.DURABLE_OBJECT as any).get = (doid: DurableObjectId) => {
		const stub = baseDoGet(doid) as any
		if (doid.toString() === unreadableSuccId) {
			return {
				...stub,
				getSteps: async () => { throw new Error('DO read timeout') },
			}
		}
		return stub
	}

	const unreadableRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${ancestorId}`, { method: 'POST' }),
		unavailHarness.env,
		ctx.ctx
	)
	assert.equal(unreadableRes.status, 503, 'Unreadable terminal successor DO must return 503 instead of falling back to older ancestor')
	assert.equal(unavailHarness.createdWorkflows.length, 0)
	assert.equal(
		unavailHarness.doNs.getStorage(ancestorId).get('retry_successor_id'),
		unreadableSuccId,
		'Terminal successor claim must NOT be replaced when successor state cannot be read'
	)

	// --- 3. Other gap: Historical AISG 1-track retries (completed snapshot AND 1-ID quick-check) are refused ---
	const singHarness = createRetryCrudHarness()
	let aisgPaidSubmits = 0
	;(singHarness.env as any).AISONGGENERATOR = {
		fetch: async () => {
			aisgPaidSubmits += 1
			throw new Error('Must NOT call AISG for 1-track AISG singleton retry')
		},
	}
	const singWf = new workflowModule.Workflow({} as ExecutionContext, singHarness.env)

	// 3a. Completed AISG singleton snapshot
	const compSingOld = '3a'.repeat(32)
	const compSingNew = '3b'.repeat(32)
	singHarness.kv.set(compSingOld, JSON.stringify({
		payload: { address: OWNER, prompt: 'singleton completed', public: true, provider: 'aisonggenerator' },
		image_base64: Buffer.from('img').toString('base64'),
		description: 'desc',
		lyrics: { title: 'Sing1', style: ['pop', 'rock'], lyrics: 'la' },
		nsfw: { safe: true, categories: [] },
		song_ids: ['aisg-only-1'],
		songs: [{ music_id: 'aisg-only-1', status: 4, audio: 'https://cdn.aisg.test/only1.mp3', service: 'aisonggenerator' }],
	}))
	await assert.rejects(
		() => singWf.run(
			{ payload: { retry_id: compSingOld }, instanceId: compSingNew, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		),
		/Incomplete AISG retry state|refusing singleton/i
	)
	assert.equal(singHarness.smolsTable.has(compSingNew), false)

	// 3b. Legacy 1-ID AISG quick-check snapshot (song_ids only)
	const idSingOld = '3c'.repeat(32)
	const idSingNew = '3d'.repeat(32)
	singHarness.kv.set(idSingOld, JSON.stringify({
		payload: { address: OWNER, prompt: 'singleton id only', public: true, provider: 'aisonggenerator' },
		image_base64: Buffer.from('img').toString('base64'),
		description: 'desc',
		lyrics: { title: 'Sing2', style: ['pop', 'rock'], lyrics: 'la' },
		nsfw: { safe: true, categories: [] },
		song_ids: ['aisg-only-2'],
	}))
	await assert.rejects(
		() => singWf.run(
			{ payload: { retry_id: idSingOld }, instanceId: idSingNew, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		),
		/Incomplete AISG retry state|refusing singleton/i
	)
	assert.equal(singHarness.smolsTable.has(idSingNew), false)
	assert.equal(aisgPaidSubmits, 0)

	// --- 4. Other gap: Enqueue search indexing retries when KV is temporarily invisible (returns false) ---
	const lagHarness = createRetryCrudHarness()
	const lagOldId = '2a'.repeat(32)
	const lagNewId = '2b'.repeat(32)
	await lagHarness.r2.bucket.put(`el-${lagOldId}.mp3`, new Uint8Array([1, 2, 3]))
	lagHarness.doNs.getStorage(lagOldId).set('payload', { address: OWNER, prompt: 'kv lag', public: true, provider: 'elevenlabs' })
	lagHarness.doNs.getStorage(lagOldId).set('image_base64', Buffer.from('img').toString('base64'))
	lagHarness.doNs.getStorage(lagOldId).set('description', 'desc')
	lagHarness.doNs.getStorage(lagOldId).set('lyrics', { title: 'KV Lag', style: ['pop', 'synth'], lyrics: 'hi' })
	lagHarness.doNs.getStorage(lagOldId).set('nsfw', { safe: true, categories: [] })
	lagHarness.doNs.getStorage(lagOldId).set('song_ids', [`el-${lagOldId}`])
	lagHarness.doNs.getStorage(lagOldId).set('songs', [{
		music_id: `el-${lagOldId}`,
		status: 4,
		audio: `https://api.smol.xyz/song/el-${lagOldId}.mp3`,
		service: 'elevenlabs',
	}])

	let hideNewKvOnceOnEnqueue = false
	const origKvGet = lagHarness.env.SMOL_KV.get
	const origKvPut = lagHarness.env.SMOL_KV.put
	;(lagHarness.env.SMOL_KV as any).put = async (key: string, val: string) => {
		await origKvPut(key, val)
		if (key === lagNewId) {
			hideNewKvOnceOnEnqueue = true
		}
	}
	;(lagHarness.env.SMOL_KV as any).get = async (key: string, type?: string) => {
		if (key === lagNewId && hideNewKvOnceOnEnqueue) {
			hideNewKvOnceOnEnqueue = false
			return null
		}
		return origKvGet(key, type as any)
	}

	const lagCache = new Map<string, unknown>()
	const lagWf = new workflowModule.Workflow({} as ExecutionContext, lagHarness.env)
	await assert.rejects(
		() => lagWf.run(
			{ payload: { retry_id: lagOldId }, instanceId: lagNewId, timestamp: new Date() } as never,
			createWorkflowStep(lagCache).step as never
		),
		/KV record not yet visible/i
	)
	assert.equal(lagHarness.queueMessages.length, 0, 'Must throw and retry instead of checkpointing without sending')

	// Replay once KV is visible delivers the search message!
	await lagWf.run(
		{ payload: { retry_id: lagOldId }, instanceId: lagNewId, timestamp: new Date() } as never,
		createWorkflowStep(lagCache).step as never
	)
	assert.equal(lagHarness.queueMessages.length, 1, 'Replay after KV visibility must send search indexing message')
})

test('Pass-3 P1 regressions: multi-generation retries (A -> B -> C) converge on ONE successor from any ancestor/descendant ID, and interrupted replacement recovery restores B ambiguous ElevenLabs claim with 0 provider calls', async () => {
	const ctx = createMockExecutionContext()

	// --- Case 1A: Normal multi-generation chain A -> B -> C -> D converges from ANY ID in chain ---
	const chain1 = createRetryCrudHarness()
	const idA = '1a'.repeat(32)
	chain1.doNs.getStorage(idA).set('payload', { address: OWNER, prompt: 'multi gen A', public: true, provider: 'aisonggenerator' })
	chain1.workflowStatuses.set(idA, 'errored')

	// Step 1: Retry failed A -> creates B
	const resB = await appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${idA}`, { method: 'POST' }), chain1.env, ctx.ctx)
	assert.equal(resB.status, 200)
	const idB = await resB.text()
	assert.equal(chain1.createdWorkflows.length, 1)
	assert.equal(chain1.doNs.getStorage(idB).get('retry_chain_root_id'), idA)

	// Step 2: B fails -> Retry failed B -> creates C (running)
	chain1.workflowStatuses.set(idB, 'errored')
	const resCFromB = await appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${idB}`, { method: 'POST' }), chain1.env, ctx.ctx)
	assert.equal(resCFromB.status, 200)
	const idC = await resCFromB.text()
	assert.notEqual(idC, idB)
	assert.equal(chain1.createdWorkflows.length, 2)
	assert.equal(chain1.createdWorkflows[1].params.retry_id, idB)

	// Step 3: Now retry failed parent A while C is running -> MUST converge on C (ZERO duplicate workflow D!)
	const resCFromA = await appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${idA}`, { method: 'POST' }), chain1.env, ctx.ctx)
	assert.equal(resCFromA.status, 200)
	assert.equal(await resCFromA.text(), idC, 'Retrying failed parent A must converge on B running successor C')
	assert.equal(chain1.createdWorkflows.length, 2, 'Must NOT spawn a second running successor D when retrying parent A')

	// Step 4: C fails -> retry A creates D -> retrying B and C both converge on D
	chain1.workflowStatuses.set(idC, 'errored')
	const resDFromA = await appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${idA}`, { method: 'POST' }), chain1.env, ctx.ctx)
	assert.equal(resDFromA.status, 200)
	const idD = await resDFromA.text()
	assert.equal(chain1.createdWorkflows.length, 3)
	assert.equal(chain1.createdWorkflows[2].params.retry_id, idC)
	const resDFromB = await appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${idB}`, { method: 'POST' }), chain1.env, ctx.ctx)
	const resDFromC = await appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${idC}`, { method: 'POST' }), chain1.env, ctx.ctx)
	assert.equal(await resDFromB.text(), idD)
	assert.equal(await resDFromC.text(), idD)
	assert.equal(chain1.createdWorkflows.length, 3)

	// --- Case 1B: Pre-existing/staged chain A -> B WITHOUT retry_chain_root_id on B ---
	// Retrying B creates C; retrying A MUST follow A -> B -> C and return C (NO duplicate D!)
	const legacyChain = createRetryCrudHarness()
	const legA = '1b'.repeat(32)
	const legB = '1c'.repeat(32)
	legacyChain.doNs.getStorage(legA).set('payload', { address: OWNER, prompt: 'staged A', public: true, provider: 'aisonggenerator' })
	legacyChain.doNs.getStorage(legA).set('retry_successor_id', legB)
	legacyChain.doNs.getStorage(legB).set('payload', { address: OWNER, prompt: 'staged A', public: true, provider: 'aisonggenerator' })
	legacyChain.workflowStatuses.set(legA, 'errored')
	legacyChain.workflowStatuses.set(legB, 'errored')

	const legResB = await appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${legB}`, { method: 'POST' }), legacyChain.env, ctx.ctx)
	assert.equal(legResB.status, 200)
	const legC = await legResB.text()
	assert.equal(legacyChain.createdWorkflows.length, 1)

	const legResA = await appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${legA}`, { method: 'POST' }), legacyChain.env, ctx.ctx)
	assert.equal(legResA.status, 200)
	assert.equal(await legResA.text(), legC, 'Retrying parent A on a legacy chain without retry_chain_root_id must follow B -> C')
	assert.equal(legacyChain.createdWorkflows.length, 1, 'Must NOT spawn duplicate D on legacy chain')

	// Reverse staged order: retrying A first creates C; retrying B next MUST converge on C (NO duplicate D!)
	const revChain = createRetryCrudHarness()
	const revA = '1d'.repeat(32)
	const revB = '1e'.repeat(32)
	revChain.doNs.getStorage(revA).set('payload', { address: OWNER, prompt: 'rev staged', public: true, provider: 'aisonggenerator' })
	revChain.doNs.getStorage(revA).set('retry_successor_id', revB)
	revChain.doNs.getStorage(revB).set('payload', { address: OWNER, prompt: 'rev staged', public: true, provider: 'aisonggenerator' })
	revChain.workflowStatuses.set(revA, 'errored')
	revChain.workflowStatuses.set(revB, 'errored')

	const revResA = await appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${revA}`, { method: 'POST' }), revChain.env, ctx.ctx)
	assert.equal(revResA.status, 200)
	const revC = await revResA.text()
	const revResB = await appModule.app.fetch(new Request(`https://api.smol.xyz/retry/${revB}`, { method: 'POST' }), revChain.env, ctx.ctx)
	assert.equal(revResB.status, 200)
	assert.equal(await revResB.text(), revC, 'Retrying B after A replaced B -> C must converge on C')
	assert.equal(revChain.createdWorkflows.length, 1)

	// --- Case 2: Interrupted replacement crash recovery preserves B's ambiguous ElevenLabs claim with ZERO provider calls! ---
	const crashHarness = createRetryCrudHarness()
	const crashA = '2c'.repeat(32)
	const crashB = '2d'.repeat(32)
	crashHarness.doNs.getStorage(crashA).set('payload', { address: OWNER, prompt: 'crash replace', public: true, provider: 'elevenlabs' })
	crashHarness.doNs.getStorage(crashA).set('retry_reservation', { successorId: crashB, predecessorId: crashA })
	crashHarness.doNs.getStorage(crashA).set('retry_successor_id', crashB)
	crashHarness.doNs.getStorage(crashB).set('payload', { address: OWNER, prompt: 'crash replace', public: true, provider: 'elevenlabs' })
	crashHarness.doNs.getStorage(crashB).set('retry_chain_root_id', crashA)
	crashHarness.doNs.getStorage(crashB).set('image_base64', Buffer.from('img').toString('base64'))
	crashHarness.doNs.getStorage(crashB).set('description', 'desc')
	crashHarness.doNs.getStorage(crashB).set('lyrics', { title: 'Crash Amb', style: ['pop', 'synth'], lyrics: 'la la' })
	crashHarness.doNs.getStorage(crashB).set('nsfw', { safe: true, categories: [] })
	crashHarness.doNs.getStorage(crashB).set('provider_attempt', {
		provider: 'elevenlabs',
		status: 'ambiguous',
		source_smol_id: crashB,
		error_code: 'submit_outcome_unknown',
		updated_at: '2026-11-23T12:00:00.000Z',
	})
	crashHarness.workflowStatuses.set(crashA, 'errored')
	crashHarness.workflowStatuses.set(crashB, 'errored')

	// Inject crash IMMEDIATELY after A's replacement pointer changes B -> C, BEFORE C is seeded or created!
	let crashNextSeed = true
	const origCrashDoGet = crashHarness.env.DURABLE_OBJECT.get.bind(crashHarness.env.DURABLE_OBJECT)
	;(crashHarness.env.DURABLE_OBJECT as any).get = (doid: DurableObjectId) => {
		const stub = origCrashDoGet(doid) as any
		const sid = doid.toString()
		if (sid !== crashA && sid !== crashB && crashNextSeed) {
			return {
				...stub,
				seedRetrySuccessorIfEmpty: async () => {
					crashNextSeed = false
					throw new Error('Worker killed immediately after replaceRetrySuccessor before seeding C')
				},
			}
		}
		return stub
	}

	const interruptedRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${crashA}`, { method: 'POST' }),
		crashHarness.env,
		ctx.ctx
	)
	assert.equal(interruptedRes.status, 500)
	const reserved = crashHarness.doNs.getStorage(crashA).get('retry_reservation') as RetryReservation | undefined
	assert.ok(reserved?.successorId && reserved.successorId !== crashB)
	assert.equal(reserved?.predecessorId, crashB, 'Replacement reservation MUST persist authoritative predecessor B')
	const reservedC = reserved!.successorId
	assert.equal(crashHarness.doNs.getStorage(reservedC).size, 0, 'C DO is unseeded right after crash')
	assert.equal(crashHarness.createdWorkflows.length, 0, 'C workflow was not created before crash')

	// Now recover by retrying A: MUST recover exact reserved ID C AND seed C with B's ambiguous ElevenLabs claim!
	const recoveredRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${crashA}`, { method: 'POST' }),
		crashHarness.env,
		ctx.ctx
	)
	assert.equal(recoveredRes.status, 200)
	assert.equal(await recoveredRes.text(), reservedC, 'Recovery must reuse exact reserved ID C')
	assert.equal(crashHarness.createdWorkflows.length, 1)
	assert.equal(crashHarness.createdWorkflows[0].id, reservedC)
	assert.equal(crashHarness.createdWorkflows[0].params.retry_id, crashB, 'Recovered workflow C must use authoritative predecessor retry_id=B (NOT A!)')

	const recoveredAttempt = crashHarness.doNs.getStorage(reservedC).get('provider_attempt') as ProviderAttemptState | undefined
	assert.equal(recoveredAttempt?.provider, 'elevenlabs', 'Recovered C DO must carry B ElevenLabs claim')
	assert.equal(recoveredAttempt?.status, 'ambiguous', 'Recovered C DO must carry B ambiguous status')
	assert.equal(recoveredAttempt?.source_smol_id, crashB)

	// Executing recovered workflow C MUST refuse any new provider call while B's ambiguous claim remains!
	let providerCalls = 0
	const origFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		providerCalls += 1
		throw new Error(`Unexpected provider call during ambiguous claim recovery: ${String(input)}`)
	}) as typeof fetch
	try {
		const wf = new workflowModule.Workflow({} as ExecutionContext, crashHarness.env)
		await assert.rejects(
			() => wf.run(
				{ payload: crashHarness.createdWorkflows[0].params, instanceId: reservedC, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/requires reconciliation before authorizing another charge/i
		)
		assert.equal(providerCalls, 0, 'ZERO provider calls allowed while B ambiguous claim remains')
	} finally {
		globalThis.fetch = origFetch
	}
})

test('Pass-4 P1 regression: expired Workflow instance (instance.not_found) NEVER overwrites successor DO ambiguous ElevenLabs claim with predecessor failed claim, and blocks second paid submission', async () => {
	const ctx = createMockExecutionContext()

	// --- Case A: Full expired successor DO B (has payload + its own ambiguous ElevenLabs claim, NO remaining Workflow instance) ---
	const expHarness = createRetryCrudHarness()
	const idA = '7e'.repeat(32)
	const idB = '7f'.repeat(32)

	// Predecessor A failed with confirmed pre-charge 'failed' ElevenLabs attempt and reserved B
	expHarness.doNs.getStorage(idA).set('payload', { address: OWNER, prompt: 'expired wf test', public: true, provider: 'elevenlabs' })
	expHarness.doNs.getStorage(idA).set('provider_attempt', {
		provider: 'elevenlabs',
		status: 'failed',
		source_smol_id: idA,
		error_code: 'provider_unavailable',
		updated_at: '2026-11-23T11:00:00.000Z',
	})
	expHarness.doNs.getStorage(idA).set('retry_reservation', { successorId: idB, predecessorId: idA })
	expHarness.doNs.getStorage(idA).set('retry_successor_id', idB)
	expHarness.workflowStatuses.set(idA, 'errored')

	// Successor B actually ran, got an ambiguous ElevenLabs attempt (no R2 receipt), and its Workflow record EXPIRED
	// (intentionally omitted from expHarness.workflowStatuses so WORKFLOW.get(idB) throws 'instance.not_found'!)
	expHarness.doNs.getStorage(idB).set('payload', { address: OWNER, prompt: 'expired wf test', public: true, provider: 'elevenlabs' })
	expHarness.doNs.getStorage(idB).set('retry_chain_root_id', idA)
	expHarness.doNs.getStorage(idB).set('retry_source_id', idA)
	expHarness.doNs.getStorage(idB).set('image_base64', Buffer.from('img').toString('base64'))
	expHarness.doNs.getStorage(idB).set('description', 'desc')
	expHarness.doNs.getStorage(idB).set('lyrics', { title: 'Expired Amb', style: ['pop', 'synth'], lyrics: 'la la' })
	expHarness.doNs.getStorage(idB).set('nsfw', { safe: true, categories: [] })
	expHarness.doNs.getStorage(idB).set('provider_attempt', {
		provider: 'elevenlabs',
		status: 'ambiguous',
		source_smol_id: idB,
		error_code: 'submit_outcome_unknown',
		updated_at: '2026-11-23T12:00:00.000Z',
	})

	// Before retry: B's DO refuses a second ElevenLabs paid claim
	const bStub = expHarness.env.DURABLE_OBJECT.get(expHarness.env.DURABLE_OBJECT.idFromString(idB)) as any
	const preClaimB = await bStub.claimPaidAttempt('elevenlabs', { source_smol_id: idB })
	assert.equal(preClaimB.claimed, false, 'Pre-check: B DO must refuse paid claim while ambiguous')

	// Retry A through the HTTP handler
	const retryRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${idA}`, { method: 'POST' }),
		expHarness.env,
		ctx.ctx
	)
	assert.equal(retryRes.status, 200)
	const idC = await retryRes.text()
	assert.notEqual(idC, idB, 'Expired executed successor B must NOT be overwritten/reused under A failed claim')

	// CRITICAL: B's DO MUST retain its ambiguous ElevenLabs claim and STILL refuse paid claims!
	const bAttemptAfter = expHarness.doNs.getStorage(idB).get('provider_attempt') as ProviderAttemptState | undefined
	assert.equal(bAttemptAfter?.status, 'ambiguous', 'B DO ambiguous claim must survive untouched')
	assert.equal(bAttemptAfter?.source_smol_id, idB)
	const postClaimB = await bStub.claimPaidAttempt('elevenlabs', { source_smol_id: idB })
	assert.equal(postClaimB.claimed, false, 'B DO must STILL refuse a fresh paid claim after retry of A')

	// New successor C MUST carry B's ambiguous ElevenLabs claim (NOT A's failed claim!) and refuse paid claims!
	const cStub = expHarness.env.DURABLE_OBJECT.get(expHarness.env.DURABLE_OBJECT.idFromString(idC)) as any
	const cAttempt = expHarness.doNs.getStorage(idC).get('provider_attempt') as ProviderAttemptState | undefined
	assert.equal(cAttempt?.provider, 'elevenlabs')
	assert.equal(cAttempt?.status, 'ambiguous', 'C DO must carry B ambiguous claim, NOT A failed claim')
	assert.equal(cAttempt?.source_smol_id, idB)
	const claimC = await cStub.claimPaidAttempt('elevenlabs', { source_smol_id: idC })
	assert.equal(claimC.claimed, false, 'C DO must ALSO refuse a second ElevenLabs paid claim')
	assert.equal(expHarness.createdWorkflows[0].params.retry_id, idB, 'C workflow must reconcile from B, not A')

	// Running workflow C must make ZERO outbound provider calls!
	let outboundCalls = 0
	const origFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		outboundCalls += 1
		throw new Error(`Unexpected provider call: ${String(input)}`)
	}) as typeof fetch
	try {
		const wf = new workflowModule.Workflow({} as ExecutionContext, expHarness.env)
		await assert.rejects(
			() => wf.run(
				{ payload: expHarness.createdWorkflows[0].params, instanceId: idC, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/requires reconciliation before authorizing another charge/i
		)
		assert.equal(outboundCalls, 0, 'ZERO outbound provider calls allowed after Workflow expiry')
	} finally {
		globalThis.fetch = origFetch
	}

	// --- Case B: Expired successor DO with ONLY ambiguous provider_attempt (no payload) fails closed with 503 ---
	const minHarness = createRetryCrudHarness()
	const minA = '8e'.repeat(32)
	const minB = '8f'.repeat(32)
	minHarness.doNs.getStorage(minA).set('payload', { address: OWNER, prompt: 'minimal expired', public: true, provider: 'elevenlabs' })
	minHarness.doNs.getStorage(minA).set('provider_attempt', {
		provider: 'elevenlabs',
		status: 'failed',
		source_smol_id: minA,
		updated_at: '2026-11-23T11:00:00.000Z',
	})
	minHarness.doNs.getStorage(minA).set('retry_reservation', { successorId: minB, predecessorId: minA })
	minHarness.doNs.getStorage(minA).set('retry_successor_id', minB)
	minHarness.workflowStatuses.set(minA, 'errored')
	// minB has ONLY its ambiguous attempt and no remaining Workflow instance
	minHarness.doNs.getStorage(minB).set('provider_attempt', {
		provider: 'elevenlabs',
		status: 'ambiguous',
		source_smol_id: minB,
		updated_at: '2026-11-23T12:00:00.000Z',
	})

	const minRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${minA}`, { method: 'POST' }),
		minHarness.env,
		ctx.ctx
	)
	assert.equal(minRes.status, 503, 'Expired successor DO with payment claim but no payload must fail closed (503)')
	assert.equal(minHarness.createdWorkflows.length, 0)
	const minBStub = minHarness.env.DURABLE_OBJECT.get(minHarness.env.DURABLE_OBJECT.idFromString(minB)) as any
	assert.equal((await minBStub.claimPaidAttempt('elevenlabs')).claimed, false, 'minB ambiguous claim must remain intact and block claims')

	// --- Case C: Seeded-but-unstarted crash recovery (crash AFTER seedRetrySuccessorIfEmpty, BEFORE WORKFLOW.create) ---
	const seedCrashHarness = createRetryCrudHarness()
	const scA = '9e'.repeat(32)
	seedCrashHarness.doNs.getStorage(scA).set('payload', { address: OWNER, prompt: 'seed crash', public: true, provider: 'elevenlabs' })
	seedCrashHarness.workflowStatuses.set(scA, 'errored')
	let failFirstCreate = true
	const origCreate = seedCrashHarness.env.WORKFLOW.create
	;(seedCrashHarness.env.WORKFLOW as any).create = async (opts: { id: string; params: WorkflowParams }) => {
		if (failFirstCreate) {
			failFirstCreate = false
			throw new Error('transient create failure after seeding')
		}
		return origCreate(opts)
	}
	const scRes1 = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${scA}`, { method: 'POST' }),
		seedCrashHarness.env,
		ctx.ctx
	)
	assert.equal(scRes1.status, 500)
	const reservedScB = (seedCrashHarness.doNs.getStorage(scA).get('retry_reservation') as RetryReservation).successorId
	assert.equal(seedCrashHarness.doNs.getStorage(reservedScB).get('retry_seed_pending'), true)

	const scRes2 = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/retry/${scA}`, { method: 'POST' }),
		seedCrashHarness.env,
		ctx.ctx
	)
	assert.equal(scRes2.status, 200)
	assert.equal(await scRes2.text(), reservedScB, 'Seeded-unstarted reservation must recover under exact reserved ID')
	assert.equal(seedCrashHarness.createdWorkflows.length, 1)
	assert.equal(seedCrashHarness.createdWorkflows[0].id, reservedScB)
})


test('PUT /:id blocks hiding minted songs (Mint_Token, Mint_Amm, and concurrent mint race) while still allowing legacy private minted songs to publish', async () => {
	const harness = createRetryCrudHarness()
	const ctx = createMockExecutionContext()
	const token = await createAuthToken(OWNER, TEST_SECRET)
	const mintedTokenId = 'b1'.repeat(32)
	const mintedAmmId = 'b2'.repeat(32)
	const raceId = 'b3'.repeat(32)
	const legacyPrivateMintedId = 'b4'.repeat(32)

	const extraMintFields = new Map<string, { Mint_Token?: string | null; Mint_Amm?: string | null }>([
		[mintedTokenId, { Mint_Token: 'CMINTTOKEN000000000000000000000000000000000000000000000001', Mint_Amm: null }],
		[mintedAmmId, { Mint_Token: null, Mint_Amm: 'CMINTAMM00000000000000000000000000000000000000000000000001' }],
		[raceId, { Mint_Token: null, Mint_Amm: null }],
		[legacyPrivateMintedId, { Mint_Token: 'CMINTTOKEN000000000000000000000000000000000000000000000002', Mint_Amm: null }],
	])

	for (const [id, pub] of [
		[mintedTokenId, 1],
		[mintedAmmId, 1],
		[raceId, 1],
		[legacyPrivateMintedId, 0],
	] as const) {
		harness.smolsTable.set(id, {
			Id: id,
			Title: `Song ${id.slice(0, 4)}`,
			Song_1: 's1',
			Song_2: null,
			Address: OWNER,
			Public: pub,
		})
	}
	harness.kv.set(legacyPrivateMintedId, JSON.stringify({
		payload: { address: OWNER, prompt: 'legacy minted' },
		nsfw: { safe: true, categories: [] },
	}))

	let simulateConcurrentMint = false
	const origPrepare = harness.env.SMOL_D1.prepare.bind(harness.env.SMOL_D1)
	;(harness.env.SMOL_D1 as any).prepare = (sql: string) => {
		if (sql.includes('SELECT Public') && sql.includes('WHERE Id = ?1 AND "Address" = ?2')) {
			return {
				bind: (id: string, addr: string) => ({
					first: async () => {
						const row = harness.smolsTable.get(id)
						if (!row || row.Address !== addr) return null
						const mint = extraMintFields.get(id) ?? {}
						return { Public: row.Public, Mint_Token: mint.Mint_Token ?? null, Mint_Amm: mint.Mint_Amm ?? null }
					},
				}),
			}
		}
		if (sql.includes('SET Public = ?1') && sql.includes('AND Public = ?4')) {
			return {
				bind: (targetPublic: number, id: string, addr: string, expectedPublic: number) => ({
					run: async () => {
						if (simulateConcurrentMint && id === raceId) {
							extraMintFields.set(raceId, {
								Mint_Token: 'CMINTTOKENRACE00000000000000000000000000000000000000000001',
								Mint_Amm: null,
							})
							simulateConcurrentMint = false
						}
						const row = harness.smolsTable.get(id)
						const mint = extraMintFields.get(id) ?? {}
						const minted = Boolean(mint.Mint_Token?.trim() || mint.Mint_Amm?.trim())
						const requireUnminted = sql.includes('Mint_Token IS NULL')
						if (
							row &&
							row.Address === addr &&
							(row.Public === 1 ? 1 : 0) === expectedPublic &&
							(!requireUnminted || !minted)
						) {
							row.Public = targetPublic
							return { success: true, meta: { changes: 1 } }
						}
						return { success: true, meta: { changes: 0 } }
					},
				}),
			}
		}
		return origPrepare(sql)
	}

	// 1. Mint_Token set -> 409 and stays Public = 1
	const resToken = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/${mintedTokenId}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${token}` },
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(resToken.status, 409)
	assert.equal(harness.smolsTable.get(mintedTokenId)?.Public, 1)

	// 2. Mint_Amm set -> 409 and stays Public = 1
	const resAmm = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/${mintedAmmId}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${token}` },
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(resAmm.status, 409)
	assert.equal(harness.smolsTable.get(mintedAmmId)?.Public, 1)

	// 3. Concurrent mint races between SELECT and UPDATE -> CAS blocks hide and returns 409
	simulateConcurrentMint = true
	const resRace = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/${raceId}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${token}` },
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(resRace.status, 409)
	assert.equal(harness.smolsTable.get(raceId)?.Public, 1)

	// 4. Legacy private minted song can still be published (0 -> 1), then cannot be hidden again (1 -> 0)
	const resPublish = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/${legacyPrivateMintedId}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${token}` },
		}),
		harness.env,
		ctx.ctx
	)
	await ctx.flush()
	assert.equal(resPublish.status, 204)
	assert.equal(harness.smolsTable.get(legacyPrivateMintedId)?.Public, 1)

	const resRehide = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/${legacyPrivateMintedId}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${token}` },
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(resRehide.status, 409)
	assert.equal(harness.smolsTable.get(legacyPrivateMintedId)?.Public, 1)
})

test('A1: carried ambiguous AISG attempt reconciles by replaying POST /api/tasks with the stored Idempotency-Key (never GET /api/attempts)', async () => {
	const harness = createRetryCrudHarness()
	const makeAudio = (seed: number) => Uint8Array.from({ length: 40_000 }, (_, i) => (seed + i * 17) & 0xff)
	const audio1 = makeAudio(11)
	const audio2 = makeAudio(77)
	const attemptId = `smol-${'a1'.repeat(32)}-aisg`
	const replays: Array<{ key: string | null; body: Record<string, unknown> }> = []
	const otherCalls: string[] = []
	let replayResponder: () => Response = () => Response.json({ task_id: 'task-a1', workspace_id: 'ws-a1' })

	;(harness.env as any).AISONGGENERATOR = {
		fetch: async (url: string, init?: RequestInit) => {
			if (url.endsWith('/api/tasks') && init?.method === 'POST') {
				replays.push({
					key: new Headers(init.headers).get('Idempotency-Key'),
					body: JSON.parse(String(init.body)),
				})
				return replayResponder()
			}
			if (url.includes('/api/tasks/task-a1')) {
				return Response.json({ task_id: 'task-a1', music_ids: ['a1-song-1', 'a1-song-2'] })
			}
			if (url.includes('/api/songs?ids=')) {
				return Response.json([
					{ music_id: 'a1-song-1', status: 4, audio: 'https://cdn.aisg.test/a1-1.mp3', service: 'aisonggenerator' },
					{ music_id: 'a1-song-2', status: 4, audio: 'https://cdn.aisg.test/a1-2.mp3', service: 'aisonggenerator' },
				])
			}
			otherCalls.push(url)
			throw new Error(`Unexpected AISG call: ${url}`)
		},
	}

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('/a1-1.mp3')) return new Response(audio1, { status: 200 })
		if (url.includes('/a1-2.mp3')) return new Response(audio2, { status: 200 })
		if (url.includes('/purge_cache')) return Response.json({ success: true })
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	const seedCarried = (oldId: string) => {
		const storage = harness.doNs.getStorage(oldId)
		storage.set('payload', { address: OWNER, prompt: 'replay me', public: false, provider: 'aisonggenerator' })
		storage.set('image_base64', Buffer.from('img').toString('base64'))
		storage.set('description', 'Replay desc')
		storage.set('lyrics', { title: 'Replay', style: ['pop', 'synth'], lyrics: 'verse' })
		storage.set('nsfw', { safe: true, categories: [] })
		storage.set('provider_attempt', {
			provider: 'aisonggenerator',
			status: 'ambiguous',
			attempt_id: attemptId,
			source_smol_id: oldId,
			error_code: 'submit_outcome_unknown',
			updated_at: '2026-11-24T00:00:00.000Z',
		})
	}

	try {
		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)

		// 1. Stored receipt is accepted -> replay returns the task id, discovery + polling resume, no new key.
		const okOldId = 'a1'.repeat(32)
		const okNewId = 'a2'.repeat(32)
		seedCarried(okOldId)
		await wf.run(
			{ payload: { retry_id: okOldId }, instanceId: okNewId, timestamp: new Date() } as never,
			createWorkflowStep(new Map()).step as never
		)
		assert.equal(replays.length, 1, 'exactly one keyed replay')
		assert.equal(replays[0].key, attemptId, 'replay reuses the stored Idempotency-Key')
		assert.equal(replays[0].body.attempt_id, attemptId)
		assert.equal(replays[0].body.public, false, 'replay payload must match the original submit (payload hash)')
		assert.equal(replays[0].body.instrumental, false)
		assert.equal(replays[0].body.description, 'Replay desc')
		assert.equal(otherCalls.length, 0, 'no call to the nonexistent GET /api/attempts route')
		assert.equal(harness.smolsTable.get(okNewId)?.Song_1, 'a1-song-1')
		assert.equal(harness.smolsTable.get(okNewId)?.Song_2, 'a1-song-2')

		// 2. Receipt still unresolved -> 504 aisg_dispatch_unknown -> refuse another charge, no discovery.
		replayResponder = () => Response.json(
			{ error: 'outcome unknown', provider: 'aisonggenerator', code: 'aisg_dispatch_unknown', retryable: false, outcome: 'unknown' },
			{ status: 504 }
		)
		const pendOldId = 'a3'.repeat(32)
		seedCarried(pendOldId)
		await assert.rejects(
			() => wf.run(
				{ payload: { retry_id: pendOldId }, instanceId: 'a4'.repeat(32), timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/requires reconciliation before authorizing another charge/
		)
		assert.equal(replays.length, 2, 'unresolved replay is not retried within the step')
		assert.equal(otherCalls.length, 0)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('A1 quota: a legacy claimed AISG attempt with no reservation never replays POST /api/tasks without first holding an AISG quota reservation (missing AND existing worker receipt)', async () => {
	const makeAudio = (seed: number) => Uint8Array.from({ length: 40_000 }, (_, i) => (seed + i * 13) & 0xff)
	const audio1 = makeAudio(21)
	const audio2 = makeAudio(87)
	type Reservation = { status: string; provider: string } | null

	const run = async (opts: {
		label: string
		receipts: Map<string, string>
		dailyClassic?: string
		carriedReservation?: boolean
		replayStatus?: { status: number; body: Record<string, unknown> }
	}) => {
		const harness = createRetryCrudHarness()
		if (opts.dailyClassic !== undefined) (harness.env as any).DAILY_LIMIT_CLASSIC = opts.dailyClassic
		const quotaStub = () => (harness.env as any).USER_QUOTA.get((harness.env as any).USER_QUOTA.idFromName(`user:${OWNER}`))
		const oldId = `${opts.label}`.padEnd(64, '0')
		const newId = `${opts.label}`.padEnd(64, '1')
		const attemptId = `smol-${oldId}-aisg`
		const reconcileReservationId = `${newId}:reconcile:aisonggenerator`
		const posts: Array<{ key: string | null; reservationAtPost: Reservation }> = []
		let freshPaidDispatches = 0

		;(harness.env as any).AISONGGENERATOR = {
			fetch: async (url: string, init?: RequestInit) => {
				if (url.endsWith('/api/tasks') && init?.method === 'POST') {
					const key = new Headers(init.headers).get('Idempotency-Key')
					posts.push({ key, reservationAtPost: await quotaStub().getReservation(reconcileReservationId) })
					if (opts.replayStatus) return Response.json(opts.replayStatus.body, { status: opts.replayStatus.status })
					// Mirrors aisonggenerator-worker postTask: stored receipt answers; a miss is a FIRST paid submit.
					let taskId = opts.receipts.get(key!)
					if (!taskId) {
						freshPaidDispatches += 1
						taskId = `task-${opts.label}`
						opts.receipts.set(key!, taskId)
					}
					return Response.json({ task_id: taskId })
				}
				if (url.includes(`/api/tasks/task-${opts.label}`)) {
					return Response.json({ task_id: `task-${opts.label}`, music_ids: [`${opts.label}-s1`, `${opts.label}-s2`] })
				}
				if (url.includes('/api/songs?ids=')) {
					return Response.json([
						{ music_id: `${opts.label}-s1`, status: 4, audio: `https://cdn.aisg.test/${opts.label}-1.mp3`, service: 'aisonggenerator' },
						{ music_id: `${opts.label}-s2`, status: 4, audio: `https://cdn.aisg.test/${opts.label}-2.mp3`, service: 'aisonggenerator' },
					])
				}
				throw new Error(`Unexpected AISG call: ${url}`)
			},
		}

		const storage = harness.doNs.getStorage(oldId)
		storage.set('payload', { address: OWNER, prompt: 'legacy claimed', public: true, provider: 'aisonggenerator' })
		storage.set('image_base64', Buffer.from('img').toString('base64'))
		storage.set('description', 'Legacy desc')
		storage.set('lyrics', { title: 'Legacy', style: ['pop', 'synth'], lyrics: 'verse' })
		storage.set('nsfw', { safe: true, categories: [] })
		storage.set('provider_attempt', {
			provider: 'aisonggenerator',
			status: 'claimed',
			attempt_id: attemptId,
			source_smol_id: oldId,
			updated_at: '2026-11-24T00:00:00.000Z',
		})
		if (opts.carriedReservation) {
			storage.set('quota_reservation_id', oldId)
			storage.set('quota_provider', 'aisonggenerator')
			const held = await quotaStub().reserve(oldId, 'aisonggenerator', { classic: 100, elevenlabs: 100 })
			assert.equal(held.ok, true)
		}

		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)
		let error: unknown
		try {
			await wf.run(
				{ payload: { retry_id: oldId }, instanceId: newId, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			)
		} catch (err) {
			error = err
		}
		return {
			harness,
			posts,
			error,
			freshPaidDispatches: () => freshPaidDispatches,
			attemptId,
			newId,
			reservation: async (): Promise<Reservation> => await quotaStub().getReservation(reconcileReservationId),
		}
	}

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.endsWith('-1.mp3')) return new Response(audio1, { status: 200 })
		if (url.endsWith('-2.mp3')) return new Response(audio2, { status: 200 })
		if (url.includes('/purge_cache')) return Response.json({ success: true })
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		// 1. MISSING worker receipt: the replay is a first paid submit -> it must already hold a reservation.
		const missing = await run({ label: 'c1', receipts: new Map() })
		assert.equal(missing.error, undefined, String(missing.error))
		assert.equal(missing.posts.length, 1)
		assert.equal(missing.freshPaidDispatches(), 1)
		assert.equal(missing.posts[0].reservationAtPost?.status, 'reserved', 'AISG reservation held BEFORE the paid replay dispatch')
		assert.equal(missing.posts[0].reservationAtPost?.provider, 'aisonggenerator')
		assert.equal((await missing.reservation())?.status, 'committed', 'fresh dispatch commits the reconcile reservation')
		assert.equal(missing.harness.smolsTable.get(missing.newId)?.Song_1, 'c1-s1')
		const missingState = missing.harness.doNs.getStorage(missing.newId)
		assert.equal(missingState.get('quota_reservation_id'), `${missing.newId}:reconcile:aisonggenerator`, 'reconcile reservation persisted for successor retries')
		assert.equal(missingState.get('quota_provider'), 'aisonggenerator')

		// 2. EXISTING worker receipt: no new upstream charge, but the legacy generation was never counted, so it
		//    is still admitted under a reservation (counted exactly once) before the replay is sent.
		const existing = await run({ label: 'c2', receipts: new Map([[`smol-${'c2'.padEnd(64, '0')}-aisg`, 'task-c2']]) })
		assert.equal(existing.error, undefined, String(existing.error))
		assert.equal(existing.posts.length, 1)
		assert.equal(existing.freshPaidDispatches(), 0, 'stored receipt answers the replay')
		assert.equal(existing.posts[0].reservationAtPost?.status, 'reserved')
		assert.equal((await existing.reservation())?.status, 'committed')
		assert.equal(existing.harness.smolsTable.get(existing.newId)?.Song_2, 'c2-s2')

		// 3. Quota exhausted: NO POST /api/tasks at all (missing receipt can never buy an unreserved generation).
		const denied = await run({ label: 'c3', receipts: new Map(), dailyClassic: '0' })
		assert.match(String(denied.error), /blocked by quota/)
		assert.equal(denied.posts.length, 0, 'no replay dispatch without a reservation')
		assert.equal(denied.freshPaidDispatches(), 0)
		assert.equal(await denied.reservation(), null)

		// 4. Replay rejected (409 conflict = worker did not dispatch) -> the reconcile reservation is refunded.
		const conflict = await run({
			label: 'c4',
			receipts: new Map(),
			replayStatus: { status: 409, body: { error: 'conflict', code: 'idempotency_conflict', retryable: false, outcome: 'rejected' } },
		})
		assert.match(String(conflict.error), /requires reconciliation before authorizing another charge/)
		assert.equal(conflict.posts.length, 1)
		assert.equal((await conflict.reservation())?.status, 'refunded')

		// 5. Replay outcome unknown (504) -> reservation retained (never refunded on a possible charge).
		const unknown = await run({
			label: 'c5',
			receipts: new Map(),
			replayStatus: { status: 504, body: { error: 'unknown', code: 'aisg_dispatch_unknown', retryable: false, outcome: 'unknown' } },
		})
		assert.match(String(unknown.error), /requires reconciliation before authorizing another charge/)
		assert.equal((await unknown.reservation())?.status, 'ambiguous')

		// 6. Carried AISG reservation already covers the attempt -> no second reservation is taken.
		const carried = await run({ label: 'c6', receipts: new Map(), carriedReservation: true })
		assert.equal(carried.error, undefined, String(carried.error))
		assert.equal(carried.posts.length, 1)
		assert.equal(await carried.reservation(), null, 'carried AISG reservation is reused, not doubled')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('A1 refunded carry: after a typed 402 rejection refunds the reconcile reservation, the next retry verifies the carried ID in the quota DO and reserves a fresh AISG slot before replaying POST /api/tasks', async () => {
	const makeAudio = (seed: number) => Uint8Array.from({ length: 40_000 }, (_, i) => (seed + i * 29) & 0xff)
	const audio1 = makeAudio(31)
	const audio2 = makeAudio(97)
	type Reservation = { status: string; provider: string } | null

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.endsWith('-1.mp3')) return new Response(audio1, { status: 200 })
		if (url.endsWith('-2.mp3')) return new Response(audio2, { status: 200 })
		if (url.includes('/purge_cache')) return Response.json({ success: true })
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	const scenario = async (label: string, denyOnRetry: boolean) => {
		const harness = createRetryCrudHarness()
		const quotaStub = () => (harness.env as any).USER_QUOTA.get((harness.env as any).USER_QUOTA.idFromName(`user:${OWNER}`))
		const idA = `${label}`.padEnd(64, 'a')
		const idB = `${label}`.padEnd(64, 'b')
		const idC = `${label}`.padEnd(64, 'c')
		const attemptId = `smol-${idA}-aisg`
		const reservationB = `${idB}:reconcile:aisonggenerator`
		const reservationC = `${idC}:reconcile:aisonggenerator`
		// Mirrors aisonggenerator-worker: a typed rejection clears the receipt, so the next keyed POST is a FIRST paid submit.
		const receipts = new Map<string, string>()
		let rejectNext = true
		let freshPaidDispatches = 0
		const posts: Array<{ key: string | null; b: Reservation; c: Reservation }> = []

		;(harness.env as any).AISONGGENERATOR = {
			fetch: async (url: string, init?: RequestInit) => {
				if (url.endsWith('/api/tasks') && init?.method === 'POST') {
					const key = new Headers(init.headers).get('Idempotency-Key')!
					posts.push({
						key,
						b: await quotaStub().getReservation(reservationB),
						c: await quotaStub().getReservation(reservationC),
					})
					if (rejectNext) {
						rejectNext = false
						receipts.delete(key)
						return Response.json(
							{ error: 'insufficient credits', code: 'aisg_insufficient_credits', retryable: false, outcome: 'rejected' },
							{ status: 402 }
						)
					}
					let taskId = receipts.get(key)
					if (!taskId) {
						freshPaidDispatches += 1
						taskId = `task-${label}`
						receipts.set(key, taskId)
					}
					return Response.json({ task_id: taskId })
				}
				if (url.includes(`/api/tasks/task-${label}`)) {
					return Response.json({ task_id: `task-${label}`, music_ids: [`${label}-s1`, `${label}-s2`] })
				}
				if (url.includes('/api/songs?ids=')) {
					return Response.json([
						{ music_id: `${label}-s1`, status: 4, audio: `https://cdn.aisg.test/${label}-1.mp3`, service: 'aisonggenerator' },
						{ music_id: `${label}-s2`, status: 4, audio: `https://cdn.aisg.test/${label}-2.mp3`, service: 'aisonggenerator' },
					])
				}
				throw new Error(`Unexpected AISG call: ${url}`)
			},
		}

		const storage = harness.doNs.getStorage(idA)
		storage.set('payload', { address: OWNER, prompt: 'refund then retry', public: true, provider: 'aisonggenerator' })
		storage.set('image_base64', Buffer.from('img').toString('base64'))
		storage.set('description', 'Refund desc')
		storage.set('lyrics', { title: 'Refund', style: ['pop', 'synth'], lyrics: 'verse' })
		storage.set('nsfw', { safe: true, categories: [] })
		storage.set('provider_attempt', {
			provider: 'aisonggenerator',
			status: 'claimed',
			attempt_id: attemptId,
			source_smol_id: idA,
			updated_at: '2026-11-24T00:00:00.000Z',
		})

		const wf = new workflowModule.Workflow({} as ExecutionContext, harness.env)

		// Retry 1 (A -> B): legacy claimed attempt reserves B's reconcile slot, the replay gets a typed 402 rejection.
		await assert.rejects(
			() => wf.run(
				{ payload: { retry_id: idA }, instanceId: idB, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			),
			/requires reconciliation before authorizing another charge/
		)
		assert.equal(posts.length, 1)
		assert.equal(posts[0].b?.status, 'reserved', 'first replay held B reconcile reservation')
		assert.equal((await quotaStub().getReservation(reservationB))?.status, 'refunded', 'typed 402 rejection refunds B reservation')
		const stateB = harness.doNs.getStorage(idB)
		assert.equal(stateB.get('quota_reservation_id'), reservationB, 'B carries the (now refunded) reservation ID')
		assert.equal((stateB.get('provider_attempt') as { status?: string } | undefined)?.status, 'claimed', 'B attempt is still claimed')
		assert.equal(receipts.size, 0, 'worker cleared its receipt on rejection')

		if (denyOnRetry) (harness.env as any).DAILY_LIMIT_CLASSIC = '0'

		// Retry 2 (B -> C): the carried ID alone must not authorize the replay.
		let error: unknown
		try {
			await wf.run(
				{ payload: { retry_id: idB }, instanceId: idC, timestamp: new Date() } as never,
				createWorkflowStep(new Map()).step as never
			)
		} catch (err) {
			error = err
		}
		return { harness, quotaStub, posts, error, idC, reservationB, reservationC, freshPaidDispatches: () => freshPaidDispatches }
	}

	try {
		// Quota available: a fresh C reservation is held at the moment of the (paid) replay and committed after.
		const ok = await scenario('d1', false)
		assert.equal(ok.error, undefined, String(ok.error))
		assert.equal(ok.posts.length, 2)
		assert.equal(ok.posts[1].b?.status, 'refunded')
		assert.equal(ok.posts[1].c?.status, 'reserved', 'retry reserved a fresh AISG slot BEFORE the paid replay')
		assert.equal(ok.posts[1].c?.provider, 'aisonggenerator')
		assert.equal(ok.freshPaidDispatches(), 1, 'the replay after a cleared receipt is a fresh paid dispatch')
		assert.equal((await ok.quotaStub().getReservation(ok.reservationC))?.status, 'committed', 'fresh dispatch is counted exactly once')
		assert.equal((await ok.quotaStub().getReservation(ok.reservationB))?.status, 'refunded', 'refunded slot is never resurrected')
		assert.equal(ok.harness.doNs.getStorage(ok.idC).get('quota_reservation_id'), ok.reservationC)
		assert.equal(ok.harness.smolsTable.get(ok.idC)?.Song_1, 'd1-s1')

		// Quota exhausted: the refunded carried ID cannot buy an uncounted generation -> no POST at all.
		const denied = await scenario('d2', true)
		assert.match(String(denied.error), /blocked by quota/)
		assert.equal(denied.posts.length, 1, 'no replay dispatch after the refund without a fresh reservation')
		assert.equal(denied.freshPaidDispatches(), 0)
		assert.equal(await denied.quotaStub().getReservation(denied.reservationC), null)
	} finally {
		globalThis.fetch = originalFetch
	}
})
