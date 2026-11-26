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
 *
 * The same bundle also proves `@simplewebauthn/server` + native base64url (`POST /login` create and
 * connect, chain reads served by the mocked KALE_WORKER) and `music-metadata` `parseBuffer` (a retry
 * Workflow whose song order can only flip if the bundled parser reads the real MP3 durations; the MP3
 * fixtures are served inside the isolate by the smoke wrapper, so nothing leaves workerd).
 *
 * WF-2b/AE-8: `GET /image/:id?scale=` runs the dependency-free PNG scaler (RGBA + indexed PLTE/tRNS,
 * exact pixels; corrupt and decompression-bomb PNGs -> 422), an in-isolate probe proves workerd's
 * `node:zlib` honours `maxOutputLength`, and `GET /created?q=` filters owner titles with escaped
 * wildcards and cursor pagination. Lane 2a: a retry Workflow regenerates lyrics through the bundled song-intent
 * module (an RPC `AI` mock answers DeepSeek) and the captured AISG submit carries `vocalGender`/`negativeTags`.
 * The compatibility date comes from wrangler.jsonc; pass
 * `MINIFLARE_WORKERD_PATH` to run a newer workerd than the one wrangler ships.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { Address, xdr } from '@stellar/stellar-sdk/base'
import { decode, sign } from 'hono/jwt'
import {
	assertSignedMintEnvelope, assertUnsignedMintEnvelope, buildMintExpectation, decodeMintCarrier, type MintKind,
} from '../src/chain/mint-authorization'
import { derivePasskeyKitContractId } from '../src/passkey'
import { decodePng } from '../src/utils/png-scale'
import { contractDataKey, storageKey } from '../src/utils/chain'
import { testIdentity, testIssuerKeypair } from '../test/fixtures/mint-authz/generate'
import { encodeTestPng, inflateIdat, packRows, readChunks } from '../test/helpers/png'

const ROOT = resolve(__dirname, '..')
const BUNDLE = resolve(process.argv[2] ?? '/tmp/wf1-lean-dry')
const TIP = 65_000_000
const SECRET = 'smoke-jwt-secret-0123456789abcdef'
const AUDIO_HOST = 'audio.smoke.invalid'
// Miniflare ships with wrangler (not a direct dependency, so it is loaded untyped); v5 takes the
// v4 worker options shape through its converter.
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve('wrangler/package.json'))('miniflare')

type Carrier = { name: string; identity: string; kind: MintKind; sub: string; tracks: { id: string; creator: string }[]; xdr: string }
const carriers = (JSON.parse(readFileSync(join(ROOT, 'test/fixtures/mint-authz/fe-carriers.json'), 'utf8')) as { carriers: Carrier[] }).carriers
const config = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))

writeFileSync(join(BUNDLE, 'smoke-entry.js'), `
import worker, { TxWorkflow } from './index.js'
import { deflateSync, inflateSync } from 'node:zlib'
export * from './index.js'
const puts = []
const logs = []
// CBR MPEG-1 Layer III, 32 kbps, 44.1 kHz mono, 104-byte silent frames (26.1 ms each).
const mp3 = (frames) => {
	const out = new Uint8Array(104 * frames)
	for (let i = 0; i < frames; i += 1) out.set([0xff, 0xfb, 0x10, 0xc0], i * 104)
	return out
}
const AUDIO = { '/short.mp3': mp3(40), '/long.mp3': mp3(120) }
const audioServed = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input))
	if (url.hostname === '${AUDIO_HOST}' && AUDIO[url.pathname]) {
		audioServed.push(url.pathname)
		return new Response(AUDIO[url.pathname], { headers: { 'Content-Type': 'audio/mpeg' } })
	}
	return realFetch(input, init)
}
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
		if (url.pathname === '/__smoke/audio') return Response.json(audioServed)
		if (url.pathname === '/__smoke/zlib') {
			const bomb = deflateSync(new Uint8Array(1 << 20))
			let capped = 'not thrown'
			try { inflateSync(bomb, { maxOutputLength: 16 }) } catch (error) { capped = error.code ?? error.name }
			return Response.json({ capped, exact: inflateSync(bomb, { maxOutputLength: 1 << 20 }).length })
		}
		if (url.pathname === '/__smoke/generate') {
			const id = env.DURABLE_OBJECT.newUniqueId().toString()
			await env.WORKFLOW.create({ id, params: await request.json() })
			return Response.json({ id })
		}
		if (url.pathname === '/__smoke/do-steps') return Response.json(await env.DURABLE_OBJECT.get(env.DURABLE_OBJECT.idFromString(url.searchParams.get('id'))).getSteps())
		if (url.pathname === '/__smoke/sign') return Response.json(await env.SMOKE_TX_WORKFLOW.create({ params: await request.json() }).then((i) => ({ id: i.id })))
		if (url.pathname === '/__smoke/status') return Response.json(await (await env[url.searchParams.get('binding')].get(url.searchParams.get('id'))).status())
		return worker.fetch(request, env, ctx)
	},
}
`)

