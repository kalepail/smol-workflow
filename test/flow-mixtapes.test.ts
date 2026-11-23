import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test, { after, before } from 'node:test'
import {
	createAuthToken,
	createMockExecutionContext,
	createSqliteD1,
	installCloudflareStubs,
	type CloudflareStubHandle,
} from './helpers/harness'
import {
	classifyOwnerMixtapes,
	findBorderlinePair,
	type MixtapeCandidate,
} from '../src/utils/mixtape-visibility'

const TEST_SECRET = 'test-jwt-secret-32-chars-minimum!'

interface FixtureMixtape { Id: string; Title: string; Desc: string; Address: string; Created_At: string; Smols: string }
interface FixtureSmol { Id: string; Title: string; Address: string; Public: number }
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/mixtapes-live-18.json', import.meta.url), 'utf8')) as {
	mixtapes: FixtureMixtape[]
	smols: FixtureSmol[]
}
const MIGRATION_0002 = readFileSync(new URL('../migrations/0002_mixtapes_lifecycle.sql', import.meta.url), 'utf8')
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
		"Address" TEXT NOT NULL, Mint_Token TEXT DEFAULT NULL, Mint_Amm TEXT DEFAULT NULL
	);
	CREATE TABLE Mixtapes (
		Id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
		Title TEXT NOT NULL, Desc TEXT NOT NULL, Smols TEXT NOT NULL, "Address" TEXT NOT NULL,
		Created_At DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE INDEX idx_mixtapes_created ON Mixtapes(Created_At DESC, Id DESC);
`

let stubs: CloudflareStubHandle
let appModule: typeof import('../src/index')
const originalFetch = globalThis.fetch
const purgedTagBatches: string[][] = []
const cachePuts: string[] = []

before(async () => {
	// Must exist before routes are defined: hono/cache checks globalThis.caches at import time.
	Reflect.set(globalThis, 'caches', {
		open: async () => ({
			match: async () => undefined,
			put: async (key: string) => {
				cachePuts.push(new URL(key).pathname)
			},
		}),
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

	const { d1 } = createSqliteD1(db)
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
	const ctx = createMockExecutionContext()

	async function send(path: string, init: { method?: string; body?: unknown; as?: string } = {}) {
		const headers = new Headers()
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
		await ctx.flush()
		return res
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
	const backdate = (id: string, minutes: number) => db.prepare(`UPDATE Mixtapes SET Created_At = datetime('now', ?) WHERE Id = ?`).run(`-${minutes} minutes`, id)

	return { db, env, send, json, row, backdate, aiCalls }
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
	cachePuts.length = 0

	const list = await h.json<Array<Record<string, any>>>('/mixtapes')
	assert.equal(list.status, 200)
	assert.equal(list.body.length, 15)
	assert.ok(HIDDEN_IDS.every((id) => !list.body.some((m) => m.Id === id)), 'hidden rows never listed')
	assert.ok(list.body.some((m) => m.Id === PRE_PARTY))
	assert.deepEqual(list.body.map((m) => m.Created_At), [...list.body.map((m) => m.Created_At)].sort().reverse(), 'newest first')
	assert.equal(list.body.find((m) => m.Id === '807e0a11b827b1e3')!.Smols.length, 11, 'private song slots never exposed')
	assert.deepEqual(Object.keys(list.body[0]).sort(), ['Address', 'Created_At', 'Desc', 'Id', 'Smols', 'Title', 'Updated_At'])
	assert.match(list.res.headers.get('Cache-Control')!, /public, max-age=60/)
	assert.equal(list.res.headers.get('Cache-Tag'), 'mixtapes')
	assert.ok(cachePuts.includes('/mixtapes'))

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
	assert.ok(!cachePuts.includes('/mixtapes/mine'), '/mine never enters the shared cache')

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

	// Appends only songs the target lacks, in source order, skipping private ones; title updated.
	const create = async (title: string, smols: string[]) => (await h.json('/mixtapes', { method: 'POST', as: NEW_OWNER, body: { title, smols } })).body.id as string
	const a = await create('Alpha', [SYN(1), SYN(2), SYN(3)])
	const b = await create('Beta', [SYN(3), SYN(4), SYN(5)])
	h.db.prepare('UPDATE Mixtapes SET Smols = ? WHERE Id = ?').run([SYN(3), PRIVATE_SYN, SYN(4), SYN(5)].join(','), b)
	const ab = await merge(b, { targetId: a, title: 'Alpha + Beta' }, NEW_OWNER)
	assert.deepEqual([ab.status, ab.body.addedCount, ab.body.totalTracks, ab.body.target.Title], [200, 2, 5, 'Alpha + Beta'])
	assert.equal(h.row(a)!.Smols, [SYN(1), SYN(2), SYN(3), SYN(4), SYN(5)].join(','))

	// Merge chains resolve to the live terminal target.
	const c = await create('Gamma', [SYN(40), SYN(41)])
	assert.equal((await merge(a, { targetId: c }, NEW_OWNER)).status, 200)
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
