import { Hono } from 'hono'
import { cache } from 'hono/cache'
import type { HonoEnv } from '../types'

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
}

playlists.get(
	'/:title',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=30',
	}),
	async (c) => {
		const { env } = c
		const playlistTitle = c.req.param('title')

		const smolsD1Result = await env.SMOL_D1.prepare(`
			SELECT s.Id, s.Title, s.Song_1, s.Address, s.Plays, s.Views, s.Mint_Token, s.Mint_Amm
			FROM Smols s
			INNER JOIN Playlists p ON s.Id = p.Id
			WHERE p.Title = ?1 AND s.Public = 1
			ORDER BY s.Created_At DESC
			LIMIT 1000
		`)
			.bind(playlistTitle)
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

		return c.json({
			smols: smolsFromDb,
			users: users,
		})
	}
)

export default playlists