const KALE_MOCK = `
import { WorkerEntrypoint } from 'cloudflare:workers'
export default class extends WorkerEntrypoint {
	async fetch(request) {
		// Song-intent smoke: the songwriter answer, and a capture of the paid AISG submit body (rejected).
		const path = new URL(request.url).pathname
		if (path === '/api/lyrics') {
			await this.env.CAPTURE.put('lyrics-request', await request.text())
			return Response.json({ title: 'Songwriter', style: ['pop', 'male vocals', 'bright'], lyrics: '[Verse]\\n(No lyrics)\\nwritten one\\nwritten two\\nwritten three\\nwritten four' })
		}
		if (path === '/api/tasks' && request.method === 'POST') {
			await this.env.CAPTURE.put('task-submit', await request.text())
			return Response.json({ code: 'invalid_request', message: 'smoke capture', outcome: 'rejected' }, { status: 400 })
		}
		return new Response(null, { status: 404 })
	}
	async getTip() { return { sequence: ${TIP}, closeTime: new Date().toISOString() } }
	async readEntries({ keys }) {
		const entries = []
		for (const key of keys) {
			const wire = await this.env.CAPTURE.get('entry:' + key, 'json')
			if (wire) entries.push(wire)
		}
		return { latestLedger: ${TIP}, archiveAware: true, entries }
	}
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

// Workers AI stand-in (song-intent smoke only): answers DeepSeek with a recorded-shape intent and
// records how it was called; every other model throws (NSFW then fails closed, as in production).
// Bound as an RPC service named AI (Miniflare 5's v4 converter drops wrappedBindings).
const AI_MOCK = `
import { WorkerEntrypoint } from 'cloudflare:workers'
export default class extends WorkerEntrypoint {
	async run(model, input, options) {
		await this.env.AI_CALLS.put(model, JSON.stringify({ argc: arguments.length, input, options: options ?? null }))
		if (model === '@cf/deepseek-ai/deepseek-v4.1-flash-1017') {
			return { response: '{"mode":"user_lyrics","lyrics_lines":[4,13],"title":null,"vocal_gender":"f","styles":["dream pop","synth pads","slow tempo","nocturnal","female vocals"],"exclusions":["drums"]}' }
		}
		throw new Error('smoke: no Workers AI model ' + model)
	}
}`

async function start(vars: Record<string, string>, rows: Array<[string, string, number]>, withAi = false) {
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
			serviceBindings: { KALE_WORKER: 'kale-mock', AISONGGENERATOR: 'kale-mock', ...(withAi ? { AI: 'ai-mock' } : {}) },
			outboundService: (request: Request) => (escaped.push(request.url), new Response('blocked', { status: 599 })),
		}, {
			name: 'kale-mock', modules: true, script: KALE_MOCK, compatibilityDate: config.compatibility_date, kvNamespaces: ['CAPTURE'],
		}, {
			name: 'ai-mock', modules: true, script: AI_MOCK, compatibilityDate: config.compatibility_date, kvNamespaces: ['AI_CALLS'],
		}],
	}))
	const db = await mf.getD1Database('SMOL_D1')
	await db.batch(splitSql(readFileSync(join(ROOT, 'schema.sql'), 'utf8')).map((sql) => db.prepare(sql)))
	if (rows.length) await db.batch(rows.map(([id, address, isPublic], index) => db.prepare(
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
	const { mf, db } = await start({ MINT_SIGNING_ENABLED: 'false' }, [['a'.repeat(64), owner, 1], ['b'.repeat(64), owner, 0], ...trackRows('mainnet')])
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
		const warm = await list('https://noot.smol.xyz')
		assert.equal(warm.text, cold.text, 'second request is a cache HIT (new row not visible)')
		assert.equal(warm.response.headers.get('Access-Control-Allow-Origin'), 'https://noot.smol.xyz')
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

// --- WebAuthn (@simplewebauthn/server + native base64url) -------------------------------------

const cbor = {
	head: (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n])
		: n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]),
	bytes: (b: Buffer) => Buffer.concat([cbor.head(2, b.length), b]),
	text: (t: string) => Buffer.concat([cbor.head(3, Buffer.byteLength(t)), Buffer.from(t)]),
}

function rawP256(publicKey: KeyObject): Buffer {
	const jwk = publicKey.export({ format: 'jwk' })
	return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
}

function registrationResponse(credentialId: Buffer, publicKey: KeyObject, origin: string, rpId: string, challenge: string) {
	const raw = rawP256(publicKey)
	const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), raw.subarray(1, 33), Buffer.from([0x22, 0x58, 0x20]), raw.subarray(33)])
	const authData = Buffer.concat([
		createHash('sha256').update(rpId).digest(), Buffer.from([0x41]), Buffer.alloc(4), Buffer.alloc(16),
		Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]), credentialId, cose,
	])
	const attestationObject = Buffer.concat([Buffer.from([0xa3]), cbor.text('fmt'), cbor.text('none'), cbor.text('attStmt'), Buffer.from([0xa0]), cbor.text('authData'), cbor.bytes(authData)])
	const id = credentialId.toString('base64url')
	return {
		id, rawId: id, type: 'public-key', clientExtensionResults: {},
		response: {
			clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })).toString('base64url'),
			attestationObject: attestationObject.toString('base64url'),
		},
	}
}

function authenticationResponse(credentialId: Buffer, privateKey: KeyObject, origin: string, rpId: string, challenge: string) {
	const authenticatorData = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([0x01, 0, 0, 0, 1])])
	const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }))
	const signature = cryptoSign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), privateKey)
	const id = credentialId.toString('base64url')
	return {
		id, rawId: id, type: 'public-key', clientExtensionResults: {},
		response: {
			authenticatorData: authenticatorData.toString('base64url'),
			clientDataJSON: clientDataJSON.toString('base64url'),
			signature: signature.toString('base64url'),
		},
	}
}

function ledgerWire(key: xdr.LedgerKey, val: xdr.ScVal) {
	const data = key.contractData()
	return {
		key: key.toXDR('base64'),
		xdr: xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({
			ext: new xdr.ExtensionPoint(0), contract: data.contract(), key: data.key(), durability: data.durability(), val,
		})).toXDR('base64'),
		lastModifiedLedgerSeq: TIP - 10,
		liveUntilLedgerSeq: TIP + 10_000,
	}
}

async function webauthnAndAudio() {
	const { mf, db } = await start({}, [])
	const capture = await mf.getKVNamespace('CAPTURE', 'kale-mock')
	try {
		const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
		const credentialId = randomBytes(32)
		const keyId = credentialId.toString('base64url')
		const contractId = derivePasskeyKitContractId(credentialId)
		const challenge = Buffer.from('stellaristhebetterblockchain').toString('base64url')
		const login = (origin: string, body: Record<string, unknown>) => call(mf, '/login', { body, headers: { Origin: origin } })
		const claims = (token: string) => decode(token).payload as { sub: string; key: string; usr: string }

		// Registration: noot.smol.xyz with the shared smol.xyz RP ID; padded keyId normalizes.
		const badChallenge = await login('https://noot.smol.xyz', {
			type: 'create', keyId, contractId, username: 'smoke', response: registrationResponse(credentialId, publicKey, 'https://noot.smol.xyz', 'smol.xyz', '!!not-base64url-garbage!!'),
		})
		assert.equal(badChallenge.response.status, 400, 'garbage challenge rejected')
		const badRp = await login('https://noot.smol.xyz', {
			type: 'create', keyId, contractId, username: 'smoke', response: registrationResponse(credentialId, publicKey, 'https://noot.smol.xyz', 'evil.xyz', challenge),
		})
		assert.equal(badRp.response.status, 400)
		assert.match(badRp.text, /Passkey origin does not match this domain/)
		const created = await login('https://noot.smol.xyz', {
			type: 'create', keyId: `${keyId}=`, contractId, username: 'smoke', response: registrationResponse(credentialId, publicKey, 'https://noot.smol.xyz', 'smol.xyz', challenge),
		})
		assert.equal(created.response.status, 200, created.text)
		assert.equal(created.response.headers.get('Cache-Control'), 'no-store')
		assert.equal(claims(created.text).sub, contractId)
		assert.equal((await db.prepare('SELECT Username FROM Users WHERE "Address" = ?1').bind(contractId).first())?.Username, 'smoke')

		// Authentication (passkey-kit signer read from the mocked mainnet ledger): smol.xyz RP ID.
		const signerKey = contractDataKey(contractId, storageKey('Secp256r1', xdr.ScVal.scvBytes(credentialId)))
		await capture.put(`entry:${signerKey.toXDR('base64')}`, JSON.stringify(ledgerWire(signerKey, xdr.ScVal.scvVec([xdr.ScVal.scvVoid(), xdr.ScVal.scvBytes(rawP256(publicKey))]))))
		const random = randomBytes(32).toString('base64url')
		const connect = (response: unknown) => login('https://smol.xyz', { type: 'connect', protocol: 'passkey-kit', keyId, contractId, response })
		const connected = await connect(authenticationResponse(credentialId, privateKey, 'https://smol.xyz', 'smol.xyz', random))
		assert.equal(connected.response.status, 200, connected.text)
		assert.deepEqual([claims(connected.text).sub, claims(connected.text).key, claims(connected.text).usr], [contractId, keyId, 'smoke'])
		const forged = await connect(authenticationResponse(credentialId, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey, 'https://smol.xyz', 'smol.xyz', random))
		assert.equal(forged.response.status, 400, 'signature from another key rejected')
		const shortChallenge = await connect(authenticationResponse(credentialId, privateKey, 'https://smol.xyz', 'smol.xyz', randomBytes(15).toString('base64url')))
		assert.equal(shortChallenge.response.status, 400, '15-byte challenge rejected')
		console.log('ok webauthn in workerd: register (noot.smol.xyz, rpId smol.xyz) 200 + D1 user, connect (passkey-kit) 200; garbage/short challenge, wrong RP, forged signature -> 400')

		// music-metadata: the streaming fingerprints claim smoke-a is ~3.1 s and smoke-b ~1.0 s, but the
		// finalized songs arrive in the opposite order with no `duration` and non-matching hashes. Only a
		// working bundled `parseBuffer` (1.04 s vs 3.13 s) can detect the swap.
		const audio = (path: string) => `https://${AUDIO_HOST}${path}`
		const fingerprint = (hash: string, path: string, duration: number) => ({ hash: hash.repeat(64), byteLength: 4096, audioUrl: audio(path), duration })
		const kv = await mf.getKVNamespace('SMOL_KV')
		await kv.put('smoke-retry', JSON.stringify({
			payload: { address: contractId, prompt: 'smoke song', public: false, instrumental: false, provider: 'aisonggenerator' },
			image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', // 1x1 PNG
			description: 'smoke', lyrics: { title: 'Smoke', style: ['lofi', 'chill'], lyrics: 'la la' }, nsfw: { safe: true, categories: [] },
			song_ids: ['smoke-a', 'smoke-b'], actual_provider: 'aisonggenerator',
			songs: [
				{ music_id: 'smoke-a', status: 4, audio: audio('/short.mp3'), service: 'aisonggenerator' },
				{ music_id: 'smoke-b', status: 4, audio: audio('/long.mp3'), service: 'aisonggenerator' },
			],
			original_fingerprints: { 'smoke-a': fingerprint('a', '/long.mp3', 3.13), 'smoke-b': fingerprint('b', '/short.mp3', 1.04) },
		}))
		const bucket = await mf.getR2Bucket('SMOL_BUCKET')
		const { id } = JSON.parse((await call(mf, '/__smoke/generate', { body: { retry_id: 'smoke-retry' } })).text)
		const stored = await until(async () => (await bucket.head('smoke-b.mp3')) ?? undefined, 'persisted song audio').catch(async (e) => {
			console.error('smoke diag: workflow', (await call(mf, `/__smoke/status?binding=WORKFLOW&id=${id}`)).text)
			console.error('smoke diag: logs', (await workerLogs(mf)).slice(-30).join('\n'))
			console.error('smoke diag: audio served', (await call(mf, '/__smoke/audio')).text)
			throw e
		})
		const first = await bucket.head('smoke-a.mp3')
		assert.equal(first?.customMetadata?.sourceUrl, audio('/long.mp3'), 'smoke-a now carries the ~3.1 s audio (swap detected)')
		assert.equal(first?.size, 120 * 104)
		assert.equal(stored.customMetadata?.sourceUrl, audio('/short.mp3'))
		assert.equal(stored.size, 40 * 104)
		const served = JSON.parse((await call(mf, '/__smoke/audio')).text) as string[]
		assert.ok(served.includes('/short.mp3') && served.includes('/long.mp3'), `fixture audio served in-isolate: ${served}`)
		assert.ok(!(await workerLogs(mf)).some((line) => line.includes('music-metadata parse failed') || line.includes('Failed to parse duration')), 'parseBuffer never failed')
		const status = JSON.parse((await call(mf, `/__smoke/status?binding=WORKFLOW&id=${id}`)).text)
		console.log(`ok music-metadata parseBuffer in workerd: durations detected the song swap (R2 smoke-a <- long.mp3); retry workflow ${status.status}`)
	} finally {
		await mf.dispose()
	}
}

