import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import {
	createMockExecutionContext,
	installCloudflareStubs,
	type CloudflareStubHandle,
} from './helpers/harness'

let stubs: CloudflareStubHandle
let appModule: typeof import('../src/index')

before(async () => {
	stubs = installCloudflareStubs()
	appModule = await import('../src/index')
})

after(() => {
	stubs.cleanup()
})

test('GET /:id attaches Users.Username and skips Views increment when ?no_view=1', async () => {
	const smolId = 'a'.repeat(64)
	const address = 'C' + 'A'.repeat(55)
	const kvData = { lyrics: { title: 'Preview Song', style: ['synth'], lyrics: 'hi' } }

	let viewIncrements = 0
	const env = {
		SMOL_KV: {
			get: async (key: string) => (key === smolId ? kvData : null),
		},
		SMOL_D1: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							first: async () => {
								if (sql.includes('FROM Smols WHERE Id = ?1') && args[0] === smolId) {
									return {
										Id: smolId,
										Title: 'Preview Song',
										Song_1: 'song-1',
										Song_2: null,
										Address: address,
										Public: 1,
										Plays: 3,
										Views: 10,
									}
								}
								if (sql.includes('SELECT Username FROM Users') && args[0] === address) {
									return { Username: 'noot' }
								}
								return null
							},
							run: async () => {
								if (sql.includes('SET Views = Views + 1')) viewIncrements++
								return { success: true, meta: { changes: 1 } }
							},
						}
					},
				}
			},
		},
	} as unknown as Env

	const ctx1 = createMockExecutionContext()
	const noViewRes = await appModule.app.fetch(new Request(`https://api.smol.xyz/${smolId}?no_view=1`), env, ctx1.ctx)
	await ctx1.flush()
	assert.equal(noViewRes.status, 200)
	const body1 = await noViewRes.json() as { d1?: { Username?: string; Title?: string } }
	assert.equal(body1.d1?.Username, 'noot')
	assert.equal(viewIncrements, 0, '?no_view=1 must not increment Views')

	const ctx2 = createMockExecutionContext()
	const normalRes = await appModule.app.fetch(new Request(`https://api.smol.xyz/${smolId}`), env, ctx2.ctx)
	await ctx2.flush()
	assert.equal(normalRes.status, 200)
	const body2 = await normalRes.json() as { d1?: { Username?: string } }
	assert.equal(body2.d1?.Username, 'noot')
	assert.equal(viewIncrements, 1, 'normal GET /:id must still increment Views')
})
