import { Hono } from 'hono'
import { cache } from 'hono/cache'
import type { HonoEnv } from '../types'

const artists = new Hono<HonoEnv>()

interface ArtistRow {
    Address: string
    Username: string | null
    songCount: number
    latestSmolId: string
    latestSmolTitle: string
    latestCreatedAt: string
}

// Get ranked artists (no raw metrics exposed for anti-cheat)
artists.get(
    '/',
    cache({
        cacheName: 'smol-workflow',
        cacheControl: 'public, max-age=300, stale-while-revalidate=600', // Cache for 5 mins
    }),
    async (c) => {
        const { env, req } = c
        const url = new URL(req.url)

        // Optional limit param
        const limitParam = parseInt(url.searchParams.get('limit') || '100')
        const limit = Math.min(Math.max(isNaN(limitParam) ? 100 : limitParam, 1), 200)

        // Query aggregates artists by Address, ordered by internal score
        // NOTE: We calculate score but DO NOT return it (hidden metrics)
        const { results } = await env.SMOL_D1.prepare(`
			SELECT 
				s.Address,
				u.Username,
				COUNT(*) as songCount,
				-- Get latest smol for cover art
				(SELECT Id FROM Smols WHERE Address = s.Address AND Public = 1 ORDER BY Created_At DESC LIMIT 1) as latestSmolId,
				(SELECT Title FROM Smols WHERE Address = s.Address AND Public = 1 ORDER BY Created_At DESC LIMIT 1) as latestSmolTitle,
				MAX(s.Created_At) as latestCreatedAt
			FROM Smols s
			LEFT JOIN Users u ON s.Address = u.Address
			WHERE s.Public = 1
			GROUP BY s.Address
			ORDER BY 
				-- Hidden score: engagement-weighted but not exposed
				(SUM(s.Plays) + SUM(s.Views) * 0.5 + 
				 (SELECT COUNT(*) FROM Likes l WHERE l.Id IN (SELECT Id FROM Smols WHERE Address = s.Address)) * 10
				) DESC,
				MAX(s.Created_At) DESC
			LIMIT ?
		`)
            .bind(limit)
            .all<ArtistRow>()

        // Return ranked artists WITHOUT raw play/view/like counts
        const rankedArtists = results.map((artist, index) => ({
            rank: index + 1,
            address: artist.Address,
            username: artist.Username,
            songCount: artist.songCount,
            latestSmol: {
                id: artist.latestSmolId,
                title: artist.latestSmolTitle,
            },
            // No plays, views, or likes exposed!
        }))

        const response = c.json({
            artists: rankedArtists,
        })

        response.headers.append('Cache-Tag', 'artists')

        return response
    }
)

export default artists
