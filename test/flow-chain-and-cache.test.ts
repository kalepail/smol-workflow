import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test, { after, before } from 'node:test'
import { Account, Address, Keypair, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal, xdr } from '@stellar/stellar-sdk/minimal'
import { balanceKey, contractDataKey, deriveMintPair, instanceKey, KALE_SAC, poolRecordsKey, storageKey, type LedgerPage } from '../src/utils/chain'
import {
	createAuthToken, createMockEdgeCache, createMockExecutionContext, createMockR2Bucket,
	createSqliteD1, createWorkflowStep, installCloudflareStubs,
} from './helpers/harness'

const SECRET = 'test-secret-for-chain-and-cache-only'
const LEDGER = 65_635_380
const TRACK = '7cf9dd5c96a0f4a14fbd8757e609a5a3ac02c719aeed17a184041ee643765c60'
const SECOND = 'f'.repeat(64)
const PRIVATE = 'c'.repeat(64)
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 1))
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 2))
const PAIR = deriveMintPair(TRACK)!
const COMET = Buffer.from('61e1fc5401a7b22418c2bd3bc5bd2c07241e4dae098c587c89f3f666aca12e37', 'hex')
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
let app: typeof import('../src/index').app
let TxWorkflow: typeof import('../src/index').TxWorkflow
let cleanup: () => void

before(async () => {
	const stubs = installCloudflareStubs({ CF_API_TOKEN: 'fixture-purge-token', CF_ZONE_ID: 'fixture-zone' })
	cleanup = stubs.cleanup
	;({ app, TxWorkflow } = await import('../src/index'))
})

after(() => cleanup())

function harness() {
	const db = new DatabaseSync(':memory:')
	db.exec(SCHEMA)
	const { d1, stats } = createSqliteD1(db)
	const env = { SECRET, SMOL_D1: d1 } as Env

	function track(id: string, options: { public?: number; tags?: string; pair?: typeof PAIR } = {}) {
		db.prepare(`
			INSERT INTO Smols (Id, Title, Song_1, Address, Public, Tags, Mint_Token, Mint_Amm, Views)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 13)
		`).run(id, id, `song-${id}`, WALLET, options.public ?? 1, options.tags ?? null,
			options.pair?.sac ?? null, options.pair?.pool ?? null)
	}

	async function send(path: string, body?: unknown, sub?: string, headers: HeadersInit = {}) {
		const ctx = createMockExecutionContext()
		const requestHeaders = new Headers(headers)
		if (sub) requestHeaders.set('Authorization', `Bearer ${await createAuthToken(sub, SECRET)}`)
		if (body) requestHeaders.set('Content-Type', 'application/json')
		const response = await app.fetch(new Request(`https://api.smol.xyz${path}`, {
			method: body ? 'POST' : 'GET',
			headers: requestHeaders,
			body: body ? JSON.stringify(body) : undefined,
		}), env, ctx.ctx)
		await ctx.flush()
		return response
	}

	return { db, env, stats, track, send }
}

function entry(key: xdr.LedgerKey, value: xdr.ScVal, archived = false): LedgerPage['entries'][number] {
	const data = key.contractData()
	return {
		key: key.toXDR('base64'),
		xdr: xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({
			ext: new xdr.ExtensionPoint(0), contract: data.contract(), key: data.key(),
			durability: data.durability(), val: value,
		})).toXDR('base64'),
		lastModifiedLedgerSeq: LEDGER - 5,
		liveUntilLedgerSeq: archived ? 0 : LEDGER + 500,
	}
}

const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' })
const ledgerMap = (entries: [xdr.ScVal, xdr.ScVal][]) => xdr.ScVal.scvMap(entries.map(
	([key, val]) => new xdr.ScMapEntry({ key, val }),
))
const fields = (object: Record<string, xdr.ScVal>) => ledgerMap(Object.entries(object).sort(([a], [b]) => a.localeCompare(b))
	.map(([key, val]) => [xdr.ScVal.scvSymbol(key), val]))
const addr = (contract: string) => new Address(contract).toScVal()
const balance = (amount: bigint) => fields({ amount: i128(amount) })

function fixtures(options: { trackBalance?: bigint; hash?: Buffer; frozen?: boolean } = {}) {
	const sac = xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({
		executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
		storage: null,
	}))
	const pool = xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({
		executable: xdr.ContractExecutable.contractExecutableWasm(options.hash ?? COMET),
		storage: [
			new xdr.ScMapEntry({ key: storageKey('Freeze'), val: xdr.ScVal.scvBool(options.frozen ?? false) }),
			new xdr.ScMapEntry({ key: storageKey('SwapFeeConfig'), val: fields({
				tracked_token: addr(KALE_SAC),
				min_fee: i128(500_000n), max_fee: i128(9_500_000n),
				low_util_balance: i128(1_000_000_000n), high_util_balance: i128(700_000_000_000n),
			}) }),
		],
	}))
	const record = (quantity: bigint, index: number) => fields({
		balance: i128(quantity), scalar: i128(10n ** 11n), weight: i128(5_000_000n), index: xdr.ScVal.scvU32(index),
	})
	return [
		entry(instanceKey(PAIR.sac), sac),
		entry(instanceKey(PAIR.pool), pool, true),
		entry(poolRecordsKey(PAIR.pool), ledgerMap([
			[addr(KALE_SAC), record(1_000_000_000n, 0)],
			[addr(PAIR.sac), record(9_900_000_000_000_000n, 1)],
		]), true),
		entry(balanceKey(PAIR.sac, WALLET), balance(options.trackBalance ?? 50n), true),
		entry(balanceKey(KALE_SAC, WALLET), balance(1_000_000_000n)),
	]
}

