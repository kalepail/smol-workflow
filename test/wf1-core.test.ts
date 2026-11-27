import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after, before } from 'node:test'
import { StrKey } from '@stellar/stellar-sdk/base'
import {
	assertSignedMintEnvelope, assertUnsignedMintEnvelope, buildMintExpectation, decodeMintCarrier, signValidatedMint, type MintKind,
} from '../src/chain/mint-authorization'
import { bytesEqual, compareBytes } from '../src/utils/bytes'
import { playlistCacheTag } from '../src/utils/cache-tags'
import { encodeCursor } from '../src/utils/pagination'
import { testIdentity, testIssuerKeypair } from './fixtures/mint-authz/generate'
import {
	createAuthToken, createMockEdgeCache, createMockExecutionContext, createMockR2Bucket, createSqliteD1, installCloudflareStubs,
} from './helpers/harness'

const ROOT = join(__dirname, '..')
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8')
const SECRET = 'wf1-core-jwt-secret-0123456789abcdef'
const ADMIN = 'wf1-core-admin-secret'
const OWNER = StrKey.encodeContract(Buffer.alloc(32, 7))
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 8))
const id = (char: string) => char.repeat(64)
const PRIVATE_HEADERS = { 'cache-control': 'private, no-store', 'cdn-cache-control': 'no-store' }

let app: typeof import('../src/index').app
let processSearchQueue: typeof import('../src/utils/search').processSearchQueue
let cleanup: () => void
const purged: string[][] = []
const liveFetch = globalThis.fetch

before(async () => {
	const stubs = installCloudflareStubs({ CF_API_TOKEN: 'wf1-token', CF_ZONE_ID: 'wf1-zone' })
	cleanup = stubs.cleanup
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input)
		assert.match(url, /\/purge_cache$/, `unmocked fetch ${url}`)
		purged.push((JSON.parse(String(init?.body)) as { tags: string[] }).tags)
		return Response.json({ success: true })
	}) as typeof fetch
	;({ app } = await import('../src/index'))
	;({ processSearchQueue } = await import('../src/utils/search'))
})

after(() => {
	globalThis.fetch = liveFetch
	Reflect.deleteProperty(globalThis, 'caches')
	cleanup()
})

function createKv(initial: Record<string, unknown> = {}) {
	const store = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]))
	const kv = {
		get: async (key: string, type?: string) => (store.has(key) ? (type === 'json' ? JSON.parse(store.get(key)!) : store.get(key)) : null),
		put: async (key: string, value: string) => void store.set(key, value),
		delete: async (key: string) => void store.delete(key),
		list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
			keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true,
		}),
	}
	return { kv, store }
}

function harness(kvInitial: Record<string, unknown> = {}) {
	const db = new DatabaseSync(':memory:')
	db.exec(SCHEMA)
	const { d1, hooks } = createSqliteD1(db)
	const { kv, store: kvStore } = createKv(kvInitial)
	const r2 = createMockR2Bucket()
	const queue: SearchQueueMessage[] = []
	const flushed: string[] = []
	const env = {
		SECRET, ADMIN_SECRET: ADMIN, SMOL_D1: d1, SMOL_KV: kv, SMOL_BUCKET: r2.bucket,
		SEARCH_QUEUE: { send: async (message: SearchQueueMessage) => void queue.push(message) },
		DURABLE_OBJECT: { idFromString: (value: string) => value, get: (value: string) => ({ setToFlush: async () => void flushed.push(value) }) },
	} as unknown as Env

	function smol(smolId: string, values: Record<string, unknown> = {}) {
		const row = { Title: smolId, Song_1: `${smolId}-1`, Song_2: null, Address: OWNER, Public: 1, Mint_Token: null, Mint_Amm: null, ...values }
		db.prepare(`INSERT INTO Smols (Id, Title, Song_1, Song_2, "Address", Public, Mint_Token, Mint_Amm, Created_At)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`).run(smolId, row.Title as string, row.Song_1 as string, row.Song_2 as string | null,
			row.Address as string, row.Public as number, row.Mint_Token as string | null, row.Mint_Amm as string | null,
			`-${db.prepare('SELECT count(*) AS n FROM Smols').get()!.n as number} minutes`)
	}

	async function send(path: string, init: { method?: string; body?: unknown; sub?: string; headers?: Record<string, string> } = {}) {
		const ctx = createMockExecutionContext()
		const headers = new Headers(init.headers)
		if (init.sub) headers.set('Authorization', `Bearer ${await createAuthToken(init.sub, SECRET)}`)
		const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
		const response = await app.fetch(new Request(`https://api.smol.xyz${path}`, {
			method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, body,
		}), env, ctx.ctx)
		await ctx.flush()
		return response
	}

	const count = (sql: string, ...args: string[]) => db.prepare(`SELECT count(*) AS n FROM ${sql}`).get(...args)!.n as number
	return { db, env, hooks, kvStore, r2, queue, flushed, smol, send, count }
}

