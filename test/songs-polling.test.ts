import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('song polling waits for every requested song status before evaluating streaming or completion', async () => {
	const songsSource = await source('src/utils/songs.ts')
	const missingStatusGuard = "if (songs.length !== song_ids.length)"

	assert.match(songsSource, /Waiting for song statuses \(\$\{songs\.length\}\/\$\{song_ids\.length\} returned\)/)
	assert.ok(
		songsSource.indexOf(missingStatusGuard) < songsSource.indexOf('let has_audio = false'),
		'missing song status guard should run before streaming/completion checks',
	)
	assert.ok(
		songsSource.indexOf(missingStatusGuard) < songsSource.indexOf("if (mode === 'streaming')"),
		'missing song status guard should run before returning streaming songs',
	)
})