test('chain snapshot uses the audited identity and quote, distinguishes archived, zero, absent, malformed and unsupported', async () => {
	const { env, track, send, db } = harness()
	track(TRACK, { pair: deriveMintPair(SECOND)! })
	track(SECOND)
	track('legacy-track')
	assert.deepEqual(PAIR, {
		sac: 'CB3243T7LCV4F7YWWR2QS3LQ2E7GDYNZS7EM275YUDD3GKMZOQBIGFG4',
		pool: 'CATG4BDEBN67UX5U336AK6OUZCYEYL4ZOGGXJAJ2AL4F2KCCJV7LRYER',
	})
	let available = fixtures()
	let archiveAware = true
	let keys: string[] = []
	env.KALE_WORKER = { readEntries: async (req) => {
		keys = req.keys
		return { latestLedger: LEDGER, archiveAware, entries: available.filter((item) => keys.includes(item.key)).reverse() }
	} } as KaleWorkerBinding

	const quote = { direction: 'kaleIn', amountIn: '330000000' }
	const snapshot = async (ids: string[], includeWallet = true, requestQuote = quote) => {
		const response = await send('/chain/snapshot', { target: { trackIds: ids }, includeWallet, quote: requestQuote }, WALLET)
		assert.equal(response.status, 200)
		assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
		return await response.json() as any
	}

	let result = await snapshot([TRACK, TRACK])
	assert.equal(keys.length, 5)
	assert.equal(result.ownership, 'owned')
	assert.equal(result.tracks[0].index, 'conflict')
	assert.equal(result.tracks[0].mint, 'verified')
	assert.equal(result.tracks[0].life, 'archived')
	assert.deepEqual(result.tracks[0].balance, { state: 'known', amount: '50', life: 'archived' })
	assert.equal(result.tracks[0].quote.expectedOut, '160698475159862')
	assert.equal(result.tracks[0].quote.swapFee7, '9500000')
	assert.equal(result.tracks[0].quote.maxIn, '333333400')
	assert.equal(result.tracks[0].quote.requiresRestore, true)

	result = await snapshot([TRACK], false, { ...quote, amountIn: '333333401' })
	assert.equal(keys.length, 3)
	assert.equal(result.ownership, 'notRequested')
	assert.equal(result.tracks[0].quoteIssue, 'invalidInput')
	assert.equal(result.kale, undefined)
	result = await snapshot([TRACK, SECOND, 'legacy-track'])
	assert.equal(result.ownership, 'notOwned')
	assert.equal(result.tracks[1].mint, 'unminted')
	assert.equal(result.tracks[2].mint, 'unresolved')
	assert.equal(result.tracks[2].sac, null)

	archiveAware = false
	assert.equal((await snapshot([SECOND])).ownership, 'unknown')
	archiveAware = true
	available = fixtures({ trackBalance: 0n })
	assert.equal((await snapshot([TRACK])).ownership, 'notOwned')
	available = fixtures({ trackBalance: -1n })
	assert.equal((await snapshot([TRACK])).ownership, 'unknown')
	available[3].xdr = 'malformed'
	result = await snapshot([TRACK])
	assert.equal(result.ownership, 'unknown')
	assert.equal(result.tracks[0].balance.state, 'unknown')
	available = fixtures({ hash: Buffer.alloc(32) })
	assert.equal((await snapshot([TRACK])).tracks[0].quoteIssue, 'unsupported')
	available = fixtures({ frozen: true })
	assert.equal((await snapshot([TRACK])).tracks[0].quoteIssue, 'frozen')
	available = fixtures().filter((_, i) => i !== 3)
	assert.deepEqual((await snapshot([TRACK])).tracks[0].balance, { state: 'known', amount: '0', life: 'absent' })
	const collision = TRACK.slice(0, 12) + 'd'.repeat(52)
	track(collision)
	result = await snapshot([TRACK, collision])
	assert.equal(result.ownership, 'unknown')
	assert.deepEqual(result.tracks.map(({ mint }: { mint: string }) => mint), ['unresolved', 'unresolved'])
	assert.equal(keys.length, 1)
	const invalid = await send('/chain/snapshot', { target: { trackIds: [TRACK] }, quote: { ...quote, amountIn: '033' } }, WALLET)
	assert.equal(invalid.status, 400)
	db.close()
})

