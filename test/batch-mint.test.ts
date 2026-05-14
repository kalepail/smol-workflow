import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function source(path: string) {
	return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('batch mint skips already-minted smols instead of rejecting the whole batch', async () => {
	const mintSource = await source('src/api/mint.ts')

	assert.match(mintSource, /const mintableIds: string\[\] = \[\]/)
	assert.match(mintSource, /const alreadyMintedIds: string\[\] = \[\]/)
	assert.doesNotMatch(mintSource, /throw new HTTPException\(409, \{ message: `Smol \$\{record\.Id\} already minted` \}\)/)
	assert.match(mintSource, /if \(mintableIds\.length === 0\)/)
	assert.match(mintSource, /acceptedIds: mintableIds/)
	assert.match(mintSource, /alreadyMinted: alreadyMintedIds/)
})

test('batch mint workflow can persist compact results for only mintable ids', async () => {
	const workflowSource = await source('src/tx-workflow.ts')

	assert.match(workflowSource, /const requestedIds = event\.payload\.ids \?\? \[\]/)
	assert.match(workflowSource, /const mintableIds = event\.payload\.mintableIds \?\? requestedIds/)
	assert.match(workflowSource, /results\.length === mintableIds\.length/)
	assert.match(workflowSource, /const id = resultIds\[i\]/)
})
