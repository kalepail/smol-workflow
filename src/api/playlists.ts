import { Hono } from 'hono'
import { cache } from 'hono/cache'
import type { HonoEnv } from '../types'
import {
	parsePaginationParams,
	buildCursorWhereClause,
	buildPaginationResponse,
} from '../utils/pagination'

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
}

playlists.get(
	'/:title',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=30, stale-while-revalidate=60',
	}),
	async (c) => {
		const { env, req } = c
		const playlistTitle = c.req.param('title')
		const { limit, cursor } = parsePaginationParams(new URL(req.url))

		const whereClause = buildCursorWhereClause(cursor, 'p.Title = ? AND s.Public = 1', 's.')
		const bindings: any[] = []

		let query: string
		if (whereClause.length > 1) {
			// Has cursor bindings
			query = `
				SELECT s.Id, s.Title, s.Song_1, s.Address, s.Plays, s.Views, s.Mint_Token, s.Mint_Amm, s.Created_At
				FROM Smols s
				INNER JOIN Playlists p ON s.Id = p.Id
				WHERE ${whereClause[0]}
				ORDER BY s.Created_At DESC, s.Id DESC
				LIMIT ?
			`
			bindings.push(playlistTitle, whereClause[1], whereClause[2], whereClause[3], limit)
		} else {
			// No cursor bindings
			query = `
				SELECT s.Id, s.Title, s.Song_1, s.Address, s.Plays, s.Views, s.Mint_Token, s.Mint_Amm, s.Created_At
				FROM Smols s
				INNER JOIN Playlists p ON s.Id = p.Id
				WHERE ${whereClause[0]}
				ORDER BY s.Created_At DESC, s.Id DESC
				LIMIT ?
			`
			bindings.push(playlistTitle, limit)
		}

		const smolsD1Result = await env.SMOL_D1.prepare(query)
			.bind(...bindings)
			.all<Smol>()

		const smolsFromDb = smolsD1Result.results || []
		let users: User[] = []

		if (smolsFromDb.length > 0) {
			const creatorAddresses = [...new Set(smolsFromDb.map((smol) => smol.Address!))].filter(
				Boolean
			)

			if (creatorAddresses.length > 0) {
				const placeholders = creatorAddresses.map(() => '?').join(',')
				const usersD1Result = await env.SMOL_D1.prepare(
					`SELECT Username, Address FROM Users WHERE Address IN (${placeholders})`
				)
					.bind(...creatorAddresses)
					.all<User>()
				users = usersD1Result.results || []
			}
		}

		const pagination = buildPaginationResponse(
			smolsFromDb,
			limit,
			(item) => item.Created_At,
			(item) => item.Id
		)

		// Remove Created_At from response items
		const smols = smolsFromDb.map(({ Created_At, ...rest }) => rest)

		return c.json({
			smols,
			users: users,
			pagination,
		})
	}
)

export default playlists