function assertPrivate(response: Response, label: string) {
	for (const [name, value] of Object.entries(PRIVATE_HEADERS)) assert.equal(response.headers.get(name), value, `${label} ${name}`)
	assert.match(response.headers.get('vary') ?? '', /^Cookie, Authorization\b/, `${label} vary`)
}

// ---------------------------------------------------------------------------
// 1. workerd byte comparisons
// ---------------------------------------------------------------------------

test('bytesEqual/compareBytes match Buffer semantics over plain Uint8Arrays', () => {
	const samples = [[], [0], [1], [0, 0], [0, 1], [1, 0], [255], [255, 0], [1, 2, 3], [1, 2, 4]].map((bytes) => new Uint8Array(bytes))
	for (const a of samples) {
		for (const b of samples) {
			assert.equal(compareBytes(a, b), Buffer.compare(Buffer.from(a), Buffer.from(b)))
			assert.equal(bytesEqual(a, b), Buffer.from(a).equals(Buffer.from(b)))
			assert.equal(bytesEqual(Buffer.from(a), b), bytesEqual(a, b))
		}
	}
})

test('FE carriers decode, validate, sign and verify with Buffer#equals and Buffer.compare unusable (workerd cross-realm)', async () => {
	const carriers = (JSON.parse(readFileSync(join(__dirname, 'fixtures/mint-authz/fe-carriers.json'), 'utf8')) as {
		carriers: Array<{ identity: string; kind: MintKind; sub: string; tracks: { id: string; creator: string }[]; xdr: string }>
	}).carriers.filter(({ identity }) => identity === 'test')
	assert.equal(carriers.length, 4)
	const identity = testIdentity()
	const { equals } = Buffer.prototype
	const { compare } = Buffer
	const crossRealm = () => { throw new TypeError('argument must be a Buffer (cross-realm)') }
	Buffer.prototype.equals = crossRealm
	Buffer.compare = crossRealm
	try {
		for (const carrier of carriers) {
			const validated = assertUnsignedMintEnvelope(
				decodeMintCarrier(carrier.xdr, carrier.kind, identity),
				buildMintExpectation({ identity, kind: carrier.kind, sub: carrier.sub, tracks: carrier.tracks }),
			)
			const signed = await signValidatedMint(validated, testIssuerKeypair(), 65_000_100, identity.networkPassphrase)
			assertSignedMintEnvelope(validated, signed, { expirationLedger: 65_000_100, networkPassphrase: identity.networkPassphrase })
		}
	} finally {
		Buffer.prototype.equals = equals
		Buffer.compare = compare
	}
	for (const file of ['src/chain/mint-authorization.ts', 'src/api/auth.ts', 'src/passkey.ts']) {
		assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), /\.equals\(|Buffer\.compare/, file)
	}
})

// ---------------------------------------------------------------------------
// 2. Private no-store + origin-neutral public cache
// ---------------------------------------------------------------------------

