/**
 * Exact-bundle workerd smoke: runs the `wrangler deploy --dry-run` output in Miniflare (real workerd)
 * with local bindings only. Outbound network is blocked and counted; no secrets or live resources.
 *
 *   pnpm exec wrangler deploy --dry-run --outdir /tmp/wf1-lean-dry
 *   pnpm exec tsx scripts/wf1-bundle-smoke.ts /tmp/wf1-lean-dry
 *
 * The bundle is pinned to the mainnet mint identity, so the 4 real FE mainnet carriers go through HTTP
 * admission, and the 4 FE test-identity carriers go through the bundled TxWorkflow signer via a
 * smoke-only subclass whose only change is `mintIdentity()` (the unit tests do the same).
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { Address, xdr } from '@stellar/stellar-sdk/minimal'
import { sign } from 'hono/jwt'
import {
	assertSignedMintEnvelope, assertUnsignedMintEnvelope, buildMintExpectation, decodeMintCarrier, type MintKind,
} from '../src/chain/mint-authorization'
import { testIdentity, testIssuerKeypair } from '../test/fixtures/mint-authz/generate'

const ROOT = resolve(__dirname, '..')
const BUNDLE = resolve(process.argv[2] ?? '/tmp/wf1-lean-dry')
const TIP = 65_000_000
const SECRET = 'smoke-jwt-secret-0123456789abcdef'
// Miniflare ships with wrangler (not a direct dependency, so it is loaded untyped); v5 takes the
// v4 worker options shape through its converter.
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve('wrangler/package.json'))('miniflare')

type Carrier = { name: string; identity: string; kind: MintKind; sub: string; tracks: { id: string; creator: string }[]; xdr: string }
const carriers = (JSON.parse(readFileSync(join(ROOT, 'test/fixtures/mint-authz/fe-carriers.json'), 'utf8')) as { carriers: Carrier[] }).carriers
const config = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
assert.equal(config.vars.MINT_SIGNING_ENABLED, 'false')
assert.equal(config.vars.PLAY_COUNT_MODE, 'server')

writeFileSync(join(BUNDLE, 'smoke-entry.js'), `
import worker, { TxWorkflow } from './index.js'
export * from './index.js'
const puts = []
const logs = []
for (const level of ['log', 'warn', 'error']) {
	const original = console[level].bind(console)
	console[level] = (...args) => (logs.push(args.map(String).join(' ')), original(...args))
}
export class SmokeTxWorkflow extends TxWorkflow {
	mintIdentity() { return JSON.parse(this.env.SMOKE_TEST_IDENTITY) }
}
export default {
	...worker,
	async fetch(request, env, ctx) {
		const cache = caches.default
		if (!cache.smokePatched) {
			const put = cache.put.bind(cache)
			cache.put = (key, value) => (puts.push(new URL(key.url ?? key).pathname), put(key, value))
			cache.smokePatched = true
		}
		const url = new URL(request.url)
		if (url.pathname === '/__smoke/cache-puts') return Response.json(puts)
		if (url.pathname === '/__smoke/logs') return Response.json(logs)
		if (url.pathname === '/__smoke/sign') return Response.json(await env.SMOKE_TX_WORKFLOW.create({ params: await request.json() }).then((i) => ({ id: i.id })))
		if (url.pathname === '/__smoke/status') return Response.json(await (await env[url.searchParams.get('binding')].get(url.searchParams.get('id'))).status())
		return worker.fetch(request, env, ctx)
	},
}
`)

const KALE_MOCK = `
import { WorkerEntrypoint } from 'cloudflare:workers'
export default class extends WorkerEntrypoint {
	async fetch() { return new Response(null, { status: 404 }) }
	async getTip() { return { sequence: ${TIP}, closeTime: new Date().toISOString() } }
	async readEntries() { return { latestLedger: ${TIP}, archiveAware: true, entries: [] } }
	async getTx() { return { status: 'NOT_FOUND', latestLedger: ${TIP} } }
	async submitTransaction({ xdr }) {
		await this.env.CAPTURE.put('signed:' + crypto.randomUUID(), xdr)
		return { error: 'smoke capture: never relayed', errorCode: 'SMOKE' }
	}
}`

const escaped: string[] = []

function splitSql(sql: string): string[] {
	const statements: string[] = []
	let current = ''
	for (const line of sql.split('\n')) {
		if (!current && (!line.trim() || line.trim().startsWith('--'))) continue
		current += `${line}\n`
		const inTrigger = /^\s*CREATE TRIGGER/i.test(current)
		if (inTrigger ? /^\s*END;\s*$/i.test(line) : line.trimEnd().endsWith(';')) {
			statements.push(current.trim())
			current = ''
		}
	}
	return statements
}

async function start(vars: Record<string, string>, rows: Array<[string, string, number]>) {
	const mf = new Miniflare(convertV4MiniflareOptions({
		workers: [{
			name: 'smol-workflow',
			modulesRoot: BUNDLE,
			modules: [{ type: 'ESModule', path: join(BUNDLE, 'smoke-entry.js') }, { type: 'ESModule', path: join(BUNDLE, 'index.js') }],
			compatibilityDate: config.compatibility_date,
			compatibilityFlags: config.compatibility_flags,
			bindings: {
				...config.vars, ...vars, SECRET, ADMIN_SECRET: 'smoke-admin-secret',
				SK: testIssuerKeypair().secret(), SMOKE_TEST_IDENTITY: JSON.stringify(testIdentity()),
			},
			d1Databases: ['SMOL_D1'],
			kvNamespaces: ['SMOL_KV'],
			r2Buckets: ['SMOL_BUCKET'],
			queueProducers: { SEARCH_QUEUE: 'smol-search-queue' },
			durableObjects: { DURABLE_OBJECT: 'SmolDurableObject', DO_STATE: 'SmolState', USER_QUOTA: { className: 'UserQuotaDO', useSQLite: true } },
			workflows: {
				WORKFLOW: { name: 'smol-workflow', className: 'Workflow' },
				TX_WORKFLOW: { name: 'smol-tx-workflow', className: 'TxWorkflow' },
				SMOKE_TX_WORKFLOW: { name: 'smoke-tx-workflow', className: 'SmokeTxWorkflow' },
			},
			serviceBindings: { KALE_WORKER: 'kale-mock', AISONGGENERATOR: 'kale-mock' },
			outboundService: (request: Request) => (escaped.push(request.url), new Response('blocked', { status: 599 })),
		}, {
			name: 'kale-mock', modules: true, script: KALE_MOCK, compatibilityDate: config.compatibility_date, kvNamespaces: ['CAPTURE'],
		}],
	}))
	const db = await mf.getD1Database('SMOL_D1')
	await db.batch(splitSql(readFileSync(join(ROOT, 'schema.sql'), 'utf8')).map((sql) => db.prepare(sql)))
	await db.batch(rows.map(([id, address, isPublic], index) => db.prepare(
		`INSERT INTO Smols (Id, Title, Song_1, "Address", Public, Created_At) VALUES (?1, 'Smoke', ?1, ?2, ?3, datetime('now', ?4))`,
	).bind(id, address, isPublic, `-${index + 1} minutes`)))
	return { mf, db }
}

type Mf = Awaited<ReturnType<typeof start>>['mf']

async function call(mf: Mf, path: string, init: { method?: string; body?: unknown; sub?: string; headers?: Record<string, string> } = {}) {
	const headers: Record<string, string> = { ...init.headers }
	if (init.sub) headers.Authorization = `Bearer ${await sign({ sub: init.sub, key: 'k', usr: 'smoke', exp: Math.floor(Date.now() / 1000) + 600 }, SECRET, 'HS256')}`
	if (init.body !== undefined) headers['Content-Type'] = 'application/json'
	const response = await mf.dispatchFetch(`https://api.smol.xyz${path}`, {
		method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
	})
	return { response, text: await response.text() }
}

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const value = await read()
		if (value !== undefined) return value
		await new Promise((done) => setTimeout(done, 50))
	}
	throw new Error(`Timed out waiting for ${what}`)
}

async function waitForErrored(mf: Mf, binding: string, id: string): Promise<void> {
	await until(async () => {
		const status = JSON.parse((await call(mf, `/__smoke/status?binding=${binding}&id=${id}`)).text)
		return status.status === 'errored' || undefined
	}, `${binding} ${id} to error`)
}

async function workerLogs(mf: Mf): Promise<string[]> {
	return JSON.parse((await call(mf, '/__smoke/logs')).text)
}

/** Appends a copy of the admin root invocation to its own sub-invocations: a wrong auth tree. */
function tamperAdminTree(carrierXdr: string, issuer: string): string {
	const envelope = xdr.TransactionEnvelope.fromXDR(carrierXdr, 'base64')
	const op = envelope.v1().tx().operations()[0].body().invokeHostFunctionOp()
	const admin = op.auth().find((entry) => entry.credentials().switch().name === 'sorobanCredentialsAddress'
		&& Address.fromScAddress(entry.credentials().address().address()).toString() === issuer)!
	const root = admin.rootInvocation()
	root.subInvocations([...root.subInvocations(), new xdr.SorobanAuthorizedInvocation({ function: root.function(), subInvocations: [] })])
	return envelope.toXDR('base64')
}