// --- WF-2b PNG scaler + AE-8 owner title filter --------------------------------------------------

async function imagesAndCreatedSearch() {
	const { mf, db } = await start({}, [])
	try {
		const zlib = JSON.parse((await call(mf, '/__smoke/zlib')).text)
		assert.deepEqual(zlib, { capped: 'ERR_BUFFER_TOO_LARGE', exact: 1 << 20 }, 'workerd node:zlib inflateSync honours maxOutputLength')

		const bucket = await mf.getR2Bucket('SMOL_BUCKET')
		const put = (key: string, bytes: Uint8Array) => bucket.put(key, bytes, { httpMetadata: { contentType: 'image/png' } })
		const rgba = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, (i * 37) & 0xff, i % 2 ? 255 : 128])
		await put('rgba.png', encodeTestPng({ width: 4, height: 4, bitDepth: 8, colorType: 6, pixels: rgba, filters: [0, 1, 2, 3, 4] }))
		const plte = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255)
		const trns = Uint8Array.of(255, 0)
		const indexed = Array.from({ length: 15 }, (_, i) => [i % 3])
		await put('indexed.png', encodeTestPng({ width: 5, height: 3, bitDepth: 4, colorType: 3, pixels: indexed, filters: [4, 3, 1], before: [['PLTE', plte], ['tRNS', trns]] }))
		await put('broken.png', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13))
		await put('bomb.png', encodeTestPng({ width: 1, height: 1, bitDepth: 8, colorType: 0, pixels: [], idat: deflateSync(Buffer.alloc(8 << 20)) }))
		// 128x128 RGBA declares 65,664 inflated bytes: an exact maxOutputLength trips workerd's 40 KiB
		// output reservation (RangeError: Memory limit exceeded), so this proves the inflate headroom.
		const cover = Array.from({ length: 128 * 128 }, (_, i) => [(i & 127) * 2, (i >> 7) * 2, ((i & 127) ^ (i >> 7)) & 0xff, 255 - (((i & 127) + (i >> 7)) & 0x7f)])
		await put('cover128.png', encodeTestPng({ width: 128, height: 128, bitDepth: 8, colorType: 6, pixels: cover, filters: [0, 1, 2, 3, 4] }))
		// Same header, 1,000 bytes too many: inside the headroom, so only the exact-length check stops it.
		await put('bomb128.png', encodeTestPng({ width: 128, height: 128, bitDepth: 8, colorType: 6, pixels: [], idat: deflateSync(Buffer.alloc(128 * (1 + 128 * 4) + 1000)) }))

		const scaled = await mf.dispatchFetch('https://api.smol.xyz/image/rgba.png?scale=4')
		const bytes = new Uint8Array(await scaled.arrayBuffer())
		assert.equal(scaled.status, 200)
		assert.equal(scaled.headers.get('Content-Type'), 'image/png')
		assert.equal(Number(scaled.headers.get('Content-Length')), bytes.byteLength)
		assert.match(scaled.headers.get('ETag') ?? '', /-s4"$/)
		const decoded = decodePng(bytes)
		assert.deepEqual([decoded.width, decoded.height, decoded.colorType, decoded.bitDepth], [16, 16, 6, 8])
		for (let y = 0; y < 16; y++) {
			for (let x = 0; x < 16; x++) {
				assert.deepEqual([...decoded.pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)], rgba[(y >> 2) * 4 + (x >> 2)], `pixel ${x},${y}`)
			}
		}

		const pal = new Uint8Array(await (await mf.dispatchFetch('https://api.smol.xyz/image/indexed.png?scale=3')).arrayBuffer())
		const palDecoded = decodePng(pal)
		const expected = Array.from({ length: 15 * 9 }, (_, i) => indexed[Math.floor(Math.floor(i / 15) / 3) * 5 + Math.floor((i % 15) / 3)])
		assert.deepEqual([palDecoded.width, palDecoded.height, palDecoded.colorType, palDecoded.bitDepth], [15, 9, 3, 4])
		assert.deepEqual(palDecoded.pixels, new Uint8Array(Buffer.concat(packRows(15, 9, 4, 3, expected))))
		assert.deepEqual(readChunks(pal).filter((c) => c.type === 'PLTE' || c.type === 'tRNS').map((c) => [c.type, [...c.data]]), [['PLTE', [...plte]], ['tRNS', [...trns]]])

		const head = await mf.dispatchFetch('https://api.smol.xyz/image/rgba.png?scale=4', { method: 'HEAD' })
		assert.equal(head.status, 200)
		await head.arrayBuffer()
		const big = await mf.dispatchFetch('https://api.smol.xyz/image/cover128.png?scale=32')
		const bigBytes = new Uint8Array(await big.arrayBuffer())
		assert.equal(big.status, 200, `128x128 cover x32: ${new TextDecoder().decode(bigBytes.subarray(0, 200))}`)
		assert.equal(Number(big.headers.get('Content-Length')), bigBytes.byteLength)
		const bigHeader = Buffer.from(readChunks(bigBytes)[0].data)
		assert.deepEqual([bigHeader.readUInt32BE(0), bigHeader.readUInt32BE(4), bigHeader[8], bigHeader[9]], [4096, 4096, 8, 6])
		// Decode independently (Node inflate + Sub/Up, the only filters the scaler writes) and check both
		// edge columns of every scaled pixel block on each block's first and last row, plus every 97th row.
		const stride = 4096 * 4
		const raw = inflateIdat(bigBytes)
		assert.equal(raw.byteLength, 4096 * (stride + 1))
		let prev = new Uint8Array(stride)
		let checked = 0
		for (let y = 0; y < 4096; y++) {
			const filter = raw[y * (stride + 1)]
			const row = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
			if (filter === 1) for (let i = 4; i < stride; i++) row[i] += row[i - 4]
			else if (filter === 2) for (let i = 0; i < stride; i++) row[i] += prev[i]
			else assert.fail(`row ${y}: unexpected filter ${filter}`)
			if (y % 32 === 0 || y % 32 === 31 || y % 97 === 0) {
				for (let sx = 0; sx < 128; sx++) {
					for (const x of [sx * 32, sx * 32 + 31]) {
						assert.deepEqual([...row.subarray(x * 4, x * 4 + 4)], cover[(y >> 5) * 128 + sx], `pixel ${x},${y}`)
						checked += 1
					}
				}
			}
			prev = row
		}

		for (const key of ['broken.png', 'bomb.png', 'bomb128.png']) {
			const rejected = await mf.dispatchFetch(`https://api.smol.xyz/image/${key}?scale=2`)
			assert.equal(rejected.status, 422, key)
			assert.match(await rejected.text(), /Unsupported or malformed PNG/)
		}
		assert.equal((await mf.dispatchFetch('https://api.smol.xyz/image/rgba.png?scale=33')).status, 400)
		console.log(`ok png scaler in workerd: RGBA 4x4 -> 16x16 exact pixels (${bytes.byteLength} B), indexed 4-bit PLTE/tRNS -> 15x9 exact; 128x128 RGBA cover x32 -> 200 4096x4096 (${bigBytes.byteLength} B, ${checked} pixels checked); corrupt, 8 MiB bomb and in-headroom overrun -> 422; node:zlib maxOutputLength enforced`)

		const owner = carriers[0].sub
		const other = carriers[0].tracks.find((track) => track.creator !== owner)?.creator ?? `C${'B'.repeat(55)}`
		const rows: Array<[string, string, string, number]> = [
			['s1', 'Midnight Drive', owner, 0], ['s2', '100% MIDNIGHT_mix', owner, 1], ['s3', 'Sunrise', owner, 1], ['s4', 'midnight elsewhere', other, 1],
		]
		await db.batch(rows.map(([id, title, address, isPublic], index) => db.prepare(
			`INSERT INTO Smols (Id, Title, Song_1, "Address", Public, Created_At) VALUES (?1, ?2, ?1, ?3, ?4, datetime('now', ?5))`,
		).bind(id, title, address, isPublic, `-${10 - index} minutes`)))
		const created = async (query: string) => {
			const { response, text } = await call(mf, `/created${query}`, { sub: owner })
			assert.equal(response.headers.get('Cache-Control'), 'private, no-store', query)
			assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store', query)
			return { status: response.status, body: JSON.parse(text) }
		}
		const ids = (body: { smols: Array<{ Id: string }> }) => body.smols.map((smol) => smol.Id)
		assert.deepEqual(ids((await created('?q=%20midNIGHT%20')).body), ['s2', 's1'], 'case-insensitive, trimmed, private + public, owner only')
		assert.deepEqual(ids((await created('?q=%25')).body), ['s2'], '% is literal')
		assert.deepEqual(ids((await created('?q=_')).body), ['s2'], '_ is literal')
		assert.deepEqual(ids((await created('?q=%5C')).body), [], 'backslash is literal')
		assert.deepEqual(ids((await created('?q=%20')).body), ['s3', 's2', 's1'], 'blank q is unfiltered')
		const page1 = (await created('?q=midnight&limit=1')).body
		assert.deepEqual([ids(page1), page1.pagination.hasMore], [['s2'], true])
		const page2 = (await created(`?q=midnight&limit=1&cursor=${encodeURIComponent(page1.pagination.nextCursor)}`)).body
		assert.deepEqual([ids(page2), page2.pagination], [['s1'], { nextCursor: null, hasMore: false }])
		assert.deepEqual(await created(`?q=${'x'.repeat(101)}`), { status: 400, body: { error: 'Query too long' } })
		console.log('ok GET /created?q= in workerd/D1: case-insensitive owner-only (private+public), escaped %/_/\\, cursor pages, blank q unfiltered, >100 -> 400')
	} finally {
		await mf.dispose()
	}
}

