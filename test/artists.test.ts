import assert from 'node:assert/strict'
import test from 'node:test'
import artists from '../src/api/artists'
import { encodeCursor } from '../src/utils/pagination'

type PreparedCall = {
	sql: string
	bindings: unknown[]
}

type MockSmol = {
	Id: string
	Title: string
	Song_1: string
	Address: string
	Plays: number
	Views: number
	Mint_Token: string | null
	Mint_Amm: string | null
	Created_At: string
}

function installCacheMock() {
	Reflect.set(globalThis, 'caches', {
		open: async () => ({
			match: async () => undefined,
			put: async () => undefined,
		}),
	})
}

function createEnv(options: {
	smols?: MockSmol[]
	artist?: { Username: string; Address: string } | null
}) {
	const calls: PreparedCall[] = []

	const env = {
		SMOL_D1: {
			prepare(sql: string) {
				return {
					bind(...bindings: unknown[]) {
						calls.push({ sql, bindings })

						return {
							all: async <T>() => {
								assert.match(sql, /s\."Address" = \? AND s\.Public = 1/)
								assert.match(sql, /ORDER BY s\.Created_At DESC, s\.Id DESC/)
								return { results: (options.smols ?? []) as T[] }
							},
							first: async <T>() => {
								assert.match(sql, /SELECT Username, Address FROM Users/)
								return (options.artist ?? null) as T | null
							},
							run: async () => ({ success: true }),
						}
					},
				}
			},
		},
	} as unknown as Env

	return { env, calls }
}

test('artist smols endpoint lists only public smols for one artist query', async () => {
	installCacheMock()
	const artistAddress = 'CARTIST'
	const smol = {
		Id: 'smol-2',
		Title: 'Public song',
		Song_1: 'song-1',
		Address: artistAddress,
		Plays: 4,
		Views: 8,
		Mint_Token: null,
		Mint_Amm: null,
		Created_At: '2026-05-14T12:00:00.000Z',
	}
	const { env, calls } = createEnv({
		smols: [smol],
		artist: { Username: 'Artist', Address: artistAddress },
	})

	const response = await artists.request(`/${artistAddress}/smols?limit=1`, {}, env)
	const body = await response.json() as {
		artist: { Username: string; Address: string } | null
		smols: MockSmol[]
		users: Array<{ Username: string; Address: string }>
		pagination: { nextCursor: string | null; hasMore: boolean }
	}

	assert.equal(response.status, 200)
	assert.deepEqual(body.artist, { Username: 'Artist', Address: artistAddress })
	assert.deepEqual(body.users, [{ Username: 'Artist', Address: artistAddress }])
	assert.deepEqual(body.smols, [smol])
	assert.equal(body.pagination.hasMore, true)
	assert.equal(body.pagination.nextCursor, encodeCursor(smol.Created_At, smol.Id))
	assert.deepEqual(calls[0].bindings, [artistAddress, 1])
	assert.deepEqual(calls[1].bindings, [artistAddress])
	assert.equal(response.headers.get('Cache-Tag'), `artist:${artistAddress}:smols`)
})

test('artist smols endpoint includes cursor bindings after artist address', async () => {
	installCacheMock()
	const cursor = encodeCursor('2026-05-14T12:00:00.000Z', 'smol-2')
	const { env, calls } = createEnv({
		smols: [],
		artist: null,
	})

	const response = await artists.request(`/CARTIST/smols?limit=25&cursor=${encodeURIComponent(cursor)}`, {}, env)
	const body = await response.json() as {
		artist: null
		smols: MockSmol[]
		users: Array<{ Username: string; Address: string }>
		pagination: { nextCursor: string | null; hasMore: boolean }
	}

	assert.equal(response.status, 200)
	assert.equal(body.artist, null)
	assert.deepEqual(body.users, [])
	assert.deepEqual(body.smols, [])
	assert.deepEqual(body.pagination, { nextCursor: null, hasMore: false })
	assert.match(calls[0].sql, /s\.Created_At < \? OR \(s\.Created_At = \? AND s\.Id < \?\)/)
	assert.deepEqual(calls[0].bindings, [
		'CARTIST',
		'2026-05-14T12:00:00.000Z',
		'2026-05-14T12:00:00.000Z',
		'smol-2',
		25,
	])
})

test('artist smols endpoint encodes artist cache tag values', async () => {
	installCacheMock()
	const { env } = createEnv({
		smols: [],
		artist: null,
	})

	const response = await artists.request('/artist%3Aone/smols', {}, env)

	assert.equal(response.status, 200)
	assert.equal(response.headers.get('Cache-Tag'), 'artist:artist%3Aone:smols')
})