test('chain snapshot checks live mixtape visibility, hides private members and retries older chunks once', async () => {
	const { env, db, send, stats, track } = harness()
	track(TRACK)
	track(SECOND)
	track(PRIVATE, { public: 0 })
	db.prepare('INSERT INTO Mixtapes (Id, Title, Desc, Smols, Address, Visibility) VALUES (?, ?, ?, ?, ?, ?)').run(
		'hidden', 'Hidden', '', `${TRACK},${PRIVATE},${SECOND}`, WALLET, 'owner',
	)
	const requests: Array<{ keyCount: number; minLedger?: number }> = []
	env.KALE_WORKER = { readEntries: async ({ keys, minLedger }) => {
		requests.push({ keyCount: keys.length, minLedger })
		const latestLedger = requests.length === 1 ? LEDGER - 1 : LEDGER
		return { latestLedger, archiveAware: true, entries: [] }
	} } as KaleWorkerBinding
	const target = { mixtapeId: 'hidden' }
	let response = await send('/chain/snapshot', { target: { trackIds: [TRACK] } })
	assert.equal(response.status, 401)
	assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
	assert.equal((await send('/chain/snapshot', { target, includeWallet: true })).status, 401)
	assert.equal((await send('/chain/snapshot', { target }, undefined, { Authorization: `Bearer ${SECRET}` })).status, 401)
	assert.equal((await send('/chain/snapshot', { target }, undefined, { Cookie: 'smol_token=invalid' })).status, 401)
	assert.equal(stats.statements.length, 0)
	assert.equal((await send('/chain/snapshot', { target }, OTHER)).status, 404)
	assert.equal((await send('/chain/snapshot', { target: { ...target, revision: '2' } }, WALLET)).status, 409)
	assert.equal(requests.length, 0)
	const cookie = `smol_token=${await createAuthToken(WALLET, SECRET)}`
	response = await send('/chain/snapshot', { target, includeWallet: true }, undefined, { Cookie: cookie })
	assert.equal(response.status, 200)
	const payload = await response.text()
	assert.equal(payload.includes(PRIVATE), false)
	assert.equal(JSON.parse(payload).incompleteMembership, true)
	assert.equal(JSON.parse(payload).ownership, 'unknown')

	const insertMix = db.prepare('INSERT INTO Mixtapes (Id, Title, Desc, Smols, Address, Created_At) VALUES (?, ?, ?, ?, ?, ?)')
	insertMix.run('live-public', 'Public', '', `${TRACK},${SECOND},${PRIVATE}`, OTHER, '2026-01-01')
	insertMix.run('stale-public', 'Public', '', `${TRACK},${SECOND},${PRIVATE}`, OTHER, '2026-01-02')
	assert.equal((await send('/chain/snapshot', { target: { mixtapeId: 'live-public' } }, WALLET)).status, 200)
	assert.equal((await send('/chain/snapshot', { target: { mixtapeId: 'stale-public' } }, WALLET)).status, 404)

	const ids = Array.from({ length: 100 }, (_, i) => createHash('sha256').update(String(i)).digest('hex'))
	for (const id of ids) track(id)
	requests.length = 0
	response = await send('/chain/snapshot', { target: { trackIds: ids }, includeWallet: true, minLedger: LEDGER - 1 }, WALLET)
	assert.deepEqual(requests, [
		{ keyCount: 200, minLedger: LEDGER - 1 }, { keyCount: 200, minLedger: LEDGER - 1 },
		{ keyCount: 1, minLedger: LEDGER - 1 }, { keyCount: 200, minLedger: LEDGER },
	])
	const body = await response.json() as any
	assert.equal(body.coherent, true)
	assert.equal(body.oldestObservationLedger, LEDGER)
	assert.equal(body.tracks.length, 100)
	assert.equal((await send('/chain/snapshot', { target: { trackIds: [...ids, TRACK] } }, WALLET)).status, 400)

	const privateSlots = Array.from({ length: 100 }, (_, i) => `private-slot-${i}`)
	for (const id of privateSlots) track(id, { public: 0 })
	insertMix.run('oversized', 'Another public mix', '', `${TRACK},${ids[0]},${privateSlots.join(',')}`, OTHER, '2026-01-03')
	const oversized = await send('/chain/snapshot', { target: { mixtapeId: 'oversized' } }, WALLET)
	assert.equal(oversized.status, 200)
	const visible = await oversized.json() as any
	assert.equal(visible.incompleteMembership, true)
	assert.deepEqual(visible.tracks.map(({ id }: { id: string }) => id), [TRACK, ids[0]])
	assert.equal((await send('/chain/snapshot', { target: { mixtapeId: 'oversized' } }, OTHER)).status, 400)
	db.close()
})

