import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test, { after, before } from 'node:test'
import {
	createAuthToken,
	createMockEdgeCache,
	createMockExecutionContext,
	createSqliteD1,
	installCloudflareStubs,
	type CloudflareStubHandle,
} from './helpers/harness'
import {
	classifyOwnerMixtapes,
	findBorderlinePair,
	type MixtapeCandidate,
	type MixtapeDecision,
} from '../src/utils/mixtape-visibility'
import { parseMixtapeDedupeResponse } from '../src/ai/mixtape-dedupe'

const TEST_SECRET = 'test-jwt-secret-32-chars-minimum!'

interface FixtureMixtape { Id: string; Title: string; Desc: string; Address: string; Created_At: string; Smols: string }
interface FixtureSmol { Id: string; Title: string; Address: string; Public: number }
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/mixtapes-live-18.json', import.meta.url), 'utf8')) as {
	mixtapes: FixtureMixtape[]
	smols: FixtureSmol[]
}
const MIGRATION_0002 = readFileSync(new URL('../migrations/0002_mixtapes_lifecycle.sql', import.meta.url), 'utf8')
const MIGRATION_0003 = readFileSync(new URL('../migrations/0003_storage_query_optimization.sql', import.meta.url), 'utf8')
const SCHEMA_SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

const byId = (id: string) => FIXTURE.mixtapes.find((m) => m.Id === id)!
const CORDOVA = '5667a5407767f926'
const CORDOVA_RETRY = '8c177735936943bd'
const CREASY_V1 = '1124d0d7162bd55a'
const CREASY_V2 = 'ce800366c10afa35'
const OUR_DECEMBER = 'c50ccefe83080d26'
const PRE_PARTY = '623d81b716c1e0e5'
const HOLIDAY_ANTHOLOGY = '119beb8a7bffc83d'
const HIDDEN_IDS = [CORDOVA_RETRY, CREASY_V1, OUR_DECEMBER]
const CORDOVA_OWNER = byId(CORDOVA).Address
const CREASY_OWNER = byId(CREASY_V2).Address
const PRE_PARTY_OWNER = byId(PRE_PARTY).Address
const ANTHOLOGY_OWNER = byId(HOLIDAY_ANTHOLOGY).Address
const NEW_OWNER = 'CNEWOWNERADDRESS0000000000000000000000000000000000000000'
const OTHER_OWNER = 'COTHEROWNERADDRESS00000000000000000000000000000000000000'
const SYN = (n: number) => `syn-${String(n).padStart(3, '0')}`
const PRIVATE_SYN = 'syn-private'

const LEGACY_DDL = `
	CREATE TABLE Smols (
		Id TEXT PRIMARY KEY, Title TEXT NOT NULL, Song_1 TEXT NOT NULL, Public BOOLEAN DEFAULT 1,
		Created_At DATETIME DEFAULT CURRENT_TIMESTAMP,
		"Address" TEXT NOT NULL, Mint_Token TEXT DEFAULT NULL, Mint_Amm TEXT DEFAULT NULL
	);
	CREATE TABLE Mixtapes (
		Id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
		Title TEXT NOT NULL, Desc TEXT NOT NULL, Smols TEXT NOT NULL, "Address" TEXT NOT NULL,
		Created_At DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE INDEX idx_mixtapes_created ON Mixtapes(Created_At DESC, Id DESC);
	CREATE TABLE Playlists (Id TEXT NOT NULL, Title TEXT NOT NULL);
`

let stubs: CloudflareStubHandle
let appModule: typeof import('../src/index')
const originalFetch = globalThis.fetch
const purgedTagBatches: string[][] = []
// Each harness installs its own in-memory edge cache; this indirection lets it swap per test.
let activeCache: Cache | null = null
const openedCacheNames = new Set<string>()

before(async () => {
	// Must exist before routes are defined: hono/cache checks globalThis.caches at import time.
	Reflect.set(globalThis, 'caches', {
		open: async (name: string) => {
			openedCacheNames.add(name)
			return activeCache
		},
	})
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('/purge_cache')) {
			purgedTagBatches.push((JSON.parse(String(init?.body)) as { tags: string[] }).tags)
			return Response.json({ success: true })
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch
	stubs = installCloudflareStubs({ CF_API_TOKEN: 'test-cf-token', CF_ZONE_ID: 'test-zone-id' })
	appModule = await import('../src/index')
})

after(() => {
	stubs.cleanup()
	globalThis.fetch = originalFetch
	Reflect.deleteProperty(globalThis, 'caches')
})

function seededShuffle<T>(items: T[], seed: number): T[] {
	const out = [...items]
	let state = seed
	for (let i = out.length - 1; i > 0; i -= 1) {
		state = (state * 1103515245 + 12345) % 2147483648
		const j = state % (i + 1)
		;[out[i], out[j]] = [out[j], out[i]]
	}
	return out
}

type AiHandler = (model: string, input: Ai_Cf_Cloudflare_Clef_Input) => Promise<unknown>

function buildHarness(options: { ai?: AiHandler; aiEnabled?: string; seed?: number } = {}) {
	const db = new DatabaseSync(':memory:')
	db.exec(LEGACY_DDL)
	const insertSmol = db.prepare('INSERT INTO Smols (Id, Title, Song_1, Public, "Address") VALUES (?, ?, ?, ?, ?)')
	for (const smol of FIXTURE.smols) insertSmol.run(smol.Id, smol.Title, `song-${smol.Id}`, smol.Public, smol.Address)
	for (let n = 1; n <= 130; n += 1) insertSmol.run(SYN(n), `Synthetic Song ${n}`, `song-${SYN(n)}`, 1, NEW_OWNER)
	insertSmol.run(PRIVATE_SYN, 'Private Song', 'song-private', 0, NEW_OWNER)
	const insertMixtape = db.prepare('INSERT INTO Mixtapes (Id, Title, Desc, Smols, "Address", Created_At) VALUES (?, ?, ?, ?, ?, ?)')
	for (const m of seededShuffle(FIXTURE.mixtapes, options.seed ?? 7)) insertMixtape.run(m.Id, m.Title, m.Desc, m.Smols, m.Address, m.Created_At)
	db.exec(MIGRATION_0002)
	db.exec(MIGRATION_0003)

	const { d1, hooks } = createSqliteD1(db)
	const edge = createMockEdgeCache()
	const heldPuts: Array<() => void> = []
	let holdPuts = false
	const realPut = edge.cache.put.bind(edge.cache)
	edge.cache.put = (async (key: RequestInfo | URL, response: Response) => {
		if (holdPuts) await new Promise<void>((resolve) => heldPuts.push(resolve))
		return realPut(key, response)
	}) as Cache['put']
	activeCache = edge.cache

	const aiCalls: Array<{ model: string; input: Ai_Cf_Cloudflare_Clef_Input }> = []
	const env = {
		SECRET: TEST_SECRET,
		SMOL_D1: d1,
		SMOL_KV: {
			get: async (keys: string | string[]) => (Array.isArray(keys) ? new Map(keys.map((k) => [k, { lyrics: { style: ['lofi'] } }])) : null),
		},
		AI: {
			run: async (model: string, input: Ai_Cf_Cloudflare_Clef_Input) => {
				aiCalls.push({ model, input })
				if (!options.ai) throw new Error('Unexpected Workers AI call')
				return options.ai(model, input)
			},
		},
		MIXTAPE_DEDUPE_AI_ENABLED: options.aiEnabled ?? 'true',
	} as unknown as Env

	/** Each request gets its own ExecutionContext; `noFlush` leaves its waitUntil work pending. */
	async function send(path: string, init: { method?: string; body?: unknown; as?: string; noFlush?: boolean; origin?: string } = {}) {
		const ctx = createMockExecutionContext()
		const headers = new Headers()
		if (init.origin) headers.set('Origin', init.origin)
		if (init.as) headers.set('Authorization', `Bearer ${init.as === 'admin' ? TEST_SECRET : await createAuthToken(init.as, TEST_SECRET)}`)
		if (init.body !== undefined) headers.set('Content-Type', 'application/json')
		const res = await appModule.app.fetch(
			new Request(`https://api.smol.xyz${path}`, {
				method: init.method ?? 'GET',
				headers,
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			}),
			env,
			ctx.ctx,
		)
		if (!init.noFlush) await ctx.flush()
		return Object.assign(res, { flush: ctx.flush })
	}
	async function json<T = any>(path: string, init: Parameters<typeof send>[1] = {}) {
		const res = await send(path, init)
		const text = await res.text()
		let body: T
		try {
			body = JSON.parse(text) as T
		} catch {
			body = text as unknown as T
		}
		return { res, status: res.status, body }
	}
	const row = (id: string) => db.prepare('SELECT * FROM Mixtapes WHERE Id = ?').get(id) as Record<string, any> | undefined
	/** Direct test-only writes must bump the epoch like every route write does. */
	const write = (sql: string, ...args: Array<string | number | null>) => {
		db.prepare(sql).run(...args)
		db.exec('UPDATE MixtapeState SET Epoch = Epoch + 1 WHERE Id = 1')
	}
	const backdate = (id: string, minutes: number) => write(`UPDATE Mixtapes SET Created_At = datetime('now', ?) WHERE Id = ?`, `-${minutes} minutes`, id)
	const epoch = () => (db.prepare('SELECT Epoch FROM MixtapeState WHERE Id = 1').get() as { Epoch: number }).Epoch
	const cache = {
		stats: edge.stats,
		keys: () => [...edge.entries.keys()],
		entries: () => [...edge.entries.entries()],
		hold: () => { holdPuts = true },
		release: () => {
			holdPuts = false
			heldPuts.splice(0).forEach((resolve) => resolve())
		},
	}

	return { db, env, send, json, row, write, backdate, epoch, aiCalls, hooks, cache }
}

function toCandidates(mixtapes: FixtureMixtape[], publicIds: Set<string>): MixtapeCandidate[] {
	return mixtapes.map((m) => {
		const stored = m.Smols.split(',')
		return { id: m.Id, address: m.Address, title: m.Title, desc: m.Desc, createdAt: m.Created_At, storedTracks: stored, publicTracks: stored.filter((id) => publicIds.has(id)) }
	})
}

const clefAnswer = (noul: number, choice = noul >= 0.5 ? 'duplicate_revision' : 'distinct_sequel_or_series') => ({
	model: 'clef-flash',
	answers: {
		is_duplicate: { type: 'noul', noul },
		relation: { type: 'choice', choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 },
	},
	usage: { input_tokens: 868, output_tokens: 0 },
})

// ---------------------------------------------------------------------------

