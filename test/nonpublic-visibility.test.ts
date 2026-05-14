import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function source(path: string) {
	return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('direct smol reads do not treat non-public smols as secret', async () => {
	const smolsSource = await source('src/api/smols.ts')

	assert.doesNotMatch(smolsSource, /smol_d1\.Public\s*!==\s*1\s*&&\s*smol_d1\.Address/)
	assert.match(smolsSource, /headers\.set\('Cache-Control', 'public, max-age=30, stale-while-revalidate=60'\)/)
})

test('authenticated liked-smol list is not filtered to public discovery items', async () => {
	const smolsSource = await source('src/api/smols.ts')

	assert.doesNotMatch(smolsSource, /l\."Address"\s*=\s*\?\s+AND\s+s\.Public\s*=\s*1/)
})

test('smol list responses expose the existing D1 Public field', async () => {
	const smolsSource = await source('src/api/smols.ts')

	assert.match(smolsSource, /interface SmolListItem[\s\S]*Public: number/)
	assert.match(smolsSource, /SELECT Id, Title, Song_1, Mint_Token, Mint_Amm, Created_At, Public/)
	assert.match(smolsSource, /SELECT s\.Id, s\.Title, s\.Song_1, s\.Mint_Token, s\.Mint_Amm, s\.Created_At, s\.Public/)
})

test('search results expose Public after public-only hydration', async () => {
	const searchSource = await source('src/utils/search.ts')

	assert.match(searchSource, /Public: number/)
	assert.match(searchSource, /if \(!row \|\| row\.Public !== 1\)/)
	assert.match(searchSource, /Public: row\.Public/)
})

test('likes endpoints can include any existing smol, public or non-public', async () => {
	const likesSource = await source('src/api/likes.ts')

	assert.match(likesSource, /WHERE l\."Address" = \?1/)
	assert.doesNotMatch(likesSource, /WHERE l\."Address" = \?1 AND s\.Public = 1/)
	assert.match(likesSource, /SELECT 1 FROM Smols WHERE Id = \?1/)
	assert.doesNotMatch(likesSource, /SELECT 1 FROM Smols WHERE Id = \?1 AND Public = 1/)
	assert.doesNotMatch(likesSource, /not public/)
})
