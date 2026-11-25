export function artistSmolsCacheTag(artistAddress: string): string {
	return `artist:${encodeURIComponent(artistAddress)}:smols`
}

/** Cache-Tag values must be short printable ASCII; a playlist title can be any text, so hash it. */
export async function playlistCacheTag(title: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(title)))
	return `playlist:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function playlistCacheTags(titles: Iterable<string>): Promise<string[]> {
	return Promise.all([...new Set(titles)].map(playlistCacheTag))
}
