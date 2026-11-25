import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after, before } from 'node:test'
import { StrKey } from '@stellar/stellar-sdk/base'
import { createAuthToken, createMockExecutionContext, createSqliteD1, installCloudflareStubs } from './helpers/harness'

const SCHEMA = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8')
const SECRET = 'created-filter-jwt-secret-0123456789'
const OWNER = StrKey.encodeContract(Buffer.alloc(32, 7))
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 8))

type Page = { smols: Array<{ Id: string; Title: string; Public: number }>; pagination: { nextCursor: string | null; hasMore: boolean } }

let app: typeof import('../src/index').app
let cleanup: () => void

before(async () => {
	cleanup = installCloudflareStubs().cleanup
	;({ app } = await import('../src/index'))
})

after(() => cleanup())

function harness() {
	const db = new DatabaseSync(':memory:')
	db.exec(SCHEMA)
	const { d1, stats } = createSqliteD1(db)
	const env = { SECRET, SMOL_D1: d1 } as unknown as Env
	let minutes = 0

	/** Insert newest-last (each row one minute newer), so listings come back in reverse insertion order. */
	function smol(id: string, title: string, values: { address?: string; public?: number } = {}) {
		minutes += 1
		db.prepare(`INSERT INTO Smols (Id, Title, Song_1, "Address", Public, Created_At) VALUES (?, ?, ?, ?, ?, datetime('2026-01-01', ?))`)
			.run(id, title, `${id}-song`, values.address ?? OWNER, values.public ?? 1, `+${minutes} minutes`)
	}

	async function created(query: string, sub = OWNER) {
		const ctx = createMockExecutionContext()
		const response = await app.fetch(new Request(`https://api.smol.xyz/created${query}`, {
			headers: { Authorization: `Bearer ${await createAuthToken(sub, SECRET)}` },
		}), env, ctx.ctx)
		await ctx.flush()
		assert.equal(response.headers.get('Cache-Control'), 'private, no-store', `${query} cache-control`)
		assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store', `${query} cdn-cache-control`)
		return { status: response.status, body: await response.json() as Page & { error?: string } }
	}

	const ids = (page: Page) => page.smols.map((s) => s.Id)
	return { db, smol, created, ids, stats }
}

test('GET /created?q= matches titles case-insensitively, owner rows only, private and public', async () => {
	const h = harness()
	// Prove the explicit LOWER() + folded pattern, not SQLite's default ASCII-insensitive LIKE.
	h.db.exec('PRAGMA case_sensitive_like = ON')
	h.smol('a', 'Midnight Drive', { public: 0 })
	h.smol('b', 'MIDNIGHT snack')
	h.smol('c', 'Sunrise')
	h.smol('d', 'midnight (other user)', { address: OTHER })
	h.smol('e', 'ÉTÉ midnight')

	const { status, body } = await h.created('?q=MidNight')
	assert.equal(status, 200)
	assert.deepEqual(h.ids(body), ['e', 'b', 'a'])
	assert.deepEqual(body.smols.map((s) => s.Public), [1, 1, 0], 'private owner rows stay visible to the owner')
	assert.deepEqual(body.pagination, { nextCursor: null, hasMore: false })

	assert.deepEqual(h.ids((await h.created('?q=%20%20drive%20')).body), ['a'], 'q is trimmed')
	assert.deepEqual(h.ids((await h.created('?q=ÉTÉ')).body), ['e'], 'non-ASCII titles match themselves')
	assert.deepEqual(h.ids((await h.created('?q=nothing')).body), [])
	assert.deepEqual(h.ids((await h.created('?q=other')).body), [], 'other users\' titles never match')
	assert.deepEqual(h.ids((await h.created('?q=midnight', OTHER)).body), ['d'], 'each owner sees only their own rows')
})

test('GET /created?q= escapes LIKE wildcards and backslashes', async () => {
	const h = harness()
	h.smol('pct', '100% vibes')
	h.smol('plain', '1000 vibes')
	h.smol('under', 'snake_case')
	h.smol('nounder', 'snakeXcase')
	h.smol('slash', 'back\\slash')
	h.smol('noslash', 'backslash')

	assert.deepEqual(h.ids((await h.created('?q=%25')).body), ['pct'])
	assert.deepEqual(h.ids((await h.created('?q=0%25%20v')).body), ['pct'])
	assert.deepEqual(h.ids((await h.created('?q=_')).body), ['under'])
	assert.deepEqual(h.ids((await h.created('?q=e_c')).body), ['under'])
	assert.deepEqual(h.ids((await h.created('?q=%5C')).body), ['slash'])
	assert.deepEqual(h.ids((await h.created('?q=k%5Cs')).body), ['slash'])
	assert.deepEqual(h.ids((await h.created(`?q=${encodeURIComponent("'; DROP TABLE Smols; --")}`)).body), [])
	assert.equal((await h.created('')).body.smols.length, 6, 'table intact')
})

test('GET /created?q= paginates within the filtered set', async () => {
	const h = harness()
	for (let i = 0; i < 7; i++) {
		h.smol(`m${i}`, `Match ${i}`, { public: i % 2 })
		h.smol(`x${i}`, `Skip ${i}`)
	}
	h.smol('foreign', 'match foreign', { address: OTHER })

	const seen: string[] = []
	let cursor = ''
	for (let page = 0; page < 5; page++) {
		const { body } = await h.created(`?q=match&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
		seen.push(...h.ids(body))
		assert.ok(body.smols.length <= 3)
		if (!body.pagination.hasMore) break
		cursor = body.pagination.nextCursor!
	}
	assert.deepEqual(seen, ['m6', 'm5', 'm4', 'm3', 'm2', 'm1', 'm0'], 'no gaps, duplicates or non-matching rows across pages')
	const last = await h.created('?q=match&limit=7')
	assert.deepEqual(last.body.pagination, { nextCursor: null, hasMore: false }, 'exact multiple has no empty trailing page')
})

test('GET /created: empty/whitespace q is unfiltered, over-long q is 400, anonymous is 401', async () => {
	const h = harness()
	h.smol('a', 'One', { public: 0 })
	h.smol('b', 'Two')
	h.smol('c', 'Theirs', { address: OTHER })

	for (const query of ['', '?q=', '?q=%20%20%09', '?q']) {
		const { status, body } = await h.created(query)
		assert.equal(status, 200, query)
		assert.deepEqual(h.ids(body), ['b', 'a'], query)
	}
	const unfilteredSql = h.stats.statements.at(-1)!
	assert.doesNotMatch(unfilteredSql, /LIKE/)

	assert.deepEqual(h.ids((await h.created(`?q=${'o'.repeat(100)}`)).body), [], '100 characters is allowed')
	assert.match(h.stats.statements.at(-1)!, /s\."Address" = \? AND LOWER\(s\.Title\) LIKE \? ESCAPE '\\'/)
	assert.deepEqual(h.ids((await h.created(`?q=${encodeURIComponent(` ${'o'.repeat(100)} `)}`)).body), [], 'length is measured after trimming')

	const statementsBefore = h.stats.statements.length
	const tooLong = await h.created(`?q=${'o'.repeat(101)}`)
	assert.deepEqual([tooLong.status, tooLong.body], [400, { error: 'Query too long' }])
	assert.equal(h.stats.statements.length, statementsBefore, 'rejected before querying D1')

	const anonymous = await app.fetch(new Request('https://api.smol.xyz/created?q=one'), { SECRET } as unknown as Env, createMockExecutionContext().ctx)
	assert.equal(anonymous.status, 401)
	assert.equal(anonymous.headers.get('Cache-Control'), 'private, no-store')
})