test('migration 0002 is additive on the legacy table, backfills Updated_At, and matches fresh schema.sql', () => {
	const { db } = buildHarness()
	const legacy = db.prepare('SELECT Id, Title, Desc, Smols, "Address" AS Address, Created_At, Updated_At, Visibility, Revision, Deleted_At, Hidden_Reason FROM Mixtapes').all() as Array<Record<string, any>>
	assert.equal(legacy.length, 18)
	for (const m of legacy) {
		const original = byId(m.Id)
		assert.deepEqual([m.Title, m.Desc, m.Smols, m.Address, m.Created_At], [original.Title, original.Desc, original.Smols, original.Address, original.Created_At], 'legacy columns & CSV Smols untouched')
		assert.equal(m.Updated_At, m.Created_At, 'Updated_At backfilled from Created_At')
		assert.deepEqual([m.Visibility, m.Revision, m.Deleted_At, m.Hidden_Reason], ['public', 1, null, null])
	}

	const fresh = new DatabaseSync(':memory:')
	fresh.exec(SCHEMA_SQL)
	fresh.prepare('INSERT INTO Mixtapes (Title, Desc, Smols, "Address") VALUES (?, ?, ?, ?)').run('Fresh', '', SYN(1), NEW_OWNER)
	assert.deepEqual({ ...(fresh.prepare('SELECT Visibility, Revision, Hidden_Reason FROM Mixtapes').get() as object) }, { Visibility: 'public', Revision: 1, Hidden_Reason: null })
	const columns = (target: DatabaseSync) => (target.prepare('PRAGMA table_info(Mixtapes)').all() as Array<Record<string, unknown>>)
		.map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }))
	assert.deepEqual(columns(db), columns(fresh), 'schema.sql mirrors migrated columns exactly')
	const indexes = (target: DatabaseSync) => (target.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'Mixtapes' AND name LIKE 'idx_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name)
	assert.deepEqual(indexes(db), ['idx_mixtapes_address_created', 'idx_mixtapes_created', 'idx_mixtapes_visibility_created'])
	assert.deepEqual(indexes(fresh), indexes(db))
	const epochObjects = (target: DatabaseSync) => (target.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name IN ('MixtapeState', 'MixtapeRetryClaim', 'idx_mixtape_retry_claim_created') OR name LIKE 'trg_mixtape_epoch_%' ORDER BY name`).all() as Array<Record<string, string>>).map((r) => `${r.type}:${r.name}:${r.sql.replace(/\s+/g, ' ')}`)
	assert.deepEqual(epochObjects(db).map((o) => o.split(':').slice(0, 2).join(':')), ['table:MixtapeRetryClaim', 'table:MixtapeState', 'index:idx_mixtape_retry_claim_created', 'trigger:trg_mixtape_epoch_smol_delete', 'trigger:trg_mixtape_epoch_smol_insert', 'trigger:trg_mixtape_epoch_smol_mint', 'trigger:trg_mixtape_epoch_smol_public'])
	assert.throws(() => db.exec('UPDATE MixtapeState SET Epoch = -1'), /CHECK constraint failed/, 'the epoch CHECK is the batch abort switch')
	assert.deepEqual(epochObjects(fresh), epochObjects(db))
	const epochOf = (target: DatabaseSync) => (target.prepare('SELECT Epoch FROM MixtapeState WHERE Id = 1').get() as { Epoch: number }).Epoch
	const before = epochOf(db)
	db.exec(`UPDATE Smols SET Public = 0 WHERE Id = '${FIXTURE.smols[0].Id}'`)
	db.exec(`UPDATE Smols SET Title = 'renamed' WHERE Id = '${FIXTURE.smols[0].Id}'`)
	assert.equal(epochOf(db), before + 1, 'privacy flips bump the epoch; unrelated column updates do not')

	for (const target of [db, fresh]) {
		for (const bad of [`Visibility = 'hidden'`, `Hidden_Reason = 'spam'`, 'Uniqueness_Score = 101', 'Revision = 0']) {
			assert.throws(() => target.exec(`UPDATE Mixtapes SET ${bad}`), /CHECK constraint failed/, bad)
		}
	}
})

test('Tier 1 on the 18-row production fixture: 15 public / 3 owner-only in any order, Pre-Party preserved, cross-owner never hides', () => {
	const publicIds = new Set(FIXTURE.smols.filter((s) => s.Public).map((s) => s.Id))
	const expected = new Map([
		[CORDOVA_RETRY, { hiddenReason: 'duplicate', relatedId: CORDOVA }],
		[CREASY_V1, { hiddenReason: 'superseded', relatedId: CREASY_V2 }],
		[OUR_DECEMBER, { hiddenReason: 'empty', relatedId: null }],
	])

	for (let seed = 1; seed <= 25; seed += 1) {
		const candidates = toCandidates(seededShuffle(FIXTURE.mixtapes, seed), publicIds)
		const decisions = classifyOwnerMixtapes(candidates)
		const hidden = [...decisions.values()].filter((d) => d.visibility === 'owner')
		assert.equal(decisions.size - hidden.length, 15, `seed ${seed}: 15 public`)
		assert.deepEqual(new Map(hidden.map((d) => [d.id, { hiddenReason: d.hiddenReason, relatedId: d.relatedId }])), expected)
		assert.equal(decisions.get(PRE_PARTY)!.visibility, 'public', 'Pre-Party (100% inside a cross-owner anthology) stays public')
		assert.equal(findBorderlinePair(candidates, decisions), null, 'zero prod pairs in the borderline band')
		for (const d of decisions.values()) assert.ok(d.uniquenessScore === null || (d.uniquenessScore >= 0 && d.uniquenessScore <= 100))
	}

	// A verbatim cross-owner copy of Cordova (later, same title/desc/tracks) never hides either side.
	const cordova = byId(CORDOVA)
	const copy = { ...cordova, Id: 'ffff000000000001', Address: OTHER_OWNER, Created_At: '2026-05-01 00:00:00' }
	const withCopy = classifyOwnerMixtapes(toCandidates([...FIXTURE.mixtapes, copy], publicIds))
	assert.equal(withCopy.get(copy.Id)!.visibility, 'public')
	assert.equal(withCopy.get(CORDOVA)!.visibility, 'public')
	assert.equal(withCopy.get(CORDOVA)!.uniquenessScore, 100, 'cross-owner overlap cannot reduce the score')

	// Synthetic same-owner rules: overlap (J = 0.8, equal size keeps newer), too_few, borderline bands.
	const mk = (id: string, tracks: number[], createdAt: string, title = id): MixtapeCandidate => ({
		id, address: NEW_OWNER, title, desc: '', createdAt, publicTracks: tracks.map(SYN),
	})
	const overlap = classifyOwnerMixtapes([
		mk('a', [1, 2, 3, 4, 5, 6, 7, 8, 9], '2026-01-01 00:00:00'),
		mk('b', [1, 2, 3, 4, 5, 6, 7, 8, 10], '2026-01-02 00:00:00'),
		mk('c', [50], '2026-01-03 00:00:00'),
	])
	assert.deepEqual([overlap.get('a')!.hiddenReason, overlap.get('a')!.relatedId, overlap.get('a')!.uniquenessScore], ['overlap', 'b', 20])
	assert.equal(overlap.get('b')!.visibility, 'public')
	assert.equal(overlap.get('c')!.hiddenReason, 'too_few')
	assert.match(overlap.get('c')!.advice!, /Add 1 more song/)

	const jaccardPair = [mk('j1', [1, 2, 3, 4, 5], '2026-01-01 00:00:00'), mk('j2', [1, 2, 3, 4, 6, 7, 8], '2026-01-02 00:00:00')]
	assert.equal(findBorderlinePair(jaccardPair, classifyOwnerMixtapes(jaccardPair), 'j2')?.trigger, 'jaccard')
	const containmentPair = [mk('k1', [1, 2, 3, 4], '2026-01-01 00:00:00'), mk('k2', [1, 2, 3, 20, 21, 22, 23], '2026-01-02 00:00:00')]
	assert.equal(findBorderlinePair(containmentPair, classifyOwnerMixtapes(containmentPair))?.trigger, 'containment')
	const reorderPair = [mk('r1', [1, 2], '2026-01-01 00:00:00', 'Same'), mk('r2', [2, 1], '2026-01-02 00:00:00', 'Same')]
	assert.equal(findBorderlinePair(reorderPair, classifyOwnerMixtapes(reorderPair))?.trigger, 'same_set_changed')
})

test('GET / vs GET /mine vs GET /:id: visibility, caching headers, and live Smols.Public re-derivation', async () => {
	const h = buildHarness({ seed: 11 })

	const list = await h.json<Array<Record<string, any>>>('/mixtapes')
	assert.equal(list.status, 200)
	assert.equal(list.body.length, 15)
	assert.ok(HIDDEN_IDS.every((id) => !list.body.some((m) => m.Id === id)), 'hidden rows never listed')
	assert.ok(list.body.some((m) => m.Id === PRE_PARTY))
	assert.deepEqual(list.body.map((m) => m.Created_At), [...list.body.map((m) => m.Created_At)].sort().reverse(), 'newest first')
	assert.equal(list.body.find((m) => m.Id === '807e0a11b827b1e3')!.Smols.length, 11, 'private song slots never exposed')
	assert.deepEqual(Object.keys(list.body[0]).sort(), ['Address', 'Created_At', 'Desc', 'Id', 'Smols', 'Title', 'Updated_At'])
	assert.equal(list.res.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate', 'browsers revalidate synchronously (no SWR window)')
	assert.equal(list.res.headers.get('CDN-Cache-Control'), 'public, s-maxage=60, stale-while-revalidate=120', 'edge policy only')
	assert.equal(list.res.headers.get('Cache-Tag'), 'mixtapes')
	assert.ok(openedCacheNames.has('smol-workflow-mixtapes-v2') && !openedCacheNames.has('smol-workflow'), 'fresh v2 namespace')
	assert.deepEqual(h.cache.keys(), [`https://api.smol.xyz/mixtapes?__mx_epoch=${h.epoch()}`], 'edge key carries the committed epoch')
	const hit = await h.send('/mixtapes?__mx_epoch=999')
	assert.equal(h.cache.stats.hits, 1, 'unchanged epoch is a hit; client-supplied epoch params are ignored')
	assert.equal(hit.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate', 'cache hits also carry the browser policy')
	assert.equal(hit.headers.get('CDN-Cache-Control'), 'public, s-maxage=60, stale-while-revalidate=120')
	assert.equal(new Headers(h.cache.entries()[0][1].headers).get('Cache-Control'), 'public, max-age=60, s-maxage=60', 'the Worker Cache API copy carries the edge TTL')
	const detailHeaders = (await h.send(`/mixtapes/${CORDOVA}`)).headers
	assert.deepEqual([detailHeaders.get('Cache-Control'), detailHeaders.get('CDN-Cache-Control')], ['public, max-age=0, must-revalidate', 'public, s-maxage=60, stale-while-revalidate=120'])
	assert.equal(((await hit.json()) as unknown[]).length, 15)

	assert.equal((await h.send('/mixtapes/mine')).status, 401)
	assert.equal((await h.send('/mixtapes/mine', { as: 'admin' })).status, 401, 'admin token has no owner subject')
	const mine = await h.json<Array<Record<string, any>>>('/mixtapes/mine', { as: CREASY_OWNER })
	assert.equal(mine.status, 200)
	assert.equal(mine.res.headers.get('Cache-Control'), 'private, no-store')
	assert.deepEqual(mine.body.map((m) => m.Id), [CREASY_V2, CREASY_V1])
	const v1 = mine.body[1]
	assert.deepEqual(
		[v1.Visibility, v1.Hidden_Reason, v1.Related_Mixtape_Id, v1.Related_Mixtape_Title, v1.Uniqueness_Score, v1.Revision, v1.Stored_Track_Count, v1.Public_Track_Count],
		['owner', 'superseded', CREASY_V2, 'Creasy Drops', 0, 1, 1, 1],
	)
	assert.match(v1.Advice, /“Creasy Drops”/)
	assert.equal(mine.body[0].Visibility, 'public')
	assert.equal(mine.body[0].Advice, null)
	assert.ok(!h.cache.keys().some((key) => key.includes('/mine')), '/mine never enters the shared cache')

	const december = (await h.json<Array<Record<string, any>>>('/mixtapes/mine', { as: PRE_PARTY_OWNER })).body.find((m) => m.Id === OUR_DECEMBER)!
	assert.deepEqual([december.Hidden_Reason, december.Stored_Track_Count, december.Public_Track_Count, december.Uniqueness_Score], ['empty', 1, 0, null])

	const detail = await h.json<Record<string, any>>(`/mixtapes/${CORDOVA_RETRY}`)
	assert.equal(detail.status, 200, 'hidden mixtape stays a playable unlisted link')
	assert.deepEqual([detail.body.Visibility, detail.body.Hidden_Reason, detail.body.Related_Mixtape_Id, detail.body.Smols.length], ['owner', 'duplicate', CORDOVA, 3])
	assert.deepEqual(detail.body.Smols[0].Tags, ['lofi'])
	assert.equal(detail.res.headers.get('X-Robots-Tag'), 'noindex')
	assert.match(detail.res.headers.get('Cache-Tag')!, new RegExp(`mixtape:${CORDOVA_RETRY}`))
	assert.equal((await h.send(`/mixtapes/${CORDOVA}`)).headers.get('X-Robots-Tag'), null)
	assert.equal((await h.send('/mixtapes/doesnotexist')).status, 404)

	// Songs made private AFTER publish: the legacy (persisted 'public') row is hidden dynamically.
	const prePartySmols = byId(PRE_PARTY).Smols.split(',')
	h.db.prepare(`UPDATE Smols SET Public = 0 WHERE Id IN (${prePartySmols.map(() => '?').join(',')})`).run(...prePartySmols)
	assert.equal(h.row(PRE_PARTY)!.Visibility, 'public', 'persisted value is stale on purpose')
	const afterPrivate = await h.json<Array<Record<string, any>>>('/mixtapes')
	assert.equal(afterPrivate.body.length, 14)
	assert.ok(!afterPrivate.body.some((m) => m.Id === PRE_PARTY))
	assert.equal((await h.json(`/mixtapes/${PRE_PARTY}`)).body.Hidden_Reason, 'empty')
	h.db.prepare(`UPDATE Smols SET Public = 1 WHERE Id IN (${prePartySmols.map(() => '?').join(',')})`).run(...prePartySmols)
	assert.equal((await h.json<unknown[]>('/mixtapes')).body.length, 15, 'auto-relists when songs return')

	assert.equal(h.aiCalls.length, 0, 'zero inference on GET routes')
})

test('POST /mixtapes: B-26 optional desc, 15-minute idempotent retry, later copies hidden, 1-track too_few', async () => {
	const h = buildHarness()
	assert.equal((await h.send('/mixtapes', { method: 'POST', body: { title: 'x', smols: [SYN(1)] } })).status, 401)
	assert.equal((await h.send('/mixtapes', { method: 'POST', as: 'admin', body: { title: 'x', smols: [SYN(1)] } })).status, 401)

	purgedTagBatches.length = 0
	const created = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Night Drive', smols: [SYN(1), SYN(2), SYN(3)] } })
	assert.equal(created.status, 201, 'omitted desc accepted (B-26)')
	assert.deepEqual([created.body.visibility, created.body.hiddenReason, created.body.revision, created.body.deduplicated], ['public', null, 1, false])
	assert.equal(h.row(created.body.id)!.Desc, '')
	assert.ok(purgedTagBatches.flat().includes('mixtapes') && purgedTagBatches.flat().includes(`mixtape:${created.body.id}`))
	assert.equal(created.res.headers.get('Cache-Control'), 'private, no-store')

	const emptyDesc = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Sunrise', desc: '', smols: [SYN(10), SYN(11)] } })
	assert.equal(emptyDesc.status, 201, 'empty desc accepted (B-26)')
	assert.equal((await h.send('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'x', desc: 5, smols: [SYN(1)] } })).status, 400)
	assert.equal((await h.send('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: '   ', smols: [SYN(1)] } })).status, 400)
	assert.equal((await h.send('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'x', smols: [SYN(1), PRIVATE_SYN] } })).status, 400)

	const countRows = () => (h.db.prepare('SELECT COUNT(*) AS n FROM Mixtapes').get() as { n: number }).n
	const before = countRows()
	const retry = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: '  night   DRIVE ', desc: null, smols: [SYN(1), SYN(2), SYN(3)] } })
	assert.equal(retry.status, 200, 'double-tap within 15 minutes is idempotent')
	assert.deepEqual([retry.body.id, retry.body.deduplicated, retry.body.visibility], [created.body.id, true, 'public'])
	assert.equal(countRows(), before)

	h.backdate(created.body.id, 20)
	const later = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Night Drive', smols: [SYN(1), SYN(2), SYN(3)] } })
	assert.equal(later.status, 201, 'outside the window a new row is created…')
	assert.deepEqual([later.body.visibility, later.body.hiddenReason, later.body.relatedMixtapeId, later.body.relatedMixtapeTitle], ['owner', 'duplicate', created.body.id, 'Night Drive'])
	assert.ok(!(await h.json<Array<{ Id: string }>>('/mixtapes')).body.some((m) => m.Id === later.body.id), '…but only the earliest is listed')
	assert.equal(h.row(later.body.id)!.Hidden_Reason, 'duplicate', 'decision persisted')

	const single = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'One Song', smols: [SYN(20)] } })
	assert.deepEqual([single.status, single.body.visibility, single.body.hiddenReason], [201, 'owner', 'too_few'])
	assert.match(single.body.advice, /Add 1 more song/)
	assert.equal(h.aiCalls.length, 0)
})

test('PUT/PATCH: owner-only, 409 revision_conflict snapshot, and editing a hidden duplicate relists it', async () => {
	const h = buildHarness()
	const patch = (id: string, body: unknown, as?: string) => h.json(`/mixtapes/${id}`, { method: 'PATCH', as, body })

	assert.equal((await patch(CORDOVA_RETRY, { title: 'x' })).status, 401)
	assert.equal((await patch(CORDOVA_RETRY, { title: 'x' }, CREASY_OWNER)).status, 403)
	assert.equal((await patch('doesnotexist', { title: 'x' }, CORDOVA_OWNER)).status, 404)
	assert.equal((await patch(CORDOVA_RETRY, {}, CORDOVA_OWNER)).status, 400)

	const conflict = await patch(CORDOVA_RETRY, { title: 'Stale', expectedRevision: 3 }, CORDOVA_OWNER)
	assert.equal(conflict.status, 409)
	assert.equal(conflict.body.code, 'revision_conflict')
	assert.deepEqual([conflict.body.current.Id, conflict.body.current.Revision, conflict.body.current.Hidden_Reason], [CORDOVA_RETRY, 1, 'duplicate'])
	assert.equal(h.row(CORDOVA_RETRY)!.Title, byId(CORDOVA_RETRY).Title, 'conflict writes nothing')

	purgedTagBatches.length = 0
	const relisted = await patch(CORDOVA_RETRY, { smols: [SYN(30), SYN(31), SYN(32)], expectedRevision: 1 }, CORDOVA_OWNER)
	assert.equal(relisted.status, 200)
	assert.deepEqual([relisted.body.visibility, relisted.body.hiddenReason, relisted.body.revision], ['public', null, 2])
	assert.equal(relisted.body.mixtape.Title, byId(CORDOVA_RETRY).Title, 'PATCH keeps omitted fields')
	assert.deepEqual(relisted.body.mixtape.Smols, [SYN(30), SYN(31), SYN(32)])
	assert.notEqual(h.row(CORDOVA_RETRY)!.Updated_At, h.row(CORDOVA_RETRY)!.Created_At)
	assert.ok(purgedTagBatches.flat().includes(`mixtape:${CORDOVA_RETRY}`))
	const list = (await h.json<Array<{ Id: string }>>('/mixtapes')).body
	assert.equal(list.length, 16)
	assert.ok(list.some((m) => m.Id === CORDOVA_RETRY) && list.some((m) => m.Id === CORDOVA))

	assert.equal((await patch(CORDOVA_RETRY, { title: 'Again', expectedRevision: 1 }, CORDOVA_OWNER)).status, 409, 'stale revision after a successful edit')

	assert.equal((await h.send(`/mixtapes/${CORDOVA_RETRY}`, { method: 'PUT', as: CORDOVA_OWNER, body: { title: 'No songs' } })).status, 400, 'PUT is a full replace')
	const put = await h.json(`/mixtapes/${CORDOVA_RETRY}`, { method: 'PUT', as: CORDOVA_OWNER, body: { title: 'Cordova Remixed', smols: [SYN(33), SYN(34)], expectedRevision: 2 } })
	assert.deepEqual([put.status, put.body.revision, put.body.mixtape.Desc, put.body.mixtape.Title], [200, 3, '', 'Cordova Remixed'])
	assert.equal(h.aiCalls.length, 0)
})

test('DELETE soft-deletes and promotes the eligible sibling; restore undoes it', async () => {
	const h = buildHarness()
	assert.equal((await h.send(`/mixtapes/${CORDOVA}`, { method: 'DELETE', as: CREASY_OWNER })).status, 403)

	const deleted = await h.json(`/mixtapes/${CORDOVA}`, { method: 'DELETE', as: CORDOVA_OWNER })
	assert.deepEqual([deleted.status, deleted.body], [200, { id: CORDOVA, deleted: true, undoable: true }])
	assert.deepEqual([h.row(CORDOVA)!.Visibility, h.row(CORDOVA)!.Hidden_Reason, h.row(CORDOVA)!.Revision], ['deleted', 'deleted', 2])
	assert.ok(h.row(CORDOVA)!.Deleted_At)
	assert.equal(h.row(CORDOVA)!.Smols, byId(CORDOVA).Smols, 'track references kept for undo')

	const list = (await h.json<Array<{ Id: string }>>('/mixtapes')).body
	assert.ok(list.some((m) => m.Id === CORDOVA_RETRY), 'retry copy promoted to public')
	assert.ok(!list.some((m) => m.Id === CORDOVA))
	assert.equal(h.row(CORDOVA_RETRY)!.Visibility, 'public', 'promotion persisted')
	const gone = await h.json(`/mixtapes/${CORDOVA}`)
	assert.deepEqual([gone.status, gone.body.code], [404, undefined])
	assert.ok(!(await h.json<Array<{ Id: string }>>('/mixtapes/mine', { as: CORDOVA_OWNER })).body.some((m) => m.Id === CORDOVA))
	assert.equal((await h.send(`/mixtapes/${CORDOVA}`, { method: 'DELETE', as: CORDOVA_OWNER })).status, 200, 'repeat delete is idempotent')
	assert.equal((await h.send(`/mixtapes/${CORDOVA}`, { method: 'PATCH', as: CORDOVA_OWNER, body: { title: 'x' } })).status, 404, 'deleted rows are not editable')

	assert.equal((await h.send(`/mixtapes/${CORDOVA}/restore`, { method: 'POST', as: CREASY_OWNER })).status, 403)
	const restored = await h.json(`/mixtapes/${CORDOVA}/restore`, { method: 'POST', as: CORDOVA_OWNER })
	assert.deepEqual([restored.status, restored.body.visibility, restored.body.restored, restored.body.revision], [200, 'public', true, 3])
	assert.equal(h.row(CORDOVA)!.Deleted_At, null)
	const afterRestore = (await h.json<Array<{ Id: string }>>('/mixtapes')).body
	assert.ok(afterRestore.some((m) => m.Id === CORDOVA) && !afterRestore.some((m) => m.Id === CORDOVA_RETRY), 'earliest is canonical again')
	assert.equal(h.row(CORDOVA_RETRY)!.Hidden_Reason, 'duplicate')
})

test('merge: owner of both, appends unique public songs, 404 mergedInto redirect, >100 guard', async () => {
	const h = buildHarness()
	const merge = (source: string, body: unknown, as: string | null = CREASY_OWNER) => h.json(`/mixtapes/${source}/merge`, { method: 'POST', as: as ?? undefined, body })

	assert.equal((await merge(CREASY_V1, { targetId: CREASY_V2 }, null)).status, 401)
	assert.equal((await merge(CREASY_V1, { targetId: CREASY_V1 })).status, 400, 'self-merge rejected')
	assert.equal((await merge(CREASY_V1, {})).status, 400)
	assert.equal((await merge(CREASY_V1, { targetId: CORDOVA })).status, 403, 'target must be owned too')
	assert.equal((await merge(CORDOVA, { targetId: CREASY_V2 })).status, 403, 'source must be owned too')

	purgedTagBatches.length = 0
	const merged = await merge(CREASY_V1, { targetId: CREASY_V2 })
	assert.equal(merged.status, 200)
	assert.deepEqual([merged.body.targetId, merged.body.mergedId, merged.body.addedCount, merged.body.totalTracks], [CREASY_V2, CREASY_V1, 0, 3])
	assert.deepEqual([merged.body.target.Visibility, merged.body.target.Revision], ['public', 2])
	assert.ok([`mixtape:${CREASY_V1}`, `mixtape:${CREASY_V2}`, 'mixtapes'].every((tag) => purgedTagBatches.flat().includes(tag)))
	const source = await h.json(`/mixtapes/${CREASY_V1}`)
	assert.deepEqual([source.status, source.body.code, source.body.mergedInto], [404, 'mixtape_merged', CREASY_V2])
	assert.equal((await h.json(`/mixtapes/${CREASY_V1}/restore`, { method: 'POST', as: CREASY_OWNER })).status, 409, 'merged sources are not restorable')
	assert.deepEqual((await h.json<Array<{ Id: string }>>('/mixtapes/mine', { as: CREASY_OWNER })).body.map((m) => m.Id), [CREASY_V2])

	// P1-5: a source song that is not public (and not already on the target) would be lost
	// forever once the source is tombstoned → 409 with a count, nothing written.
	const create = async (title: string, smols: string[]) => (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title, smols } })).body.id as string
	const a = await create('Alpha', [SYN(1), SYN(2), SYN(3)])
	const b = await create('Beta', [SYN(3), SYN(4), SYN(5)])
	h.write('UPDATE Mixtapes SET Smols = ? WHERE Id = ?', [SYN(3), PRIVATE_SYN, SYN(4), SYN(5)].join(','), b)
	const stranded = await merge(b, { targetId: a, title: 'Alpha + Beta' }, NEW_OWNER)
	assert.deepEqual([stranded.status, stranded.body.code, stranded.body.unavailableCount], [409, 'merge_unavailable_tracks', 1])
	assert.equal(stranded.res.headers.get('Cache-Control'), 'private, no-store')
	assert.deepEqual([h.row(b)!.Deleted_At, h.row(b)!.Revision, h.row(a)!.Revision], [null, 1, 1], 'nothing written')

	// Once the owner removes it, the merge appends only songs the target lacks, in source order.
	assert.equal((await h.send(`/mixtapes/${b}`, { method: 'PATCH', as: NEW_OWNER, body: { smols: [SYN(3), SYN(4), SYN(5)] } })).status, 200)
	const ab = await merge(b, { targetId: a, title: 'Alpha + Beta' }, NEW_OWNER)
	assert.deepEqual([ab.status, ab.body.addedCount, ab.body.totalTracks, ab.body.target.Title], [200, 2, 5, 'Alpha + Beta'])
	assert.equal(h.row(a)!.Smols, [SYN(1), SYN(2), SYN(3), SYN(4), SYN(5)].join(','))

	// Merging the target onward flattens the older alias (b → c directly, one hop).
	const c = await create('Gamma', [SYN(40), SYN(41)])
	assert.equal((await merge(a, { targetId: c }, NEW_OWNER)).status, 200)
	assert.equal(h.row(b)!.Related_Mixtape_Id, c, 'alias flattened transactionally')
	assert.equal((await h.json(`/mixtapes/${b}`)).body.mergedInto, c)

	const big = await create('Big', Array.from({ length: 60 }, (_, i) => SYN(i + 50)))
	const big2 = await create('Big Two', Array.from({ length: 50 }, (_, i) => SYN(i + 1)))
	const tooMany = await merge(big2, { targetId: big }, NEW_OWNER)
	assert.equal(tooMany.status, 400)
	assert.match(String(tooMany.body), /max 100/)
	assert.equal(h.row(big2)!.Deleted_At, null, 'rejected merge writes nothing')
})

test('POST /check-uniqueness is Tier 1 only: zero AI, zero writes, impacts and borderline flags', async () => {
	const h = buildHarness({ ai: async () => clefAnswer(0.99) })
	const check = (body: unknown, as = CORDOVA_OWNER) => h.json('/mixtapes/check-uniqueness', { method: 'POST', as, body })
	const snapshot = () => JSON.stringify(h.db.prepare('SELECT * FROM Mixtapes ORDER BY Id').all())
	const before = snapshot()
	const cordova = byId(CORDOVA)

	assert.equal((await h.send('/mixtapes/check-uniqueness', { method: 'POST', body: {} })).status, 401)
	const dup = await check({ title: cordova.Title, desc: cordova.Desc, smols: cordova.Smols.split(',') })
	assert.equal(dup.res.headers.get('Cache-Control'), 'private, no-store')
	assert.deepEqual(
		[dup.body.willBeListed, dup.body.visibility, dup.body.hiddenReason, dup.body.matchedMixtape, dup.body.uniquenessScore],
		[false, 'owner', 'duplicate', { id: CORDOVA, title: cordova.Title }, 0],
	)
	assert.match(dup.body.advice, /exact copy/)

	const fresh = await check({ title: 'Brand New', smols: [SYN(1), SYN(2)] })
	assert.deepEqual([fresh.body.willBeListed, fresh.body.hiddenReason, fresh.body.isBorderline, fresh.body.impacts], [true, null, false, []])
	assert.equal((await check({ smols: [SYN(1)] })).body.hiddenReason, 'too_few', 'untitled draft can be previewed')
	assert.equal((await check({ title: 'Empty', smols: [] })).body.hiddenReason, 'empty')

	const superset = await check({ title: 'Cordova Deluxe', smols: [...cordova.Smols.split(','), SYN(9)] })
	assert.equal(superset.body.willBeListed, true)
	assert.deepEqual(superset.body.impacts.find((i: any) => i.id === CORDOVA), { id: CORDOVA, title: cordova.Title, visibility: 'owner', hiddenReason: 'superseded' })
	assert.equal(superset.body.impacts.find((i: any) => i.id === CORDOVA_RETRY)?.hiddenReason, 'superseded', 'retry copy re-points at the new keeper (no chain)')

	const borderline = await check({ title: 'Cordova Mix', smols: [...cordova.Smols.split(',').slice(0, 2), SYN(7)] })
	assert.deepEqual([borderline.body.willBeListed, borderline.body.isBorderline, borderline.body.borderlineMixtape?.id], [true, true, CORDOVA])

	const edit = await check({ id: CORDOVA_RETRY, smols: [SYN(5), SYN(6)] })
	assert.deepEqual([edit.body.willBeListed, edit.body.hiddenReason], [true, null], 'edit preview: fixing a hidden duplicate relists it')
	assert.equal((await check({ id: CORDOVA_RETRY, smols: [SYN(5), SYN(6)] }, CREASY_OWNER)).status, 403)

	assert.equal(h.aiCalls.length, 0, 'zero inference')
	assert.equal(snapshot(), before, 'zero writes')
})

test('Tier 2 clef-flash on write: duplicate hides the weaker sibling, unique keeps both, timeout/invalid/disabled fail open', async () => {
	const A = [1, 2, 3, 4, 5].map(SYN)
	const B = [1, 2, 3, 4, 6, 7, 8].map(SYN) // J = 4/8 = 0.5, max containment = 0.8 → borderline
	async function seedPair(h: ReturnType<typeof buildHarness>) {
		const a = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Late Night Drafts', desc: 'v1', smols: A } })).body.id as string
		h.backdate(a, 60)
		const b = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Late Night Drafts (final)', desc: 'v2', smols: B } })
		return { a, b }
	}

	// Duplicate verdict.
	{
		const h = buildHarness({ ai: async () => clefAnswer(0.82) })
		const { a, b } = await seedPair(h)
		assert.equal(b.status, 201)
		assert.equal(h.aiCalls.length, 1, 'exactly one call for the top-1 borderline pair')
		const call = h.aiCalls[0]
		assert.equal(call.model, '@cf/cloudflare/clef-flash')
		assert.equal(call.input.model, 'clef-flash')
		assert.deepEqual(Object.keys(call.input.questions), ['is_duplicate', 'relation'])
		const state = call.input.state as any
		assert.deepEqual([state.existing_mixtape.title, state.candidate_mixtape.title, state.relationship_metrics.shared_track_count, state.relationship_metrics.track_jaccard], ['Late Night Drafts', 'Late Night Drafts (final)', 4, 0.5])
		assert.equal(state.shared_tracks_sample[0], 'Synthetic Song 1', 'song titles, never wallet addresses')
		assert.ok(!JSON.stringify(call.input).includes(NEW_OWNER))

		assert.equal(b.body.visibility, 'public', 'larger/newer keeper stays listed')
		const hidden = h.row(a)!
		assert.deepEqual([hidden.Visibility, hidden.Hidden_Reason, hidden.Related_Mixtape_Id], ['owner', 'semantic_duplicate', b.body.id])
		const receipt = JSON.parse(hidden.Ai_Verdict)
		assert.deepEqual([receipt.model, receipt.p, receipt.dup, receipt.rel, receipt.keep, receipt.hidden], ['clef-flash', 0.82, true, 'duplicate_revision', b.body.id, a])

		assert.ok(!(await h.json<Array<{ Id: string }>>('/mixtapes')).body.some((m) => m.Id === a), 'persisted verdict honoured on public GET')
		const mine = (await h.json<Array<Record<string, any>>>('/mixtapes/mine', { as: NEW_OWNER })).body.find((m) => m.Id === a)!
		assert.deepEqual([mine.Hidden_Reason, mine.Related_Mixtape_Title, mine.Uniqueness_Score], ['semantic_duplicate', 'Late Night Drafts (final)', 18])
		assert.match(mine.Advice, /another version/)
		assert.equal((await h.json(`/mixtapes/${a}`)).body.Hidden_Reason, 'semantic_duplicate')
		await h.json('/mixtapes/check-uniqueness', { method: 'POST', as: NEW_OWNER, body: { title: 'x', smols: B } })
		assert.equal(h.aiCalls.length, 1, 'GET and check-uniqueness never infer')

		// Editing the hidden draft invalidates its receipt and re-adjudicates once.
		const edited = await h.json(`/mixtapes/${a}`, { method: 'PATCH', as: NEW_OWNER, body: { desc: 'reworked' } })
		assert.equal(edited.status, 200)
		assert.equal(h.aiCalls.length, 2)
		assert.equal(edited.body.hiddenReason, 'semantic_duplicate')

		// Deleting the keeper relists the semantic duplicate (no stale pointer).
		await h.send(`/mixtapes/${b.body.id}`, { method: 'DELETE', as: NEW_OWNER })
		assert.equal(h.row(a)!.Visibility, 'public')
		assert.equal(h.aiCalls.length, 2, 'DELETE re-evaluates with Tier 1 only')
	}

	// Unique verdict.
	{
		const h = buildHarness({ ai: async () => clefAnswer(0.08) })
		const { a, b } = await seedPair(h)
		assert.equal(h.aiCalls.length, 1)
		assert.equal(b.body.visibility, 'public')
		assert.equal(h.row(a)!.Visibility, 'public')
		const receipt = JSON.parse(h.row(b.body.id)!.Ai_Verdict)
		assert.deepEqual([receipt.dup, receipt.p, receipt.hidden], [false, 0.08, null])
		assert.equal((await h.json<unknown[]>('/mixtapes')).body.length, 17)
	}

	// Fail-open: timeout (hard 1500 ms), invalid payload, thrown error, and the kill switch.
	const failures: Array<[string, Parameters<typeof buildHarness>[0], string | null]> = [
		['timeout', { ai: () => new Promise(() => {}) }, 'timeout'],
		['invalid', { ai: async () => clefAnswer(1.7) }, 'invalid_response'],
		['error', { ai: async () => { throw new Error('3040: capacity exceeded') } }, 'error'],
		['disabled', { aiEnabled: 'false', ai: async () => clefAnswer(0.99) }, null],
	]
	for (const [label, options, fallback] of failures) {
		const h = buildHarness(options)
		const startedAt = Date.now()
		const { a, b } = await seedPair(h)
		assert.equal(b.status, 201, `${label}: write never fails`)
		assert.equal(b.body.visibility, 'public', `${label}: Tier 1 decision stands`)
		assert.equal(h.row(a)!.Visibility, 'public')
		assert.equal(h.aiCalls.length, label === 'disabled' ? 0 : 1)
		const verdict = h.row(b.body.id)!.Ai_Verdict
		assert.equal(verdict ? JSON.parse(verdict).fallback : null, fallback)
		if (label === 'timeout') assert.ok(Date.now() - startedAt < 4000, 'bounded by the 1.5 s timeout')
	}
})

// ---------------------------------------------------------------------------
// Regressions from reports/25b-review-mixtape-be.md
// ---------------------------------------------------------------------------

function assertNoHiddenKeepers(decisions: Map<string, MixtapeDecision>, label: string) {
	for (const decision of decisions.values()) {
		if (decision.relatedId) assert.equal(decisions.get(decision.relatedId)?.visibility, 'public', `${label}: ${decision.id} → ${decision.relatedId} must point at a listed keeper`)
	}
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('P1-1 / P2-6: a concurrent target edit makes merge 409 without tombstoning the source; long merge chains stay one hop', async () => {
	const h = buildHarness()
	let injected = false
	h.hooks.onStatement = (sql) => {
		if (!injected && sql.includes(`Hidden_Reason = 'merged', Related_Mixtape_Id = ?1`)) {
			injected = true
			// Another tab renames the target between this request's read and its batch.
			h.db.prepare(`UPDATE Mixtapes SET Title = 'Renamed elsewhere', Revision = Revision + 1 WHERE Id = ?`).run(CREASY_V2)
		}
	}
	const raced = await h.json(`/mixtapes/${CREASY_V1}/merge`, { method: 'POST', as: CREASY_OWNER, body: { targetId: CREASY_V2, title: 'Requested title' } })
	h.hooks.onStatement = undefined
	assert.equal(injected, true)
	assert.deepEqual([raced.status, raced.body.code, raced.body.current?.Title], [409, 'revision_conflict', 'Renamed elsewhere'])
	assert.deepEqual([h.row(CREASY_V1)!.Deleted_At, h.row(CREASY_V1)!.Visibility, h.row(CREASY_V1)!.Related_Mixtape_Id, h.row(CREASY_V1)!.Revision], [null, 'public', null, 1], 'source untouched (not tombstoned, still editable)')
	assert.equal(h.row(CREASY_V2)!.Title, 'Renamed elsewhere', 'requested title never applied')
	const retried = await h.json(`/mixtapes/${CREASY_V1}/merge`, { method: 'POST', as: CREASY_OWNER, body: { targetId: CREASY_V2 } })
	assert.equal(retried.status, 200, 'a fresh retry succeeds')

	// Twelve sequential merges: every older alias is flattened to the live terminal target.
	const ids: string[] = []
	for (let i = 0; i < 13; i += 1) {
		ids.push((await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: `Chain ${i}`, smols: [SYN(2 * i + 1), SYN(2 * i + 2)] } })).body.id)
	}
	for (let i = 0; i < 12; i += 1) {
		assert.equal((await h.send(`/mixtapes/${ids[i]}/merge`, { method: 'POST', as: NEW_OWNER, body: { targetId: ids[i + 1] } })).status, 200)
	}
	const terminal = ids[12]
	for (const id of ids.slice(0, 12)) assert.equal(h.row(id)!.Related_Mixtape_Id, terminal, `${id} points straight at the terminal target`)
	assert.equal(h.row(terminal)!.Smols.split(',').length, 26)
	const first = await h.json(`/mixtapes/${ids[0]}`)
	assert.deepEqual([first.status, first.body.code, first.body.mergedInto], [404, 'mixtape_merged', terminal])

	// Corrupt legacy cycles resolve safely (plain 404, no hang).
	h.write(`UPDATE Mixtapes SET Deleted_At = CURRENT_TIMESTAMP, Visibility = 'deleted', Hidden_Reason = 'merged', Related_Mixtape_Id = ? WHERE Id = ?`, CORDOVA_RETRY, CORDOVA)
	h.write(`UPDATE Mixtapes SET Deleted_At = CURRENT_TIMESTAMP, Visibility = 'deleted', Hidden_Reason = 'merged', Related_Mixtape_Id = ? WHERE Id = ?`, CORDOVA, CORDOVA_RETRY)
	const cycle = await h.json(`/mixtapes/${CORDOVA}`)
	assert.deepEqual([cycle.status, cycle.body.code], [404, undefined])
})