test('mint status routes before /:id, scopes batches to the submitter and polls with one D1 read', async () => {
	const { env, db, send, stats, track } = harness()
	track(TRACK, { pair: PAIR })
	track(SECOND)
	db.prepare('INSERT INTO Mixtapes (Id, Title, Desc, Smols, Address) VALUES (?, ?, ?, ?, ?)').run(
		'status-mix', 'Status', '', `${TRACK},${SECOND}`, WALLET,
	)
	db.prepare('INSERT INTO MintBatchStatus (Workflow_Id, Address, Ids, Phase, Tx_Hash) VALUES (?, ?, ?, ?, ?)').run(
		'our-batch', WALLET, JSON.stringify([TRACK, SECOND]), 'submitted', 'a'.repeat(64),
	)
	db.prepare('INSERT INTO MintBatchStatus (Workflow_Id, Address, Ids) VALUES (?, ?, ?)').run(
		'other-batch', OTHER, JSON.stringify([TRACK]),
	)
	const lookedUp: string[] = []
	env.TX_WORKFLOW = { get: async (id: string) => {
		lookedUp.push(id)
		return { status: async () => ({ status: 'running' }) }
	} } as Env['TX_WORKFLOW']
	const forbidRead = () => assert.fail('RPC and KV must stay outside status polling')
	env.KALE_WORKER = { readEntries: forbidRead, getTx: forbidRead } as unknown as KaleWorkerBinding
	env.SMOL_KV = { get: forbidRead } as unknown as KVNamespace
	const response = await send('/mint/status', {
		workflowIds: ['other-batch', 'our-batch'],
		target: { mixtapeId: 'status-mix', revision: '1' },
	}, WALLET)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
	const { revision, batches, tracks } = await response.json() as any
	assert.equal(revision, '1')
	assert.deepEqual(batches, [{ workflowId: 'our-batch', phase: 'submitted', txHash: 'a'.repeat(64), ids: [TRACK, SECOND] }])
	assert.deepEqual(tracks, [{ id: TRACK, sac: PAIR.sac, pool: PAIR.pool }, { id: SECOND, sac: null, pool: null }])
	assert.deepEqual(lookedUp, ['our-batch'])
	assert.equal(stats.statements.length, 1)
	assert.equal(db.prepare('SELECT SUM(Views) AS views FROM Smols').get()?.views, 26)

	const unauth = await send('/mint/status', { ids: [TRACK] })
	assert.equal(unauth.status, 401)
	assert.equal(unauth.headers.get('Cache-Control'), 'private, no-store')
	assert.equal((await send('/mint/status', { ids: [TRACK] }, WALLET)).status, 200)
	const workflowOnly = await send('/mint/status', { workflowIds: ['our-batch'] }, WALLET)
	assert.equal(workflowOnly.status, 200)
	assert.deepEqual((await workflowOnly.json() as any).tracks, tracks)
	db.close()
})

test('mint status separates legacy replay, missing creation, and confirmed persistence errors', async () => {
	const { env, db, send, track } = harness()
	track(TRACK)
	track(SECOND)
	const txHash = 'b'.repeat(64)
	const source = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 10)).publicKey()
	const signedXdr = new TransactionBuilder(new Account(source, '1'),
		{ fee: '100', networkPassphrase: Networks.PUBLIC })
		.addOperation(Operation.bumpSequence({ bumpTo: '4' })).setTimeout(30).build().toXDR()
	let lastId = ''
	let create: (id: string) => void = () => { throw new Error('instance.already_exists') }
	let lookup: () => InstanceStatus = () => ({ status: 'errored' })
	env.TX_WORKFLOW = {
		create: async ({ id }: WorkflowInstanceCreateOptions) => {
			lastId = id!
			create(lastId)
			return { id }
		},
		get: async () => ({ status: async () => lookup() }),
	} as Env['TX_WORKFLOW']
	const poll = async (workflowId: string) => {
		const response = await send('/mint/status', { workflowIds: [workflowId] }, WALLET)
		assert.equal(response.status, 200)
		return (await response.json() as any).batches[0]
	}

	const replay = await send('/mint', { ids: [TRACK], xdr: signedXdr }, WALLET)
	assert.equal(replay.status, 202)
	const { workflowId: legacyId } = await replay.json() as { workflowId: string }
	assert.equal((await poll(legacyId)).phase, 'uncertain')
	lookup = () => { throw new Error('instance.not_found') }
	assert.equal((await poll(legacyId)).phase, 'uncertain', 'A known legacy workflow may have already submitted')

	create = () => { throw new Error('Duplicate upstream proxy header') }
	const single = () => send(`/mint/${SECOND}`, { xdr: signedXdr }, WALLET)
	assert.equal((await single()).status, 503)
	const newId = lastId
	lookup = () => { throw new Error('HTTP 404 Not Found') }
	assert.equal((await poll(newId)).phase, 'uncertain', 'A proxy error does not establish instance absence')
	lookup = () => { throw Object.assign(new Error('Missing instance'), { code: 'instance.not_found' }) }
	assert.equal((await poll(newId)).phase, 'failed')

	create = () => {}
	lookup = () => ({ status: 'queued' })
	const retry = await single()
	assert.equal(retry.status, 202)
	assert.deepEqual(await retry.json(), { workflowId: newId })
	assert.equal((await poll(newId)).phase, 'queued')
	lookup = () => ({ status: 'errored' })
	assert.equal((await poll(newId)).phase, 'failed', 'A new queued workflow has yet to submit')

	// A fast execution can confirm before the submission route updates its D1 row.
	create = (id) => {
		db.prepare("UPDATE MintBatchStatus SET Phase = 'confirmed', Tx_Hash = ?, Confirmed_Ledger = ? WHERE Workflow_Id = ?")
			.run(txHash, LEDGER, id)
	}
	assert.equal((await single()).status, 202)
	assert.deepEqual(await poll(newId), {
		workflowId: newId, phase: 'confirmed', ids: [SECOND], txHash, confirmedLedger: LEDGER,
	})
	db.close()
})

