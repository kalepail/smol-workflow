import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function source(path: string) {
	return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

function routeSource(smolsSource: string) {
	return smolsSource.slice(
		smolsSource.indexOf("smols.post('/', parseAuth"),
		smolsSource.indexOf('// Retry smol creation')
	)
}

test('create route seeds durable object payload before workflow create returns an id', async () => {
	const smolsSource = await source('src/api/smols.ts')
	const createRouteSource = routeSource(smolsSource)

	assert.match(createRouteSource, /const workflowParams = \{/)
	assert.match(createRouteSource, /address: payload\.sub/)
	assert.match(createRouteSource, /prompt: body\.prompt/)
	assert.match(createRouteSource, /public: body\.public \?\? true/)
	assert.match(createRouteSource, /instrumental: isInstrumental/)
	assert.match(createRouteSource, /playlist: body\.playlist/)
	assert.match(createRouteSource, /const doid = env\.DURABLE_OBJECT\.idFromString\(instanceId\)/)
	assert.match(createRouteSource, /const stub = env\.DURABLE_OBJECT\.get\(doid\)/)
	assert.match(createRouteSource, /await stub\.saveStep\('payload', workflowParams\)/)
	assert.match(createRouteSource, /params: workflowParams/)
	assert.ok(
		createRouteSource.indexOf("await stub.saveStep('payload', workflowParams)") <
			createRouteSource.indexOf('await env.WORKFLOW.create'),
		'payload must be saved before workflow creation can race with an early GET'
	)
})

test('early owned get path reads seeded durable object payload for in-progress smols', async () => {
	const smolsSource = await source('src/api/smols.ts')
	const getRouteSource = smolsSource.slice(
		smolsSource.indexOf("smols.get(\n\t'/:id'"),
		smolsSource.indexOf('// Create new smol')
	)

	assert.match(getRouteSource, /const steps = \(await stub\.getSteps\(\)\) as any \|\| \{\}/)
	assert.match(getRouteSource, /if \(!payload\?\.sub \|\| steps\?\.payload\?\.address !== payload\.sub\) \{/)
	assert.match(getRouteSource, /const \{ image_base64, \.\.\.rest \} = steps/)
	assert.match(getRouteSource, /kv_do,\s+wf: instance && \(await instance\.status\(\)\),\s+liked,/)
	assert.match(getRouteSource, /response\.headers\.set\('Cache-Control', 'no-store'\)/)
})