function mintRequest(carrier: Carrier, xdrB64 = carrier.xdr) {
	return carrier.kind === 'coin_it'
		? { path: `/mint/${carrier.tracks[0].id}`, body: { xdr: xdrB64 } }
		: { path: '/mint', body: { ids: carrier.tracks.map(({ id }) => id), xdr: xdrB64 } }
}

const trackRows = (identity: string) => carriers.filter((c) => c.identity === identity)
	.flatMap((c) => c.tracks.map(({ id, creator }) => [id, creator, 1] as [string, string, number]))

async function pausedAndCache() {
	const owner = carriers[0].sub
	const { mf, db } = await start({}, [['a'.repeat(64), owner, 1], ['b'.repeat(64), owner, 0], ...trackRows('mainnet')])
	try {
		const mainnet = carriers.filter((c) => c.identity === 'mainnet')
		for (const carrier of mainnet) {
			const { path, body } = mintRequest(carrier)
			const { response, text } = await call(mf, path, { body, sub: carrier.sub })
			assert.equal(response.status, 503, carrier.name)
			assert.deepEqual(JSON.parse(text), { error: 'mint_paused' })
		}

		const list = (origin?: string) => call(mf, '/?limit=2', { headers: origin ? { Origin: origin } : {} })
		const cold = await list('https://smol.xyz')
		assert.equal(cold.response.headers.get('Access-Control-Allow-Origin'), 'https://smol.xyz')
		assert.equal(cold.response.headers.get('Cache-Control'), 'public, max-age=30, s-maxage=30, stale-while-revalidate=60')
		await until(async () => (JSON.parse((await call(mf, '/__smoke/cache-puts')).text) as string[]).includes('/') || undefined, 'public cache put')
		await db.prepare(`INSERT INTO Smols (Id, Title, Song_1, "Address", Public) VALUES (?1, 'New', ?1, ?2, 1)`).bind('c'.repeat(64), owner).run()
		const warm = await list('https://next.smol.xyz')
		assert.equal(warm.text, cold.text, 'second request is a cache HIT (new row not visible)')
		assert.equal(warm.response.headers.get('Access-Control-Allow-Origin'), 'https://next.smol.xyz')
		const anonymous = await list()
		assert.equal(anonymous.text, cold.text)
		assert.equal(anonymous.response.headers.get('Access-Control-Allow-Origin'), null)
		const unlisted = await list('https://evil.example')
		assert.notEqual(unlisted.text, cold.text, 'unlisted origins bypass the shared cache')
		assert.equal(unlisted.response.headers.get('Access-Control-Allow-Origin'), null)

		const privatePaths = ['/created', '/liked', '/likes', '/chain/balance', '/search/admin/dlq']
		for (const path of privatePaths) {
			for (const sub of [owner, undefined]) {
				const { response } = await call(mf, path, { sub })
				assert.equal(response.headers.get('Cache-Control'), 'private, no-store', `${path} ${sub ? 'authed' : 'anonymous'} ${response.status}`)
				assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store')
			}
		}
		assert.equal((await call(mf, '/created', { sub: owner })).response.status, 200)
		assert.equal((await call(mf, '/chain/balance', { sub: owner })).response.status, 200)
		const puts = JSON.parse((await call(mf, '/__smoke/cache-puts')).text) as string[]
		assert.deepEqual(puts.filter((path) => privatePaths.includes(path)), [], 'private routes never reach caches.default.put')
		assert.equal((await call(mf, '/image/x.mp3')).response.status, 404)
		assert.equal((await call(mf, '/song/x.png')).response.status, 404)
		console.log(`ok paused 503 x${mainnet.length}; public cache HIT + request-matched CORS; private no-store, cache puts ${JSON.stringify(puts)}`)
	} finally {
		await mf.dispose()
	}
}