test('public list cache: warm HIT with request-matched CORS, unlisted origins bypass, private routes never cached', async () => {
	const edge = createMockEdgeCache()
	Reflect.set(globalThis, 'caches', { default: edge.cache })
	const h = harness()
	h.smol(id('a'))
	h.smol(id('b'), { Public: 0 })
	h.db.prepare('INSERT INTO Likes (Id, "Address") VALUES (?, ?)').run(id('a'), OWNER)

	const cold = await h.send('/?limit=5', { headers: { Origin: 'https://smol.xyz' } })
	const coldBody = await cold.text()
	assert.equal(cold.headers.get('Access-Control-Allow-Origin'), 'https://smol.xyz')
	assert.equal(cold.headers.get('Cache-Control'), 'public, max-age=30, s-maxage=30, stale-while-revalidate=60')
	assert.equal(cold.headers.get('Cache-Tag'), null, 'clients never see Cache-Tag')
	assert.equal(edge.stats.putCalls, 1)
	const [stored] = edge.entries.values()
	assert.ok(stored.headers.every(([name]) => !name.startsWith('access-control-') && name !== 'vary'), 'shared copy is origin-neutral')
	assert.deepEqual(stored.headers.find(([name]) => name === 'cache-tag'), ['cache-tag', 'public-smols'], 'the cached copy keeps its purge tag')

	h.smol(id('c'))
	const warm = await h.send('/?limit=5', { headers: { Origin: 'https://noot.smol.xyz' } })
	assert.equal(await warm.text(), coldBody, 'HIT serves the cached list')
	assert.equal(warm.headers.get('Access-Control-Allow-Origin'), 'https://noot.smol.xyz')
	const anonymous = await h.send('/?limit=5')
	assert.equal(await anonymous.text(), coldBody)
	assert.equal(anonymous.headers.get('Access-Control-Allow-Origin'), null)
	const unlisted = await h.send('/?limit=5', { headers: { Origin: 'https://evil.example' } })
	assert.equal((await unlisted.json() as { smols: unknown[] }).smols.length, 2, 'unlisted origin bypasses the cache')
	assert.equal(unlisted.headers.get('Access-Control-Allow-Origin'), null)
	assert.equal(edge.stats.putCalls, 1)

	for (const path of ['/created', '/liked', '/likes', '/chain/balance', '/mint/status', '/search/admin/dlq']) {
		const method = path === '/mint/status' ? 'POST' : 'GET'
		const anonymousResponse = await h.send(path, { method })
		assert.equal(anonymousResponse.status, 401, path)
		assertPrivate(anonymousResponse, `${path} anonymous`)
	}
	for (const path of ['/created', '/liked', '/likes']) {
		const response = await h.send(path, { sub: OWNER })
		assert.equal(response.status, 200, path)
		assertPrivate(response, path)
	}
	assert.equal((await (await h.send('/created', { sub: OWNER })).json() as { smols: unknown[] }).smols.length, 3)
	assert.equal(edge.stats.putCalls, 1, 'private routes never reach caches.default.put')

	const title = 'chill, vibes ✨'
	h.db.prepare('INSERT INTO Playlists (Id, Title) VALUES (?, ?)').run(id('a'), title)
	const playlist = await h.send(`/playlist/${encodeURIComponent(title)}`)
	const tag = await playlistCacheTag(title)
	assert.match(tag, /^playlist:[0-9a-f]{64}$/)
	assert.equal(playlist.headers.get('Cache-Tag'), null)
	assert.equal(edge.stats.putCalls, 2)
	assert.deepEqual([...edge.entries.values()][1].headers.find(([name]) => name === 'cache-tag'), ['cache-tag', tag])

	const failing = harness()
	failing.env.SMOL_D1 = { prepare() { throw new Error('D1 secret internals') } } as unknown as D1Database
	const error = await failing.send('/?limit=7')
	assert.equal(error.status, 500)
	assert.equal(error.headers.get('Cache-Control'), 'no-store')
	assert.deepEqual(await error.json(), { error: 'internal_error' })
	assert.equal(edge.stats.putCalls, 2, 'errors are never cached')
	Reflect.deleteProperty(globalThis, 'caches')
})

// ---------------------------------------------------------------------------
// 3. Guarded atomic deletes
// ---------------------------------------------------------------------------