test('a mainnet mint signs with a gateway tip, confirms the relay hash and purges reverse membership and playlist tags', async () => {
	const { env, db, send, track } = harness()
	track(TRACK)
	track(SECOND)
	db.prepare('INSERT INTO Mixtapes (Id, Title, Desc, Smols, Address) VALUES (?, ?, ?, ?, ?)').run(
		'indexed-mixtape', 'Mix', '', `${TRACK},${SECOND}`, WALLET,
	)
	db.prepare('INSERT INTO Playlists (Id, Title) VALUES (?, ?)').run(TRACK, 'arcade')
	const signingKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8))
	const contract = 'CBRNUVLGFM5OYWAGZVGU7CTMP2UJLKZCLFY2ANUCK5UGKND6BBAA5PLA'
	env.SK = signingKey.secret()
	env.SMOL_CONTRACT_ID = contract
	env.NETWORK_PASSPHRASE = Networks.PUBLIC
	env.RPC_URL = 'https://unused.invalid'
	const invocation = new xdr.InvokeContractArgs({
		contractAddress: new Address(contract).toScAddress(),
		functionName: 'coin_it',
		args: [],
	})
	const auth = new xdr.SorobanAuthorizationEntry({
		credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
			address: new Address(signingKey.publicKey()).toScAddress(),
			nonce: xdr.Int64.fromString('1'), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid(),
		})),
		rootInvocation: new xdr.SorobanAuthorizedInvocation({
			function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invocation),
			subInvocations: [],
		}),
	})
	const inputXdr = new TransactionBuilder(new Account(
		Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey(), '1',
	), { fee: '100', networkPassphrase: Networks.PUBLIC })
		.addOperation(Operation.invokeContractFunction({ contract, function: 'coin_it', args: [], auth: [auth] }))
		.setTimeout(30).build().toXDR()

	const requests: string[] = []
	const txHash = 'e'.repeat(64)
	let returnedPair = PAIR
	env.KALE_WORKER = {
		getTip: async () => {
			requests.push('tip')
			return { sequence: LEDGER, closeTime: new Date().toISOString() }
		},
		submitTransaction: async ({ xdr: signed }) => {
			requests.push('submit')
			const op = xdr.TransactionEnvelope.fromXDR(signed, 'base64').v1().tx().operations()[0]
			const credentials = op.body().invokeHostFunctionOp().auth()[0].credentials().address()
			assert.equal(credentials.signatureExpirationLedger(), LEDGER + 100)
			return { hash: txHash }
		},
		getTx: async (hash: string) => {
			requests.push('receipt')
			assert.equal(hash, txHash)
			return {
				status: 'SUCCESS', latestLedger: LEDGER, ledger: LEDGER,
				returnValueXdr: nativeToScVal([returnedPair.sac, returnedPair.pool]).toXDR('base64'),
			}
		},
	} as KaleWorkerBinding
	const tags = new Set<string>()
	const fetchBefore = globalThis.fetch
	globalThis.fetch = (async (input, init) => {
		assert.match(String(input), /\/purge_cache$/)
		for (const tag of (JSON.parse(String(init?.body)) as { tags: string[] }).tags) tags.add(tag)
		return Response.json({ success: true })
	}) as typeof fetch
	try {
		const created = new Map<string, WorkflowTxParams>()
		env.TX_WORKFLOW = { create: async ({ id, params }) => {
			created.set(id!, params!)
			return { id }
		} } as Env['TX_WORKFLOW']
		assert.equal((await send(`/mint/${TRACK}`, { xdr: inputXdr }, WALLET)).status, 202)
		const [instanceId, payload] = [...created.entries()][0]
		const wf = new TxWorkflow({} as ExecutionContext, env)
		const epoch = db.prepare('SELECT Epoch FROM MixtapeState').get()!.Epoch as number
		await wf.run({ instanceId, payload, timestamp: new Date() }, createWorkflowStep(new Map()).step as never)
		assert.deepEqual(requests, ['tip', 'submit', 'receipt'])
		assert.ok(['mixtapes', 'mixtape:indexed-mixtape', 'public-smols', 'playlist:arcade', `smol:${TRACK}:anonymous`]
			.every((tag) => tags.has(tag)))
		assert.equal(db.prepare('SELECT Epoch FROM MixtapeState').get()?.Epoch, epoch + 1)
		const status = await send('/mint/status', { workflowIds: [instanceId] }, WALLET)
		assert.deepEqual((await status.json() as any).batches, [{
			workflowId: instanceId, ids: [TRACK], phase: 'persisted', txHash, confirmedLedger: LEDGER,
		}])

		tags.clear()
		await assert.rejects(
			wf.run({ instanceId: 'wrong-track', payload: { ...payload, entropy: SECOND, trackStatus: false }, timestamp: new Date() },
				createWorkflowStep(new Map()).step as never),
			/canonical token and pool/,
		)
		assert.equal(db.prepare('SELECT Mint_Token FROM Smols WHERE Id = ?').get(SECOND)?.Mint_Token, null)
		assert.equal(tags.size, 0)

		// Batch mint retains reverse return attribution and purges the same reverse indexes.
		const batchInvocation = { contract, function: 'coin_them', args: [
			addr(WALLET), xdr.ScVal.scvVec([]), xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.from(SECOND, 'hex'))]),
		] }
		const batchXdr = new TransactionBuilder(new Account(signingKey.publicKey(), '2'),
			{ fee: '100', networkPassphrase: Networks.PUBLIC })
			.addOperation(Operation.invokeContractFunction(batchInvocation)).setTimeout(30).build().toXDR()
		returnedPair = deriveMintPair(SECOND)!
		db.prepare('INSERT INTO Playlists (Id, Title) VALUES (?, ?)').run(SECOND, 'chill')
		const batchSteps = new Map<string, unknown>([
			['sign transaction#1', batchXdr],
			['submit transaction#1', { hash: txHash }],
			['confirm transaction#1', { returnValue: nativeToScVal([[returnedPair.sac, returnedPair.pool]]).toXDR('base64'), ledger: LEDGER }],
		])
		await wf.run({
			instanceId: 'batch-replay', timestamp: new Date(),
			payload: { type: 'batch-mint', xdr: batchXdr, sub: WALLET, ids: [SECOND], mintableIds: [SECOND] },
		}, createWorkflowStep(batchSteps).step as never)
		assert.equal(db.prepare('SELECT Mint_Token FROM Smols WHERE Id = ?').get(SECOND)?.Mint_Token, returnedPair.sac)
		assert.ok(tags.has('mixtape:indexed-mixtape'))
		assert.ok(tags.has('playlist:chill'))
	} finally {
		globalThis.fetch = fetchBefore
		db.close()
	}
})