test('P1-2: a delayed AI verdict can never overwrite a newer edit\'s decision', async () => {
	let releaseFirst!: () => void
	const first = new Promise<void>((resolve) => { releaseFirst = resolve })
	let calls = 0
	const h = buildHarness({
		ai: async () => {
			calls += 1
			if (calls === 1) {
				await first
				return clefAnswer(0.08) // stale "unique" verdict from the slow request
			}
			return clefAnswer(0.9)
		},
	})
	const A = [1, 2, 3, 4, 5].map(SYN)
	const B = [1, 2, 3, 4, 6, 7, 8].map(SYN)
	const a = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Drafts', desc: 'v1', smols: A } })).body.id as string
	h.backdate(a, 60)

	const slowCreate = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Drafts final', desc: 'v2', smols: B } })
	while (h.aiCalls.length < 1) await tick()
	const b = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Drafts final'`).get() as { Id: string }).Id

	// Meanwhile the owner edits A; that request adjudicates the pair as a duplicate and commits.
	const edit = await h.json(`/mixtapes/${a}`, { method: 'PATCH', as: NEW_OWNER, body: { desc: 'v1 reworked' } })
	assert.deepEqual([edit.status, edit.body.hiddenReason, edit.body.relatedMixtapeId], [200, 'semantic_duplicate', b])

	releaseFirst()
	const created = await slowCreate
	assert.equal(created.status, 201, 'the slow write still succeeds')
	assert.equal(h.aiCalls.length, 2, 'stale work is re-derived, never re-inferred')
	const hidden = h.row(a)!
	assert.deepEqual([hidden.Visibility, hidden.Hidden_Reason, hidden.Related_Mixtape_Id], ['owner', 'semantic_duplicate', b], 'newer verdict survives')
	assert.equal(JSON.parse(hidden.Ai_Verdict).p, 0.9)
	assert.equal(h.row(b)!.Ai_Verdict, null, 'the stale receipt (old revisions) is never persisted')
	assert.ok(!(await h.json<Array<{ Id: string }>>('/mixtapes')).body.some((m) => m.Id === a))
})