test('DELETE /:id: owner only, 409 for minted or minting, atomic guard, shared MP3s protected', async () => {
	const h = harness({ [id('a')]: { songs: [{ music_id: 'mp3-a', status: 4 }] } })
	h.smol(id('a'), { Song_1: 'mp3-a', Song_2: 'mp3-shared' })
	h.smol(id('b'), { Song_1: 'mp3-shared' })
	h.smol(id('1'), { Mint_Token: 'CSAC' })
	h.smol(id('2'), { Mint_Amm: 'CPOOL' })
	h.smol(id('3'))
	h.smol(id('4'))
	h.db.prepare(`INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase) VALUES ('wf', ?, ?, 'submitted')`).run(OWNER, JSON.stringify([id('3')]))
	for (const smolId of [id('a'), id('4')]) {
		h.db.prepare('INSERT INTO Likes (Id, "Address") VALUES (?, ?)').run(smolId, OTHER)
		h.db.prepare('INSERT INTO Playlists (Id, Title) VALUES (?, ?)').run(smolId, 'mix')
	}
	for (const key of [`${id('a')}.png`, 'mp3-a.mp3', 'mp3-shared.mp3']) await h.r2.bucket.put(key, 'bytes')

	assert.equal((await h.send(`/${id('a')}`, { method: 'DELETE', sub: OTHER })).status, 404)
	assert.equal((await h.send(`/${id('1')}`, { method: 'DELETE', sub: OWNER })).status, 409)
	assert.equal((await h.send(`/${id('2')}`, { method: 'DELETE', sub: OWNER })).status, 409)
	assert.equal((await h.send(`/${id('3')}`, { method: 'DELETE', sub: OWNER })).status, 409, 'unresolved mint receipt')

	// A mint lands between the read and the batch: the guarded batch deletes nothing at all.
	h.hooks.onStatement = (sql) => {
		if (sql.startsWith('DELETE FROM Likes')) h.db.prepare('UPDATE Smols SET Mint_Token = ? WHERE Id = ?').run('CRACE', id('4'))
	}
	assert.equal((await h.send(`/${id('4')}`, { method: 'DELETE', sub: OWNER })).status, 409)
	h.hooks.onStatement = undefined
	assert.equal(h.count('Smols WHERE Id = ?', id('4')), 1)
	assert.equal(h.count('Likes WHERE Id = ?', id('4')), 1)
	assert.equal(h.count('Playlists WHERE Id = ?', id('4')), 1)

	purged.length = 0
	assert.equal((await h.send(`/${id('a')}`, { method: 'DELETE', sub: OWNER })).status, 204)
	for (const table of ['Smols', 'Likes', 'Playlists']) assert.equal(h.count(`${table} WHERE Id = ?`, id('a')), 0, table)
	assert.equal(h.kvStore.has(id('a')), false)
	assert.deepEqual([...h.r2.store.keys()], ['mp3-shared.mp3'], 'cover + unreferenced MP3 deleted, shared MP3 kept')
	assert.deepEqual(h.flushed, [id('a')])
	assert.deepEqual(h.queue.map((message) => message.type), ['delete'])
	const tags = purged.flat()
	for (const expected of ['public-smols', `smol:${id('a')}:media`, `song:mp3-a:media`, await playlistCacheTag('mix')]) assert.ok(tags.includes(expected), expected)
	assert.ok(!tags.some((tag) => tag.startsWith('user:')), 'per-user tags label nothing cached and are never purged')
})

test('DELETE /admin/bulk: admin JSON body, Mint_Token/Mint_Amm/receipt guards, allowPublic skip semantics', async () => {
	const h = harness()
	h.smol(id('5'))
	h.smol(id('6'), { Public: 0 })
	h.smol(id('2'), { Public: 0, Mint_Amm: 'CPOOL' })
	h.smol(id('3'), { Public: 0 })
	h.db.prepare(`INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase) VALUES ('wf', ?, ?, 'confirmed')`).run(OWNER, JSON.stringify([id('3')]))
	const admin = { 'x-admin-secret': ADMIN, 'Content-Type': 'application/json' }
	const bulk = (body: unknown) => h.send('/admin/bulk', { method: 'DELETE', body, headers: admin })

	assert.equal((await h.send('/admin/bulk', { method: 'DELETE', body: { ids: [id('6')] } })).status, 401)
	assert.equal((await bulk('{not json')).status, 400)
	assert.equal((await bulk({ ids: 'nope' })).status, 400)
	assert.deepEqual(await (await bulk({ ids: [id('5'), id('6'), id('2'), id('3'), id('7')] })).json(), { deleted: 1, skipped: 4, total: 5 })
	assert.deepEqual(h.db.prepare('SELECT Id FROM Smols ORDER BY Id').all().map((row) => row.Id), [id('2'), id('3'), id('5')])
	assert.deepEqual(await (await bulk({ ids: [id('5'), id('2')], allowPublic: true })).json(), { deleted: 1, skipped: 1, total: 2 })
	assert.equal(h.count('Smols WHERE Id = ?', id('5')), 0)
})

