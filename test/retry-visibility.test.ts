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

test('retry smol route accepts DO or KV state instead of requiring a D1 row', async () => {
	const smolsSource = await source('src/api/smols.ts')
	const retryRouteSource = smolsSource.slice(
		smolsSource.indexOf("smols.post('/retry/:id'"),
		smolsSource.indexOf('// Toggle public/private')
	)

	assert.match(smolsSource, /async function hasRetryableSmolState/)
	assert.match(smolsSource, /retrySteps = await stub\.getSteps\(\)/)
	assert.match(smolsSource, /if \(!retrySteps\?\.payload\) \{/)
	assert.match(smolsSource, /retrySteps = await env\.SMOL_KV\.get\(id, 'json'\)/)
	assert.match(smolsSource, /retrySteps\?\.payload\?\.address && retrySteps\?\.payload\?\.prompt/)
	assert.doesNotMatch(retryRouteSource, /SELECT Id\s+FROM Smols\s+WHERE Id = \?1/)
})

test('retry workflow falls back to KV if durable object state has flushed', async () => {
	const workflowSource = await source('src/workflow.ts')

	assert.match(workflowSource, /if \(!retry_steps\?\.payload\) \{/)
	assert.match(workflowSource, /retry_steps = await this\.env\.SMOL_KV\.get\(retry_id, 'json'\) as WorkflowSteps/)
})
