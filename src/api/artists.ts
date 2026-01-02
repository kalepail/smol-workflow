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
        // Optimized with CTEs to avoid correlated subqueries (O(n) instead of O(n^2))
        const { results } = await env.SMOL_D1.prepare(`
			WITH RankedSmols AS (
				SELECT 
					Address, Id, Title, Created_At,
					ROW_NUMBER() OVER (PARTITION BY Address ORDER BY Created_At DESC) as rn
				FROM Smols
				WHERE Public = 1
			),
			Aggregates AS (
				SELECT
					Address,
					COUNT(*) as songCount,
					SUM(Plays) as totalPlays,
					SUM(Views) as totalViews
				FROM Smols
				WHERE Public = 1
				GROUP BY Address
			),
			LikesCount AS (
				SELECT s.Address, COUNT(l.Id) as totalLikes
				FROM Smols s
				JOIN Likes l ON s.Id = l.Id
				WHERE s.Public = 1
				GROUP BY s.Address
			)
			SELECT 
				agg.Address,
				u.Username,
				agg.songCount,
				latest.Id as latestSmolId,
				latest.Title as latestSmolTitle,
				latest.Created_At as latestCreatedAt
			FROM Aggregates agg
			JOIN RankedSmols latest ON agg.Address = latest.Address AND latest.rn = 1
			LEFT JOIN LikesCount lc ON agg.Address = lc.Address
			LEFT JOIN Users u ON agg.Address = u.Address
			ORDER BY 
				(agg.totalPlays + agg.totalViews * 0.5 + IFNULL(lc.totalLikes, 0) * 10) DESC,
				latest.Created_At DESC
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
