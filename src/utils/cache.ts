/**
 * Cache purge utilities for invalidating Cloudflare cache via API
 */

import { env } from 'cloudflare:workers'

/** Cloudflare accepts up to 100 tags per purge request (Free: 5 requests/min, bucket 25). */
const PURGE_TAGS_PER_REQUEST = 100

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
		for (let i = 0; i < uniqueTags.length; i += PURGE_TAGS_PER_REQUEST) {
			tagChunks.push(uniqueTags.slice(i, i + PURGE_TAGS_PER_REQUEST))
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
				} else if (response.status === 429) {
					console.warn('Cache purge rate limited:', { tagCount: chunk.length, retryAfter: response.headers.get('Retry-After') })
				} else {
					console.error('Cache purge failed:', response.status)
				}
				return false
			}

			const result = await response.json() as { success: boolean }
			return result.success === true
		}))

		const succeeded = results.filter(Boolean).length
		if (succeeded === results.length) {
			console.log('Cache purged', { tagCount: uniqueTags.length, chunkCount: tagChunks.length })
			return true
		}
		console.warn('Cache purge incomplete', { tagCount: uniqueTags.length, chunkCount: tagChunks.length, failedChunks: results.length - succeeded })
		return false
	} catch {
		console.warn('Cache purge request failed')
		return false
	}
}

/**
 * Purge the mixtapes listing plus the detail entries of every mixtape whose
 * content or derived visibility changed (edited row, promoted/hidden siblings, merge target).
 */
export function purgeMixtapeCache(mixtapeIds: string[]): Promise<boolean> {
	return purgeCacheByTags(['mixtapes', ...mixtapeIds.map((id) => `mixtape:${id}`)])
}