test('P1-3: a song turning private invalidates a stored AI verdict immediately, with zero inference', async () => {
	const h = buildHarness({ ai: async () => clefAnswer(0.9) })
	const A = [1, 2, 3, 4, 5, 6].map(SYN)
	const B = [1, 2, 3, 4, 7, 8].map(SYN) // J = 4/8 → borderline; equal size keeps the newer B
	const a = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Season', smols: A } })).body.id as string
	h.backdate(a, 60)
	const b = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Season II', smols: B } })).body.id as string
	const receipt = JSON.parse(h.row(a)!.Ai_Verdict)
	assert.deepEqual([receipt.hidden, receipt.keep, receipt.applied], [a, b, true])
	assert.match(receipt.fp, /^[0-9a-f]{64}$/, 'SHA-256 input fingerprint persisted')

	const flip = (value: number) => h.db.prepare(`UPDATE Smols SET Public = ? WHERE Id IN (?, ?, ?, ?)`).run(value, ...[1, 2, 3, 4].map(SYN))
	flip(0) // the four shared songs go private: the mixtapes are now disjoint
	const mine = (await h.json<Array<Record<string, any>>>('/mixtapes/mine', { as: NEW_OWNER })).body.find((m) => m.Id === a)!
	assert.deepEqual([mine.Visibility, mine.Hidden_Reason, mine.Public_Track_Count], ['public', null, 2])
	const list = (await h.json<Array<{ Id: string }>>('/mixtapes')).body
	assert.ok(list.some((m) => m.Id === a) && list.some((m) => m.Id === b))

	flip(1) // identical inputs again → the fingerprint matches and the verdict applies again
	assert.equal((await h.json(`/mixtapes/${a}`)).body.Hidden_Reason, 'semantic_duplicate')
	assert.equal(h.aiCalls.length, 1, 'reads never infer')
})

