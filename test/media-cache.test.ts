import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('generated R2 media uses long-lived cache headers', async () => {
	const mediaSource = await readFile(new URL('../src/api/media.ts', import.meta.url), 'utf8')

	assert.match(mediaSource, /MEDIA_CACHE_CONTROL = 'public, max-age=2592000, stale-while-revalidate=86400'/)
	assert.doesNotMatch(mediaSource, /max-age=300/)
	assert.match(mediaSource, /headers\.set\('Cache-Control', MEDIA_CACHE_CONTROL\)/)
	assert.match(mediaSource, /'Cache-Control': MEDIA_CACHE_CONTROL/)
})
