import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function source(path: string) {
	return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('retry smol route does not require caller authentication', async () => {
	const smolsSource = await source('src/api/smols.ts')

	assert.match(smolsSource, /smols\.post\('\/retry\/:id', async \(c\) =>/)
	assert.doesNotMatch(smolsSource, /smols\.post\('\/retry\/:id', parseAuth/)
})

test('retry workflow preserves original smol creator attribution', async () => {
	const workflowSource = await source('src/workflow.ts')

	assert.match(workflowSource, /Retry can be started by anyone/)
	assert.match(workflowSource, /\.\.\.retry_steps\?\.payload/)
	assert.match(workflowSource, /const \{ address/)
})