test('P1-4: a delayed in-flight GET cannot refill the current cache key; purge runs even when recompute fails', async () => {
	const h = buildHarness()
	for (const path of ['/mixtapes', `/mixtapes/${CORDOVA}`]) {
		h.cache.hold()
		const inFlight = await h.send(path, { noFlush: true }) // computed before the edit, fill still pending
		const renamed = `Renamed via ${path}`
		assert.equal((await h.send(`/mixtapes/${CORDOVA}`, { method: 'PATCH', as: CORDOVA_OWNER, body: { title: renamed } })).status, 200)
		h.cache.release()
		await inFlight.flush() // the stale fill lands now — under the OLD epoch key
		const fresh = await h.json<any>(path)
		const title = Array.isArray(fresh.body) ? fresh.body.find((m: { Id: string }) => m.Id === CORDOVA)?.Title : fresh.body.Title
		assert.equal(title, renamed, `${path}: never served from the stale fill`)
		const hitsBefore = h.cache.stats.hits
		await h.send(path)
		assert.equal(h.cache.stats.hits, hitsBefore + 1, `${path}: the current epoch is cached normally`)
	}

	// A song privacy flip bumps the epoch through the trigger: no stale public song data.
	const cordovaSong = byId(CORDOVA).Smols.split(',')[0]
	h.db.prepare('UPDATE Smols SET Public = 0 WHERE Id = ?').run(cordovaSong)
	assert.ok(!(await h.json<any>(`/mixtapes/${CORDOVA}`)).body.Smols.some((s: { Id: string }) => s.Id === cordovaSong))

	// The mutation commits, then the cohort recompute throws: the purge still goes out.
	purgedTagBatches.length = 0
	let armed = true
	h.hooks.onStatement = (sql) => {
		if (armed && /"Address" = \?1 AND Deleted_At IS NULL/.test(sql)) {
			armed = false
			throw new Error('D1_ERROR: transient')
		}
	}
	const failed = await h.send(`/mixtapes/${CORDOVA_RETRY}`, { method: 'PATCH', as: CORDOVA_OWNER, body: { title: 'Committed anyway' } })
	h.hooks.onStatement = undefined
	assert.equal(failed.status, 500)
	assert.equal(h.row(CORDOVA_RETRY)!.Title, 'Committed anyway')
	assert.ok(['mixtapes', `mixtape:${CORDOVA_RETRY}`].every((tag) => purgedTagBatches.flat().includes(tag)), 'purge is guaranteed after commit')
})

test('P2-1: simultaneous identical POSTs claim atomically: zero provisional rows, consistent 201/200 receipts', async () => {
	const h = buildHarness()
	h.db.exec(`CREATE TEMP TABLE inserted_log (Id TEXT); CREATE TEMP TRIGGER log_mixtape_insert AFTER INSERT ON main.Mixtapes BEGIN INSERT INTO inserted_log VALUES (NEW.Id); END;`)
	let arrivals = 0
	let openBarrier!: () => void
	const barrier = new Promise<void>((resolve) => { openBarrier = resolve })
	h.hooks.onStatement = async (sql) => {
		if (sql.includes('DELETE FROM MixtapeRetryClaim WHERE Created_At') && arrivals < 2) {
			arrivals += 1
			if (arrivals === 2) openBarrier()
			await barrier // both requests are past validation before either claims
		}
	}
	const body = { title: 'Double Tap', smols: [SYN(1), SYN(2)] }
	const results = await Promise.all([1, 2].map(() => h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })))
	h.hooks.onStatement = undefined
	assert.equal(arrivals, 2)
	assert.deepEqual(results.map((r) => r.status).sort(), [200, 201])
	const won = results.find((r) => r.status === 201)!.body
	const deduped = results.find((r) => r.status === 200)!.body
	assert.deepEqual([deduped.id, deduped.deduplicated, won.deduplicated], [won.id, true, false])
	for (const field of ['visibility', 'hiddenReason', 'relatedMixtapeId', 'revision', 'uniquenessScore']) assert.deepEqual(deduped[field], won[field], `consistent ${field}`)
	assert.deepEqual((h.db.prepare('SELECT Id FROM inserted_log').all() as Array<{ Id: string }>).map((r) => r.Id), [won.id], 'no provisional row was ever inserted')
	assert.equal((await h.json(`/mixtapes/${won.id}`)).body.Visibility, won.visibility, 'receipt matches the next read')

	// The claim only stands for a live, unedited row inside the window.
	assert.equal((await h.send(`/mixtapes/${won.id}`, { method: 'PATCH', as: NEW_OWNER, body: { desc: 'edited' } })).status, 200)
	const afterEdit = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.equal(afterEdit.status, 201, 'editing the original frees its retry claim')
	assert.equal((await h.send(`/mixtapes/${afterEdit.body.id}`, { method: 'DELETE', as: NEW_OWNER })).status, 200)
	const afterDelete = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.equal(afterDelete.status, 201, 'deleting it frees the claim too')
	assert.notEqual(afterDelete.body.id, afterEdit.body.id)
})

test('P2-2 / P2-3: pointers only target listed keepers; 3+ track reorders reach Tier 2', async () => {
	const mk = (id: string, tracks: number[], createdAt: string, title = 'Mix', desc = ''): MixtapeCandidate => ({
		id, address: NEW_OWNER, title, desc, createdAt, publicTracks: tracks.map(SYN),
	})
	// A ⊂ B, B overlaps newer C at J = 0.80. A must not point at hidden B; it is promoted.
	const abc = classifyOwnerMixtapes([
		mk('A', [1, 9], '2026-01-01 00:00:00', 'A'),
		mk('B', [1, 2, 3, 4, 5, 6, 7, 8, 9], '2026-01-02 00:00:00', 'B'),
		mk('C', [1, 2, 3, 4, 5, 6, 7, 8, 10], '2026-01-03 00:00:00', 'C'),
	])
	assert.deepEqual([abc.get('A')!.visibility, abc.get('B')!.hiddenReason, abc.get('B')!.relatedId], ['public', 'overlap', 'C'])
	assertNoHiddenKeepers(abc, 'A→B→C')

	// A semantic verdict that hides a keeper re-tests its dependents against the survivors.
	const rows = [
		mk('K', [1, 2, 3, 6, 7, 8, 9], '2026-01-03 00:00:00', 'K'),
		mk('H', [1, 2, 3, 4, 5], '2026-01-02 00:00:00', 'H'),
		mk('D', [1, 2, 4], '2026-01-01 00:00:00', 'D'),
		mk('E', [1, 2, 3], '2026-01-01 00:00:00', 'E'),
	]
	const plain = classifyOwnerMixtapes(rows)
	assert.deepEqual([plain.get('D')!.relatedId, plain.get('H')!.visibility], ['H', 'public'])
	const withVerdict = classifyOwnerMixtapes(rows, [{ hiddenId: 'H', keeperId: 'K', pDuplicate: 0.9 }])
	assert.deepEqual([withVerdict.get('H')!.hiddenReason, withVerdict.get('H')!.relatedId], ['semantic_duplicate', 'K'])
	assert.deepEqual([withVerdict.get('D')!.visibility, withVerdict.get('E')!.relatedId], ['public', 'K'], 'D promoted; E re-pointed to the surviving keeper')
	assertNoHiddenKeepers(withVerdict, 'semantic')
	assertNoHiddenKeepers(classifyOwnerMixtapes(rows, [{ hiddenId: 'K', keeperId: 'H', pDuplicate: 0.9 }]), 'verdict against rank')

	// Three-track editions with a changed order or title are borderline, not deterministic overlap.
	for (const [label, second] of [['reorder', mk('r2', [3, 2, 1], '2026-01-02 00:00:00', 'Trilogy')], ['retitle', mk('r2', [1, 2, 3], '2026-01-02 00:00:00', 'Trilogy (Live)')]] as const) {
		const pair = [mk('r1', [1, 2, 3], '2026-01-01 00:00:00', 'Trilogy'), second]
		const decisions = classifyOwnerMixtapes(pair)
		assert.equal(decisions.get('r1')!.visibility, 'public', `${label}: not hidden as overlap`)
		assert.equal(findBorderlinePair(pair, decisions)?.trigger, 'same_set_changed', label)
	}

	const h = buildHarness({ ai: async () => clefAnswer(0.9) })
	const original = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Trilogy', smols: [1, 2, 3].map(SYN) } })).body.id as string
	h.backdate(original, 60)
	const reordered = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Trilogy', smols: [3, 2, 1].map(SYN) } })
	assert.equal(h.aiCalls.length, 1, 'the reorder is adjudicated by clef-flash')
	assert.equal((h.aiCalls[0].input.state as any).relationship_metrics.exact_same_order, false)
	assert.equal(reordered.body.visibility, 'public')
	assert.deepEqual([h.row(original)!.Hidden_Reason, h.row(original)!.Related_Mixtape_Id], ['semantic_duplicate', reordered.body.id])
})

test('P2-4: the clef-flash parser rejects error envelopes and malformed payloads before using a probability', async () => {
	const valid = clefAnswer(0.99)
	assert.equal(parseMixtapeDedupeResponse(valid)?.pDuplicate, 0.99)
	assert.equal(parseMixtapeDedupeResponse({ success: true, errors: [], result: valid })?.pDuplicate, 0.99)
	assert.equal(parseMixtapeDedupeResponse({ state: 'Completed', result: { success: true, errors: [], result: valid } })?.pDuplicate, 0.99)
	const { model: _model, usage: _usage, ...bare } = valid
	const malformed: Array<[string, unknown]> = [
		['success:false', { success: false, errors: [], result: valid }],
		['errors', { success: true, errors: [{ code: 3040, message: 'capacity' }], result: valid }],
		['pending', { state: 'Running', result: valid }],
		['bare answers', bare],
		['missing usage', { ...valid, usage: undefined }],
		['negative tokens', { ...valid, usage: { input_tokens: -1, output_tokens: 0 } }],
		['empty model', { ...valid, model: ' ' }],
		['bad relation', { ...valid, answers: { ...valid.answers, relation: { type: 'choice', choice: 'banana' } } }],
		['wrong type', { ...valid, answers: { is_duplicate: { type: 'score', noul: 0.9 } } }],
		['out of range', clefAnswer(1.2)],
	]
	const nest = (node: unknown, levels: number, inner: Record<string, unknown> = {}): unknown => (levels === 0 ? node : { success: true, errors: [], ...inner, result: nest(node, levels - 1, inner) })
	malformed.push(
		['4x nested, inner success:false', nest({ success: false, errors: [{ code: 1 }], result: valid }, 3)],
		['3 envelopes (excess nesting)', nest(valid, 3)],
		['string success "false"', { success: 'false', errors: [], result: valid }],
		['string success "true"', { success: 'true', result: valid }],
		['terminal success:false', { ...valid, success: false }],
		['terminal errors', { ...valid, errors: ['boom'] }],
	)
	assert.equal(parseMixtapeDedupeResponse(nest(valid, 2))?.pDuplicate, 0.99, 'two envelopes are accepted')
	for (const [label, payload] of malformed) assert.equal(parseMixtapeDedupeResponse(payload), null, label)

	// End to end: a success:false envelope with a duplicate probability fails open.
	const h = buildHarness({ ai: async () => ({ success: false, errors: [{ code: 1 }], result: valid }) })
	const a = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'One', smols: [1, 2, 3, 4, 5].map(SYN) } })).body.id as string
	h.backdate(a, 60)
	const b = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Two', smols: [1, 2, 3, 4, 6, 7, 8].map(SYN) } })
	assert.deepEqual([b.status, b.body.visibility, h.row(a)!.Visibility], [201, 'public', 'public'])
	assert.equal(JSON.parse(h.row(b.body.id)!.Ai_Verdict).fallback, 'invalid_response')
})

test('P2-5: owner-route errors (401/400/403/404/409) carry private no-store headers', async () => {
	const h = buildHarness()
	const cases: Array<[string, Parameters<typeof h.send>[1], number]> = [
		['/mixtapes/mine', {}, 401],
		['/mixtapes/check-uniqueness', { method: 'POST', body: {} }, 401],
		['/mixtapes/check-uniqueness', { method: 'POST', as: NEW_OWNER, body: { smols: 'nope' } }, 400],
		['/mixtapes', { method: 'POST', body: { title: 'x', smols: [SYN(1)] } }, 401],
		['/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: '', smols: [SYN(1)] } }, 400],
		[`/mixtapes/${CORDOVA}`, { method: 'PATCH', as: NEW_OWNER, body: { title: 'x' } }, 403],
		['/mixtapes/doesnotexist', { method: 'DELETE', as: NEW_OWNER }, 404],
		[`/mixtapes/${CORDOVA}/merge`, { method: 'POST', as: CORDOVA_OWNER, body: { targetId: CORDOVA } }, 400],
	]
	for (const [path, init, status] of cases) {
		const res = await h.send(path, init)
		assert.equal(res.status, status, `${init?.method ?? 'GET'} ${path}`)
		assert.equal(res.headers.get('Cache-Control'), 'private, no-store', `${path} ${status}`)
		assert.equal(res.headers.get('CDN-Cache-Control'), 'no-store', `${path} ${status}`)
	}
	const mine = await h.send('/mixtapes/mine', { as: NEW_OWNER })
	assert.deepEqual([mine.status, mine.headers.get('Cache-Control')], [200, 'private, no-store'])
	assert.match((await h.send('/mixtapes')).headers.get('Cache-Control')!, /^public/, 'public GETs stay cacheable')
})

// ---------------------------------------------------------------------------
// Pass-2 regressions (reports/25b-review-mixtape-be.md §Pass 2)
// ---------------------------------------------------------------------------

test('Pass 2 P1-1: a competing merge returns 409 without touching the winner\'s target', async () => {
	const h = buildHarness()
	const create = async (title: string, smols: string[]) => (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title, smols } })).body.id as string
	const target = await create('Target', [SYN(1), SYN(2)])
	const source = await create('Source', [SYN(3), SYN(4)])
	let winner: Awaited<ReturnType<typeof h.json>> | null = null
	h.hooks.onStatement = async (sql) => {
		if (!winner && sql.includes('SET Smols = ?1, Title = ?2, Desc = ?3')) {
			// The loser has read both rows; the winner merges the same source first.
			winner = { status: 0 } as never
			winner = await h.json(`/mixtapes/${source}/merge`, { method: 'POST', as: NEW_OWNER, body: { targetId: target, title: 'Winner title' } })
		}
	}
	const loser = await h.json(`/mixtapes/${source}/merge`, { method: 'POST', as: NEW_OWNER, body: { targetId: target, title: 'Loser title' } })
	h.hooks.onStatement = undefined
	assert.equal(winner!.status, 200)
	assert.equal(winner!.body.target.Revision, 2)
	assert.deepEqual([loser.status, loser.body.code], [409, 'revision_conflict'])
	const t = h.row(target)!
	assert.deepEqual([t.Title, t.Revision, t.Smols], ['Winner title', 2, [1, 2, 3, 4].map(SYN).join(',')], 'loser never wrote the target')
	const s = h.row(source)!
	assert.deepEqual([s.Hidden_Reason, s.Related_Mixtape_Id, s.Revision], ['merged', target, 2], 'source tombstoned exactly once')
})