test('delete vs admitted mint: an open receipt makes both delete batches delete nothing (409); a delete that commits first stops the mint before dispatch', async () => {
	const h = harness()
	const admin = { 'x-admin-secret': ADMIN, 'Content-Type': 'application/json' }
	h.smol(id('c'), { Public: 0 })
	h.db.prepare('INSERT INTO Likes (Id, "Address") VALUES (?, ?)').run(id('c'), OTHER)
	h.db.prepare('INSERT INTO Playlists (Id, Title) VALUES (?, ?)').run(id('c'), 'mix')
	const receipt = (phase: string) => h.db.prepare(`INSERT OR REPLACE INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase) VALUES ('wf-c', ?, ?, ?)`)
		.run(OTHER, JSON.stringify([id('c')]), phase)
	// (a) The receipt is admitted/advances after the pre-check read but before the batch commits.
	const race = async (phase: string, request: () => Promise<Response>) => {
		h.db.prepare('DELETE FROM MintBatchStatus').run()
		h.hooks.onStatement = (sql) => { if (sql.startsWith('DELETE FROM Likes')) receipt(phase) }
		const response = await request()
		h.hooks.onStatement = undefined
		for (const table of ['Smols', 'Likes', 'Playlists']) assert.equal(h.count(`${table} WHERE Id = ?`, id('c')), 1, `${phase} ${table}`)
		return response
	}
	for (const phase of ['queued', 'submitting']) {
		assert.equal((await race(phase, () => h.send(`/${id('c')}`, { method: 'DELETE', sub: OWNER }))).status, 409, phase)
		const bulk = await race(phase, () => h.send('/admin/bulk', { method: 'DELETE', body: { ids: [id('c')] }, headers: admin }))
		assert.deepEqual(await bulk.json(), { deleted: 0, skipped: 1, total: 1 })
	}
	h.db.prepare('DELETE FROM MintBatchStatus').run()

	// (b) The delete commits while the admission is still unverified; the signer then records `submitting`.
	receipt('unverified')
	assert.equal((await h.send(`/${id('c')}`, { method: 'DELETE', sub: OWNER })).status, 204)
	const { TxWorkflow, SIGNED_MINT_CHECKPOINT_VERSION } = await import('../src/tx-workflow')
	const { createWorkflowStep } = await import('./helpers/harness')
	const lock = { mintAttemptState: async () => 'undispatched', resolveMintPrefixes: async () => ({ state: 'failed' }), markMintDispatched: async () => assert.fail('marked') }
	Object.assign(h.env, {
		MINT_SIGNING_ENABLED: 'true', USER_QUOTA: { idFromName: () => 'x', get: () => lock },
		KALE_WORKER: { submitTransaction: async () => assert.fail('relayed a mint for a deleted song') },
	})
	const event = { instanceId: 'wf-c', timestamp: new Date(), payload: { type: 'mint', xdr: 'x', entropy: id('c'), sub: OTHER, ownerSub: OWNER, trackStatus: true } }
	const step = createWorkflowStep(new Map([['sign transaction#1', { version: SIGNED_MINT_CHECKPOINT_VERSION, xdr: 'signed' }]])).step
	await assert.rejects(new TxWorkflow({} as ExecutionContext, h.env).run(event as never, step as never), /missing or minted before dispatch/)
	assert.equal(h.db.prepare(`SELECT Phase FROM MintBatchStatus WHERE Workflow_Id = 'wf-c'`).get()!.Phase, 'failed')
})

// ---------------------------------------------------------------------------
// 4. API & correctness
// ---------------------------------------------------------------------------

test('GET /chain/balance: contract sessions only, archive-aware read, fail-closed 503 (never a fabricated 0)', async () => {
	const h = harness()
	let page: unknown = { latestLedger: 100, archiveAware: true, entries: [] }
	h.env.KALE_WORKER = { readEntries: async () => { if (page instanceof Error) throw page; return page } } as unknown as Env['KALE_WORKER']
	const balance = async (sub = OWNER) => h.send('/chain/balance', { sub })

	assert.equal((await balance(testIssuerKeypair().publicKey())).status, 400)
	const absent = await balance()
	assertPrivate(absent, 'balance')
	assert.deepEqual(await absent.json(), { network: 'mainnet', latestLedger: 100, kale: { state: 'known', amount: '0', life: 'absent' } })
	page = { latestLedger: 100, archiveAware: false, entries: [] }
	assert.equal((await balance()).status, 503)
	page = new Error('rpc down')
	const down = await balance()
	assert.equal(down.status, 503)
	assert.deepEqual(await down.json(), { error: 'balance_unavailable' })
})

