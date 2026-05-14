export function artistSmolsCacheTag(artistAddress: string): string {
	return `artist:${encodeURIComponent(artistAddress)}:smols`
}