test('mainnet login accepts archived signers for both protocols and testnet retains sequential RPC reads', async () => {
	const { env, db, send } = harness()
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	const publicJwk = publicKey.export({ format: 'jwk' })
	const rawKey = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x!, 'base64url'), Buffer.from(publicJwk.y!, 'base64url')])
	const credentialId = Buffer.alloc(32, 13)
	const keyId = credentialId.toString('base64url')
	const origin = 'https://smol.xyz'
	const clientData = Buffer.from(JSON.stringify({
		type: 'webauthn.get', origin, challenge: Buffer.alloc(32, 5).toString('base64url'),
	}))
	const authenticatorData = Buffer.concat([createHash('sha256').update('smol.xyz').digest(), Buffer.from([1, 0, 0, 0, 1])])
	const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]), privateKey)
	const authBody = {
		type: 'connect', protocol: 'smart-account-kit', keyId, contractId: WALLET,
		response: {
			id: keyId, rawId: keyId, type: 'public-key', clientExtensionResults: {},
			response: {
				authenticatorData: authenticatorData.toString('base64url'),
				clientDataJSON: clientData.toString('base64url'),
				signature: signature.toString('base64url'),
			},
		},
	}
	const ids = contractDataKey(WALLET, storageKey('Ids', storageKey('Default')))
	const rule = (id: number) => contractDataKey(WALLET, storageKey('Signers', xdr.ScVal.scvU32(id)))
	const externalSigner = xdr.ScVal.scvVec([storageKey('External', addr(OTHER), xdr.ScVal.scvBytes(Buffer.concat([rawKey, credentialId])))])
	const legacy = contractDataKey(WALLET, storageKey('Secp256r1', xdr.ScVal.scvBytes(credentialId)))
	const entries = [
		entry(ids, xdr.ScVal.scvVec(Array.from({ length: 201 }, (_, n) => xdr.ScVal.scvU32(n)))),
		entry(rule(200), externalSigner),
		entry(legacy, xdr.ScVal.scvVec([xdr.ScVal.scvVoid(), xdr.ScVal.scvBytes(rawKey)])),
	]
	const testnetEntries = [
		entry(ids, xdr.ScVal.scvVec([xdr.ScVal.scvU32(0), xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2)])),
		entry(rule(1), externalSigner),
	]
	const mainnet: Array<[number, number | undefined]> = []
	env.KALE_WORKER = { readEntries: async ({ keys, minLedger }) => {
		mainnet.push([keys.length, minLedger])
		return { latestLedger: LEDGER, archiveAware: true, entries: entries.filter(({ key }) => keys.includes(key)) }
	} } as KaleWorkerBinding
	env.RPC_URL = 'https://mainnet-unused.invalid'
	env.RPC_URL_TESTNET = 'https://testnet-fixture.invalid'
	const testnet: number[] = []
	const fetchBefore = globalThis.fetch
	globalThis.fetch = (async (input, init) => {
		assert.equal(new URL(String(input)).origin, env.RPC_URL_TESTNET)
		const body = JSON.parse(String(init?.body))
		assert.equal(body.method, 'getLedgerEntries')
		testnet.push(body.params.keys.length)
		return Response.json({ jsonrpc: '2.0', id: body.id, result: {
			latestLedger: LEDGER, entries: testnetEntries.filter(({ key }) => body.params.keys.includes(key)),
		} })
	}) as typeof fetch
	try {
		const response = await send('/login', authBody, undefined, { Origin: origin })
		assert.equal(response.status, 200)
		assert.deepEqual(mainnet, [[1, undefined], [200, LEDGER], [1, LEDGER]])
		assert.equal(testnet.length, 0)

		for (const ttl of [0, LEDGER - 1]) {
			for (const signer of entries) signer.liveUntilLedgerSeq = ttl
			assert.equal((await send('/login', authBody, undefined, { Origin: origin })).status, 200)
			assert.equal((await send('/login', { ...authBody, protocol: 'passkey-kit' }, undefined, { Origin: origin })).status, 200)
		}
		mainnet.length = 0
		assert.equal((await send('/login', { ...authBody, network: 'testnet' }, undefined, { Origin: origin })).status, 200)
		assert.deepEqual(testnet, [1, 1, 1])
		assert.equal(mainnet.length, 0)
	} finally {
		globalThis.fetch = fetchBefore
		db.close()
	}
})

