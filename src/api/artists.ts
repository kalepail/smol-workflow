import { Hono } from 'hono'
import type { HonoEnv } from '../types'
import { parsePaginationParams, buildCursorWhereClause, paginate } from '../utils/pagination'
import { artistSmolsCacheTag } from '../utils/cache-tags'
import { publicCache } from '../utils/public-cache'

const artists = new Hono<HonoEnv>()

interface Artist {
	Username: string
	Address: string
}

interface ArtistSmol {
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

artists.get('/:address/smols', publicCache, async (c) => {
	const { env, req } = c
	const artistAddress = c.req.param('address')
	const { limit, cursor } = parsePaginationParams(new URL(req.url))
	const [where, ...cursorBindings] = buildCursorWhereClause(cursor, 's."Address" = ? AND s.Public = 1', 's.')

	const { results } = await env.SMOL_D1.prepare(`
		SELECT s.Id, s.Title, s.Song_1, s.Address, s.Plays, s.Views, s.Mint_Token, s.Mint_Amm, s.Created_At, s.Public
		FROM Smols s
		WHERE ${where}
		ORDER BY s.Created_At DESC, s.Id DESC
		LIMIT ?
	`).bind(artistAddress, ...cursorBindings, limit + 1).all<ArtistSmol>()
	const { items, pagination } = paginate(results ?? [], limit)

	const artist = items.length > 0
		? await env.SMOL_D1.prepare(`SELECT Username, Address FROM Users WHERE Address = ? LIMIT 1`)
			.bind(artistAddress)
			.first<Artist>()
		: null

	const response = c.json({
		artist: artist ?? null,
		smols: items,
		users: artist ? [artist] : [],
		pagination,
	})
	response.headers.append('Cache-Tag', artistSmolsCacheTag(artistAddress))
	return response
})

export default artists