test('Pass 2 P1-2: a late fail-open evaluation of the same revisions cannot overwrite a committed 0.95 verdict', async () => {
	let failFirst!: (error: Error) => void
	let markFirstCalled!: () => void
	const firstCalled = new Promise<void>((resolve) => { markFirstCalled = resolve })
	let calls = 0
	const h = buildHarness({
		ai: async () => {
			calls += 1
			if (calls === 1) {
				markFirstCalled()
				return await new Promise((_, reject) => { failFirst = reject })
			}
			return clefAnswer(0.95)
		},
	})
	// Hold X's cohort read until Y's content write has committed, and Y's until X is inferring:
	// both evaluations then judge the same (X rev 1, Y rev 1) cohort.
	let arrivals = 0
	let markYRead!: () => void
	const yRead = new Promise<void>((resolve) => { markYRead = resolve })
	h.hooks.onStatement = async (sql, args) => {
		if (!/"Address" = \?1 AND Deleted_At IS NULL AND Visibility != 'deleted'/.test(sql) || args[0] !== NEW_OWNER) return
		arrivals += 1
		if (arrivals === 1) await yRead
		else if (arrivals === 2) {
			markYRead()
			await firstCalled
		}
	}
	const pendingX = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Drafts', smols: [1, 2, 3, 4, 5].map(SYN) } })
	while (arrivals < 1) await tick()
	const y = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Drafts final', smols: [1, 2, 3, 4, 6, 7, 8].map(SYN) } })
	assert.deepEqual([y.status, y.body.visibility], [201, 'public'])
	const xId = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Drafts'`).get() as { Id: string }).Id
	assert.equal(JSON.parse(h.row(xId)!.Ai_Verdict).p, 0.95, 'Y committed the duplicate verdict on X')

	failFirst(new Error('5xx provider error'))
	const x = await pendingX
	h.hooks.onStatement = undefined
	assert.equal(h.aiCalls.length, 2)
	assert.equal(x.status, 201)
	assert.deepEqual([x.body.visibility, x.body.hiddenReason, x.body.relatedMixtapeId], ['owner', 'semantic_duplicate', y.body.id], 'X reports the committed state')
	const receipt = JSON.parse(h.row(xId)!.Ai_Verdict)
	assert.deepEqual([receipt.p, receipt.dup, receipt.fallback], [0.95, true, undefined], 'the late fallback never overwrote the verdict')
	assert.ok(!(await h.json<Array<{ Id: string }>>('/mixtapes')).body.some((m) => m.Id === xId))
})

test('Pass 2 P2-2: a song privacy flip during pending clef inference yields an accurate post-flip receipt', async () => {
	let resolveAi!: (value: unknown) => void
	const h = buildHarness({ ai: () => new Promise((resolve) => { resolveAi = resolve }) })
	const a = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Season', smols: [1, 2, 3, 4, 5, 6].map(SYN) } })).body.id as string
	h.backdate(a, 60)
	const pending = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Season II', smols: [1, 2, 3, 4, 7, 8].map(SYN) } })
	while (h.aiCalls.length < 1) await tick()
	h.db.prepare('UPDATE Smols SET Public = 0 WHERE Id IN (?, ?, ?, ?)').run(...[1, 2, 3, 4].map(SYN)) // trigger bumps the epoch
	resolveAi(clefAnswer(0.9)) // verdict about inputs that no longer exist
	const b = await pending
	assert.deepEqual([b.status, b.body.visibility, b.body.hiddenReason, b.body.uniquenessScore], [201, 'public', null, 100])
	assert.deepEqual([h.row(a)!.Visibility, h.row(a)!.Ai_Verdict], ['public', null], 'the stale duplicate verdict was never persisted')
	assert.equal((await h.json(`/mixtapes/${a}`)).body.Visibility, 'public', 'receipt matches the next read')
	assert.equal(h.aiCalls.length, 1)
})

// ---------------------------------------------------------------------------
// Pass-3 regressions (reports/25b-review-mixtape-be.md §Pass 3)
// ---------------------------------------------------------------------------

test('Pass 3 P1: a late verdict cannot contradict a committed adjudication of the same pair stored on the other row', async () => {
	let resolveFirst!: (value: unknown) => void
	let markFirstCalled!: () => void
	const firstCalled = new Promise<void>((resolve) => { markFirstCalled = resolve })
	let calls = 0
	const h = buildHarness({
		ai: async () => {
			calls += 1
			if (calls === 1) {
				markFirstCalled()
				return await new Promise((resolve) => { resolveFirst = resolve })
			}
			return clefAnswer(0.03) // the newer request: clearly unique
		},
	})
	// Both evaluations read the same (X rev 1, Y rev 1) cohort → same pair and input fingerprint.
	let arrivals = 0
	let markYRead!: () => void
	const yRead = new Promise<void>((resolve) => { markYRead = resolve })
	h.hooks.onStatement = async (sql, args) => {
		if (!/"Address" = \?1 AND Deleted_At IS NULL AND Visibility != 'deleted'/.test(sql) || args[0] !== NEW_OWNER) return
		arrivals += 1
		if (arrivals === 1) await yRead
		else if (arrivals === 2) {
			markYRead()
			await firstCalled
		}
	}
	const pendingX = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Drafts', smols: [1, 2, 3, 4, 5].map(SYN) } })
	while (arrivals < 1) await tick()
	const y = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Drafts final', smols: [1, 2, 3, 4, 6, 7, 8].map(SYN) } })
	const xId = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Drafts'`).get() as { Id: string }).Id
	const committed = JSON.parse(h.row(y.body.id)!.Ai_Verdict)
	assert.deepEqual([committed.p, committed.dup], [0.03, false], 'Y committed "unique" on the larger row')

	resolveFirst(clefAnswer(0.95)) // late, contradictory duplicate verdict about the same inputs
	const x = await pendingX
	h.hooks.onStatement = undefined
	assert.equal(h.aiCalls.length, 2)
	assert.deepEqual([x.status, x.body.visibility, x.body.hiddenReason], [201, 'public', null], 'the committed decision wins')
	assert.equal(h.row(xId)!.Ai_Verdict, null, 'the late 0.95 receipt was discarded')
	const receipts = (h.db.prepare(`SELECT Id, Ai_Verdict FROM Mixtapes WHERE "Address" = ? AND Ai_Verdict IS NOT NULL`).all(NEW_OWNER) as Array<{ Id: string; Ai_Verdict: string }>)
		.map((row) => ({ id: row.Id, ...JSON.parse(row.Ai_Verdict) }))
		.filter((receipt) => receipt.pair.includes(xId) && receipt.pair.includes(y.body.id))
	assert.equal(receipts.length, 1, 'exactly one receipt for the pair')
	assert.equal(receipts[0].p, 0.03)
	assert.equal((await h.json(`/mixtapes/${xId}`)).body.Visibility, 'public')

	// A later edit moves the pair to new revisions, so it is adjudicated afresh exactly once.
	assert.equal((await h.send(`/mixtapes/${y.body.id}`, { method: 'PATCH', as: NEW_OWNER, body: { title: 'Drafts final' } })).status, 200)
	assert.equal(h.aiCalls.length, 3)
})

test('Pass 3 P2: an identical POST during the winner\'s Clef inference reports the same final visibility', async () => {
	let resolveAi!: (value: unknown) => void
	const h = buildHarness({ ai: () => new Promise((resolve) => { resolveAi = resolve }) })
	const bigger = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Full set', smols: [1, 2, 3, 4, 6, 7, 8].map(SYN) } })).body.id as string
	h.backdate(bigger, 60)
	const body = { title: 'Early set', smols: [1, 2, 3, 4, 5].map(SYN) }
	const pendingWinner = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	while (h.aiCalls.length < 1) await tick()
	const replayStarted = Date.now()
	const pendingReplay = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	await new Promise((resolve) => setTimeout(resolve, 150)) // the replay is polling the unfinalized claim
	resolveAi(clefAnswer(0.9))
	const [winner, replay] = await Promise.all([pendingWinner, pendingReplay])
	assert.deepEqual([winner.status, winner.body.visibility, winner.body.hiddenReason], [201, 'owner', 'semantic_duplicate'])
	assert.deepEqual([replay.status, replay.body.deduplicated, replay.body.id], [200, true, winner.body.id])
	for (const field of ['visibility', 'hiddenReason', 'relatedMixtapeId', 'uniquenessScore', 'revision']) assert.deepEqual(replay.body[field], winner.body[field], `replay ${field}`)
	assert.ok(Date.now() - replayStarted >= 150, 'the replay waited for finalization')
	assert.equal(h.aiCalls.length, 1)
	assert.equal((h.db.prepare('SELECT Finalized FROM MixtapeRetryClaim').all() as Array<{ Finalized: number }>).filter((r) => r.Finalized === 1).length, 2)
})

test('Pass 3 P2: a no-op PATCH keeps the 15-minute exact-retry protection', async () => {
	const h = buildHarness()
	const body = { title: 'Quiet Hours', smols: [SYN(1), SYN(2)] }
	const created = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	const noop = await h.json(`/mixtapes/${created.body.id}`, { method: 'PATCH', as: NEW_OWNER, body: { desc: '' } })
	assert.deepEqual([noop.status, noop.body.revision], [200, 2], 'revision bumps, identity unchanged')
	const replay = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([replay.status, replay.body.id, replay.body.deduplicated, replay.body.revision], [200, created.body.id, true, 2])
	assert.equal((h.db.prepare(`SELECT COUNT(*) AS n FROM Mixtapes WHERE Title = 'Quiet Hours'`).get() as { n: number }).n, 1)
})

test('Pass 3 P2: non-200 public responses (deleted / merged / unknown 404) are never shareable', async () => {
	const h = buildHarness()
	assert.equal((await h.send(`/mixtapes/${CORDOVA}`, { method: 'DELETE', as: CORDOVA_OWNER })).status, 200)
	assert.equal((await h.send(`/mixtapes/${CREASY_V1}/merge`, { method: 'POST', as: CREASY_OWNER, body: { targetId: CREASY_V2 } })).status, 200)
	for (const path of [`/mixtapes/${CORDOVA}`, `/mixtapes/${CREASY_V1}`, '/mixtapes/doesnotexist']) {
		const res = await h.send(path)
		assert.equal(res.status, 404, path)
		assert.equal(res.headers.get('Cache-Control'), 'no-store', `${path} Cache-Control`)
		assert.equal(res.headers.get('CDN-Cache-Control'), 'no-store', `${path} CDN-Cache-Control`)
	}
	assert.ok(!h.cache.keys().some((key) => key.includes(CORDOVA) || key.includes('doesnotexist')), 'no 404 in the Worker cache')
	assert.equal((await h.send(`/mixtapes/${CORDOVA}/restore`, { method: 'POST', as: CORDOVA_OWNER })).status, 200)
	const restored = await h.send(`/mixtapes/${CORDOVA}`)
	assert.deepEqual([restored.status, restored.headers.get('Cache-Control'), restored.headers.get('CDN-Cache-Control')], [200, 'public, max-age=0, must-revalidate', 'public, s-maxage=60, stale-while-revalidate=120'], 'undo is visible immediately')
})

// ---------------------------------------------------------------------------
// Pass-4 regressions (reports/25b-review-mixtape-be.md §Pass 4)
// ---------------------------------------------------------------------------

const CLASSIFY_BATCH = 'UPDATE MixtapeState SET Epoch = -1 WHERE Id = 1 AND Epoch != ?1'
const OWNER_ROWS_READ = /"Address" = \?1 AND Deleted_At IS NULL AND Visibility != 'deleted'/

async function seedBiggerSibling(h: ReturnType<typeof buildHarness>) {
	const bigger = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title: 'Full set', smols: [1, 2, 3, 4, 6, 7, 8].map(SYN) } })).body.id as string
	h.backdate(bigger, 60)
	return bigger
}
const countTitled = (h: ReturnType<typeof buildHarness>, title: string) => (h.db.prepare('SELECT COUNT(*) AS n FROM Mixtapes WHERE Title = ?').get(title) as { n: number }).n
const claimState = (h: ReturnType<typeof buildHarness>, id: string) => (h.db.prepare('SELECT Finalized FROM MixtapeRetryClaim WHERE Mixtape_Id = ?').get(id) as { Finalized: number } | undefined)?.Finalized

test('Pass 4 P2-1a: a replay that outlasts an unfinished classification gets a retryable 503, never a premature 200', async () => {
	const h = buildHarness({ ai: async () => clefAnswer(0.95) })
	await seedBiggerSibling(h)
	let release!: () => void
	const gate = new Promise<void>((resolve) => { release = resolve })
	let held = false
	h.hooks.onStatement = async (sql) => {
		if (!held && sql.includes(CLASSIFY_BATCH)) {
			held = true
			await gate // the winner's classification commit is stuck past the replay deadline
		}
	}
	const body = { title: 'Early set', smols: [1, 2, 3, 4, 5].map(SYN) }
	const pendingWinner = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	while (!held) await tick()

	const replay = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([replay.status, replay.body.code], [503, 'create_pending'])
	assert.equal(replay.res.headers.get('Retry-After'), '1')
	assert.equal(replay.res.headers.get('Cache-Control'), 'private, no-store')

	release()
	const winner = await pendingWinner
	h.hooks.onStatement = undefined
	assert.deepEqual([winner.status, winner.body.visibility, winner.body.hiddenReason], [201, 'owner', 'semantic_duplicate'])
	assert.equal(claimState(h, winner.body.id), 1)
	const retried = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([retried.status, retried.body.id, retried.body.visibility, retried.body.hiddenReason], [200, winner.body.id, 'owner', 'semantic_duplicate'])
	assert.equal(countTitled(h, 'Early set'), 1)
})