test('/song serves only .mp3 and /image only .png; cross-media GET/HEAD is 404', async () => {
	const h = harness()
	for (const method of ['GET', 'HEAD']) {
		assert.equal((await h.send('/image/x.mp3', { method })).status, 404)
		assert.equal((await h.send('/song/x.png', { method })).status, 404)
	}
})

test('GET /:id exposes only the smol-fe allowlist of workflow state', async () => {
	const steps = {
		payload: { address: OWNER, prompt: 'p', instrumental: false, public: true, playlist: 'mix', provider: 'aisonggenerator', retry_id: 'r', quota_day_key: 'd' },
		image_base64: 'AAAA', description: 'cover', duration: 93, requested_provider: 'aisonggenerator', active_provider: 'elevenlabs',
		actual_provider: 'elevenlabs', fallback_from: 'aisonggenerator', fallback_reason: 'Upstream said: credits exhausted for workspace ws-9',
		generation_meta: { requested_provider: 'aisonggenerator', actual_provider: 'elevenlabs', fallback_reason: 'provider_unavailable' },
		lyrics: { title: 't', style: ['pop'], lyrics: 'la', raw_upstream: 'x' },
		nsfw: { safe: false, categories: ['S1', 'S14', 'S15', 'violent crimes'] },
		songs: [{ music_id: 'm1', status: 4, audio: 'https://api.smol.xyz/song/m1.mp3', duration: 93, error_message: 'vendor 500', image_url: 'https://cdn.vendor/x', credits: 3 }],
		provider_attempt: { task_id: 'task-1', workspace_id: 'ws-9', error_message: 'raw' },
		quota_reservation_id: 'q', search: { status: 'ready' }, song_ids: ['m1'],
	}
	const h = harness({ [id('a')]: steps })
	h.smol(id('a'))
	h.db.prepare('INSERT INTO Likes (Id, "Address") VALUES (?, ?)').run(id('a'), OWNER)
	const response = await h.send(`/${id('a')}`, { headers: { Authorization: `bearer   ${await createAuthToken(OWNER, SECRET)}` } })
	const body = await response.json() as { kv_do: Record<string, unknown>; liked: boolean }
	assert.equal(body.liked, true, 'optionalAuth accepts a case-insensitive Bearer scheme')
	assert.deepEqual(body.kv_do, {
		description: 'cover', duration: 93, requested_provider: 'aisonggenerator', active_provider: 'elevenlabs',
		actual_provider: 'elevenlabs', fallback_from: 'aisonggenerator',
		payload: { address: OWNER, prompt: 'p', instrumental: false, public: true, playlist: 'mix', provider: 'aisonggenerator' },
		generation_meta: { requested_provider: 'aisonggenerator', actual_provider: 'elevenlabs', fallback_reason: 'provider_unavailable' },
		lyrics: { title: 't', style: ['pop'], lyrics: 'la' },
		nsfw: { safe: false, categories: ['S1', 'S14'] },
		songs: [{ music_id: 'm1', status: 4, audio: 'https://api.smol.xyz/song/m1.mp3', duration: 93 }],
		image: true,
	})
})

test('list routes read LIMIT + 1: exact hasMore, no empty trailing page', async () => {
	const h = harness()
	for (const char of ['a', 'b', 'c']) h.smol(id(char))
	const page = async (path: string) => await (await h.send(path)).json() as { smols: Array<{ Id: string; Created_At: string }>; pagination: { hasMore: boolean; nextCursor: string | null } }

	const exact = await page('/?limit=3')
	assert.deepEqual(exact.pagination, { hasMore: false, nextCursor: null })
	const first = await page('/?limit=2')
	assert.equal(first.smols.length, 2)
	const last = first.smols[1]
	assert.deepEqual(first.pagination, { hasMore: true, nextCursor: encodeCursor(last.Created_At, last.Id) })
	const second = await page(`/?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor!)}`)
	assert.deepEqual([second.smols.length, second.pagination.hasMore], [1, false])
	assert.equal((await page(`/artists/${OWNER}/smols?limit=3`)).pagination.hasMore, false)
})

test('POST /mint/status rejects a non-JSON body with 400 (private)', async () => {
	const h = harness()
	const response = await h.send('/mint/status', { body: '{bad', sub: OWNER, headers: { 'Content-Type': 'application/json' } })
	assert.equal(response.status, 400)
	assertPrivate(response, 'mint status')
})