test('mixtape tags use D1 first and bulk-read only legacy KV rows', async () => {
	const { env, track, send, db } = harness()
	track(TRACK, { tags: '["D1 tag"]' })
	track(SECOND)
	db.prepare('INSERT INTO Mixtapes (Id, Title, Desc, Smols, Address) VALUES (?, ?, ?, ?, ?)').run(
		'tags-mix', 'Tags', '', `${TRACK},${SECOND}`, WALLET,
	)
	const reads: string[][] = []
	env.SMOL_KV = { get: async (ids: string[]) => {
		reads.push(ids)
		return new Map([[SECOND, { lyrics: { style: ['KV tag'] } }]])
	} } as unknown as KVNamespace
	const edge = createMockEdgeCache()
	Reflect.set(globalThis, 'caches', { open: async () => edge.cache })
	try {
		const response = await send('/mixtapes/tags-mix')
		assert.equal(response.status, 200)
		assert.deepEqual((await response.json() as any).Smols.map(({ Tags }: { Tags: string[] }) => Tags), [['D1 tag'], ['KV tag']])
		assert.deepEqual(reads, [[SECOND]])
		assert.deepEqual(response.headers.get('Cache-Tag')?.split(','), [
			'mixtapes', 'mixtape:tags-mix', `smol:${TRACK}:anonymous`, `smol:${SECOND}:anonymous`,
		])
	} finally {
		Reflect.deleteProperty(globalThis, 'caches')
		db.close()
	}
})

test('cold MP3 Range warms one full response and leaves server and beacon count modes intact', async () => {
	for (const mode of ['server', 'beacon']) {
		const { env, db, track } = harness()
		track(TRACK)
		env.PLAY_COUNT_MODE = mode
		const r2 = createMockR2Bucket()
		const edge = createMockEdgeCache()
		env.SMOL_BUCKET = r2.bucket as unknown as R2Bucket
		Reflect.set(globalThis, 'caches', { default: edge.cache })
		const bytes = Uint8Array.from({ length: 1024 }, (_, i) => i % 256)
		await r2.bucket.put(`song-${TRACK}.mp3`, bytes, { customMetadata: { smolId: TRACK } })
		const ctx = createMockExecutionContext()
		const request = (range: string) => app.fetch(new Request(`https://api.smol.xyz/song/song-${TRACK}.mp3`, {
			headers: { Range: range },
		}), env, ctx.ctx)
		try {
			assert.equal((await request('bytes=0-1')).status, 206)
			await ctx.flush()
			assert.equal(edge.stats.putCalls, 0)

			const [start, seek] = await Promise.all([request('bytes=0-511'), request('bytes=512-')])
			assert.equal(start.status, 206)
			assert.equal(seek.status, 206)
			assert.deepEqual(new Uint8Array(await start.arrayBuffer()), bytes.slice(0, 512))
			await ctx.flush()
			assert.equal(edge.stats.putCalls, 1)
			assert.equal([...edge.entries.values()][0].status, 200)
			assert.deepEqual([...edge.entries.values()][0].body, bytes)
			assert.equal(db.prepare('SELECT Plays FROM Smols').get()?.Plays, mode === 'server' ? 1 : 0)

			const gets = r2.stats.getCalls
			const warm = await request('bytes=10-19')
			assert.equal(warm.status, 206)
			assert.deepEqual(new Uint8Array(await warm.arrayBuffer()), bytes.slice(10, 20))
			assert.equal(r2.stats.getCalls, gets)
		} finally {
			Reflect.deleteProperty(globalThis, 'caches')
			db.close()
		}
	}
})