async function mainnetAdmission() {
	const { mf } = await start({ MINT_SIGNING_ENABLED: 'true' }, trackRows('mainnet'))
	try {
		const [first, ...rest] = carriers.filter((c) => c.identity === 'mainnet')
		const tampered = mintRequest(first, tamperAdminTree(first.xdr, 'GBVJZCVQIKK7SL2K6NL4BO6ZYNXAGNVBTAQDDNOIJ5VPP3IXCSE2SMOL'))
		const rejected = await call(mf, tampered.path, { body: tampered.body, sub: first.sub })
		assert.equal(rejected.response.status, 400)
		assert.deepEqual(JSON.parse(rejected.text), { error: 'mint_tx_rejected', code: 'admin_tree_mismatch' })
		for (const carrier of [first, ...rest]) {
			const { path, body } = mintRequest(carrier)
			const { response, text } = await call(mf, path, { body, sub: carrier.sub })
			// Admission ran decode (canonical bytes) and the construct-and-compare validator in workerd. The
			// queued signer cannot sign here (no mainnet issuer key); test-identity signing is proven below.
			assert.equal(response.status, 202, `${carrier.name}: ${text}`)
			assert.match(JSON.parse(text).workflowId, /^(?:batch-)?mint-[0-9a-f]{48}$/)
		}
		console.log(`ok mainnet FE carriers admitted x${rest.length + 1}; wrong admin tree -> 400 admin_tree_mismatch`)
	} finally {
		await mf.dispose()
	}
}

