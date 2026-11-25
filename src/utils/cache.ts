/**
 * Cache purge utilities for invalidating Cloudflare cache via API
 */

import { env } from 'cloudflare:workers'

/**
 * Purge cache by tags using Cloudflare API
 * This performs a global cache purge across all data centers
 */
export async function purgeCacheByTags(tags: string[]): Promise<boolean> {
	if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
		console.warn('Cache purge skipped: CF_API_TOKEN or CF_ZONE_ID not configured')
		return false
	}

	const uniqueTags = [...new Set(tags)]

	if (!uniqueTags.length) {
		console.warn('Cache purge skipped: no tags provided')
		return false
	}

	try {
		const tagChunks: string[][] = []
		for (let i = 0; i < uniqueTags.length; i += 30) {
			tagChunks.push(uniqueTags.slice(i, i + 30))
		}

		const results = await Promise.all(tagChunks.map(async (chunk) => {
			const response = await fetch(
				`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`,
				{
					method: 'POST',
					signal: AbortSignal.timeout(10_000),
					headers: {
						'Authorization': `Bearer ${env.CF_API_TOKEN}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ tags: chunk }),
				}
			)

			if (!response.ok) {
				await response.body?.cancel().catch(() => {})
				if (response.status === 401 || response.status === 403) {
					console.warn('Cache purge skipped due auth error:', response.status)
				} else {
					console.error('Cache purge failed:', response.status)
				}
				return false
			}

			const result = await response.json() as { success: boolean }
			return result.success
		}))

		console.log('Cache purged', { tagCount: uniqueTags.length, chunkCount: tagChunks.length })
		return results.every(Boolean)
	} catch {
		console.warn('Cache purge request failed')
		return false
	}
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
 * Purge the mixtapes listing plus the detail entries of every mixtape whose
 * content or derived visibility changed (edited row, promoted/hidden siblings, merge target).
 */
export function purgeMixtapeCache(mixtapeIds: string[]): Promise<boolean> {
	return purgeCacheByTags(['mixtapes', ...mixtapeIds.map((id) => `mixtape:${id}`)])
}
