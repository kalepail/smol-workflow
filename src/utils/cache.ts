/**
 * Cache purge utilities for invalidating Cloudflare cache via API
 */

import { env } from 'cloudflare:workers'
import type { Context } from 'hono'
import type { HonoEnv } from '../types'

/**
 * Purge cache by tags using Cloudflare API
 * This performs a global cache purge across all data centers
 */
export async function purgeCacheByTags(tags: string[]): Promise<boolean> {
	if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
		console.warn('Cache purge skipped: CF_API_TOKEN or CF_ZONE_ID not configured')
		return false
	}

	if (!tags.length) {
		console.warn('Cache purge skipped: no tags provided')
		return false
	}

	try {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`,
			{
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${env.CF_API_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ tags }),
			}
		)

		if (!response.ok) {
			const error = await response.text()
			console.error('Cache purge failed:', response.status, error)
			return false
		}

		const result = await response.json() as { success: boolean }
		console.log('Cache purged successfully for tags:', tags)
		return result.success
	} catch (error) {
		console.error('Cache purge error:', error)
		return false
	}
}

/**
 * Helper to purge cache for a specific user's created smols
 */
export function purgeUserCreatedCache(userId: string): Promise<boolean> {
	return purgeCacheByTags([`user:${userId}:created`])
}

/**
 * Helper to purge cache for a specific user's liked smols
 * Purges both the /liked list and /likes array
 */
export function purgeUserLikedCache(
	userId: string,
	smolId?: string
): Promise<boolean> {
	const tags = [`user:${userId}:liked`, `user:${userId}:likes`]

	// Optionally purge the specific smol detail page for this user ONLY
	// Since cache varies by Cookie, each user has their own cache entry
	// We only need to purge the cache for the user who toggled the like
	if (smolId) {
		tags.push(`user:${userId}:smol:${smolId}`)
	}

	return purgeCacheByTags(tags)
}

/**
 * Helper to purge cache for mixtapes
 */
export function purgeMixtapesCache(): Promise<boolean> {
	return purgeCacheByTags(['mixtapes'])
}

/**
 * Helper to purge cache for public smols list
 */
export function purgePublicSmolsCache(): Promise<boolean> {
	return purgeCacheByTags(['public-smols'])
}

/**
 * Helper to purge cache for a specific playlist
 */
export function purgePlaylistCache(playlistTitle: string): Promise<boolean> {
	return purgeCacheByTags([`playlist:${playlistTitle}`])
}

/**
 * Cache key generator that varies by user's sub claim (contract/wallet address)
 * instead of the raw Cookie header. This ensures cache hits even when the JWT
 * token changes (e.g., after logout/login).
 */
export function userCacheKeyGenerator(c: Context<HonoEnv>): string {
	const payload = c.get('jwtPayload')
	const userSub = payload?.sub || 'anonymous'
	const url = new URL(c.req.url)

	// Create a unique URL by adding user identifier as a query param
	// This keeps it a valid URL while varying by user
	url.searchParams.set('__cache_user', userSub)

	return url.toString()
}