test('Pass 4 P2-1b: a failed or abandoned classification is recovered by a replay on the SAME row', async () => {
	const h = buildHarness({ ai: async () => clefAnswer(0.95) })
	await seedBiggerSibling(h)
	let failed = false
	h.hooks.onStatement = (sql) => {
		if (!failed && sql.includes(CLASSIFY_BATCH)) {
			failed = true
			throw new Error('D1_ERROR: transient network error')
		}
	}
	const body = { title: 'Early set', smols: [1, 2, 3, 4, 5].map(SYN) }
	const winner = await h.send('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	h.hooks.onStatement = undefined
	assert.equal(winner.status, 500)
	const id = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Early set'`).get() as { Id: string }).Id
	assert.equal(claimState(h, id), 2, 'failure is recorded as FAILED, never finalized')
	assert.equal(h.row(id)!.Ai_Verdict, null, 'no verdict persisted yet')

	const recovered = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([recovered.status, recovered.body.id, recovered.body.deduplicated], [200, id, true])
	assert.deepEqual([recovered.body.visibility, recovered.body.hiddenReason], ['owner', 'semantic_duplicate'], 'the true persisted verdict')
	assert.equal(JSON.parse(h.row(id)!.Ai_Verdict).p, 0.95)
	assert.equal(claimState(h, id), 1)
	assert.equal(countTitled(h, 'Early set'), 1, 'zero second mixtape inserted')

	// An abandoned in-progress claim (>= 30 s old) is recovered the same way.
	const other = { title: 'Solo pair', smols: [SYN(40), SYN(41)] }
	const created = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: other })
	h.db.prepare(`UPDATE MixtapeRetryClaim SET Finalized = 0, Created_At = datetime('now', '-60 seconds') WHERE Mixtape_Id = ?`).run(created.body.id)
	const takeover = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: other })
	assert.deepEqual([takeover.status, takeover.body.id, takeover.body.visibility], [200, created.body.id, 'public'])
	assert.equal(claimState(h, created.body.id), 1)
	assert.equal(countTitled(h, 'Solo pair'), 1)
})

test('Pass 4 P2-2: a delete or edit between replay reads never yields a 500 or a false 200', async () => {
	for (const change of ['delete', 'edit'] as const) {
		const h = buildHarness()
		const body = { title: `Replay ${change}`, smols: [SYN(1), SYN(2)] }
		const original = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })).body.id as string
		let fired = false
		h.hooks.onStatement = (sql, args) => {
			if (fired || !OWNER_ROWS_READ.test(sql) || args[0] !== NEW_OWNER) return
			fired = true // the replay has seen the finalized claim; now the owner changes the row
			if (change === 'delete') {
				h.write(`UPDATE Mixtapes SET Deleted_At = CURRENT_TIMESTAMP, Visibility = 'deleted', Hidden_Reason = 'deleted', Revision = Revision + 1 WHERE Id = ?`, original)
			} else {
				h.write('UPDATE Mixtapes SET Title = ?, Smols = ?, Revision = Revision + 1 WHERE Id = ?', 'Something else', [SYN(7), SYN(8)].join(','), original)
			}
		}
		const replay = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
		h.hooks.onStatement = undefined
		assert.equal(fired, true, change)
		assert.equal(replay.status, 201, `${change}: re-enters create instead of 500 / false dedupe`)
		assert.notEqual(replay.body.id, original)
		assert.equal(replay.body.deduplicated, false)
		assert.equal(h.row(replay.body.id)!.Title, body.title, `${change}: the new row has the requested content`)
		if (change === 'edit') assert.equal(h.row(original)!.Title, 'Something else', 'edited row untouched')
		assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM Mixtapes WHERE Title = ? AND Deleted_At IS NULL').get(body.title) as { n: number }).n, 1)
	}
})

// ---------------------------------------------------------------------------
// Pass-5 regressions (reports/25b-review-mixtape-be.md §Pass 5)
// ---------------------------------------------------------------------------

const claimRow = (h: ReturnType<typeof buildHarness>, id: string) => h.db.prepare('SELECT Finalized, Attempt_Token FROM MixtapeRetryClaim WHERE Mixtape_Id = ?').get(id) as { Finalized: number; Attempt_Token: string } | undefined

test('Pass 5 P2-1: when every guarded classification write rolls back, the create is 503 create_pending (never 201) and recovers on retry', async () => {
	const h = buildHarness({ ai: async () => clefAnswer(0.95) })
	await seedBiggerSibling(h)
	let unrelatedWrites = 0
	h.hooks.onStatement = (sql) => {
		if (unrelatedWrites < 3 && sql.includes(CLASSIFY_BATCH)) {
			unrelatedWrites += 1 // another owner commits right before each guarded write
			h.write(`UPDATE Mixtapes SET Title = ? WHERE Id = ?`, `Cordova take ${unrelatedWrites}`, CORDOVA)
		}
	}
	const body = { title: 'Early set', smols: [1, 2, 3, 4, 5].map(SYN) }
	const first = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	h.hooks.onStatement = undefined
	assert.equal(unrelatedWrites, 3, 'all three guarded attempts rolled back')
	assert.deepEqual([first.status, first.body.code], [503, 'create_pending'])
	assert.equal(first.res.headers.get('Retry-After'), '1')
	assert.equal(first.res.headers.get('Cache-Control'), 'private, no-store')
	const id = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Early set'`).get() as { Id: string }).Id
	assert.equal(claimRow(h, id)!.Finalized, 2, 'left recoverable, never finalized')
	assert.deepEqual([h.row(id)!.Ai_Verdict, h.row(id)!.Uniqueness_Score], [null, null], 'nothing was persisted')

	const retry = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([retry.status, retry.body.id, retry.body.deduplicated, retry.body.visibility, retry.body.hiddenReason], [200, id, true, 'owner', 'semantic_duplicate'])
	assert.equal(JSON.parse(h.row(id)!.Ai_Verdict).p, 0.95)
	assert.equal(claimRow(h, id)!.Finalized, 1)
	assert.equal(countTitled(h, 'Early set'), 1)
})

test('Pass 5 P2-2: delete-then-restore between the replay read and the next claim check keeps one live row', async () => {
	const h = buildHarness()
	const body = { title: 'Undo me', smols: [SYN(1), SYN(2)] }
	const original = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })).body.id as string
	let deleted = false
	let restored = false
	h.hooks.onStatement = async (sql, args) => {
		if (!deleted && OWNER_ROWS_READ.test(sql) && args[0] === NEW_OWNER) {
			deleted = true // the owner deletes it just before the replay's cohort read…
			assert.equal((await h.send(`/mixtapes/${original}`, { method: 'DELETE', as: NEW_OWNER })).status, 200)
		} else if (deleted && !restored && sql.includes('FROM MixtapeRetryClaim c LEFT JOIN Mixtapes m')) {
			restored = true // …and hits Undo just before the replay re-checks the claim
			assert.equal((await h.send(`/mixtapes/${original}/restore`, { method: 'POST', as: NEW_OWNER })).status, 200)
		}
	}
	const replay = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	h.hooks.onStatement = undefined
	assert.equal(deleted && restored, true)
	assert.deepEqual([replay.status, replay.body.id, replay.body.deduplicated], [200, original, true])
	assert.equal((h.db.prepare(`SELECT COUNT(*) AS n FROM Mixtapes WHERE Title = 'Undo me' AND Deleted_At IS NULL`).get() as { n: number }).n, 1, 'no second live copy')
	assert.equal(countTitled(h, 'Undo me'), 1)
})

test('Pass 5 P2-3: an expired holder failing after a takeover cannot flip the recovered claim from finalized to failed', async () => {
	const h = buildHarness()
	let release!: () => void
	const gate = new Promise<void>((resolve) => { release = resolve })
	let held = false
	h.hooks.onStatement = async (sql) => {
		if (!held && sql.includes(CLASSIFY_BATCH)) {
			held = true
			await gate
			throw new Error('D1_ERROR: late failure of the expired holder')
		}
	}
	const body = { title: 'Slow start', smols: [SYN(1), SYN(2)] }
	const pendingOriginal = h.send('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	while (!held) await tick()
	const id = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Slow start'`).get() as { Id: string }).Id
	const originalToken = claimRow(h, id)!.Attempt_Token
	assert.match(originalToken, /^[0-9a-f]{16}$/)
	h.db.prepare(`UPDATE MixtapeRetryClaim SET Created_At = datetime('now', '-60 seconds') WHERE Mixtape_Id = ?`).run(id) // holder looks abandoned

	const recovered = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([recovered.status, recovered.body.id, recovered.body.visibility], [200, id, 'public'])
	const afterRecovery = claimRow(h, id)!
	assert.equal(afterRecovery.Finalized, 1)
	assert.notEqual(afterRecovery.Attempt_Token, originalToken, 'takeover issued a fresh token')

	release()
	const original = await pendingOriginal
	h.hooks.onStatement = undefined
	assert.equal(original.status, 500)
	assert.deepEqual(claimRow(h, id), afterRecovery, 'the expired holder could not overwrite the recovery')
	const next = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([next.status, next.body.id], [200, id])
	assert.equal(countTitled(h, 'Slow start'), 1)
})

// ---------------------------------------------------------------------------
// Pass-6 regressions (reports/25b-review-mixtape-be.md §Pass 6)
// ---------------------------------------------------------------------------

test('Pass 6 P2-1: Undo right before the atomic replacement batch still yields the original as the only live row', async () => {
	const h = buildHarness()
	const body = { title: 'Undo late', smols: [SYN(1), SYN(2)] }
	const original = (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })).body.id as string
	let deleted = false
	let restored = false
	let claimBatches = 0
	h.hooks.onStatement = async (sql, args) => {
		if (!deleted && OWNER_ROWS_READ.test(sql) && args[0] === NEW_OWNER) {
			deleted = true // replay is about to observe the deletion
			assert.equal((await h.send(`/mixtapes/${original}`, { method: 'DELETE', as: NEW_OWNER })).status, 200)
		} else if (sql.includes(`DELETE FROM MixtapeRetryClaim WHERE Created_At`)) {
			claimBatches += 1
			if (deleted && !restored) {
				restored = true // Undo lands at the latest possible point: right before replacement
				assert.equal((await h.send(`/mixtapes/${original}/restore`, { method: 'POST', as: NEW_OWNER })).status, 200)
				const mine = (await h.json<Array<{ Id: string; Title: string }>>('/mixtapes/mine', { as: NEW_OWNER })).body.filter((m) => m.Title === 'Undo late')
				assert.deepEqual(mine.map((m) => m.Id), [original])
			}
		}
	}
	const replay = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	h.hooks.onStatement = undefined
	assert.equal(deleted && restored, true)
	assert.ok(claimBatches >= 2, 'the replay went back through the atomic claim batch')
	assert.deepEqual([replay.status, replay.body.id, replay.body.deduplicated], [200, original, true])
	assert.equal(countTitled(h, 'Undo late'), 1, 'no second mixtape row was ever inserted')
	assert.equal(claimRow(h, original)?.Finalized, 1, 'the claim was never released')
})

test('Pass 6 P2-2: an expired creator whose finalize affects 0 rows returns the current committed verdict, never its stale one', async () => {
	let calls = 0
	const h = buildHarness({
		ai: async () => {
			calls += 1
			if (calls === 1) throw new Error('5xx provider error') // the original commits the public fallback
			return clefAnswer(0.95) // the recovery's adjudication
		},
	})
	await seedBiggerSibling(h)
	let release!: () => void
	const gate = new Promise<void>((resolve) => { release = resolve })
	let held = false
	h.hooks.onStatement = async (sql) => {
		if (!held && sql.includes('UPDATE MixtapeRetryClaim SET Finalized = ?4')) {
			held = true
			await gate // the original is paused at claim finalization, after committing "public"
		}
	}
	const body = { title: 'Early set', smols: [1, 2, 3, 4, 5].map(SYN) }
	const pendingOriginal = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	while (!held) await tick()
	const id = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Early set'`).get() as { Id: string }).Id
	assert.equal(h.row(id)!.Visibility, 'public', 'the original committed its fallback classification')
	h.db.prepare(`UPDATE MixtapeRetryClaim SET Created_At = datetime('now', '-60 seconds') WHERE Mixtape_Id = ?`).run(id)

	const recovered = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([recovered.status, recovered.body.id, recovered.body.visibility, recovered.body.hiddenReason], [200, id, 'owner', 'semantic_duplicate'])

	release()
	const original = await pendingOriginal
	h.hooks.onStatement = undefined
	assert.equal(original.status, 201)
	assert.deepEqual(
		[original.body.id, original.body.visibility, original.body.hiddenReason, original.body.relatedMixtapeId],
		[id, 'owner', 'semantic_duplicate', recovered.body.relatedMixtapeId],
		'the superseded creator reports the current committed verdict',
	)
	const next = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([next.status, next.body.visibility], [200, 'owner'])
	assert.equal(countTitled(h, 'Early set'), 1)
})

// ---------------------------------------------------------------------------
// Pass-7 regressions (reports/25b-review-mixtape-be.md §Pass 7)
// ---------------------------------------------------------------------------

test('Pass 7 P2-1: an expired creator waking after recovery finalized never calls Clef nor rewrites the verdict', async () => {
	let calls = 0
	const h = buildHarness({
		ai: async () => {
			calls += 1
			if (calls === 1) throw new Error('5xx provider error') // recovery's Clef call fails open → public
			return clefAnswer(0.95) // what the expired creator would have received
		},
	})
	await seedBiggerSibling(h)
	let release!: () => void
	const gate = new Promise<void>((resolve) => { release = resolve })
	let held = false
	h.hooks.onStatement = async (sql, args) => {
		if (!held && OWNER_ROWS_READ.test(sql) && args[0] === NEW_OWNER) {
			held = true
			await gate // the creator stalls before its first cohort read
		}
	}
	const body = { title: 'Early set', smols: [1, 2, 3, 4, 5].map(SYN) }
	const pendingCreator = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	while (!held) await tick()
	const id = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Early set'`).get() as { Id: string }).Id
	h.db.prepare(`UPDATE MixtapeRetryClaim SET Created_At = datetime('now', '-60 seconds') WHERE Mixtape_Id = ?`).run(id)

	const recovered = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([recovered.status, recovered.body.id, recovered.body.visibility], [200, id, 'public'])
	const committed = { claim: claimRow(h, id), row: h.row(id) }
	assert.equal(committed.claim!.Finalized, 1)
	assert.equal(JSON.parse(committed.row!.Ai_Verdict).fallback, 'error')

	release()
	const creator = await pendingCreator
	h.hooks.onStatement = undefined
	assert.equal(h.aiCalls.length, 1, 'the expired creator never invoked Clef')
	assert.deepEqual([creator.status, creator.body.id, creator.body.visibility, creator.body.hiddenReason], [201, id, 'public', null], 'it reports the committed verdict')
	assert.deepEqual({ claim: claimRow(h, id), row: h.row(id) }, committed, 'zero new writes: claim, visibility and receipt unchanged')
	const next = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	assert.deepEqual([next.status, next.body.visibility], [200, 'public'])
})

