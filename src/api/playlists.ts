import { Hono } from 'hono'
import type { HonoEnv } from '../types'
import { parsePaginationParams, buildCursorWhereClause, paginate } from '../utils/pagination'
import { playlistCacheTag } from '../utils/cache-tags'
import { publicCache } from '../utils/public-cache'

const playlists = new Hono<HonoEnv>()

interface User {
	Username: string
	Address: string
}

interface Smol {
	Id: string
	Title: string
	Song_1: string
	Address: string
	Plays: number
	Views: number
	Mint_Token: string | null
	Mint_Amm: string | null
	Created_At: string
	Public: number
}

playlists.get('/:title', publicCache, async (c) => {
	const { env, req } = c
	const playlistTitle = c.req.param('title')
	const { limit, cursor } = parsePaginationParams(new URL(req.url))

	const [where, ...cursorBindings] = buildCursorWhereClause(cursor, 'p.Title = ? AND +s.Public = 1', 's.')
	const { results } = await env.SMOL_D1.prepare(`
		SELECT s.Id, s.Title, s.Song_1, s.Address, s.Plays, s.Views, s.Mint_Token, s.Mint_Amm, s.Created_At, s.Public
		FROM Playlists p CROSS JOIN Smols s ON s.Id = p.Id
		WHERE ${where}
		ORDER BY s.Created_At DESC, s.Id DESC
		LIMIT ?
	`).bind(playlistTitle, ...cursorBindings, limit + 1).all<Smol>()
	const { items: smolsFromDb, pagination } = paginate(results, limit)

	const addresses = [...new Set(smolsFromDb.map((smol) => smol.Address))].filter(Boolean)
	const userReads: Promise<D1Result<User>>[] = []
	for (let index = 0; index < addresses.length; index += 90) {
		const chunk = addresses.slice(index, index + 90)
		userReads.push(env.SMOL_D1.prepare(
			`SELECT Username, Address FROM Users WHERE Address IN (${chunk.map(() => '?').join(',')})`
		).bind(...chunk).all<User>())
	}
	const users = (await Promise.all(userReads)).flatMap(({ results }) => results)

	const response = c.json({ smols: smolsFromDb, users, pagination })
	response.headers.append('Cache-Tag', await playlistCacheTag(playlistTitle))
	return response
})

export default playlists
