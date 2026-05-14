import { Hono } from 'hono'
import { cache } from 'hono/cache'
import type { HonoEnv } from '../types'
import {
	parsePaginationParams,
	buildCursorWhereClause,
	buildPaginationResponse,
} from '../utils/pagination'
import { artistSmolsCacheTag } from '../utils/cache-tags'

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
}

artists.get(
	'/:address/smols',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=30, stale-while-revalidate=60',
	}),
	async (c) => {
		const { env, req } = c
		const artistAddress = c.req.param('address')
		const { limit, cursor } = parsePaginationParams(new URL(req.url))

		const whereClause = buildCursorWhereClause(cursor, 's."Address" = ? AND s.Public = 1', 's.')
		const bindings: any[] = []

		const query = `
			SELECT s.Id, s.Title, s.Song_1, s.Address, s.Plays, s.Views, s.Mint_Token, s.Mint_Amm, s.Created_At
			FROM Smols s
			WHERE ${whereClause[0]}
			ORDER BY s.Created_At DESC, s.Id DESC
			LIMIT ?
		`

		if (whereClause.length > 1) {
			bindings.push(artistAddress, whereClause[1], whereClause[2], whereClause[3], limit)
		} else {
			bindings.push(artistAddress, limit)
		}

		const smolsD1Result = await env.SMOL_D1.prepare(query)
			.bind(...bindings)
			.all<ArtistSmol>()

		const smolsFromDb = smolsD1Result.results || []
		let artist: Artist | null = null
		if (smolsFromDb.length > 0) {
			artist = await env.SMOL_D1.prepare(
				`SELECT Username, Address FROM Users WHERE Address = ? LIMIT 1`
			)
				.bind(artistAddress)
				.first<Artist>()
		}

		const pagination = buildPaginationResponse(
			smolsFromDb,
			limit,
			(item) => item.Created_At,
			(item) => item.Id
		)

		const response = c.json({
			artist: artist ?? null,
			smols: smolsFromDb,
			users: artist ? [artist] : [],
			pagination,
		})

		response.headers.append('Cache-Tag', artistSmolsCacheTag(artistAddress))

		return response
	}
)

export default artists