// --- Song intent (lane 2a): DeepSeek intent -> finalized lyrics -> AISG submit body, in the bundle ----

async function songIntent() {
	const { mf } = await start({}, [], true)
	try {
		const prompt = 'Title: Night Bus\r\n[STYLE: lo-fi hip hop, female vocals, no drums]\r\n\r\n[Verse]\r\nWindow fogged\r\nthe city hums\r\n\r\nneon puddles\r\nslow bus turns\r\n[Chorus]\r\nRide on\r\nride on\r\n"one more stop"'
		const kv = await mf.getKVNamespace('SMOL_KV')
		await kv.put('smoke-intent-retry', JSON.stringify({
			payload: { address: 'CSMOKEINTENT', prompt, public: false, instrumental: false, provider: 'aisonggenerator' },
			image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
			description: 'a pixel bus at night',
		}))
		const { id } = JSON.parse((await call(mf, '/__smoke/generate', { body: { retry_id: 'smoke-intent-retry' } })).text)
		const lyrics = await until(async () => JSON.parse((await call(mf, `/__smoke/do-steps?id=${id}`)).text).lyrics ?? undefined, 'finalized lyrics')
		assert.deepEqual(lyrics, {
			title: 'Night Bus',
			style: ['dream pop', 'female vocals', 'synth pads', 'slow tempo', 'nocturnal'],
			lyrics: '[Verse]\nWindow fogged\nthe city hums\n\nneon puddles\nslow bus turns\n[Chorus]\nRide on\nride on\n"one more stop"',
			vocalGender: 'f',
			negativeTags: 'male vocals, drums',
			intent_v: 1,
		})
		const aiCalls = await mf.getKVNamespace('AI_CALLS', 'ai-mock')
		const intentCall = JSON.parse((await aiCalls.get('@cf/deepseek-ai/deepseek-v4.1-flash-1017'))!)
		assert.equal(intentCall.argc, 2, 'env.AI.run(model, input): no gateway option')
		assert.deepEqual(intentCall.input.response_format, { type: 'json_object' })
		const capture = await mf.getKVNamespace('CAPTURE', 'kale-mock')
		const lyricsRequest = JSON.parse((await capture.get('lyrics-request'))!)
		assert.equal(lyricsRequest.user_prompt, prompt)
		assert.ok(!lyricsRequest.prompt.includes('# Description') && !lyricsRequest.prompt.includes('pixel bus'))
		const logs = await workerLogs(mf)
		const intentLog = logs.find((line) => line.includes('"song_intent"'))
		assert.ok(intentLog, 'song_intent log line')
		const parsedIntentLog = JSON.parse(intentLog)
		assert.deepEqual(Object.keys(parsedIntentLog).sort(), ['event', 'mode', 'ms', 'smol_id', 'source'])
		assert.equal(parsedIntentLog.smol_id, id)
		assert.match(intentLog, /"source":"model","mode":"user_lyrics"/)
		const submitted = JSON.parse(await until(async () => (await capture.get('task-submit')) ?? undefined, 'AISG submit body'))
		assert.deepEqual([submitted.vocalGender, submitted.negativeTags, submitted.lyrics, submitted.description], ['f', 'male vocals, drums', lyrics.lyrics, 'a pixel bus at night'])
		console.log('ok song intent in workerd: DeepSeek via env.AI (no gateway) -> verbatim user lyrics, female vocals first, negativeTags string; AISG submit carries vocalGender/negativeTags; /api/lyrics gets user_prompt, no caption')
	} finally {
		await mf.dispose()
	}
}

async function main() {
	console.log(`compatibility_date ${config.compatibility_date}`)
	await imagesAndCreatedSearch()
	await pausedAndCache()
	await mainnetAdmission()
	await testIdentitySigning()
	await webauthnAndAudio()
	await songIntent()
	assert.deepEqual(escaped, [], 'no outbound network calls')
	console.log('wf1 bundle smoke: PASS (0 outbound calls)')
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