async function testIdentitySigning() {
	const { mf } = await start({ MINT_SIGNING_ENABLED: 'true' }, trackRows('test'))
	const capture = await mf.getKVNamespace('CAPTURE', 'kale-mock')
	const identity = testIdentity()
	try {
		const signerPayload = (carrier: Carrier, xdrB64: string) => carrier.kind === 'coin_it'
			? { type: 'mint', xdr: xdrB64, entropy: carrier.tracks[0].id, sub: carrier.sub, ownerSub: carrier.tracks[0].creator }
			: { type: 'batch-mint', xdr: xdrB64, sub: carrier.sub, ids: carrier.tracks.map(({ id }) => id), mintableIds: carrier.tracks.map(({ id }) => id) }
		const test = carriers.filter((c) => c.identity === 'test')

		const bad = JSON.parse((await call(mf, '/__smoke/sign', { body: signerPayload(test[0], tamperAdminTree(test[0].xdr, identity.issuer)) })).text)
		await waitForErrored(mf, 'SMOKE_TX_WORKFLOW', bad.id)
		assert.ok((await workerLogs(mf)).some((line) => line.includes('"event":"mint_sign_refused","code":"admin_tree_mismatch"')))
		assert.equal((await capture.list()).keys.length, 0, 'a wrong auth tree is never signed or relayed')

		for (const carrier of test) {
			const { id } = JSON.parse((await call(mf, '/__smoke/sign', { body: signerPayload(carrier, carrier.xdr) })).text)
			await waitForErrored(mf, 'SMOKE_TX_WORKFLOW', id)
			const [key] = (await capture.list()).keys
			const signed = await capture.get(key.name)
			await capture.delete(key.name)
			const validated = assertUnsignedMintEnvelope(
				decodeMintCarrier(carrier.xdr, carrier.kind, identity),
				buildMintExpectation({ identity, kind: carrier.kind, sub: carrier.sub, tracks: carrier.tracks }),
			)
			assertSignedMintEnvelope(validated, signed!, { expirationLedger: TIP + 100, networkPassphrase: identity.networkPassphrase })
		}
		console.log(`ok test-identity FE carriers signed in workerd and verified x${test.length}; wrong admin tree refused unsigned`)
	} finally {
		await mf.dispose()
	}
}

async function main() {
	await pausedAndCache()
	await mainnetAdmission()
	await testIdentitySigning()
	assert.deepEqual(escaped, [], 'no outbound network calls')
	console.log('wf1 bundle smoke: PASS (0 outbound calls)')
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
