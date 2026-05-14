import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('mint completion avoids global cache purges', async () => {
	const workflowSource = await readFile(new URL('../src/tx-workflow.ts', import.meta.url), 'utf8')

	assert.doesNotMatch(workflowSource, /'public-smols'/)
	assert.doesNotMatch(workflowSource, /'mixtapes'/)
	assert.match(workflowSource, /user:\$\{ownerSub\}:smol:\$\{id\}/)
	assert.match(workflowSource, /smol:\$\{id\}:anonymous/)
	assert.match(workflowSource, /artistSmolsCacheTag\(ownerSub\)/)
})