test('Pass 7 P2-2: a superseded recovery never reports deduplicated:true for content the owner changed after takeover', async () => {
	const h = buildHarness()
	const body = { title: 'Morning set', smols: [SYN(1), SYN(2)] }
	let failed = false
	h.hooks.onStatement = (sql) => {
		if (!failed && sql.includes(CLASSIFY_BATCH)) {
			failed = true
			throw new Error('D1_ERROR: transient')
		}
	}
	assert.equal((await h.send('/mixtapes', { method: 'POST', as: NEW_OWNER, body })).status, 500)
	const id = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Morning set'`).get() as { Id: string }).Id
	assert.equal(claimRow(h, id)!.Finalized, 2)

	// Recovery R1 classifies, then stalls right before recording its outcome.
	let release!: () => void
	const gate = new Promise<void>((resolve) => { release = resolve })
	let held = false
	h.hooks.onStatement = async (sql) => {
		if (!held && sql.includes('UPDATE MixtapeRetryClaim SET Finalized = ?4')) {
			held = true
			await gate
		}
	}
	const pendingR1 = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	while (!held) await tick()
	h.db.prepare(`UPDATE MixtapeRetryClaim SET Created_At = datetime('now', '-60 seconds') WHERE Mixtape_Id = ?`).run(id)
	const r2 = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body }) // takeover R2 finalizes
	assert.deepEqual([r2.status, r2.body.id, r2.body.revision], [200, id, 1])

	const edit = await h.json(`/mixtapes/${id}`, { method: 'PATCH', as: NEW_OWNER, body: { title: 'Evening set', smols: [SYN(3), SYN(4)] } })
	assert.deepEqual([edit.status, edit.body.revision], [200, 2])

	release()
	const r1 = await pendingR1
	h.hooks.onStatement = undefined
	assert.ok(!(r1.status === 200 && r1.body.deduplicated), 'never a dedupe receipt for different content')
	assert.ok([201, 409].includes(r1.status), `re-entered create or conflict, got ${r1.status}`)
	if (r1.status === 201) {
		assert.notEqual(r1.body.id, id)
		assert.equal(h.row(r1.body.id)!.Title, 'Morning set', 'the new row has the requested content')
	}
	assert.deepEqual([h.row(id)!.Title, h.row(id)!.Revision], ['Evening set', 2], 'the edited mixtape is untouched')
})

test('Pass 7 P2-1b: losing the claim during inference (no epoch change) aborts the guarded write batch itself', async () => {
	let resolveAi!: (value: unknown) => void
	const h = buildHarness({ ai: () => new Promise((resolve) => { resolveAi = resolve }) })
	await seedBiggerSibling(h)
	const body = { title: 'Early set', smols: [1, 2, 3, 4, 5].map(SYN) }
	const pending = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
	while (h.aiCalls.length < 1) await tick()
	const id = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Early set'`).get() as { Id: string }).Id
	const epochBefore = h.epoch()
	// Ownership moves to another attempt without touching any mixtape (so the epoch is unchanged).
	h.db.prepare(`UPDATE MixtapeRetryClaim SET Attempt_Token = 'someone-else' WHERE Mixtape_Id = ?`).run(id)
	resolveAi(clefAnswer(0.95))
	const res = await pending
	assert.equal(h.epoch(), epochBefore, 'nothing was committed')
	assert.deepEqual([h.row(id)!.Ai_Verdict, h.row(id)!.Hidden_Reason], [null, null], 'the stale attempt wrote no verdict')
	assert.deepEqual([res.status, res.body.code], [503, 'create_pending'], 'the new owner has not finalized yet')
})

// ---------------------------------------------------------------------------
// Pass-8 regressions (reports/25b-review-mixtape-be.md §Pass 8)
// ---------------------------------------------------------------------------

test('Pass 8 P2a/b: an owner DELETE or PATCH while the creator awaits Clef yields 409 create_conflict, never 500 or a mismatched 201', async () => {
	for (const change of ['delete', 'patch'] as const) {
		let resolveAi!: (value: unknown) => void
		const h = buildHarness({ ai: () => new Promise((resolve) => { resolveAi = resolve }) })
		await seedBiggerSibling(h)
		const body = { title: 'Early set', smols: [1, 2, 3, 4, 5].map(SYN) }
		const pending = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
		while (h.aiCalls.length < 1) await tick()
		const id = (await h.json<Array<{ Id: string; Title: string }>>('/mixtapes/mine', { as: NEW_OWNER })).body.find((m) => m.Title === 'Early set')!.Id
		const ownerWrite = change === 'delete'
			? await h.send(`/mixtapes/${id}`, { method: 'DELETE', as: NEW_OWNER })
			: await h.send(`/mixtapes/${id}`, { method: 'PATCH', as: NEW_OWNER, body: { title: 'Renamed', smols: [SYN(1)] } })
		assert.equal(ownerWrite.status, 200, `${change} succeeded during inference`)
		resolveAi(clefAnswer(0.95))
		const creator = await pending
		assert.deepEqual([creator.status, creator.body.code, creator.body.id], [409, 'create_conflict', id], change)
		assert.equal(creator.res.headers.get('Cache-Control'), 'private, no-store')
		assert.notEqual(claimRow(h, id)?.Finalized, 1, `${change}: a mismatched row is never finalized`)
		if (change === 'patch') assert.deepEqual([h.row(id)!.Title, h.row(id)!.Revision], ['Renamed', 2], 'the owner edit stands')
		else assert.ok(h.row(id)!.Deleted_At, 'the owner delete stands')
		const again = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
		assert.equal(again.status, 201, `${change}: the next identical POST simply creates it`)
		assert.notEqual(again.body.id, id)
	}
})

test('Pass 8 P2c: an owner DELETE right after commit on PATCH, restore and merge is reported, never a 500', async () => {
	const h = buildHarness()
	const create = async (title: string, smols: string[]) => (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title, smols } })).body.id as string
	const deleteRightAfterCommit = (id: string) => {
		let fired = false
		h.hooks.onStatement = (sql, args) => {
			if (fired || !OWNER_ROWS_READ.test(sql) || args[0] !== NEW_OWNER) return
			fired = true // the write has committed; its cohort read is next
			h.write(`UPDATE Mixtapes SET Deleted_At = CURRENT_TIMESTAMP, Visibility = 'deleted', Hidden_Reason = 'deleted', Revision = Revision + 1 WHERE Id = ?`, id)
		}
		return () => {
			h.hooks.onStatement = undefined
			assert.equal(fired, true)
		}
	}

	const edited = await create('Edit me', [SYN(1), SYN(2)])
	let done = deleteRightAfterCommit(edited)
	const patch = await h.json(`/mixtapes/${edited}`, { method: 'PATCH', as: NEW_OWNER, body: { title: 'Edited' } })
	done()
	assert.deepEqual([patch.status, patch.body.code, patch.body.id], [409, 'concurrent_delete', edited])
	assert.equal(patch.res.headers.get('Cache-Control'), 'private, no-store')
	assert.equal(h.row(edited)!.Title, 'Edited', 'the PATCH itself committed')

	const restorable = await create('Restore me', [SYN(3), SYN(4)])
	assert.equal((await h.send(`/mixtapes/${restorable}`, { method: 'DELETE', as: NEW_OWNER })).status, 200)
	done = deleteRightAfterCommit(restorable)
	const restore = await h.json(`/mixtapes/${restorable}/restore`, { method: 'POST', as: NEW_OWNER })
	done()
	assert.deepEqual([restore.status, restore.body.code, restore.body.id], [409, 'concurrent_delete', restorable])

	const target = await create('Target', [SYN(5), SYN(6)])
	const source = await create('Source', [SYN(7), SYN(8)])
	done = deleteRightAfterCommit(target)
	const merge = await h.json(`/mixtapes/${source}/merge`, { method: 'POST', as: NEW_OWNER, body: { targetId: target } })
	done()
	assert.equal(merge.status, 200)
	assert.deepEqual(
		[merge.body.targetId, merge.body.mergedId, merge.body.addedCount, merge.body.totalTracks, merge.body.target, merge.body.targetDeletedConcurrently],
		[target, source, 2, 4, null, true],
	)
	assert.deepEqual([h.row(source)!.Hidden_Reason, h.row(source)!.Related_Mixtape_Id], ['merged', target], 'the merge committed')
})

// ---------------------------------------------------------------------------
// Pass-9 regression (reports/25b-review-mixtape-be.md §Pass 9)
// ---------------------------------------------------------------------------

test('Pass 9 P2: an owner DELETE or PATCH while an active recovery awaits Clef re-enters create (201), never 503', async () => {
	for (const change of ['patch', 'delete'] as const) {
		let calls = 0
		let resolveRecovery!: (value: unknown) => void
		const h = buildHarness({
			ai: async () => {
				calls += 1
				if (calls === 2) return await new Promise((resolve) => { resolveRecovery = resolve }) // the recovery's Clef call
				return clefAnswer(0.95)
			},
		})
		await seedBiggerSibling(h)
		const body = { title: 'Early set', smols: [1, 2, 3, 4, 5].map(SYN) }
		let failed = false
		h.hooks.onStatement = (sql) => {
			if (!failed && sql.includes(CLASSIFY_BATCH)) {
				failed = true
				throw new Error('D1_ERROR: transient')
			}
		}
		assert.equal((await h.send('/mixtapes', { method: 'POST', as: NEW_OWNER, body })).status, 500)
		h.hooks.onStatement = undefined
		const id = (h.db.prepare(`SELECT Id FROM Mixtapes WHERE Title = 'Early set'`).get() as { Id: string }).Id
		assert.equal(claimRow(h, id)!.Finalized, 2)

		const pendingRecovery = h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
		while (calls < 2) await tick() // the recovery took over and is awaiting Clef
		const ownerWrite = change === 'delete'
			? await h.send(`/mixtapes/${id}`, { method: 'DELETE', as: NEW_OWNER })
			: await h.send(`/mixtapes/${id}`, { method: 'PATCH', as: NEW_OWNER, body: { title: 'Renamed', smols: [SYN(1)] } })
		assert.equal(ownerWrite.status, 200)
		resolveRecovery(clefAnswer(0.95))
		const recovery = await pendingRecovery

		assert.notEqual(recovery.status, 503, `${change}: never create_pending for its own failed claim`)
		assert.deepEqual([recovery.status, recovery.body.deduplicated], [201, false], `${change}: re-entered the atomic replacement`)
		assert.notEqual(recovery.body.id, id)
		assert.equal(h.row(recovery.body.id)!.Title, 'Early set', 'the fresh row has the requested content')
		assert.equal(claimRow(h, recovery.body.id)!.Finalized, 1)
		if (change === 'patch') assert.equal(h.row(id)!.Title, 'Renamed', 'the owner edit stands')
		else assert.ok(h.row(id)!.Deleted_At, 'the owner delete stands')
		const replay = await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body })
		assert.deepEqual([replay.status, replay.body.id], [200, recovery.body.id])
	}
})

test('47b B1: the shared GET /mixtapes edge copy never replays one origin\'s CORS headers to another', async () => {
	const h = buildHarness()

	const first = await h.send('/mixtapes', { origin: 'https://next.smol.xyz' })
	assert.equal(first.status, 200)
	assert.equal(first.headers.get('Access-Control-Allow-Origin'), 'https://next.smol.xyz')
	await first.text()

	const stored = h.cache.entries()
	assert.equal(stored.length, 1, 'miss stores exactly one edge copy')
	const storedNames = stored[0][1].headers.map(([name]) => name.toLowerCase())
	assert.equal(storedNames.some((name) => name.startsWith('access-control-')), false, 'edge copy must carry no Access-Control-* headers')
	assert.equal(storedNames.includes('vary'), false, 'edge copy must carry no Vary header')

	const hitsBefore = h.cache.stats.hits
	const second = await h.send('/mixtapes', { origin: 'https://smol.xyz' })
	assert.equal(second.status, 200)
	assert.equal(h.cache.stats.hits, hitsBefore + 1, 'second origin is served from the edge copy')
	assert.equal(second.headers.get('Access-Control-Allow-Origin'), 'https://smol.xyz')

	const foreign = await h.send('/mixtapes', { origin: 'https://evil.example' })
	assert.equal(foreign.status, 200)
	assert.equal(h.cache.stats.hits, hitsBefore + 2)
	assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null, 'a disallowed origin never inherits a cached allow-origin')
})

test('48b: a warm pre-deploy edge entry that still carries CORS/Vary headers is stripped on the HIT path', async () => {
	const h = buildHarness()

	const first = await h.send('/mixtapes', { origin: 'https://next.smol.xyz' })
	assert.equal(first.status, 200)
	await first.text()

	// Simulate an entry written by the previous deploy (no strip-on-write): first requester's CORS + Vary.
	const stored = h.cache.entries()
	assert.equal(stored.length, 1)
	stored[0][1].headers.push(
		['access-control-allow-origin', 'https://next.smol.xyz'],
		['access-control-allow-credentials', 'true'],
		['access-control-expose-headers', 'X-Stale'],
		['vary', 'Origin, X-Stale-Vary'],
	)

	const hitsBefore = h.cache.stats.hits
	const foreign = await h.send('/mixtapes', { origin: 'https://evil.example' })
	assert.equal(foreign.status, 200)
	assert.equal(h.cache.stats.hits, hitsBefore + 1, 'served from the stale edge entry')
	assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null, 'stale allow-origin never replayed')
	assert.ok(!(foreign.headers.get('Access-Control-Expose-Headers') ?? '').includes('X-Stale'), 'stale expose-headers never replayed')
	assert.ok(!(foreign.headers.get('Vary') ?? '').includes('X-Stale-Vary'), 'stale Vary from the cached entry is not replayed')
	assert.equal(foreign.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate')

	const allowed = await h.send('/mixtapes', { origin: 'https://smol.xyz' })
	assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://smol.xyz', 'cors() re-adds the correct origin on a hit')
})