test('0003 rehearses on populated pre-0001 SQLite and keeps indexed probes and membership updates', () => {
	const migration = (name: string) => readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8')
	const db = new DatabaseSync(':memory:')
	db.exec(`
		CREATE TABLE Smols (
			Id TEXT PRIMARY KEY, Title TEXT NOT NULL, Song_1 TEXT NOT NULL, Song_2 TEXT NOT NULL,
			Created_At DATETIME DEFAULT CURRENT_TIMESTAMP, Public BOOLEAN DEFAULT 1, Instrumental BOOLEAN DEFAULT 0,
			Plays INTEGER DEFAULT 0, Views INTEGER DEFAULT 0, "Address" TEXT NOT NULL, Mint_Token TEXT, Mint_Amm TEXT
		);
		CREATE TABLE Mixtapes (Id TEXT PRIMARY KEY, Title TEXT, Desc TEXT, Smols TEXT NOT NULL,
			"Address" TEXT NOT NULL, Created_At DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE Playlists (Id TEXT NOT NULL, Title TEXT NOT NULL, UNIQUE (Id, Title));
		WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
		INSERT INTO Smols (Id, Title, Song_1, Song_2, Address, Public, Mint_Token)
		SELECT 'track-' || i, 'Track', 'song', '', 'owner', (i % 3 != 0), CASE WHEN i % 100 = 0 THEN 'token' END FROM n;
		INSERT INTO Mixtapes (Id, Title, Desc, Smols, Address) VALUES ('existing', 'Mix', '', 'track-1, track-2,track-1', 'owner');
		INSERT INTO Playlists (Id, Title) VALUES
			('track-1', 'arcade'), ('track-2', 'chill'), ('track-3', 'chill'), ('track-4', 'chill');
	`)
	db.exec(migration('0001_smol_music_providers'))
	db.exec(migration('0002_mixtapes_lifecycle'))
	const sql = migration('0003_storage_query_optimization')
	db.exec(sql)
	assert.equal(db.prepare('SELECT count(*) AS n FROM Smols').get()?.n, 2500)
	assert.equal(db.prepare("SELECT Tags FROM Smols WHERE Id = 'track-1'").get()?.Tags, null)
	assert.ok(db.prepare("SELECT 1 FROM sqlite_stat1 WHERE idx = 'idx_smols_minted_created'").get())
	assert.deepEqual(db.prepare("SELECT smol_id, pos FROM MixtapeMember WHERE mix_id = 'existing' ORDER BY pos").all()
		.map(({ smol_id, pos }) => [smol_id, pos]), [['track-1', 0], ['track-2', 1]])
	db.exec("UPDATE Mixtapes SET Smols = 'track-4, track-1' WHERE Id = 'existing'")
	assert.equal(db.prepare("SELECT smol_id FROM MixtapeMember WHERE mix_id = 'existing' ORDER BY pos LIMIT 1").get()?.smol_id, 'track-4')
	assert.equal(db.prepare("SELECT count(*) AS n FROM MixtapeMember WHERE smol_id = 'track-2'").get()?.n, 0)
	// The live precheck guards the ALTER. Rehearse replay of the remaining statements once Tags exists.
	assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('Smols') WHERE name = 'Tags'").get())
	db.exec(sql.replace('ALTER TABLE Smols ADD COLUMN Tags TEXT DEFAULT NULL;', ''))

	const plan = (query: string) => db.prepare(`EXPLAIN QUERY PLAN ${query}`).all().map(({ detail }) => detail).join('\n')
	assert.match(plan("SELECT Title FROM Smols WHERE Id IN ('track-1', 'track-2') AND +Public = 1"), /SEARCH Smols USING INDEX sqlite_autoindex_Smols_1/)
	const playlistPlan = plan(`SELECT s.Title FROM Playlists p CROSS JOIN Smols s ON s.Id = p.Id
		WHERE p.Title = 'arcade' AND +s.Public = 1 ORDER BY s.Created_At DESC, s.Id DESC LIMIT 100`)
	assert.match(playlistPlan, /SEARCH p USING COVERING INDEX idx_playlists_title_id/)
	assert.match(playlistPlan, /SEARCH s USING INDEX sqlite_autoindex_Smols_1/)
	db.close()
})