test('search DLQ: admin list + replay re-enqueue and drop records; late deletes never de-index public songs', async () => {
	const prefix = '__internal:search-dlq:'
	const h = harness({ [`${prefix}upsert:${id('a')}`]: { kind: 'upsert' }, [`${prefix}delete:${id('b')}`]: { kind: 'delete' }, [id('a')]: { payload: {} } })
	const admin = { 'x-admin-secret': ADMIN }
	assert.equal((await h.send('/search/admin/dlq')).status, 401)
	const listed = await h.send('/search/admin/dlq', { headers: admin })
	assertPrivate(listed, 'dlq')
	const { entries, cursor } = await listed.json() as { entries: Array<{ key: string; kind: string; smolId: string }>; cursor: string | null }
	assert.deepEqual(entries.map(({ kind, smolId }) => [kind, smolId]), [['upsert', id('a')], ['delete', id('b')]])
	assert.equal(cursor, null)

	const replay = await h.send('/search/admin/dlq/replay', { body: { keys: [...entries.map(({ key }) => key), 'unrelated'] }, headers: admin })
	assert.deepEqual(await replay.json(), { replayed: entries.map(({ key }) => key), failed: [] })
	assert.deepEqual(h.queue.map(({ type, smolId }) => [type, smolId]), [['upsert', id('a')], ['delete', id('b')]])
	assert.equal([...h.kvStore.keys()].some((key) => key.startsWith(prefix)), false)
	assert.equal((await h.send('/search/admin/dlq/replay', { body: { keys: [] }, headers: admin })).status, 400)

	// A public D1 song whose source KV record is missing cannot be enqueued: its record is kept, not replayed.
	const missing = `${prefix}upsert:${id('c')}`
	h.smol(id('c'))
	h.kvStore.set(missing, JSON.stringify({ kind: 'upsert' }))
	const sends = h.queue.length
	const kept = await h.send('/search/admin/dlq/replay', { body: { keys: [missing] }, headers: admin })
	assert.deepEqual(await kept.json(), { replayed: [], failed: [missing] })
	assert.equal(h.queue.length, sends, 'no queue send')
	assert.equal(h.kvStore.has(missing), true, 'DLQ record retained')

	h.smol(id('5'))
	h.smol(id('8'), { Public: 0 })
	const deleted: string[] = []
	h.env.SMOL_SEARCH_INDEX = { deleteByIds: async (ids: string[]) => void deleted.push(...ids) } as unknown as Vectorize
	const acked: string[] = []
	const message = (smolId: string) => ({ body: { type: 'delete', smolId, vectorIds: [`${smolId}:v`] }, attempts: 1, ack: () => void acked.push(smolId), retry: () => assert.fail('retry') })
	await processSearchQueue({ messages: [message(id('5')), message(id('8'))] } as unknown as MessageBatch<SearchQueueMessage>, h.env, {} as ExecutionContext)
	assert.deepEqual(deleted, [`${id('8')}:v`])
	assert.deepEqual(acked, [id('5'), id('8')])
})

// ---------------------------------------------------------------------------
// 5. Dead code & platform
// ---------------------------------------------------------------------------

test('platform: smol-sdk and dead helpers removed, preview bindings and DLQ invariants intact', () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
	const wrangler = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
	assert.equal(existsSync(join(ROOT, 'ext/smol-sdk')) || existsSync(join(ROOT, 'scripts/build-sdk.mjs')), false)
	assert.equal(pkg.dependencies['smol-sdk'] ?? pkg.devDependencies['@cloudflare/workers-types'] ?? pkg.scripts['build:sdk'] ?? pkg.scripts['start:remote'], undefined)
	assert.equal(wrangler.r2_buckets[0].preview_bucket_name ?? wrangler.kv_namespaces[0].preview_id, undefined)
	assert.equal(wrangler.queues.consumers.find((c: { queue: string }) => c.queue === 'smol-search-queue-dlq').max_retries, 3)
	const sources = ['src/utils/cache.ts', 'src/utils.ts', 'src/utils/search.ts', 'src/ai/elevenlabs.ts', 'src/utils/songs.ts', 'src/types.ts']
		.map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\n')
	assert.doesNotMatch(sources, /userCacheKeyGenerator|function sleep|function parseRange|SEARCH_METADATA_JSON_SCHEMA|resolveElevenLabsMusicLengthMs|doesRetryReuseExistingAttempt|as unknown as Vectorize|from '\.\/do'/)
})
