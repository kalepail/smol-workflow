import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after, before } from 'node:test'
import { hash, Keypair, nativeToScVal, Networks, StrKey, xdr } from '@stellar/stellar-sdk/base'
import {
	assertSignedMintEnvelope,
	assertUnsignedMintEnvelope,
	buildMintExpectation,
	decodeMintCarrier,
	MAINNET_MINT_IDENTITY,
	MAX_MINT_REQUEST_BODY_BYTES,
	type MintIdentity,
	type MintKind,
} from '../src/chain/mint-authorization'
import { deriveMintPair, SMOL_FACTORY } from '../src/utils/chain'
import { HISTORICAL_DELETED_MINT_PREFIXES, MINT_ADMISSION_LEASE_MS, MINT_PREFIX_LOCK_OBJECT } from '../src/utils/mint-eligibility'
import { readBoundedJsonObject } from '../src/utils/bounded-read'
import { buildFeCoinItCarrier, buildFeCoinThemCarrier, createPasskey } from './fixtures/mint-authz/fe-builder'
import { FE_MINTER, testIdentity, testIssuerKeypair } from './fixtures/mint-authz/generate'
import {
	createAuthToken,
	createMockExecutionContext,
	createMockUserQuotaNamespace,
	createSqliteBackedStorage,
	createSqliteD1,
	createWorkflowStep,
	installCloudflareStubs,
} from './helpers/harness'

const SECRET = 'test-secret-for-mint-authz-flow-only'
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'mint-authz', 'fe-carriers.json'), 'utf8')) as {
	carriers: Array<{ name: string; kind: MintKind; sub: string; tracks: Array<{ id: string; creator: string }>; userExpirationLedger: number; xdr: string }>
}
const carrier = (name: string) => fixtures.carriers.find((entry) => entry.name === name)!
const TIP = 65_659_000
const TEST_IDENTITY: MintIdentity = Object.freeze({ ...testIdentity() })
const TEST_ISSUER = testIssuerKeypair()
const OTHER_WALLET = StrKey.encodeContract(hash(Buffer.from('other-wallet')))
const PASSKEY = createPasskey('flow-tests')

let app: typeof import('../src/index').app
let TxWorkflow: typeof import('../src/index').TxWorkflow
let UserQuotaDO: typeof import('../src/index').UserQuotaDO
let cleanup: () => void

before(async () => {
	const stubs = installCloudflareStubs({ CF_API_TOKEN: 'purge-token', CF_ZONE_ID: 'zone' })
	cleanup = stubs.cleanup
	;({ app, TxWorkflow, UserQuotaDO } = await import('../src/index'))
})
after(() => cleanup())

function harness(options: { enabled?: string | null } = {}) {
	const db = new DatabaseSync(':memory:')
	db.exec(SCHEMA)
	const { d1, stats, hooks } = createSqliteD1(db)
	const creates: Array<{ id: string; params: WorkflowTxParams }> = []
	const relayed: string[] = []
	const calls: string[] = []
	let tip = TIP
	const enabled = options.enabled === undefined ? 'true' : options.enabled
	const env = {
		SECRET,
		SMOL_D1: d1,
		SMOL_CONTRACT_ID: SMOL_FACTORY,
		NETWORK_PASSPHRASE: Networks.PUBLIC,
		RPC_URL: 'https://rpc.invalid/',
		SK: Keypair.random().secret(),
		...(enabled === null ? {} : { MINT_SIGNING_ENABLED: enabled }),
		TX_WORKFLOW: {
			create: async ({ id, params }: { id: string; params: WorkflowTxParams }) => {
				if (creates.some((entry) => entry.id === id)) throw new Error('instance.already_exists')
				creates.push({ id, params })
				return { id }
			},
			// Like the Workflows API: an instance that was never created is "not found".
			get: async (instanceId: string) => {
				if (!creates.some((entry) => entry.id === instanceId)) throw new Error('instance.not_found')
				return { status: async () => ({ status: 'queued' }) }
			},
		},
		KALE_WORKER: {
			getTip: async () => {
				calls.push('tip')
				return { sequence: tip, closeTime: new Date().toISOString() }
			},
			submitTransaction: async ({ xdr: signed }: { xdr: string }) => {
				calls.push('submit')
				relayed.push(signed)
				return { hash: 'ab'.repeat(32) }
			},
			getTx: async () => ({ status: 'NOT_FOUND', latestLedger: tip }),
		},
	} as unknown as Env
	const quota = createMockUserQuotaNamespace(UserQuotaDO, env)

	function track(id: string, row: { creator?: string; isPublic?: number; pair?: { sac: string; pool: string } } = {}) {
		db.prepare(`INSERT OR IGNORE INTO Smols (Id, Title, Song_1, Address, Public, Mint_Token, Mint_Amm) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(id, `Smol ${id.slice(0, 6)}`, `song-${id}`, row.creator ?? FE_MINTER, row.isPublic ?? 1, row.pair?.sac ?? null, row.pair?.pool ?? null)
	}
	function tracksOf(c: { tracks: Array<{ id: string; creator: string }> }) {
		for (const t of c.tracks) track(t.id, { creator: t.creator })
	}
	async function send(path: string, body?: unknown, sub?: string, init: { raw?: string; headers?: Record<string, string> } = {}) {
		const ctx = createMockExecutionContext()
		const headers = new Headers(init.headers)
		if (sub) headers.set('Authorization', `Bearer ${await createAuthToken(sub, SECRET)}`)
		headers.set('Content-Type', 'application/json')
		const response = await app.fetch(new Request(`https://api.smol.xyz${path}`, {
			method: 'POST',
			headers,
			body: init.raw ?? JSON.stringify(body ?? {}),
		}), env, ctx.ctx)
		await ctx.flush()
		return response
	}
	const locks = () => {
		quota.namespace.get(quota.namespace.idFromName(MINT_PREFIX_LOCK_OBJECT))
		return quota.instances.get(MINT_PREFIX_LOCK_OBJECT)!.db.prepare('SELECT prefix, smol_id, workflow_id, status FROM mint_prefix_locks ORDER BY prefix').all()
			.map((row) => ({ ...row }) as { prefix: string; smol_id: string; workflow_id: string; status: string })
	}
	const batchRow = (workflowId: string) => db.prepare('SELECT * FROM MintBatchStatus WHERE Workflow_Id = ?').get(workflowId) as Record<string, unknown> | undefined
	return {
		db, env, stats, hooks, creates, relayed, calls, quota, track, tracksOf, send, locks, batchRow,
		setTip: (value: number) => { tip = value },
	}
}

async function json(response: Response) {
	return await response.json() as Record<string, unknown>
}

function lockStub(h: ReturnType<typeof harness>) {
	return h.env.USER_QUOTA.get(h.env.USER_QUOTA.idFromName(MINT_PREFIX_LOCK_OBJECT))
}

/** A provisional claim's admission token (the DO requires one at admission). */
const TOKEN = 'flow-test-claim-token'

const mainnetSingle = carrier('mainnet/coin_it-split')
const mainnetSelf = carrier('mainnet/coin_it-self')
const mainnetBatch = carrier('mainnet/coin_them-5')
const mainnetBatch2 = carrier('mainnet/coin_them-2')

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

test('kill switch: closed (unset or "false") rejects both mint routes with 503 mint_paused before any D1 or workflow work', async () => {
	for (const enabled of [null, 'false', 'TRUE', '1']) {
		const h = harness({ enabled })
		h.tracksOf(mainnetSingle)
		const statementsBefore = h.stats.statements.length
		for (const [path, body] of [
			[`/mint/${mainnetSingle.tracks[0].id}`, { xdr: mainnetSingle.xdr }],
			['/mint', { xdr: mainnetBatch.xdr, ids: mainnetBatch.tracks.map(({ id }) => id) }],
		] as const) {
			for (const sub of [FE_MINTER, undefined]) {
				const response = await h.send(path, body, sub)
				assert.equal(response.status, 503, `${enabled} ${path}`)
				assert.deepEqual(await json(response), { error: 'mint_paused' })
				assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
			}
		}
		assert.equal(h.stats.statements.length, statementsBefore, 'no D1 statement while paused')
		assert.equal(h.creates.length, 0)
		assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM MintBatchStatus').get()!.n, 0)
		h.db.close()
	}
})

test('kill switch: POST /mint/status keeps working while paused', async () => {
	const h = harness({ enabled: 'false' })
	h.tracksOf(mainnetSingle)
	h.db.prepare(`INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase, Tx_Hash, Confirmed_Ledger) VALUES (?, ?, ?, 'confirmed', ?, ?)`)
		.run('mint-paused-status', FE_MINTER, JSON.stringify([mainnetSingle.tracks[0].id]), 'cd'.repeat(32), TIP)
	const response = await h.send('/mint/status', { workflowIds: ['mint-paused-status'], ids: [mainnetSingle.tracks[0].id] }, FE_MINTER)
	assert.equal(response.status, 200)
	const body = await json(response)
	assert.deepEqual(body.batches, [{ workflowId: 'mint-paused-status', ids: [mainnetSingle.tracks[0].id], phase: 'confirmed', txHash: 'cd'.repeat(32), confirmedLedger: TIP }])
	h.db.close()
})

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

test('admission: real FE carriers are accepted (single split/self, 2- and 5-track batch), deduplicated, and reserve their prefixes', async () => {
	const h = harness()
	for (const c of [mainnetSingle, mainnetSelf, mainnetBatch2, mainnetBatch]) h.tracksOf(c)

	const single = await h.send(`/mint/${mainnetSingle.tracks[0].id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
	assert.equal(single.status, 202)
	const { workflowId } = await json(single) as { workflowId: string }
	assert.match(workflowId, /^mint-[0-9a-f]{48}$/)
	assert.deepEqual(h.creates[0].params, {
		type: 'mint', xdr: mainnetSingle.xdr, entropy: mainnetSingle.tracks[0].id, sub: FE_MINTER,
		ownerSub: mainnetSingle.tracks[0].creator, trackStatus: true,
	})
	assert.equal(h.batchRow(workflowId)?.Phase, 'queued')
	const again = await h.send(`/mint/${mainnetSingle.tracks[0].id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
	assert.equal(again.status, 202)
	assert.deepEqual(await json(again), { workflowId })
	assert.equal(h.creates.length, 1, 'identical submissions deduplicate')

	assert.equal((await h.send(`/mint/${mainnetSelf.tracks[0].id}`, { xdr: mainnetSelf.xdr }, FE_MINTER)).status, 202)

	for (const c of [mainnetBatch2, mainnetBatch]) {
		const ids = c.tracks.map(({ id }) => id)
		// The posted order may differ from the carrier's salt order.
		const response = await h.send('/mint', { xdr: c.xdr, ids: [...ids].reverse() }, FE_MINTER)
		assert.equal(response.status, 202, c.name)
		const body = await json(response) as { workflowId: string; acceptedIds: string[]; skipped: unknown }
		assert.match(body.workflowId, /^batch-mint-[0-9a-f]{48}$/)
		assert.deepEqual(body.acceptedIds, [...ids].reverse())
		assert.deepEqual(body.skipped, { alreadyMinted: [] })
		const params = h.creates.at(-1)!.params
		assert.deepEqual(params.mintableIds, ids, 'salt order from the carrier')
		assert.deepEqual(params.ownerSubsById, Object.fromEntries(c.tracks.map(({ id, creator }) => [id, creator])))
	}
	const allIds = [mainnetSingle, mainnetSelf, mainnetBatch2, mainnetBatch].flatMap((c) => c.tracks.map(({ id }) => id)).sort()
	assert.deepEqual(h.locks().map((row: any) => row.smol_id).sort(), allIds)
	h.db.close()
})

test('admission: D1 eligibility (private, missing creator, not found, already minted, stale batch, all-minted no-work)', async () => {
	const h = harness()
	const [a, b] = mainnetBatch2.tracks
	const single = mainnetSingle.tracks[0]

	assert.equal((await h.send(`/mint/${single.id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)).status, 404)
	h.track(single.id, { creator: single.creator, isPublic: 0 })
	const hidden = await h.send(`/mint/${single.id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
	assert.equal(hidden.status, 403)
	assert.deepEqual(await json(hidden), { error: 'mint_not_eligible', code: 'not_public', ids: [single.id] })
	h.db.prepare("UPDATE Smols SET Public = 1, Address = '' WHERE Id = ?").run(single.id)
	const creatorless = await h.send(`/mint/${single.id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
	assert.equal(creatorless.status, 400)
	assert.deepEqual(await json(creatorless), { error: 'mint_not_eligible', code: 'missing_creator', ids: [single.id] })
	h.db.prepare('UPDATE Smols SET Address = ?, Mint_Token = ?, Mint_Amm = ? WHERE Id = ?')
		.run(single.creator, deriveMintPair(single.id)!.sac, deriveMintPair(single.id)!.pool, single.id)
	const minted = await h.send(`/mint/${single.id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
	assert.equal(minted.status, 409)
	assert.deepEqual(await json(minted), { error: 'already_minted', ids: [single.id] })

	h.track(a.id, { creator: a.creator, isPublic: 0 })
	h.track(b.id, { creator: b.creator })
	const ids = [a.id, b.id]
	const privateBatch = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids }, FE_MINTER)
	assert.equal(privateBatch.status, 403)
	assert.deepEqual(await json(privateBatch), { error: 'mint_not_eligible', code: 'not_public', ids: [a.id] })

	h.db.prepare('UPDATE Smols SET Public = 1, Mint_Token = ?, Mint_Amm = ? WHERE Id = ?').run(deriveMintPair(a.id)!.sac, deriveMintPair(a.id)!.pool, a.id)
	const stale = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids }, FE_MINTER)
	assert.equal(stale.status, 409)
	assert.deepEqual(await json(stale), { error: 'stale_batch', alreadyMinted: [a.id] })

	h.db.prepare('UPDATE Smols SET Mint_Token = ?, Mint_Amm = ? WHERE Id = ?').run(deriveMintPair(b.id)!.sac, deriveMintPair(b.id)!.pool, b.id)
	const done = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids }, FE_MINTER)
	assert.equal(done.status, 200)
	assert.deepEqual(await json(done), { workflowId: null, acceptedIds: [], skipped: { alreadyMinted: ids } })

	assert.equal(h.creates.length, 0)
	assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM MintBatchStatus').get()!.n, 0, 'no claim row for any rejection')
	assert.deepEqual(h.locks(), [], 'no prefix reserved for any rejection')
	h.db.close()
})

test('admission: closed-set rejections for carriers, ids, sessions, bodies and configuration', async () => {
	const h = harness()
	for (const c of [mainnetSingle, mainnetBatch2]) h.tracksOf(c)
	const id = mainnetSingle.tracks[0].id
	const ids = mainnetBatch2.tracks.map((t) => t.id)
	const expect = async (response: Response, status: number, body: Record<string, unknown>) => {
		assert.equal(response.status, status, JSON.stringify(body))
		assert.deepEqual(await json(response), body)
		assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
	}

	await expect(await h.send(`/mint/${id}`, { xdr: mainnetBatch2.xdr }, FE_MINTER), 400, { error: 'mint_tx_rejected', code: 'function_mismatch' })
	await expect(await h.send(`/mint/${mainnetBatch2.tracks[0].id}`, { xdr: mainnetSingle.xdr }, FE_MINTER), 400, { error: 'mint_tx_rejected', code: 'ids_mismatch' })
	await expect(await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, OTHER_WALLET), 400, { error: 'mint_tx_rejected', code: 'host_function_mismatch' })
	await expect(await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, Keypair.random().publicKey()), 400, { error: 'mint_tx_rejected', code: 'session_invalid' })
	await expect(await h.send(`/mint/${id}`, {}, FE_MINTER), 400, { error: 'mint_tx_rejected', code: 'xdr_missing' })
	await expect(await h.send(`/mint/${id.toUpperCase()}`, { xdr: mainnetSingle.xdr }, FE_MINTER), 400, { error: 'invalid_id' })
	await expect(await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [ids[0]] }, FE_MINTER), 400, { error: 'mint_tx_rejected', code: 'ids_mismatch' })
	await expect(await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [...ids, ids[0]] }, FE_MINTER), 400, { error: 'invalid_ids' })
	await expect(await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: ids.map((x) => ` ${x}`) }, FE_MINTER), 400, { error: 'invalid_ids' })
	await expect(await h.send('/mint', { xdr: mainnetSingle.xdr, ids: [id] }, FE_MINTER), 400, { error: 'mint_tx_rejected', code: 'function_mismatch' })

	// Bodies: malformed, non-object, oversize (streamed and declared).
	for (const raw of ['{"xdr":', '[]', '"xdr"', '']) {
		await expect(await h.send(`/mint/${id}`, undefined, FE_MINTER, { raw }), 400, { error: 'invalid_json' })
		await expect(await h.send('/mint', undefined, FE_MINTER, { raw }), 400, { error: 'invalid_json' })
	}
	const huge = JSON.stringify({ xdr: 'A'.repeat(MAX_MINT_REQUEST_BODY_BYTES), ids })
	await expect(await h.send(`/mint/${id}`, undefined, FE_MINTER, { raw: huge }), 413, { error: 'payload_too_large' })
	await expect(await h.send('/mint', undefined, FE_MINTER, { raw: huge }), 413, { error: 'payload_too_large' })
	const declared = await readBoundedJsonObject(new Request('https://x.invalid', {
		method: 'POST', body: '{}', headers: { 'content-length': String(MAX_MINT_REQUEST_BODY_BYTES + 1) },
	}), MAX_MINT_REQUEST_BODY_BYTES).catch(() => ({ ok: false, reason: 'too_large' as const }))
	assert.deepEqual(declared, { ok: false, reason: 'too_large' })

	// A misconfigured worker refuses to admit.
	h.env.NETWORK_PASSPHRASE = Networks.TESTNET
	await expect(await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER), 503, { error: 'mint_unavailable' })
	h.env.NETWORK_PASSPHRASE = Networks.PUBLIC
	h.env.SMOL_CONTRACT_ID = OTHER_WALLET
	await expect(await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER), 503, { error: 'mint_unavailable' })

	assert.equal(h.creates.length, 0)
	assert.equal((await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr })).status, 401)
	h.db.close()
})

test('admission: 12-hex prefix locks (minted holder in D1, concurrent race, batch overlap, same-id retry)', async () => {
	const h = harness()
	const prefix = hash(Buffer.from('shared-prefix')).toString('hex').slice(0, 12)
	const [idA, idB, idC] = ['a', 'b', 'c'].map((ch) => `${prefix}${ch.repeat(52)}`)
	const other = hash(Buffer.from('other-track')).toString('hex')
	for (const id of [idA, idB, other]) h.track(id, { creator: OTHER_WALLET })
	const coinIt = (id: string, nonce: bigint) => buildFeCoinItCarrier({
		identity: MAINNET_MINT_IDENTITY, user: FE_MINTER, passkey: PASSKEY, expiration: TIP + 500, nonces: [nonce, nonce + 1n],
		track: { id, creator: OTHER_WALLET },
	})
	const [xdrA, xdrB, xdrA2] = await Promise.all([coinIt(idA, 1n), coinIt(idB, 3n), coinIt(idA, 5n)])
	const batchXdr = await buildFeCoinThemCarrier({
		identity: MAINNET_MINT_IDENTITY, user: FE_MINTER, passkey: PASSKEY, expiration: TIP + 500, nonces: [7n, 8n],
		tracks: [{ id: other, creator: OTHER_WALLET }, { id: idB, creator: OTHER_WALLET }],
	})

	const race = await Promise.all([
		h.send(`/mint/${idA}`, { xdr: xdrA }, FE_MINTER),
		h.send(`/mint/${idB}`, { xdr: xdrB }, FE_MINTER),
	])
	assert.deepEqual(race.map((r) => r.status).sort(), [202, 409])
	const loser = race.find((r) => r.status === 409)!
	assert.deepEqual(await json(loser), { error: 'prefix_conflict', code: 'prefix_reserved' })
	const winner = race[0].status === 202 ? idA : idB
	const winnerXdr = winner === idA ? xdrA2 : await coinIt(idB, 9n)
	const loserId = winner === idA ? idB : idA
	const loserXdr = winner === idA ? xdrB : xdrA
	assert.equal(h.creates.length, 1)
	assert.equal((await h.send(`/mint/${loserId}`, { xdr: loserXdr }, FE_MINTER)).status, 409, 'the loser stays locked out')
	const competing = await h.send(`/mint/${winner}`, { xdr: winnerXdr }, FE_MINTER)
	assert.equal(competing.status, 409, 'a second carrier for the same song waits for the unresolved first workflow')
	assert.deepEqual(await json(competing), { error: 'mint_in_progress', ids: [winner] })
	assert.deepEqual(h.locks().map(({ workflow_id, status }) => [workflow_id, status]), [[h.creates[0].id, 'reserved']], 'the owner is never overwritten')
	if (winner === idA) {
		const overlap = await h.send('/mint', { xdr: batchXdr, ids: [other, idB] }, FE_MINTER)
		assert.equal(overlap.status, 409)
		assert.deepEqual(await json(overlap), { error: 'prefix_conflict', code: 'prefix_reserved' })
	}
	assert.deepEqual(h.locks().map((row: any) => [row.prefix, row.smol_id]), [[prefix, winner]])

	// A prefix already minted (in D1) by a different smol blocks new admissions outright.
	h.track(idC, { creator: OTHER_WALLET, pair: deriveMintPair(idC)! })
	const fresh = harness()
	fresh.track(idA, { creator: OTHER_WALLET })
	fresh.track(idC, { creator: OTHER_WALLET, pair: deriveMintPair(idC)! })
	const held = await fresh.send(`/mint/${idA}`, { xdr: xdrA }, FE_MINTER)
	assert.equal(held.status, 409)
	assert.deepEqual(await json(held), { error: 'prefix_conflict', code: 'prefix_minted' })
	h.db.close()
	fresh.db.close()
})

// ---------------------------------------------------------------------------
// TxWorkflow signing boundary
// ---------------------------------------------------------------------------

/** The production class with only its identity swapped, so tests can sign with a throwaway issuer. */
function testWorkflowClass() {
	return class extends TxWorkflow {
		protected mintIdentity() {
			return TEST_IDENTITY
		}
	}
}

function batchEvent(c: ReturnType<typeof carrier>, instanceId: string, xdrOverride?: string) {
	const ids = c.tracks.map(({ id }) => id)
	return {
		instanceId,
		timestamp: new Date(),
		payload: c.kind === 'coin_it'
			? { type: 'mint' as const, xdr: xdrOverride ?? c.xdr, entropy: ids[0], sub: c.sub, ownerSub: c.tracks[0].creator, trackStatus: true }
			: {
				type: 'batch-mint' as const, xdr: xdrOverride ?? c.xdr, ids, mintableIds: ids, sub: c.sub,
				ownerSubsById: Object.fromEntries(c.tracks.map(({ id, creator }) => [id, creator])), trackStatus: true,
			},
	}
}

function claim(h: ReturnType<typeof harness>, event: ReturnType<typeof batchEvent>) {
	const ids = event.payload.type === 'mint' ? [event.payload.entropy] : event.payload.mintableIds
	h.db.prepare(`INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase) VALUES (?, ?, ?, 'queued')`)
		.run(event.instanceId, event.payload.sub, JSON.stringify(ids))
}

function independentlyValidate(c: ReturnType<typeof carrier>, identity: MintIdentity) {
	return assertUnsignedMintEnvelope(decodeMintCarrier(c.xdr, c.kind, identity), buildMintExpectation({ identity, kind: c.kind, sub: c.sub, tracks: c.tracks }))
}

test('signing: paused TxWorkflow refuses to sign an already-queued instance, records failed, never touches SK, tip or relay', async () => {
	for (const enabled of [null, 'false']) {
		const h = harness({ enabled })
		const c = carrier('test/coin_them-5')
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		const event = batchEvent(c, `paused-${enabled}`)
		claim(h, event)
		const Wf = testWorkflowClass()
		const wf = new Wf({} as ExecutionContext, h.env)
		await assert.rejects(wf.signTransaction(event as never), (e: unknown) => e instanceof Error && e.name === 'NonRetryableError' && /Mint signing is paused/.test(e.message))
		await assert.rejects(wf.run(event as never, createWorkflowStep(new Map()).step as never), /Mint signing is paused/)
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'failed')
		assert.deepEqual(h.calls, [])
		assert.deepEqual(h.relayed, [])
		h.db.close()
	}
})

test('signing: a checkpoint signed earlier is not relayed while paused', async () => {
	const h = harness({ enabled: 'false' })
	const c = carrier('test/coin_it-split')
	const event = batchEvent(c, 'paused-after-sign')
	claim(h, event)
	const wf = new TxWorkflow({} as ExecutionContext, h.env)
	await assert.rejects(
		wf.run(event as never, createWorkflowStep(new Map([['sign transaction#1', 'previously-signed-xdr']])).step as never),
		(e: unknown) => e instanceof Error && e.name === 'NonRetryableError' && /paused/.test(e.message),
	)
	assert.deepEqual(h.relayed, [])
	assert.equal(h.batchRow(event.instanceId)?.Phase, 'failed')
	h.db.close()
})

test('signing: enabled TxWorkflow re-validates, signs only the issuer entry with authorizeEntry and relays a verified envelope', async () => {
	for (const name of ['test/coin_it-split', 'test/coin_it-self', 'test/coin_them-2', 'test/coin_them-5']) {
		const h = harness()
		const c = carrier(name)
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		const event = batchEvent(c, `happy-${name}`)
		claim(h, event)
		const pairs = c.tracks.map(({ id }) => deriveMintPair(id)!)
		const returnValue = c.kind === 'coin_it'
			? nativeToScVal([pairs[0].sac, pairs[0].pool])
			: nativeToScVal(pairs.map(({ sac, pool }) => [sac, pool]).reverse())
		;(h.env.KALE_WORKER as unknown as { getTx: unknown }).getTx = async () => ({ status: 'SUCCESS', latestLedger: TIP + 2, ledger: TIP + 2, returnValueXdr: returnValue.toXDR('base64') })
		const originalFetch = globalThis.fetch
		globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch
		const cache = new Map<string, unknown>()
		try {
			const Wf = testWorkflowClass()
			const wf = new Wf({} as ExecutionContext, h.env)
			const result = await wf.run(event as never, createWorkflowStep(cache).step as never)
			assert.equal(result.hash, 'ab'.repeat(32))
		} finally {
			globalThis.fetch = originalFetch
		}
		assert.deepEqual(h.calls, ['tip', 'submit'])
		assert.equal(h.relayed.length, 1)
		assert.deepEqual(cache.get('sign transaction#1'), { version: 'wf0-v1', xdr: h.relayed[0] }, 'the signing checkpoint is versioned')
		assert.deepEqual(h.locks().map(({ status }) => status), c.tracks.map(() => 'minted'), 'a confirmed mint settles its locks')
		const validated = independentlyValidate(c, TEST_IDENTITY)
		assertSignedMintEnvelope(validated, h.relayed[0], { expirationLedger: TIP + 100, networkPassphrase: Networks.PUBLIC })
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'persisted')
		for (const [i, { id }] of c.tracks.entries()) {
			assert.equal(h.db.prepare('SELECT Mint_Token FROM Smols WHERE Id = ?').get(id)?.Mint_Token, pairs[i].sac)
		}
		assert.deepEqual(h.locks().map((row: any) => row.smol_id).sort(), c.tracks.map(({ id }) => id).sort())
		h.db.close()
	}
})

test('signing: D1 is re-read immediately before signing (minted, hidden, re-attributed, deleted, prefix taken)', async () => {
	const c = carrier('test/coin_them-2')
	const [a] = c.tracks
	const cases: Array<[string, (h: ReturnType<typeof harness>) => void | Promise<void>, RegExp, string[]?]> = [
		['minted meanwhile', (h) => { h.db.prepare("UPDATE Smols SET Mint_Token = 'C', Mint_Amm = 'C' WHERE Id = ?").run(a.id) }, /already_minted/],
		['made private', (h) => { h.db.prepare('UPDATE Smols SET Public = 0 WHERE Id = ?').run(a.id) }, /not_public/],
		['creator changed', (h) => { h.db.prepare('UPDATE Smols SET Address = ? WHERE Id = ?').run(OTHER_WALLET, a.id) }, /host_function_mismatch/],
		['row deleted', (h) => { h.db.prepare('DELETE FROM Smols WHERE Id = ?').run(a.id) }, /not_found/],
		['prefix minted by another smol', (h) => { h.track(`${a.id.slice(0, 12)}${'0'.repeat(52)}`, { pair: { sac: 'C', pool: 'C' } }) }, /prefix_minted/],
		// The authoritative lock claim is the last step before signing, after the (read-only) tip read.
		['prefix reserved by another smol', async (h) => {
			assert.deepEqual(await lockStub(h).reserveMintPrefixes({ workflowId: 'other', ids: [`${a.id.slice(0, 12)}${'1'.repeat(52)}`], stage: 'admission', claimToken: TOKEN }), { ok: true })
		}, /prefix_reserved/, ['tip']],
		['same smol owned by another workflow', async (h) => {
			assert.deepEqual(await lockStub(h).reserveMintPrefixes({ workflowId: 'other', ids: [a.id], stage: 'admission', claimToken: TOKEN }), { ok: true })
		}, /mint_in_progress/, ['tip']],
	]
	for (const [name, change, pattern, calls = []] of cases) {
		const h = harness()
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		await change(h)
		const event = batchEvent(c, `reread-${name}`)
		claim(h, event)
		const Wf = testWorkflowClass()
		await assert.rejects(new Wf({} as ExecutionContext, h.env).signTransaction(event as never),
			(e: unknown) => e instanceof Error && e.name === 'NonRetryableError' && pattern.test(e.message), name)
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'failed', name)
		assert.deepEqual(h.calls, calls, `${name}: no relay`)
		h.db.close()
	}
})

test('signing: refuses tampered payloads, a non-issuer key, a mainnet carrier without the real key, and expired wallet auth', async () => {
	const c = carrier('test/coin_it-split')
	const presigned = (() => {
		const envelope = xdr.TransactionEnvelope.fromXDR(c.xdr, 'base64')
		const auth = envelope.v1().tx().operations()[0].body().invokeHostFunctionOp().auth()
		const admin = auth.find((entry) => entry.credentials().address().address().switch().name === 'scAddressTypeAccount')!
		admin.credentials().address().signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap([])]))
		return envelope.toXDR('base64')
	})()
	const Wf = testWorkflowClass()
	const run = async (setup: (h: ReturnType<typeof harness>) => void, event: ReturnType<typeof batchEvent>, pattern: RegExp, Cls: typeof TxWorkflow = Wf) => {
		const h = harness()
		h.tracksOf(c)
		h.tracksOf(mainnetSingle)
		h.env.SK = TEST_ISSUER.secret()
		setup(h)
		claim(h, event)
		await assert.rejects(new Cls({} as ExecutionContext, h.env).signTransaction(event as never),
			(e: unknown) => e instanceof Error && e.name === 'NonRetryableError' && pattern.test(e.message))
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'failed')
		assert.deepEqual(h.relayed, [])
		h.db.close()
	}
	await run(() => {}, batchEvent(c, 'presigned', presigned), /admin_presigned/)
	assert.notEqual(mainnetSelf.tracks[0].id, c.tracks[0].id)
	await run(() => {}, { ...batchEvent(c, 'wrong-id'), payload: { ...batchEvent(c, 'wrong-id').payload, entropy: mainnetSelf.tracks[0].id } } as never, /ids_mismatch/)
	await run((h) => { h.env.SK = Keypair.random().secret() }, batchEvent(c, 'wrong-key'), /does not match the SMOL issuer/)
	await run((h) => { h.env.SK = 'not-a-secret' }, batchEvent(c, 'bad-key'), /key is invalid/)
	await run((h) => h.setTip(c.userExpirationLedger), batchEvent(c, 'expired'), /user authorization has expired/)
	// Production identity: a valid mainnet carrier can only be signed by the real issuer key.
	await run(() => {}, batchEvent(mainnetSingle, 'mainnet-wrong-key'), /does not match the SMOL issuer/, TxWorkflow)
	await run((h) => { h.env.NETWORK_PASSPHRASE = Networks.TESTNET }, batchEvent(mainnetSingle, 'mainnet-wrong-network'), /network_mismatch/, TxWorkflow)
})

test('signing: transient D1 or lock failures stay retryable and do not record failure', async () => {
	const c = carrier('test/coin_it-self')
	for (const failing of ['FROM Smols', 'lock']) {
		const h = harness()
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		const event = batchEvent(c, `transient-${failing}`)
		claim(h, event)
		if (failing === 'lock') {
			(h.env as unknown as { USER_QUOTA: unknown }).USER_QUOTA = { idFromName: () => 'x', get: () => ({ reserveMintPrefixes: async () => { throw new Error('DO overloaded') } }) }
		} else {
			h.hooks.onStatement = (sql) => { if (sql.includes(failing)) throw new Error('D1_ERROR: network connection lost') }
		}
		const Wf = testWorkflowClass()
		await assert.rejects(new Wf({} as ExecutionContext, h.env).signTransaction(event as never),
			(e: unknown) => e instanceof Error && e.name !== 'NonRetryableError')
		h.hooks.onStatement = undefined
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'queued')
		h.db.close()
	}
})

// ---------------------------------------------------------------------------
// Pass 2: one owning workflow per song, versioned checkpoints, visibility first,
// mixed batches, terminal refusals under D1 outage, historical deleted prefixes
// ---------------------------------------------------------------------------

/** Runs `fn` with the wall clock moved forward (the routes and the DO read `Date.now()`). */
async function later<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
	const realNow = Date.now
	Date.now = () => realNow() + offsetMs
	try {
		return await fn()
	} finally {
		Date.now = realNow
	}
}
const AFTER_LEASE = MINT_ADMISSION_LEASE_MS + 1_000

const isTerminal = (pattern: RegExp) => (e: unknown) => e instanceof Error && e.name === 'NonRetryableError' && pattern.test(e.message)
const feCoinIt = (track: { id: string; creator: string }, nonce: bigint, identity: MintIdentity = MAINNET_MINT_IDENTITY) =>
	buildFeCoinItCarrier({ identity, user: FE_MINTER, passkey: PASSKEY, expiration: TIP + 500, nonces: [nonce, nonce + 1n], track })
const feCoinThem = (tracks: Array<{ id: string; creator: string }>, nonce: bigint, identity: MintIdentity = MAINNET_MINT_IDENTITY) =>
	buildFeCoinThemCarrier({ identity, user: FE_MINTER, passkey: PASSKEY, expiration: TIP + 500, nonces: [nonce, nonce + 1n], tracks })

test('prefix locks (DO): one owning workflow per smol while unresolved; dispatch is retained; takeover only after a definite failure; release only by the acquiring token', async () => {
	const h = harness()
	const stub = lockStub(h)
	const NOW = 1_800_000_000_000
	// A provisional holder was never signed; every holder past `reserved` was claimed for signing at NOW.
	const lease = { claimToken: TOKEN, leaseUntilMs: NOW + MINT_ADMISSION_LEASE_MS, leaseVersion: 1, signedAtMs: null }
	const noLease = { claimToken: null, leaseUntilMs: null, leaseVersion: null, signedAtMs: NOW }
	const prefixOf = (label: string) => hash(Buffer.from(label)).toString('hex').slice(0, 12)
	const prefix = prefixOf('lock-state-machine')
	const [A, B] = ['a', 'b'].map((ch) => `${prefix}${ch.repeat(52)}`)
	const row = (p = prefix) => h.locks().find((entry) => entry.prefix === p)
	const claim = (workflowId: string, ids: string[], stage: 'admission' | 'signing', claimToken = TOKEN) =>
		stub.reserveMintPrefixes({ workflowId, ids, stage, ...(stage === 'admission' ? { claimToken } : {}), nowMs: NOW })
	const conflict = (reason: string, workflowId: string, status: string, id = A, held = noLease, heldBy = A, p = prefix) => ({
		ok: false, conflicts: [{ prefix: p, id, heldBy, workflowId, status, ...held, reason }],
	})
	const mark = (workflowId: string, ids: string[]) => stub.markMintDispatched({ workflowId, ids, nowMs: NOW })
	const resolve = (workflowId: string, ids: string[], outcome: 'failed' | 'failed_onchain' | 'ambiguous' | 'minted') =>
		stub.resolveMintPrefixes({ workflowId, ids, outcome, nowMs: NOW })

	// Admission: a provisional claim tagged with its admission token and a creation lease.
	assert.deepEqual(await claim('w1', [A], 'admission'), { ok: true })
	assert.deepEqual(row(), { prefix, smol_id: A, workflow_id: 'w1', status: 'reserved' })
	// Another workflow for the same smol is refused at both stages and never overwrites the owner.
	assert.deepEqual(await claim('w2', [A], 'admission'), conflict('mint_in_progress', 'w1', 'reserved', A, lease))
	assert.deepEqual(await claim('w2', [A], 'signing'), conflict('mint_in_progress', 'w1', 'reserved', A, lease))
	// Another smol with the same prefix is refused whatever its workflow.
	assert.deepEqual(await claim('w1', [B], 'admission'), conflict('prefix_reserved', 'w1', 'reserved', B, lease))
	// An identical-carrier admission joins the claim without acquiring it: its token releases nothing.
	assert.deepEqual(await claim('w1', [A], 'admission', 'joining-admission-token'), { ok: true })
	assert.deepEqual(await stub.releaseMintPrefixes({ workflowId: 'w1', ids: [A], claimToken: 'joining-admission-token' }), { released: 0 })
	// Once joined, the acquirer's own cleanup can no longer release it either: the joiner may have queued the workflow.
	assert.deepEqual(await stub.releaseMintPrefixes({ workflowId: 'w1', ids: [A], claimToken: TOKEN }), { released: 0 }, 'joined claim retained')
	// A competing reclaim is refused inside the creation lease, even with the right token and the exact
	// observed lease (the join renewed it and bumped its generation to 2).
	const joinedLease = [{ id: A, leaseUntilMs: NOW + MINT_ADMISSION_LEASE_MS, leaseVersion: 2 }]
	assert.deepEqual(await stub.releaseMintPrefixes({ workflowId: 'w1', ids: [A], claimToken: TOKEN, expiredLeaseOnly: true, observedLeases: joinedLease, nowMs: NOW + 1_000 }), { released: 0 })
	assert.equal(row()?.status, 'reserved')

	// The owner's signing claim; admission never downgrades it; nothing releases it.
	assert.deepEqual(await claim('w1', [A], 'signing'), { ok: true })
	assert.deepEqual(await claim('w1', [A], 'admission'), { ok: true })
	assert.equal(row()?.status, 'signing')
	assert.deepEqual(await stub.releaseMintPrefixes({ workflowId: 'w1', ids: [A], claimToken: TOKEN }), { released: 0 })
	assert.deepEqual(await resolve('w2', [A], 'failed'), { resolved: 0, state: 'none' }, 'resolution is owner-guarded')
	assert.deepEqual(await claim('w2', [A], 'admission'), conflict('mint_in_progress', 'w1', 'signing'))

	// The dispatch marker: only the owner's `signing` claim may become `dispatched`.
	assert.deepEqual(await mark('w2', [A]), { ok: false, state: 'not_owned' })
	assert.deepEqual(await mark('w1', [A]), { ok: true })
	assert.equal(row()?.status, 'dispatched')
	// Retained against everyone: other workflows, releases, pre-dispatch failures and re-signing.
	assert.deepEqual(await claim('w2', [A], 'admission'), conflict('mint_in_progress', 'w1', 'dispatched'))
	assert.deepEqual(await claim('w2', [A], 'signing'), conflict('mint_in_progress', 'w1', 'dispatched'))
	assert.deepEqual(await claim('w1', [A], 'admission'), { ok: true }, 'an identical repost joins the live dispatch')
	assert.deepEqual(await stub.releaseMintPrefixes({ workflowId: 'w1', ids: [A], claimToken: TOKEN, expiredLeaseOnly: true, observedLeases: joinedLease, nowMs: NOW * 2 }), { released: 0 })
	// A full restart re-entering signing is refused, and the same transaction retains it as ambiguous.
	assert.deepEqual(await claim('w1', [A], 'signing'), conflict('dispatch_uncertain', 'w1', 'dispatched'))
	assert.equal(row()?.status, 'ambiguous')
	// A pre-dispatch failure (e.g. a paused submit replay) never demotes it; nor does a second mark.
	assert.deepEqual(await resolve('w1', [A], 'failed'), { resolved: 0, state: 'uncertain' })
	assert.deepEqual(await mark('w1', [A]), { ok: false, state: 'uncertain' })
	assert.deepEqual(await claim('w1', [A], 'signing'), conflict('dispatch_uncertain', 'w1', 'ambiguous'))
	assert.deepEqual(await claim('w1', [A], 'admission'), conflict('dispatch_uncertain', 'w1', 'ambiguous'), 'no new admission while ambiguous')
	assert.deepEqual(await claim('w3', [A], 'admission'), conflict('mint_in_progress', 'w1', 'ambiguous'))
	assert.deepEqual(await resolve('w1', [A], 'failed_onchain'), { resolved: 0, state: 'uncertain' }, 'ambiguity is for reconciliation')
	assert.equal(row()?.status, 'ambiguous')
	// Only a confirmed receipt settles it. Minted is terminal: never downgraded, never taken over.
	assert.deepEqual(await resolve('w1', [A], 'minted'), { resolved: 1, state: 'minted' })
	assert.deepEqual(await resolve('w1', [A], 'failed'), { resolved: 0, state: 'minted' })
	assert.deepEqual(await claim('w5', [A], 'admission'), conflict('minted', 'w1', 'minted'))
	assert.deepEqual(await claim('w1', [A], 'signing'), conflict('minted', 'w1', 'minted'))

	// A dispatched replay is detected by the marker itself (a lost checkpoint after a relayed submit).
	const P2 = prefixOf('lock-state-machine-dispatch')
	const [C, D] = ['c', 'd'].map((ch) => `${P2}${ch.repeat(52)}`)
	assert.deepEqual(await claim('w1', [C], 'signing'), { ok: true })
	assert.deepEqual(await mark('w1', [C]), { ok: true })
	assert.deepEqual(await mark('w1', [C]), { ok: false, state: 'uncertain' })
	assert.equal(row(P2)?.status, 'ambiguous')
	// A relay outcome that is unknown moves `dispatched` to `ambiguous` too.
	const P3 = prefixOf('lock-state-machine-relay')
	const [E] = [`${P3}${'e'.repeat(52)}`]
	await claim('w1', [E], 'signing')
	await mark('w1', [E])
	assert.deepEqual(await resolve('w1', [E], 'ambiguous'), { resolved: 1, state: 'uncertain' })
	assert.equal(row(P3)?.status, 'ambiguous')
	// An on-chain FAILED receipt for the owner's own dispatch is definite: same-smol takeover only.
	const P4 = prefixOf('lock-state-machine-receipt')
	const [F, G] = ['f', '1'].map((ch) => `${P4}${ch.repeat(52)}`)
	await claim('w1', [F], 'signing')
	await mark('w1', [F])
	assert.deepEqual(await resolve('w1', [F], 'failed_onchain'), { resolved: 1, state: 'failed' })
	assert.deepEqual(await claim('w3', [G], 'admission'), conflict('prefix_reserved', 'w1', 'failed', G, noLease, F, P4), 'binding kept')
	assert.deepEqual(await claim('w2', [F], 'admission'), { ok: true })
	assert.deepEqual(row(P4), { prefix: P4, smol_id: F, workflow_id: 'w2', status: 'reserved' })
	assert.deepEqual(await claim('w1', [F], 'signing'), conflict('mint_in_progress', 'w2', 'reserved', F, { ...lease, signedAtMs: NOW }, F, P4), 'the old workflow can no longer sign')
	// Releasing w2's (taken-over, once-signed) provisional claim returns it to `failed`, never deletes it.
	assert.deepEqual(await stub.releaseMintPrefixes({ workflowId: 'w2', ids: [F], claimToken: TOKEN }), { released: 1 })
	assert.deepEqual(row(P4), { prefix: P4, smol_id: F, workflow_id: 'w2', status: 'failed' })
	assert.deepEqual(await mark('w2', [F]), { ok: false, state: 'not_owned' }, 'a failed claim can never be dispatched')

	// A never-signed provisional claim is deleted, by release or by a definite refusal, freeing the prefix.
	const P5 = prefixOf('lock-state-machine-provisional')
	const [H, I] = ['2', '3'].map((ch) => `${P5}${ch.repeat(52)}`)
	assert.deepEqual(await claim('w6', [H], 'admission'), { ok: true })
	// `released`, not `failed`: an admission reservation proves nothing about an earlier (pre-v7) dispatch.
	assert.deepEqual(await resolve('w6', [H], 'failed'), { resolved: 1, state: 'released' })
	assert.equal(row(P5), undefined, 'a never-signed refusal deletes the row')
	assert.deepEqual(await claim('w7', [I], 'admission'), { ok: true }, 'another smol sharing the prefix may claim it')
	assert.deepEqual(await stub.releaseMintPrefixes({ workflowId: 'w7', ids: [I], claimToken: TOKEN }), { released: 1 })
	assert.equal(row(P5), undefined)
	// Only an owned `signing` claim moving to `failed` is proof that this workflow's signed attempt never
	// dispatched. A repeat refusal of an already `failed` claim, or a once-signed claim taken over by
	// another workflow's admission, is `released`: it settles the lock but proves nothing about a dispatch.
	const P6 = prefixOf('lock-state-machine-proof')
	const [L] = [`${P6}${'4'.repeat(52)}`]
	assert.deepEqual(await claim('w10', [L], 'admission'), { ok: true })
	assert.deepEqual(await claim('w10', [L], 'signing'), { ok: true })
	assert.deepEqual(await resolve('w10', [L], 'failed'), { resolved: 1, state: 'failed' })
	assert.equal(row(P6)?.status, 'failed')
	assert.deepEqual(await resolve('w10', [L], 'failed'), { resolved: 0, state: 'released' }, 'a repeat proves nothing new')
	assert.deepEqual(await claim('w11', [L], 'admission'), { ok: true })
	assert.deepEqual(row(P6), { prefix: P6, smol_id: L, workflow_id: 'w11', status: 'reserved' })
	assert.deepEqual(await resolve('w11', [L], 'failed'), { resolved: 1, state: 'released' }, 'a taken-over (once-signed) reservation')
	assert.equal(row(P6)?.status, 'failed', 'once signed: kept as failed, never deleted')

	// The marker is all-or-nothing across a batch: one prefix not in `signing` blocks every prefix.
	const [J, K] = ['marker-batch-1', 'marker-batch-2'].map((label) => hash(Buffer.from(label)).toString('hex'))
	await claim('w8', [J], 'signing')
	await claim('w8', [K], 'admission')
	assert.deepEqual(await mark('w8', [J, K]), { ok: false, state: 'not_owned' })
	assert.deepEqual([row(J.slice(0, 12))?.status, row(K.slice(0, 12))?.status], ['signing', 'reserved'])
	// Reservations are all-or-nothing too.
	const fresh = hash(Buffer.from('lock-state-machine-fresh')).toString('hex')
	assert.equal((await claim('w9', [fresh, A], 'admission')).ok, false)
	assert.equal(h.locks().some((entry) => entry.smol_id === fresh), false, 'nothing is claimed when any prefix conflicts')

	// Schema invariants: no `failed` row was ever left unsigned, and the CHECKs refuse one outright.
	const db = h.quota.instances.get(MINT_PREFIX_LOCK_OBJECT)!.db
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM mint_prefix_locks WHERE status = 'failed' AND signed_at_ms IS NULL`).get()!.n, 0)
	const insert = (status: string, token: string | null, signed: number | null, dispatched: number | null) => db.prepare(
		`INSERT INTO mint_prefix_locks (prefix, smol_id, workflow_id, status, claim_token, lease_until_ms, reserved_at_ms, signed_at_ms, dispatched_at_ms, updated_at_ms)
		 VALUES ('ffffffffffff', 'ffffffffffff${'f'.repeat(52)}', 'wx', ?, ?, NULL, 1, ?, ?, 1)`).run(status, token, signed, dispatched)
	assert.throws(() => insert('failed', null, null, null), /CHECK/, 'never-signed failed')
	assert.throws(() => insert('reserved', null, null, null), /CHECK/, 'provisional without a token')
	assert.throws(() => insert('dispatched', null, 1, null), /CHECK/, 'dispatched without a dispatch time')
	assert.throws(() => insert('ambiguous', null, null, 1), /CHECK/, 'ambiguous without a signing claim')
	assert.throws(() => insert('released', TOKEN, 1, 1), /CHECK/, 'unknown status')

	// Malformed requests throw (transient to callers), never partially write.
	await assert.rejects(stub.reserveMintPrefixes({ workflowId: 'w9', ids: [fresh, `${fresh.slice(0, 12)}${'0'.repeat(52)}`], stage: 'admission', claimToken: TOKEN }))
	await assert.rejects(stub.reserveMintPrefixes({ workflowId: 'w9', ids: [fresh], stage: 'other' as never }))
	await assert.rejects(stub.reserveMintPrefixes({ workflowId: 'w9', ids: [fresh], stage: 'admission' }), /Invalid/, 'admission requires a token')
	await assert.rejects(stub.reserveMintPrefixes({ workflowId: 'w9', ids: [fresh], stage: 'admission', claimToken: 'short' }))
	await assert.rejects(stub.releaseMintPrefixes({ workflowId: 'w9', ids: [fresh] } as never), /Invalid/, 'release requires a token')
	await assert.rejects(stub.releaseMintPrefixes({ workflowId: 'w9', ids: [fresh], claimToken: TOKEN, expiredLeaseOnly: true }), /Invalid/,
		'expiry recovery requires the observed lease')
	await assert.rejects(stub.releaseMintPrefixes({
		workflowId: 'w9', ids: [fresh], claimToken: TOKEN, expiredLeaseOnly: true, observedLeases: [{ id: A, leaseUntilMs: NOW, leaseVersion: 1 }],
	}), /Invalid/, 'an observed lease for every id')
	await assert.rejects(stub.resolveMintPrefixes({ workflowId: 'w9', ids: [fresh], outcome: 'reserved' as never }))
	assert.equal(h.locks().some((entry) => entry.smol_id === fresh), false)
	h.db.close()
})

test('admission: one workflow per song while unresolved (409 mint_in_progress); identical XDR with reordered ids dedupes; a definite failure frees the song', async () => {
	const h = harness()
	h.tracksOf(mainnetBatch2)
	const ids = mainnetBatch2.tracks.map(({ id }) => id)
	const first = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids }, FE_MINTER)
	assert.equal(first.status, 202)
	const { workflowId } = await json(first) as { workflowId: string }
	const reordered = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [...ids].reverse() }, FE_MINTER)
	assert.equal(reordered.status, 202)
	assert.equal((await json(reordered)).workflowId, workflowId, 'the workflow id follows the carrier salt order, not the posted order')
	assert.equal(h.creates.length, 1)

	// A fresh carrier for the same songs (new nonces and wallet signature) is a different workflow.
	const fresh = await feCoinThem(mainnetBatch2.tracks, 41n)
	const competing = await h.send('/mint', { xdr: fresh, ids }, FE_MINTER)
	assert.equal(competing.status, 409)
	assert.deepEqual(await json(competing), { error: 'mint_in_progress', ids })
	const competingSingle = await h.send(`/mint/${ids[1]}`, { xdr: await feCoinIt(mainnetBatch2.tracks[1], 43n) }, FE_MINTER)
	assert.equal(competingSingle.status, 409)
	assert.deepEqual(await json(competingSingle), { error: 'mint_in_progress', ids: [ids[1]] })
	assert.equal(h.creates.length, 1)
	const owners = () => h.locks().map(({ smol_id, workflow_id, status }) => [smol_id, workflow_id, status]).sort()
	assert.deepEqual(owners(), ids.map((id) => [id, workflowId, 'reserved']).sort())

	// Once the owner has definitely failed, a new carrier takes over.
	await lockStub(h).resolveMintPrefixes({ workflowId, ids, outcome: 'failed' })
	const retry = await h.send('/mint', { xdr: fresh, ids }, FE_MINTER)
	assert.equal(retry.status, 202)
	const { workflowId: retryId } = await json(retry) as { workflowId: string }
	assert.notEqual(retryId, workflowId)
	assert.deepEqual(owners(), ids.map((id) => [id, retryId, 'reserved']).sort())
	h.db.close()
})

test('admission: a definite pre-sign failure (claim row or workflow creation) releases the provisional claim; a signing claim is never released', async () => {
	const h = harness()
	h.tracksOf(mainnetSingle)
	const id = mainnetSingle.tracks[0].id
	const workflows = h.env.TX_WORKFLOW as unknown as { create: (arg: { id: string; params: WorkflowTxParams }) => Promise<unknown> }
	const create = workflows.create
	workflows.create = async () => { throw new Error('workflow service unavailable') }
	assert.equal((await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)).status, 503)
	assert.deepEqual(h.locks(), [], 'creation failure released the provisional claim')

	workflows.create = create
	h.hooks.onStatement = (sql) => { if (sql.includes('INSERT INTO MintBatchStatus')) throw new Error('D1_ERROR: network connection lost') }
	assert.equal((await h.send(`/mint/${id}`, { xdr: await feCoinIt(mainnetSingle.tracks[0], 49n) }, FE_MINTER)).status, 503)
	h.hooks.onStatement = undefined
	assert.deepEqual(h.locks(), [], 'a claim-row failure released the provisional claim')
	assert.equal(h.creates.length, 0)

	// Not stuck: a fresh carrier for the same song is admitted.
	const fresh = await feCoinIt(mainnetSingle.tracks[0], 51n)
	const admitted = await h.send(`/mint/${id}`, { xdr: fresh }, FE_MINTER)
	assert.equal(admitted.status, 202)
	const { workflowId } = await json(admitted) as { workflowId: string }

	// Once the workflow has claimed for signing, a creation failure on a duplicate request releases nothing.
	assert.deepEqual(await lockStub(h).reserveMintPrefixes({ workflowId, ids: [id], stage: 'signing' }), { ok: true })
	workflows.create = async () => { throw new Error('workflow service unavailable') }
	assert.equal((await h.send(`/mint/${id}`, { xdr: fresh }, FE_MINTER)).status, 503)
	assert.deepEqual(h.locks().map(({ workflow_id, status }) => [workflow_id, status]), [[workflowId, 'signing']])
	h.db.close()
})

test('admission: a provisional claim whose workflow is terminal before signing is released for a new carrier after its creation lease; a live or signing owner keeps it', async () => {
	const id = mainnetSingle.tracks[0].id
	const setup = async () => {
		const h = harness()
		h.tracksOf(mainnetSingle)
		const statuses = new Map<string, string | Error>()
		;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = async (instanceId: string) => ({
			status: async () => {
				const status = statuses.get(instanceId) ?? 'queued'
				if (status instanceof Error) throw status
				return { status }
			},
		})
		const first = await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
		assert.equal(first.status, 202)
		const { workflowId } = await json(first) as { workflowId: string }
		return { h, statuses, workflowId, fresh: await feCoinIt(mainnetSingle.tracks[0], 61n) }
	}

	{
		const { h, statuses, workflowId, fresh } = await setup()
		// Inside the creation lease nothing is inspected or reclaimed, whatever the owner's status.
		for (const status of ['queued', 'errored', 'terminated', new Error('instance.not_found')]) {
			statuses.set(workflowId, status)
			const response = await h.send(`/mint/${id}`, { xdr: fresh }, FE_MINTER)
			assert.equal(response.status, 409, `in lease: ${String(status)}`)
			assert.deepEqual(await json(response), { error: 'mint_in_progress', ids: [id] })
		}
		for (const status of ['queued', 'running', 'waiting', 'paused', 'unknown', new Error('Workflows API unavailable')]) {
			statuses.set(workflowId, status)
			const response = await later(AFTER_LEASE, () => h.send(`/mint/${id}`, { xdr: fresh }, FE_MINTER))
			assert.equal(response.status, 409, String(status))
			assert.deepEqual(await json(response), { error: 'mint_in_progress', ids: [id] })
		}
		for (const status of ['errored', 'terminated', new Error('instance.not_found')]) {
			const { h: run, statuses: runStatuses, workflowId: owner, fresh: next } = status === 'errored' ? { h, statuses, workflowId, fresh } : await setup()
			runStatuses.set(owner, status)
			const response = await later(AFTER_LEASE, () => run.send(`/mint/${id}`, { xdr: next }, FE_MINTER))
			assert.equal(response.status, 202, String(status))
			const { workflowId: takeover } = await json(response) as { workflowId: string }
			assert.deepEqual(run.locks().map(({ workflow_id, status: lock }) => [workflow_id, lock]), [[takeover, 'reserved']])
			if (run !== h) run.db.close()
		}
		h.db.close()
	}
	// Errored after claiming for signing: the outcome may be ambiguous, so the claim is retained.
	{
		const { h, statuses, workflowId, fresh } = await setup()
		await lockStub(h).reserveMintPrefixes({ workflowId, ids: [id], stage: 'signing' })
		statuses.set(workflowId, 'errored')
		assert.equal((await later(AFTER_LEASE, () => h.send(`/mint/${id}`, { xdr: fresh }, FE_MINTER))).status, 409)
		assert.deepEqual(h.locks().map(({ workflow_id, status }) => [workflow_id, status]), [[workflowId, 'signing']])
		h.db.close()
	}
})

test('signing: only the owning workflow may sign; outcomes settle the lock (never-signed refusal deletes, failed receipt frees the song, ambiguous relay retains it)', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const Wf = testWorkflowClass()
	const setup = (instanceId: string) => {
		const h = harness()
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		const event = batchEvent(c, instanceId)
		claim(h, event)
		return { h, event, wf: new Wf({} as ExecutionContext, h.env) }
	}

	// A competing workflow for a song owned by another unresolved workflow is refused before signing.
	{
		const { h, event, wf } = setup('competitor')
		await lockStub(h).reserveMintPrefixes({ workflowId: 'owner', ids: [id], stage: 'admission', claimToken: TOKEN })
		await assert.rejects(wf.signTransaction(event as never), isTerminal(/mint_in_progress/))
		await assert.rejects(wf.run(event as never, createWorkflowStep(new Map()).step as never), isTerminal(/mint_in_progress/))
		assert.deepEqual(h.relayed, [])
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'failed')
		assert.deepEqual(h.locks().map(({ workflow_id, status }) => [workflow_id, status]), [['owner', 'reserved']], 'the owner keeps its claim')
		h.db.close()
	}
	// A refusal before signing releases the owner's never-signed provisional claim, so the song can be retried.
	{
		const { h, event, wf } = setup('refused-owner')
		await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN })
		h.setTip(c.userExpirationLedger)
		await assert.rejects(wf.signTransaction(event as never), isTerminal(/user authorization has expired/))
		assert.deepEqual(h.locks(), [], 'never signed, never dispatched: deleted, not failed')
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'failed')
		assert.deepEqual(await lockStub(h).reserveMintPrefixes({ workflowId: 'retry', ids: [id], stage: 'admission', claimToken: TOKEN }), { ok: true })
		h.db.close()
	}
	// An on-chain FAILED receipt is definite: the lock is resolved failed and a new workflow may take over.
	{
		const { h, event, wf } = setup('receipt-failed')
		;(h.env.KALE_WORKER as unknown as { getTx: unknown }).getTx = async () => ({ status: 'FAILED', latestLedger: TIP + 2 })
		await assert.rejects(wf.run(event as never, createWorkflowStep(new Map()).step as never), isTerminal(/failed on-chain/))
		assert.equal(h.relayed.length, 1)
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'failed')
		assert.deepEqual(h.locks().map(({ workflow_id, status }) => [workflow_id, status]), [[event.instanceId, 'failed']])
		assert.deepEqual(await lockStub(h).reserveMintPrefixes({ workflowId: 'retry', ids: [id], stage: 'admission', claimToken: TOKEN }), { ok: true })
		h.db.close()
	}
	// An ambiguous relay outcome retains the dispatched claim as ambiguous: no other workflow may sign the song.
	{
		const { h, event, wf } = setup('relay-ambiguous')
		;(h.env.KALE_WORKER as unknown as { submitTransaction: unknown }).submitTransaction = async () => { throw new Error('relay connection reset') }
		await assert.rejects(wf.run(event as never, createWorkflowStep(new Map()).step as never), isTerminal(/outcome unknown/))
		assert.deepEqual(h.locks().map(({ workflow_id, status }) => [workflow_id, status]), [[event.instanceId, 'ambiguous']])
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'submitting', 'an ambiguous dispatch is never recorded failed')
		assert.equal((await lockStub(h).reserveMintPrefixes({ workflowId: 'retry', ids: [id], stage: 'admission', claimToken: TOKEN })).ok, false)
		assert.deepEqual(await lockStub(h).releaseMintPrefixes({ workflowId: event.instanceId, ids: [id], claimToken: TOKEN }), { released: 0 })
		h.db.close()
	}
})

test('signing: an enabled submit step refuses any unversioned (pre-WF-0) signing checkpoint and never relays it; a queued row fails durably (failed after instance.not_found), an unresolved receipt stays uncertain + H1; a completed submit still reconciles', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const checkpoints: unknown[] = [
		'legacy-blind-signed-xdr',
		c.xdr,
		{ version: 'wf0-v0', xdr: c.xdr },
		{ version: 'wf0-v1', xdr: '' },
		{ version: 'wf0-v1', xdr: c.xdr, signedBy: 'legacy' },
		{ xdr: c.xdr },
		[c.xdr],
		null,
	]
	for (const checkpoint of checkpoints) {
		const h = harness()
		h.tracksOf(c)
		const event = batchEvent(c, 'legacy-checkpoint')
		claim(h, event)
		const wf = new TxWorkflow({} as ExecutionContext, h.env)
		await assert.rejects(
			wf.run(event as never, createWorkflowStep(new Map([['sign transaction#1', checkpoint]])).step as never),
			isTerminal(/Unversioned signing checkpoint refused/),
			JSON.stringify(checkpoint),
		)
		assert.deepEqual(h.relayed, [], 'nothing relayed')
		assert.deepEqual(h.calls, [], 'no tip read or relay call')
		// Pass 10: the refusal is settled durably. The queued row records `failed`, which outlives the
		// instance: status stays `failed` after the Workflows API forgets it (instance.not_found).
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'failed', JSON.stringify(checkpoint))
		for (const lookup of [
			async () => ({ status: async () => ({ status: 'errored' }) }),
			async () => { throw new Error('instance.not_found') },
		]) {
			;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = lookup
			const status = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
			const { batches } = await json(status) as { batches: Array<Record<string, unknown>> }
			assert.deepEqual(batches, [{ workflowId: event.instanceId, ids: [id], phase: 'failed' }], JSON.stringify(checkpoint))
		}
		h.db.close()
	}

	// A legacy checkpoint over an unresolved receipt (`submitted` + H1, or `submitting`) is refused without
	// a relay and never downgraded: the row and its hash stay for reconciliation, reported `uncertain`.
	const H1 = 'cd'.repeat(32)
	for (const [phase, hash] of [['submitted', H1], ['submitting', null]] as const) {
		for (const lock of ['none', 'reserved'] as const) {
			const label = `${phase} / ${lock}`
			const h = harness()
			h.tracksOf(c)
			const event = batchEvent(c, `legacy-checkpoint-${phase}-${lock}`)
			claim(h, event)
			h.db.prepare('UPDATE MintBatchStatus SET Phase = ?, Tx_Hash = ? WHERE Workflow_Id = ?').run(phase, hash, event.instanceId)
			if (lock === 'reserved') {
				await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN })
			}
			const wf = new TxWorkflow({} as ExecutionContext, h.env)
			const run = createWorkflowStep(new Map([['sign transaction#1', 'legacy-blind-signed-xdr']]))
			await assert.rejects(wf.run(event as never, run.step as never), isTerminal(/Unversioned signing checkpoint refused/), label)
			assert.deepEqual(run.executed.map(({ name }) => name), ['record mint submit intent', 'submit transaction'], label)
			assert.deepEqual(h.relayed, [], `${label}: zero relays`)
			assert.deepEqual(h.calls, [], label)
			const row = h.batchRow(event.instanceId)!
			assert.deepEqual([row.Phase, row.Tx_Hash], [phase, hash], `${label}: the receipt is preserved`)
			for (const lookup of [
				async () => ({ status: async () => ({ status: 'errored' }) }),
				async () => { throw new Error('instance.not_found') },
			]) {
				;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = lookup
				const status = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
				const { batches } = await json(status) as { batches: Array<Record<string, unknown>> }
				assert.deepEqual(batches, [{ workflowId: event.instanceId, ids: [id], phase: 'uncertain', ...(hash ? { txHash: hash } : {}) }], label)
			}
			h.db.close()
		}
	}

	// A submit step that completed before the deploy keeps its checkpoint: confirmation and persistence run.
	const h = harness()
	h.tracksOf(c)
	const event = batchEvent(c, 'legacy-submitted')
	claim(h, event)
	const pair = deriveMintPair(id)!
	;(h.env.KALE_WORKER as unknown as { getTx: unknown }).getTx = async () => ({
		status: 'SUCCESS', latestLedger: TIP + 2, ledger: TIP + 2, returnValueXdr: nativeToScVal([pair.sac, pair.pool]).toXDR('base64'),
	})
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch
	try {
		const result = await new TxWorkflow({} as ExecutionContext, h.env).run(event as never, createWorkflowStep(new Map<string, unknown>([
			['sign transaction#1', 'legacy-blind-signed-xdr'],
			['submit transaction#1', { hash: 'cd'.repeat(32) }],
		])).step as never)
		assert.equal(result.hash, 'cd'.repeat(32))
	} finally {
		globalThis.fetch = originalFetch
	}
	assert.deepEqual(h.relayed, [])
	assert.equal(h.db.prepare('SELECT Mint_Token FROM Smols WHERE Id = ?').get(id)?.Mint_Token, pair.sac)
	assert.equal(h.batchRow(event.instanceId)?.Phase, 'persisted')
	h.db.close()
})

test('admission: visibility and creator come before any mint-status shortcut (private or creatorless minted songs never get 200, stale_batch or already_minted)', async () => {
	const h = harness()
	const single = mainnetSingle.tracks[0]
	const [a, b] = mainnetBatch2.tracks
	const pair = (id: string) => deriveMintPair(id)!

	h.track(single.id, { creator: single.creator, isPublic: 0, pair: pair(single.id) })
	const privateMinted = await h.send(`/mint/${single.id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
	assert.equal(privateMinted.status, 403)
	assert.deepEqual(await json(privateMinted), { error: 'mint_not_eligible', code: 'not_public', ids: [single.id] })
	h.db.prepare("UPDATE Smols SET Public = 1, Address = '' WHERE Id = ?").run(single.id)
	const creatorlessMinted = await h.send(`/mint/${single.id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
	assert.equal(creatorlessMinted.status, 400)
	assert.deepEqual(await json(creatorlessMinted), { error: 'mint_not_eligible', code: 'missing_creator', ids: [single.id] })

	// Every posted id private and minted: 403, not the 200 no-work answer.
	h.track(a.id, { creator: a.creator, isPublic: 0, pair: pair(a.id) })
	h.track(b.id, { creator: b.creator, isPublic: 0, pair: pair(b.id) })
	const allPrivate = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [a.id, b.id] }, FE_MINTER)
	assert.equal(allPrivate.status, 403)
	assert.deepEqual(await json(allPrivate), { error: 'mint_not_eligible', code: 'not_public', ids: [a.id, b.id] })
	// A private minted salt inside the carrier: 403, not stale_batch.
	h.db.prepare('UPDATE Smols SET Public = 1, Mint_Token = NULL, Mint_Amm = NULL WHERE Id = ?').run(b.id)
	const privateSalt = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [a.id, b.id] }, FE_MINTER)
	assert.equal(privateSalt.status, 403)
	assert.deepEqual(await json(privateSalt), { error: 'mint_not_eligible', code: 'not_public', ids: [a.id] })
	// A private (or creatorless) minted extra posted id outside the carrier: refused, never listed as skipped.
	h.db.prepare('UPDATE Smols SET Public = 1, Mint_Token = NULL, Mint_Amm = NULL WHERE Id = ?').run(a.id)
	h.db.prepare("UPDATE Smols SET Public = 0, Address = ? WHERE Id = ?").run(single.creator, single.id)
	const privateExtra = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [single.id, a.id, b.id] }, FE_MINTER)
	assert.equal(privateExtra.status, 403)
	assert.deepEqual(await json(privateExtra), { error: 'mint_not_eligible', code: 'not_public', ids: [single.id] })
	h.db.prepare("UPDATE Smols SET Public = 1, Address = '' WHERE Id = ?").run(single.id)
	const creatorlessExtra = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [single.id, a.id, b.id] }, FE_MINTER)
	assert.equal(creatorlessExtra.status, 400)
	assert.deepEqual(await json(creatorlessExtra), { error: 'mint_not_eligible', code: 'missing_creator', ids: [single.id] })

	assert.equal(h.creates.length, 0)
	assert.deepEqual(h.locks(), [])
	h.db.close()
})

test('strict SQL NULL: empty-string or half-populated mint columns are never treated as unminted (admission and signing)', async () => {
	const values: Array<[string | null, string | null]> = [['', null], [null, ''], ['', '']]
	const h = harness()
	h.tracksOf(mainnetSingle)
	const id = mainnetSingle.tracks[0].id
	for (const [token, amm] of values) {
		h.db.prepare('UPDATE Smols SET Mint_Token = ?, Mint_Amm = ? WHERE Id = ?').run(token, amm, id)
		const response = await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
		assert.equal(response.status, 409, JSON.stringify([token, amm]))
		assert.deepEqual(await json(response), { error: 'already_minted', ids: [id] })
	}
	assert.equal(h.creates.length, 0)
	h.db.close()

	const c = carrier('test/coin_it-split')
	for (const [token, amm] of values) {
		const signer = harness()
		signer.tracksOf(c)
		signer.env.SK = TEST_ISSUER.secret()
		signer.db.prepare('UPDATE Smols SET Mint_Token = ?, Mint_Amm = ? WHERE Id = ?').run(token, amm, c.tracks[0].id)
		const event = batchEvent(c, `strict-null-${token}-${amm}`)
		claim(signer, event)
		const Wf = testWorkflowClass()
		await assert.rejects(new Wf({} as ExecutionContext, signer.env).signTransaction(event as never), isTerminal(/already_minted/))
		assert.deepEqual(signer.calls, [])
		signer.db.close()
	}
})

test('admission: a mixed batch (posted ids include already-minted public songs; the carrier signs only the rest) is accepted', async () => {
	const h = harness()
	h.tracksOf(mainnetBatch2)
	const [a, b] = mainnetBatch2.tracks.map(({ id }) => id)
	const extra = mainnetSingle.tracks[0]
	h.track(extra.id, { creator: extra.creator, pair: deriveMintPair(extra.id)! })

	// A carrier salt that was not posted is refused before any D1 read.
	const before = h.stats.statements.length
	const unposted = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [a, extra.id] }, FE_MINTER)
	assert.equal(unposted.status, 400)
	assert.deepEqual(await json(unposted), { error: 'mint_tx_rejected', code: 'ids_mismatch' })
	assert.equal(h.stats.statements.length, before)

	const mixed = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [b, extra.id, a] }, FE_MINTER)
	assert.equal(mixed.status, 202)
	const body = await json(mixed) as { workflowId: string }
	assert.deepEqual(body, { workflowId: body.workflowId, acceptedIds: [b, a], skipped: { alreadyMinted: [extra.id] } })
	assert.equal(h.creates.length, 1)
	assert.deepEqual(h.creates[0].params.ids, [b, extra.id, a])
	assert.deepEqual(h.creates[0].params.mintableIds, [a, b], 'the workflow signs exactly the carrier salts')
	assert.deepEqual(Object.keys(h.creates[0].params.ownerSubsById ?? {}).sort(), [a, b].sort())
	// The same carrier posted without the minted extra dedupes to the same workflow.
	const plain = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [a, b] }, FE_MINTER)
	assert.equal(plain.status, 202)
	assert.deepEqual(await json(plain), { workflowId: body.workflowId, acceptedIds: [a, b], skipped: { alreadyMinted: [] } })
	assert.equal(h.creates.length, 1)

	// An unminted posted id outside the carrier is a mismatch.
	const unsigned = hash(Buffer.from('mixed-unsigned')).toString('hex')
	h.track(unsigned, { creator: OTHER_WALLET })
	const missingSalt = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [a, b, unsigned] }, FE_MINTER)
	assert.equal(missingSalt.status, 400)
	assert.deepEqual(await json(missingSalt), { error: 'mint_tx_rejected', code: 'ids_mismatch' })
	// A minted salt inside the carrier is stale, whatever else is posted.
	h.db.prepare('UPDATE Smols SET Mint_Token = ?, Mint_Amm = ? WHERE Id = ?').run(deriveMintPair(a)!.sac, deriveMintPair(a)!.pool, a)
	const stale = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [extra.id, a, b] }, FE_MINTER)
	assert.equal(stale.status, 409)
	assert.deepEqual(await json(stale), { error: 'stale_batch', alreadyMinted: [extra.id, a] })
	// Everything posted is minted: 200 no-work.
	h.db.prepare('UPDATE Smols SET Mint_Token = ?, Mint_Amm = ? WHERE Id = ?').run(deriveMintPair(b)!.sac, deriveMintPair(b)!.pool, b)
	const done = await h.send('/mint', { xdr: mainnetBatch2.xdr, ids: [a, b, extra.id] }, FE_MINTER)
	assert.equal(done.status, 200)
	assert.deepEqual(await json(done), { workflowId: null, acceptedIds: [], skipped: { alreadyMinted: [a, b, extra.id] } })
	assert.equal(h.creates.length, 1)
	h.db.close()

	// A posted minted extra that shares a carrier salt's 12-hex prefix still blocks that salt.
	const twin = harness()
	twin.tracksOf(mainnetBatch2)
	const holder = `${a.slice(0, 12)}${'f'.repeat(52)}`
	twin.track(holder, { creator: OTHER_WALLET, pair: { sac: 'C', pool: 'C' } })
	const shared = await twin.send('/mint', { xdr: mainnetBatch2.xdr, ids: [holder, a, b] }, FE_MINTER)
	assert.equal(shared.status, 409)
	assert.deepEqual(await json(shared), { error: 'prefix_conflict', code: 'prefix_minted' })
	assert.equal(twin.creates.length, 0)
	twin.db.close()
})

test('signing: a D1 or lock-store outage while recording a definite refusal never turns it into a retryable failure', async () => {
	const c = carrier('test/coin_it-split')
	const Wf = testWorkflowClass()
	const setup = (instanceId: string, enabled?: string) => {
		const h = harness({ enabled })
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		const event = batchEvent(c, instanceId)
		claim(h, event)
		// Only the `failed` status write breaks; the lock store refuses every resolution.
		h.hooks.onStatement = (sql, args) => {
			if (sql.includes('UPDATE MintBatchStatus') && args[0] === 'failed') throw new Error('D1_ERROR: network connection lost')
		}
		const quota = h.env.USER_QUOTA
		;(h.env as unknown as { USER_QUOTA: unknown }).USER_QUOTA = {
			idFromName: (name: string) => quota.idFromName(name),
			get: (doId: DurableObjectId) => {
				const stub = quota.get(doId)
				return {
					reserveMintPrefixes: (params: never) => stub.reserveMintPrefixes(params),
					mintAttemptState: (params: never) => stub.mintAttemptState(params),
					releaseMintPrefixes: async () => { throw new Error('DO overloaded') },
					resolveMintPrefixes: async () => { throw new Error('DO overloaded') },
				}
			},
		}
		return { h, event, wf: new Wf({} as ExecutionContext, h.env) }
	}
	const signed = { version: 'wf0-v1', xdr: c.xdr }

	{
		const { h, event, wf } = setup('outage-paused-sign', 'false')
		await assert.rejects(wf.signTransaction(event as never), isTerminal(/Mint signing is paused/))
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'queued', 'the status write failed; the refusal still stands')
		h.db.close()
	}
	{
		const { h, event, wf } = setup('outage-validation')
		h.db.prepare('UPDATE Smols SET Public = 0 WHERE Id = ?').run(c.tracks[0].id)
		await assert.rejects(wf.signTransaction(event as never), isTerminal(/not_public/))
		assert.deepEqual(h.calls, [])
		h.db.close()
	}
	{
		const { h, event, wf } = setup('outage-paused-submit', 'false')
		await assert.rejects(wf.run(event as never, createWorkflowStep(new Map<string, unknown>([['sign transaction#1', signed]])).step as never),
			isTerminal(/Mint signing is paused/))
		assert.deepEqual(h.relayed, [])
		h.db.close()
	}
	{
		// A confirmed FAILED receipt is not a refusal: its lock settlement must happen, so a lock-store
		// outage fails only the (retryable) settlement step, and D1 is never recorded failed before it.
		const { h, event, wf } = setup('outage-failed-receipt')
		;(h.env.KALE_WORKER as unknown as { getTx: unknown }).getTx = async () => ({ status: 'FAILED', latestLedger: TIP + 2 })
		const run = createWorkflowStep(new Map<string, unknown>([
			['sign transaction#1', signed],
			['submit transaction#1', { hash: 'ef'.repeat(32) }],
		]))
		await assert.rejects(wf.run(event as never, run.step as never), (e: unknown) => e instanceof Error && e.name !== 'NonRetryableError' && /DO overloaded/.test(e.message))
		assert.deepEqual(run.executed.map(({ name }) => name), ['record mint submit intent', 'record submitted mint', 'confirm transaction', 'settle failed mint locks'])
		assert.deepEqual(h.relayed, [])
		assert.notEqual(h.batchRow(event.instanceId)?.Phase, 'failed')
		h.db.close()
	}
})

test('historical deleted mint: the A1 prefix c9a369e2aef3 is refused at admission and at signing, even for a re-created row', async () => {
	const deleted = 'c9a369e2aef338077c788959598a0c13b78b948514c068b9fdcf73576936b9d4'
	assert.deepEqual([...HISTORICAL_DELETED_MINT_PREFIXES], [deleted.slice(0, 12)])
	assert.ok(Object.isFrozen(HISTORICAL_DELETED_MINT_PREFIXES))
	const twin = `${deleted.slice(0, 12)}${'5'.repeat(52)}`
	for (const id of [deleted, twin]) {
		const h = harness()
		const track = { id, creator: OTHER_WALLET }
		h.track(id, { creator: OTHER_WALLET })
		const single = await h.send(`/mint/${id}`, { xdr: await feCoinIt(track, 71n) }, FE_MINTER)
		assert.equal(single.status, 409)
		assert.deepEqual(await json(single), { error: 'prefix_conflict', code: 'prefix_minted' })
		const companion = hash(Buffer.from(`historical-companion-${id}`)).toString('hex')
		h.track(companion, { creator: OTHER_WALLET })
		const batch = await h.send('/mint', { xdr: await feCoinThem([{ id: companion, creator: OTHER_WALLET }, track], 73n), ids: [companion, id] }, FE_MINTER)
		assert.equal(batch.status, 409)
		assert.deepEqual(await json(batch), { error: 'prefix_conflict', code: 'prefix_minted' })
		assert.equal(h.creates.length, 0)
		assert.deepEqual(h.locks(), [])

		// The signer refuses it too (an instance admitted by any earlier revision).
		h.env.SK = TEST_ISSUER.secret()
		const event = {
			instanceId: `historical-${id.slice(-4)}`,
			timestamp: new Date(),
			payload: { type: 'mint' as const, xdr: await feCoinIt(track, 75n, TEST_IDENTITY), entropy: id, sub: FE_MINTER, ownerSub: OTHER_WALLET, trackStatus: true },
		}
		claim(h, event as never)
		const Wf = testWorkflowClass()
		await assert.rejects(new Wf({} as ExecutionContext, h.env).signTransaction(event as never), isTerminal(/prefix_minted/))
		assert.deepEqual(h.calls, [])
		assert.deepEqual(h.locks(), [])
		h.db.close()
	}
})

// ---------------------------------------------------------------------------
// Pass 3: durable owner-checked dispatch marker, creation lease, never-signed release,
// SQLite v6 -> v7 upgrade
// ---------------------------------------------------------------------------

const lockState = (h: ReturnType<typeof harness>) => h.locks().map(({ workflow_id, status }) => [workflow_id, status])

/** Counts issuer signatures: `authorizeEntry` signs with `Keypair#sign`. */
function countIssuerSignatures(issuer: string) {
	const original = Keypair.prototype.sign
	let count = 0
	Keypair.prototype.sign = function sign(this: Keypair, data: Buffer) {
		if (this.publicKey() === issuer) count += 1
		return original.call(this, data)
	}
	return { get count() { return count }, restore: () => { Keypair.prototype.sign = original } }
}

type HarnessStep = ReturnType<typeof createWorkflowStep>['step']
/**
 * The engine runs `name`'s callback (every side effect, including the relay call, happens) and then
 * dies before checkpointing its result, so the next execution replays that callback.
 */
function loseCheckpointOf(name: string, step: HarnessStep): HarnessStep {
	return {
		...step,
		do: async (stepName: string, config: unknown, fn?: unknown) => {
			if (stepName === name) {
				await (fn as () => Promise<unknown>)()
				throw new Error(`engine crashed: ${name} checkpoint lost`)
			}
			return await step.do(stepName, config, fn)
		},
	} as HarnessStep
}

/** Starts a mint workflow whose relay accepted the transaction but whose submit checkpoint was lost. */
async function dispatchThenLoseCheckpoint(instanceId: string) {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const h = harness()
	h.tracksOf(c)
	h.env.SK = TEST_ISSUER.secret()
	const event = batchEvent(c, instanceId)
	claim(h, event)
	// The provisional claim the admission route wrote for this workflow.
	await lockStub(h).reserveMintPrefixes({ workflowId: instanceId, ids: [id], stage: 'admission', claimToken: TOKEN })
	const signatures = countIssuerSignatures(TEST_IDENTITY.issuer)
	const wf = new (testWorkflowClass())({} as ExecutionContext, h.env)
	const cache = new Map<string, unknown>()
	await assert.rejects(wf.run(event as never, loseCheckpointOf('submit transaction', createWorkflowStep(cache).step) as never), /checkpoint lost/)
	assert.equal(h.relayed.length, 1, 'the relay accepted one submission')
	assert.equal(signatures.count, 1, 'one issuer signature')
	assert.deepEqual(lockState(h), [[instanceId, 'dispatched']], 'the marker was durable before the relay call')
	assert.equal(h.batchRow(instanceId)?.Phase, 'submitting')
	assert.equal(cache.has('submit transaction#1'), false)
	return { c, id, h, event, wf, cache, signatures }
}

test('P1 dispatch marker (a): dispatch started -> kill switch flipped to "false" -> submit replays: lock stays owned (ambiguous, never failed), competing workflows are refused, zero second issuer authorization', async () => {
	for (const replaySwitch of ['false', 'true']) {
		const { c, id, h, event, wf, cache, signatures } = await dispatchThenLoseCheckpoint(`dispatch-replay-${replaySwitch}`)
		try {
			// The operator pauses minting; Workflows replays the submit callback (sign and intent are cached).
			h.env.MINT_SIGNING_ENABLED = replaySwitch
			const replay = createWorkflowStep(cache)
			await assert.rejects(wf.run(event as never, replay.step as never), isTerminal(/dispatch outcome uncertain/))
			assert.deepEqual(replay.executed.map(({ name }) => name), ['submit transaction'], 'only the submit callback re-ran')
			assert.equal(h.relayed.length, 1, 'never relayed again')
			assert.equal(signatures.count, 1, 'never signed again')
			assert.deepEqual(lockState(h), [[event.instanceId, 'ambiguous']], 'retained as ambiguous, never failed')
			assert.equal(h.batchRow(event.instanceId)?.Phase, 'submitting', 'never recorded failed')
			// Every later replay, paused or not, is refused the same way.
			for (const enabled of ['false', 'true', 'false']) {
				h.env.MINT_SIGNING_ENABLED = enabled
				await assert.rejects(wf.run(event as never, createWorkflowStep(cache).step as never), isTerminal(/dispatch outcome uncertain/))
			}
			assert.deepEqual(lockState(h), [[event.instanceId, 'ambiguous']])
			assert.equal(h.batchRow(event.instanceId)?.Phase, 'submitting')
			// Nothing releases it, not even the acquiring admission's token after its lease.
			assert.deepEqual(await lockStub(h).releaseMintPrefixes({ workflowId: event.instanceId, ids: [id], claimToken: TOKEN }), { released: 0 })
			assert.deepEqual(await lockStub(h).releaseMintPrefixes({
				workflowId: event.instanceId, ids: [id], claimToken: TOKEN, expiredLeaseOnly: true, nowMs: Date.now() + AFTER_LEASE,
				observedLeases: [{ id, leaseUntilMs: null, leaseVersion: 1 }],
			}), { released: 0 })
			// The status API reports the errored instance as uncertain, not failed.
			;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = async () => ({ status: async () => ({ status: 'errored' }) })
			const status = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
			assert.equal((await json(status) as { batches: Array<{ phase: string }> }).batches[0].phase, 'uncertain')

			// A competing carrier for the same song, with minting open again and the owner errored.
			h.env.MINT_SIGNING_ENABLED = 'true'
			const competing = await later(AFTER_LEASE, async () => h.send(`/mint/${id}`, { xdr: await feCoinIt(c.tracks[0], 81n) }, FE_MINTER))
			assert.equal(competing.status, 409)
			assert.deepEqual(await json(competing), { error: 'mint_in_progress', ids: [id] })
			assert.equal(h.creates.length, 0)
			// A competing workflow instance (admitted by any revision) reaches its signer: refused before signing.
			const rival = batchEvent(c, `rival-${replaySwitch}`)
			claim(h, rival)
			const rivalWf = new (testWorkflowClass())({} as ExecutionContext, h.env)
			await assert.rejects(rivalWf.signTransaction(rival as never), isTerminal(/mint_in_progress/))
			await assert.rejects(rivalWf.run(rival as never, createWorkflowStep(new Map()).step as never), isTerminal(/mint_in_progress/))
			assert.equal(signatures.count, 1, 'zero second issuer authorization')
			assert.equal(h.relayed.length, 1)
			assert.deepEqual(lockState(h), [[event.instanceId, 'ambiguous']], 'the original owner keeps it')
		} finally {
			signatures.restore()
			h.db.close()
		}
	}
})

test('P1 dispatch marker (b): dispatch started -> full workflow restart re-enters the sign step: re-signing is refused and the lock is retained', async () => {
	for (const restartSwitch of ['true', 'false']) {
		const { id, h, event, wf, signatures } = await dispatchThenLoseCheckpoint(`dispatch-restart-${restartSwitch}`)
		try {
			// A full restart discards every step result and runs `sign transaction` again under the same owner.
			h.env.MINT_SIGNING_ENABLED = restartSwitch
			const restart = createWorkflowStep(new Map())
			await assert.rejects(wf.run(event as never, restart.step as never), isTerminal(/dispatch outcome uncertain/))
			assert.deepEqual(restart.executed.map(({ name }) => name), ['sign transaction'])
			assert.equal(signatures.count, 1, 'refuses re-signing')
			assert.equal(h.relayed.length, 1)
			assert.deepEqual(lockState(h), [[event.instanceId, 'ambiguous']])
			assert.equal(h.batchRow(event.instanceId)?.Phase, 'submitting', 'never recorded failed')
			// Direct re-entry too, and again after the switch flips.
			for (const enabled of ['true', 'false']) {
				h.env.MINT_SIGNING_ENABLED = enabled
				await assert.rejects(wf.signTransaction(event as never), isTerminal(/dispatch outcome uncertain/))
			}
			// Even when D1 changes under it (a refusal that would otherwise be definite), the claim is retained:
			// the unresolved `submitting` receipt refuses a replacement before validation even runs.
			h.env.MINT_SIGNING_ENABLED = 'true'
			h.db.prepare('UPDATE Smols SET Public = 0 WHERE Id = ?').run(id)
			await assert.rejects(wf.signTransaction(event as never), isTerminal(/dispatch outcome uncertain.*batch already submitting/))
			assert.equal(signatures.count, 1)
			assert.deepEqual(lockState(h), [[event.instanceId, 'ambiguous']])
			assert.equal(h.batchRow(event.instanceId)?.Phase, 'submitting')
		} finally {
			signatures.restore()
			h.db.close()
		}
	}

	// A completed submit whose confirmation never settles, then a full restart: the same refusal.
	const c = carrier('test/coin_them-2')
	const h = harness()
	h.tracksOf(c)
	h.env.SK = TEST_ISSUER.secret()
	const event = batchEvent(c, 'confirm-then-restart')
	claim(h, event)
	;(h.env.KALE_WORKER as unknown as { getTx: unknown }).getTx = async () => { throw new Error('rpc down') }
	const signatures = countIssuerSignatures(TEST_IDENTITY.issuer)
	try {
		const wf = new (testWorkflowClass())({} as ExecutionContext, h.env)
		await assert.rejects(wf.run(event as never, createWorkflowStep(new Map()).step as never), /receipt lookup unavailable/)
		assert.deepEqual(lockState(h), c.tracks.map(() => [event.instanceId, 'dispatched']))
		await assert.rejects(wf.run(event as never, createWorkflowStep(new Map()).step as never), isTerminal(/dispatch outcome uncertain/))
		assert.equal(signatures.count, 1)
		assert.equal(h.relayed.length, 1)
		assert.deepEqual(lockState(h), c.tracks.map(() => [event.instanceId, 'ambiguous']))
	} finally {
		signatures.restore()
		h.db.close()
	}
})

test('P1 dispatch marker: a never-dispatched paused submit is still a definite failure; a marker the workflow does not own, or cannot write, relays nothing', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const checkpoint = () => new Map<string, unknown>([['sign transaction#1', { version: 'wf0-v1', xdr: c.xdr }]])
	// Signed, claimed for signing, never dispatched, then paused: `failed`, so the song can be retried.
	{
		const h = harness({ enabled: 'false' })
		h.tracksOf(c)
		const event = batchEvent(c, 'paused-before-dispatch')
		claim(h, event)
		await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'signing' })
		await assert.rejects(new TxWorkflow({} as ExecutionContext, h.env).run(event as never, createWorkflowStep(checkpoint()).step as never),
			isTerminal(/^Mint signing is paused$/))
		assert.deepEqual(lockState(h), [[event.instanceId, 'failed']])
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'failed')
		assert.deepEqual(h.relayed, [])
		h.db.close()
	}
	// Enabled, but the workflow's claim was never moved to `signing` (or belongs to another workflow).
	for (const owner of ['self-reserved', 'other']) {
		const h = harness()
		h.tracksOf(c)
		const event = batchEvent(c, 'marker-not-owned')
		claim(h, event)
		await lockStub(h).reserveMintPrefixes({ workflowId: owner === 'other' ? 'other-owner' : event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN })
		await assert.rejects(new TxWorkflow({} as ExecutionContext, h.env).run(event as never, createWorkflowStep(checkpoint()).step as never),
			isTerminal(/does not hold its signing claim/))
		assert.deepEqual(h.relayed, [])
		assert.deepEqual(lockState(h), owner === 'other' ? [['other-owner', 'reserved']] : [], owner)
		h.db.close()
	}
	// The lock store fails while writing the marker: nothing is relayed and nothing is recorded failed.
	{
		const h = harness()
		h.tracksOf(c)
		const event = batchEvent(c, 'marker-unavailable')
		claim(h, event)
		await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'signing' })
		const quota = h.env.USER_QUOTA
		;(h.env as unknown as { USER_QUOTA: unknown }).USER_QUOTA = {
			idFromName: (name: string) => quota.idFromName(name),
			get: (doId: DurableObjectId) => ({
				mintAttemptState: (params: never) => quota.get(doId).mintAttemptState(params),
				markMintDispatched: async () => { throw new Error('DO overloaded') },
				resolveMintPrefixes: async () => { throw new Error('DO overloaded') },
			}),
		}
		await assert.rejects(new TxWorkflow({} as ExecutionContext, h.env).run(event as never, createWorkflowStep(checkpoint()).step as never),
			isTerminal(/marker unavailable/))
		assert.deepEqual(h.relayed, [])
		;(h.env as unknown as { USER_QUOTA: unknown }).USER_QUOTA = quota
		assert.deepEqual(lockState(h), [[event.instanceId, 'signing']], 'retained (never released) while the state is unknown')
		assert.equal(h.batchRow(event.instanceId)?.Phase, 'submitting')
		h.db.close()
	}
})

test('P2 creation lease: a competing admission while the first is still creating its workflow gets 409 and never displaces it; a losing admission\'s cleanup never deletes another admission\'s claim', async () => {
	const h = harness()
	h.tracksOf(mainnetSingle)
	const id = mainnetSingle.tracks[0].id
	const workflows = h.env.TX_WORKFLOW as unknown as {
		create: (arg: { id: string; params: WorkflowTxParams }) => Promise<unknown>
		get: (id: string) => Promise<unknown>
	}
	const create = workflows.create
	let openGate!: () => void
	const gate = new Promise<void>((resolve) => { openGate = resolve })
	const creating: string[] = []
	let failNextCreate = false
	workflows.create = async (arg) => {
		if (failNextCreate) {
			failNextCreate = false
			throw new Error('workflow service unavailable')
		}
		creating.push(arg.id)
		// Only admission A's creation is held open; any later creation proceeds immediately.
		if (creating.length === 1) await gate
		return await create(arg)
	}
	// An instance that has not been created yet is "not found".
	workflows.get = async (instanceId: string) => {
		if (!h.creates.some((entry) => entry.id === instanceId)) throw new Error('instance.not_found')
		return { status: async () => ({ status: 'queued' }) }
	}

	// Admission A reserves the song and is now creating its Workflow instance.
	const first = h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
	// A failed assertion below must not leave A blocked forever.
	try {
		for (let i = 0; i < 500 && !creating.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 2))
		assert.equal(creating.length, 1, 'admission A is inside TX_WORKFLOW.create')
		const [ownerId] = creating
		const owned = () => h.quota.instances.get(MINT_PREFIX_LOCK_OBJECT)!.db
			.prepare('SELECT workflow_id, status, claim_token FROM mint_prefix_locks').all().map((row) => ({ ...row }))
		const [{ claim_token: ownerToken }] = owned() as Array<{ claim_token: string }>
		assert.deepEqual(owned(), [{ workflow_id: ownerId, status: 'reserved', claim_token: ownerToken }])

		// Admission C posts the identical carrier (same workflow id), joins A's claim, then fails to create:
		// its cleanup carries C's own token and cannot drop the claim A acquired.
		failNextCreate = true
		const joined = await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
		assert.equal(joined.status, 503)
		assert.deepEqual(owned(), [{ workflow_id: ownerId, status: 'reserved', claim_token: ownerToken }], 'A keeps its claim')

		// Admission B posts a competing carrier: A's instance is "not found" because it is still being
		// created, but the creation lease protects it. B gets 409 and nothing is released.
		const competing = await h.send(`/mint/${id}`, { xdr: await feCoinIt(mainnetSingle.tracks[0], 91n) }, FE_MINTER)
		assert.equal(competing.status, 409)
		assert.deepEqual(await json(competing), { error: 'mint_in_progress', ids: [id] })
		assert.deepEqual(owned(), [{ workflow_id: ownerId, status: 'reserved', claim_token: ownerToken }], 'never displaced')
	} finally {
		// A finishes creating its instance.
		openGate()
	}
	// One 202, one workflow, one owner.
	const firstResponse = await first
	const ownerId = creating[0]
	assert.equal(firstResponse.status, 202)
	assert.deepEqual(await json(firstResponse), { workflowId: ownerId })
	assert.deepEqual(creating, [ownerId], 'no competing workflow was ever created')
	assert.deepEqual(h.creates.map((entry) => entry.id), [ownerId])
	assert.deepEqual(lockState(h), [[ownerId, 'reserved']])
	// After the lease, a live owner still keeps it.
	const afterLease = await later(AFTER_LEASE, async () => h.send(`/mint/${id}`, { xdr: await feCoinIt(mainnetSingle.tracks[0], 93n) }, FE_MINTER))
	assert.equal(afterLease.status, 409)
	assert.deepEqual(lockState(h), [[ownerId, 'reserved']])
	h.db.close()

	// An admission that died between reserving and creating (its instance never appears) is reclaimed,
	// but only after the lease and only by the exact token it observed.
	const h2 = harness()
	h2.tracksOf(mainnetSingle)
	const created = (h2.env.TX_WORKFLOW as unknown as typeof workflows)
	created.get = async (instanceId: string) => {
		if (!h2.creates.some((entry) => entry.id === instanceId)) throw new Error('instance.not_found')
		return { status: async () => ({ status: 'queued' }) }
	}
	await lockStub(h2).reserveMintPrefixes({ workflowId: 'mint-orphaned-admission', ids: [id], stage: 'admission', claimToken: TOKEN })
	const inLease = await h2.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
	assert.equal(inLease.status, 409)
	assert.deepEqual(lockState(h2), [['mint-orphaned-admission', 'reserved']])
	const reclaimed = await later(AFTER_LEASE, () => h2.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER))
	assert.equal(reclaimed.status, 202)
	const { workflowId: takeover } = await json(reclaimed) as { workflowId: string }
	assert.deepEqual(lockState(h2), [[takeover, 'reserved']])
	h2.db.close()
})

test('P2 never-signed refusal: a provisional claim refused before signing is deleted, so a different song sharing its 12-hex prefix can be minted', async () => {
	const c = carrier('test/coin_it-split')
	assert.equal(c.sub, FE_MINTER)
	const song = c.tracks[0]
	const twin = { id: `${song.id.slice(0, 12)}${song.id.at(12) === 'd' ? 'e' : 'd'}${'d'.repeat(51)}`, creator: OTHER_WALLET }
	assert.notEqual(twin.id, song.id)
	const refusals: Array<[string, (h: ReturnType<typeof harness>) => void, RegExp]> = [
		['kill switch closed', (h) => { h.env.MINT_SIGNING_ENABLED = 'false' }, /^Mint signing is paused$/],
		['made private', (h) => { h.db.prepare('UPDATE Smols SET Public = 0 WHERE Id = ?').run(song.id) }, /not_public/],
		['wallet authorization expired', (h) => { h.setTip(c.userExpirationLedger) }, /user authorization has expired/],
	]
	for (const [name, refuse, pattern] of refusals) {
		const h = harness()
		h.tracksOf(c)
		h.track(twin.id, { creator: OTHER_WALLET })
		h.env.SK = TEST_ISSUER.secret()
		// The song is admitted over HTTP, so its prefix is provisionally claimed by its workflow.
		const admitted = await h.send(`/mint/${song.id}`, { xdr: await feCoinIt(song, 101n) }, FE_MINTER)
		assert.equal(admitted.status, 202, name)
		const { workflowId } = await json(admitted) as { workflowId: string }
		assert.deepEqual(lockState(h), [[workflowId, 'reserved']])
		const blocked = await h.send(`/mint/${twin.id}`, { xdr: await feCoinIt(twin, 103n) }, FE_MINTER)
		assert.equal(blocked.status, 409, name)
		assert.deepEqual(await json(blocked), { error: 'prefix_conflict', code: 'prefix_reserved' })

		// That workflow refuses definitely before signing (never signed, never dispatched).
		refuse(h)
		const event = batchEvent(c, workflowId)
		await assert.rejects(new (testWorkflowClass())({} as ExecutionContext, h.env).signTransaction(event as never), isTerminal(pattern), name)
		assert.deepEqual(h.locks(), [], `${name}: the provisional row is deleted, not marked failed`)
		assert.equal(h.batchRow(workflowId)?.Phase, 'failed', name)

		// The different song sharing the prefix is no longer blocked.
		h.env.MINT_SIGNING_ENABLED = 'true'
		const twinAdmitted = await h.send(`/mint/${twin.id}`, { xdr: await feCoinIt(twin, 105n) }, FE_MINTER)
		assert.equal(twinAdmitted.status, 202, name)
		const { workflowId: twinWorkflow } = await json(twinAdmitted) as { workflowId: string }
		assert.deepEqual(h.locks().map(({ smol_id, workflow_id, status }) => [smol_id, workflow_id, status]), [[twin.id, twinWorkflow, 'reserved']])
		h.db.close()
	}
})

// ---------------------------------------------------------------------------
// Pass 4: the acquiring admission never releases a joined or possibly-queued claim; an expired,
// never-signed holder of a shared prefix is recoverable by a different song; a confirmed on-chain
// failure settles the lock in its own retryable step before D1 records failed
// ---------------------------------------------------------------------------

type WorkflowsStub = {
	create: (arg: { id: string; params: WorkflowTxParams }) => Promise<unknown>
	get: (id: string) => Promise<{ status: () => Promise<{ status: string }> }>
}
const workflowsOf = (h: ReturnType<typeof harness>) => h.env.TX_WORKFLOW as unknown as WorkflowsStub
const lockRows = (h: ReturnType<typeof harness>) => h.locks().map(({ smol_id, workflow_id, status }) => [smol_id, workflow_id, status])
async function until(condition: () => boolean, what: string) {
	for (let i = 0; i < 500 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 2))
	assert.ok(condition(), what)
}

test('P2 pass 4: admission 1 reserves -> identical admission 2 joins and gets 202 (workflow queued) -> admission 1 hits a D1 or creation error: the claim is retained and a different carrier is still rejected', async () => {
	const id = mainnetSingle.tracks[0].id
	for (const failure of ['d1', 'create'] as const) {
		// `lyingGet`: the Workflows API wrongly reports the just-queued instance as not found, so only the
		// lock store's join record stands between admission 1's cleanup and the queued workflow.
		for (const lyingGet of [false, true]) {
			const label = `${failure}${lyingGet ? ' (get reports not_found)' : ''}`
			const h = harness()
			h.tracksOf(mainnetSingle)
			const workflows = workflowsOf(h)
			const create = workflows.create
			const realGet = workflows.get
			let release!: () => void
			const gate = new Promise<void>((resolve) => { release = resolve })
			let held = false
			if (failure === 'd1') {
				// Admission 1's claim-row insert is held open, then fails.
				h.hooks.onStatement = async (sql) => {
					if (!sql.includes('INSERT INTO MintBatchStatus') || held) return
					held = true
					await gate
					throw new Error('D1_ERROR: network connection lost')
				}
			} else {
				// Admission 1's creation call is held open, then fails; admission 2 creates normally.
				workflows.create = async (arg) => {
					if (held) return await create(arg)
					held = true
					await gate
					throw new Error('workflow service unavailable')
				}
			}
			if (lyingGet) workflows.get = async () => { throw new Error('instance.not_found') }

			const first = h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
			let firstResponse: Response
			try {
				await until(() => held, `${label}: admission 1 reserved and is inside its ${failure} call`)
				const [{ workflow_id: workflowId }] = h.locks()
				// Admission 2: the identical carrier joins the claim, queues the workflow and answers 202.
				const joined = await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
				assert.equal(joined.status, 202, label)
				assert.deepEqual(await json(joined), { workflowId })
				assert.deepEqual(h.creates.map((entry) => entry.id), [workflowId], `${label}: the workflow is queued`)
			} finally {
				release()
				firstResponse = await first
			}
			const workflowId = h.creates[0].id
			// Admission 1 fails...
			assert.equal(firstResponse.status, 503, label)
			// ...but never deletes the claim the queued workflow depends on.
			assert.deepEqual(lockRows(h), [[id, workflowId, 'reserved']], `${label}: reservation retained`)
			assert.equal(h.batchRow(workflowId)?.Phase, 'queued', label)

			// A different carrier for the same song is rejected, inside the lease and after it (the owner is queued).
			workflows.get = realGet
			const competing = await h.send(`/mint/${id}`, { xdr: await feCoinIt(mainnetSingle.tracks[0], 201n) }, FE_MINTER)
			assert.equal(competing.status, 409, label)
			assert.deepEqual(await json(competing), { error: 'mint_in_progress', ids: [id] })
			const afterLease = await later(AFTER_LEASE, async () => h.send(`/mint/${id}`, { xdr: await feCoinIt(mainnetSingle.tracks[0], 203n) }, FE_MINTER))
			assert.equal(afterLease.status, 409, label)
			assert.deepEqual(h.creates.map((entry) => entry.id), [workflowId], `${label}: no competing workflow`)
			// The queued workflow still owns the song when it reaches its signer; a rival never does.
			assert.equal((await lockStub(h).reserveMintPrefixes({ workflowId: 'mint-rival', ids: [id], stage: 'signing' })).ok, false)
			assert.deepEqual(await lockStub(h).reserveMintPrefixes({ workflowId, ids: [id], stage: 'signing' }), { ok: true })
			assert.deepEqual(lockRows(h), [[id, workflowId, 'signing']])
			h.db.close()
		}
	}

	// Lock store: a join after the original lease ran out renews it AND bumps its generation. A recovery
	// whose absence check observed the original lease (before the join) can never release the claim:
	// not inside the renewed lease, and not after the renewed lease has also run out. Only a recovery
	// that observed the renewed lease (and so checked the workflow afresh, after the join) can.
	const h = harness()
	const stub = lockStub(h)
	const T0 = 1_800_000_000_000
	assert.deepEqual(await stub.reserveMintPrefixes({ workflowId: 'w-join', ids: [id], stage: 'admission', claimToken: TOKEN, nowMs: T0 }), { ok: true })
	const conflictLease = async (nowMs: number) => {
		const result = await stub.reserveMintPrefixes({ workflowId: 'w-rival', ids: [id], stage: 'admission', claimToken: 'rival-admission-token', nowMs })
		assert.equal(result.ok, false)
		const [{ leaseUntilMs, leaseVersion }] = (result as { conflicts: Array<{ leaseUntilMs: number | null; leaseVersion: number }> }).conflicts
		return [{ id, leaseUntilMs, leaseVersion }]
	}
	// The pre-join observation (expired original lease, generation 1)...
	const stale = await conflictLease(T0 + AFTER_LEASE)
	assert.deepEqual(stale, [{ id, leaseUntilMs: T0 + MINT_ADMISSION_LEASE_MS, leaseVersion: 1 }])
	// ...then the join renews the lease (generation 2).
	const RENEWED = T0 + AFTER_LEASE + MINT_ADMISSION_LEASE_MS
	assert.deepEqual(await stub.reserveMintPrefixes({ workflowId: 'w-join', ids: [id], stage: 'admission', claimToken: 'late-joining-admission', nowMs: T0 + AFTER_LEASE }), { ok: true })
	const recover = (nowMs: number, observedLeases: Array<{ id: string; leaseUntilMs: number | null; leaseVersion: number }>) =>
		stub.releaseMintPrefixes({ workflowId: 'w-join', ids: [id], claimToken: TOKEN, expiredLeaseOnly: true, observedLeases, nowMs })
	assert.deepEqual(await recover(T0 + AFTER_LEASE + 1_000, stale), { released: 0 }, 'renewed by the join')
	assert.deepEqual(await stub.releaseMintPrefixes({ workflowId: 'w-join', ids: [id], claimToken: TOKEN, nowMs: T0 + AFTER_LEASE + 1_000 }), { released: 0 }, 'joined: never by the acquirer')
	// The stale observation, delivered after the renewed deadline too, still releases nothing.
	assert.deepEqual(await recover(RENEWED + 1_000, stale), { released: 0 }, 'a pre-join observation never releases a joined claim')
	assert.deepEqual(await recover(RENEWED + 1_000, [{ id, leaseUntilMs: RENEWED, leaseVersion: 1 }]), { released: 0 }, 'deadline alone is not enough')
	assert.deepEqual(await recover(RENEWED + 1_000, [{ id, leaseUntilMs: T0 + MINT_ADMISSION_LEASE_MS, leaseVersion: 2 }]), { released: 0 }, 'generation alone is not enough')
	assert.deepEqual(lockRows(h), [[id, 'w-join', 'reserved']])
	// A fresh observation of the renewed lease, inside it, is still refused; after it, it may release.
	const fresh = await conflictLease(RENEWED + 1_000)
	assert.deepEqual(fresh, [{ id, leaseUntilMs: RENEWED, leaseVersion: 2 }])
	assert.deepEqual(await recover(RENEWED - 1, fresh), { released: 0 }, 'still inside the renewed lease')
	assert.deepEqual(await recover(RENEWED + 1_000, fresh), { released: 1 })
	assert.deepEqual(h.locks(), [])
	h.db.close()
})

test('P2 pass 4: an ambiguous or lost creation response retains the claim until the workflow is proven absent; only proven absence releases it', async () => {
	const id = mainnetSingle.tracks[0].id
	const cases: Array<[string, (h: ReturnType<typeof harness>, create: WorkflowsStub['create']) => void, boolean]> = [
		// The instance was queued, but the response was lost.
		['lost response, instance queued', (h, create) => {
			workflowsOf(h).create = async (arg) => { await create(arg); throw new Error('Network connection lost') }
		}, true],
		// Creation failed and the instance's existence cannot be established.
		['creation failed, Workflows API unavailable', (h) => {
			workflowsOf(h).create = async () => { throw new Error('workflow service unavailable') }
			workflowsOf(h).get = async () => { throw new Error('Workflows API unavailable') }
		}, true],
		// Creation failed and the instance is definitively absent: released at once.
		['creation failed, instance not found', (h) => {
			workflowsOf(h).create = async () => { throw new Error('workflow service unavailable') }
		}, false],
	]
	for (const [label, arrange, retained] of cases) {
		const h = harness()
		h.tracksOf(mainnetSingle)
		const { create, get } = workflowsOf(h)
		arrange(h, create)
		const response = await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
		assert.equal(response.status, 503, label)
		workflowsOf(h).create = create
		workflowsOf(h).get = get
		const fresh = await feCoinIt(mainnetSingle.tracks[0], 211n)
		if (!retained) {
			assert.deepEqual(h.locks(), [], label)
			assert.equal((await h.send(`/mint/${id}`, { xdr: fresh }, FE_MINTER)).status, 202, `${label}: a fresh carrier is admitted`)
			h.db.close()
			continue
		}
		const [{ workflow_id: workflowId }] = h.locks()
		assert.deepEqual(lockRows(h), [[id, workflowId, 'reserved']], `${label}: retained`)
		// A different carrier cannot displace it inside the lease.
		const competing = await h.send(`/mint/${id}`, { xdr: fresh }, FE_MINTER)
		assert.equal(competing.status, 409, label)
		assert.deepEqual(await json(competing), { error: 'mint_in_progress', ids: [id] })
		// The same carrier, reposted, joins and (re)creates or finds the workflow.
		assert.equal((await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)).status, 202, `${label}: identical repost`)
		assert.deepEqual(h.creates.map((entry) => entry.id), [workflowId])
		// After the lease, the queued owner still keeps it.
		assert.equal((await later(AFTER_LEASE, () => h.send(`/mint/${id}`, { xdr: fresh }, FE_MINTER))).status, 409, label)
		assert.deepEqual(lockRows(h), [[id, workflowId, 'reserved']])
		h.db.close()
	}

	// A claim that was retained because existence was unknown, whose workflow never appeared, is recovered
	// only after the lease and only once the instance is proven absent.
	const h = harness()
	h.tracksOf(mainnetSingle)
	const { get } = workflowsOf(h)
	workflowsOf(h).create = async () => { throw new Error('workflow service unavailable') }
	workflowsOf(h).get = async () => { throw new Error('Workflows API unavailable') }
	assert.equal((await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)).status, 503)
	const fresh = await feCoinIt(mainnetSingle.tracks[0], 213n)
	assert.equal((await later(AFTER_LEASE, () => h.send(`/mint/${id}`, { xdr: fresh }, FE_MINTER))).status, 409, 'existence still unknown')
	workflowsOf(h).get = get
	workflowsOf(h).create = async (arg) => { h.creates.push(arg); return { id: arg.id } }
	const recovered = await later(AFTER_LEASE, () => h.send(`/mint/${id}`, { xdr: fresh }, FE_MINTER))
	assert.equal(recovered.status, 202)
	const { workflowId: takeover } = await json(recovered) as { workflowId: string }
	assert.deepEqual(lockRows(h), [[id, takeover, 'reserved']])
	h.db.close()
})

test('P2 pass 4: an expired, never-signed holder of a shared 12-hex prefix is recovered by a different song (by the stored holder id and token); an active, live, signed or dispatched holder is still rejected', async () => {
	const c = carrier('test/coin_it-split')
	const song = c.tracks[0]
	const twin = { id: `${song.id.slice(0, 12)}${song.id.at(12) === 'd' ? 'e' : 'd'}${'d'.repeat(51)}`, creator: OTHER_WALLET }
	assert.notEqual(twin.id, song.id)
	const setup = () => {
		const h = harness()
		h.tracksOf(c)
		h.track(twin.id, { creator: OTHER_WALLET })
		return h
	}
	const sendTwin = async (h: ReturnType<typeof harness>, nonce: bigint, offset = 0) =>
		await later(offset, async () => h.send(`/mint/${twin.id}`, { xdr: await feCoinIt(twin, nonce) }, FE_MINTER))
	const prefixConflict = { error: 'prefix_conflict', code: 'prefix_reserved' }

	// Song A reserves its prefix and its admission stops before creating the workflow.
	{
		const h = setup()
		await lockStub(h).reserveMintPrefixes({ workflowId: 'mint-song-a-orphan', ids: [song.id], stage: 'admission', claimToken: TOKEN })
		assert.deepEqual(lockRows(h), [[song.id, 'mint-song-a-orphan', 'reserved']])
		// Inside A's lease, song B is rejected and nothing is inspected or released.
		const inLease = await sendTwin(h, 301n)
		assert.equal(inLease.status, 409)
		assert.deepEqual(await json(inLease), prefixConflict)
		assert.deepEqual(lockRows(h), [[song.id, 'mint-song-a-orphan', 'reserved']])
		// After the lease, A's workflow is proven absent: A's stored row is released and B reserves cleanly.
		const recovered = await sendTwin(h, 303n, AFTER_LEASE)
		assert.equal(recovered.status, 202)
		const { workflowId: twinWorkflow } = await json(recovered) as { workflowId: string }
		assert.deepEqual(lockRows(h), [[twin.id, twinWorkflow, 'reserved']])
		assert.deepEqual(h.creates.map((entry) => entry.id), [twinWorkflow])
		// Song A is now the one refused: the prefix belongs to B.
		const songA = await h.send(`/mint/${song.id}`, { xdr: await feCoinIt(song, 305n) }, FE_MINTER)
		assert.equal(songA.status, 409)
		assert.deepEqual(await json(songA), prefixConflict)
		h.db.close()
	}
	// A's workflow exists and is terminal before signing (errored or terminated): also recoverable.
	for (const status of ['errored', 'terminated']) {
		const h = setup()
		const admitted = await h.send(`/mint/${song.id}`, { xdr: await feCoinIt(song, 311n) }, FE_MINTER)
		assert.equal(admitted.status, 202)
		const { workflowId } = await json(admitted) as { workflowId: string }
		workflowsOf(h).get = async (instanceId) => ({ status: async () => ({ status: instanceId === workflowId ? status : 'queued' }) })
		assert.equal((await sendTwin(h, 313n)).status, 409, `${status}: in lease`)
		const recovered = await sendTwin(h, 315n, AFTER_LEASE)
		assert.equal(recovered.status, 202, status)
		assert.deepEqual(lockRows(h).map(([smol]) => smol), [twin.id])
		h.db.close()
	}
	// Still rejected after the lease: a live (queued or running) owner, or an owner whose status is unknown.
	for (const status of ['queued', 'running', 'waiting', new Error('Workflows API unavailable')]) {
		const h = setup()
		const admitted = await h.send(`/mint/${song.id}`, { xdr: await feCoinIt(song, 321n) }, FE_MINTER)
		const { workflowId } = await json(admitted) as { workflowId: string }
		workflowsOf(h).get = async () => ({ status: async () => { if (status instanceof Error) throw status; return { status } } })
		const response = await sendTwin(h, 323n, AFTER_LEASE)
		assert.equal(response.status, 409, String(status))
		assert.deepEqual(await json(response), prefixConflict)
		assert.deepEqual(lockRows(h), [[song.id, workflowId, 'reserved']], String(status))
		h.db.close()
	}
	// Still rejected, whatever the owner's workflow status: a holder that was ever claimed for signing
	// (signing, dispatched, ambiguous, failed, minted) keeps its prefix -> smol binding permanently.
	for (const lifecycle of ['signing', 'dispatched', 'ambiguous', 'failed', 'minted'] as const) {
		const h = setup()
		const stub = lockStub(h)
		await stub.reserveMintPrefixes({ workflowId: 'mint-song-a', ids: [song.id], stage: 'admission', claimToken: TOKEN })
		await stub.reserveMintPrefixes({ workflowId: 'mint-song-a', ids: [song.id], stage: 'signing' })
		if (lifecycle !== 'signing' && lifecycle !== 'failed') await stub.markMintDispatched({ workflowId: 'mint-song-a', ids: [song.id] })
		if (lifecycle === 'ambiguous') await stub.resolveMintPrefixes({ workflowId: 'mint-song-a', ids: [song.id], outcome: 'ambiguous' })
		if (lifecycle === 'failed') await stub.resolveMintPrefixes({ workflowId: 'mint-song-a', ids: [song.id], outcome: 'failed' })
		if (lifecycle === 'minted') await stub.resolveMintPrefixes({ workflowId: 'mint-song-a', ids: [song.id], outcome: 'minted' })
		workflowsOf(h).get = async () => { throw new Error('instance.not_found') }
		const response = await sendTwin(h, 331n, AFTER_LEASE)
		assert.equal(response.status, 409, lifecycle)
		assert.deepEqual(await json(response), prefixConflict)
		assert.deepEqual(lockRows(h), [[song.id, 'mint-song-a', lifecycle]], lifecycle)
		h.db.close()
	}
	// A once-signed holder later re-reserved by a takeover workflow (signed_at_ms kept) is not recoverable
	// by a different song either, even after its lease with its owner absent.
	{
		const h = setup()
		const stub = lockStub(h)
		await stub.reserveMintPrefixes({ workflowId: 'mint-song-a', ids: [song.id], stage: 'signing' })
		await stub.resolveMintPrefixes({ workflowId: 'mint-song-a', ids: [song.id], outcome: 'failed' })
		await stub.reserveMintPrefixes({ workflowId: 'mint-song-a-retry', ids: [song.id], stage: 'admission', claimToken: TOKEN })
		workflowsOf(h).get = async () => { throw new Error('instance.not_found') }
		const response = await sendTwin(h, 341n, AFTER_LEASE)
		assert.equal(response.status, 409)
		assert.deepEqual(await json(response), prefixConflict)
		assert.deepEqual(lockRows(h), [[song.id, 'mint-song-a-retry', 'reserved']])
		// The same song, though, recovers it: the release returns the row to `failed`, then it is taken over.
		const sameSong = await later(AFTER_LEASE, async () => h.send(`/mint/${song.id}`, { xdr: await feCoinIt(song, 343n) }, FE_MINTER))
		assert.equal(sameSong.status, 202)
		const { workflowId: takeover } = await json(sameSong) as { workflowId: string }
		assert.deepEqual(lockRows(h), [[song.id, takeover, 'reserved']])
		h.db.close()
	}
})

test('P2 pass 4: a confirmed on-chain failure with a transient lock-store fault retries only the settlement step (zero re-sign, zero re-submit); the lock settles, D1 records failed only afterwards, and a new admission succeeds', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	// `lost`: the first settlement commits in the lock store but its response is lost.
	for (const fault of ['before', 'lost'] as const) {
		const h = harness()
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		const event = batchEvent(c, `failed-onchain-settle-${fault}`)
		claim(h, event)
		await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN })
		;(h.env.KALE_WORKER as unknown as { getTx: unknown }).getTx = async () => ({ status: 'FAILED', latestLedger: TIP + 2 })
		const quota = h.env.USER_QUOTA
		let faults = 1
		;(h.env as unknown as { USER_QUOTA: unknown }).USER_QUOTA = {
			idFromName: (name: string) => quota.idFromName(name),
			get: (doId: DurableObjectId) => {
				const stub = quota.get(doId)
				return {
					reserveMintPrefixes: (params: never) => stub.reserveMintPrefixes(params),
					releaseMintPrefixes: (params: never) => stub.releaseMintPrefixes(params),
					markMintDispatched: (params: never) => stub.markMintDispatched(params),
					mintAttemptState: (params: never) => stub.mintAttemptState(params),
					resolveMintPrefixes: async (params: never) => {
						if (faults > 0) {
							faults -= 1
							if (fault === 'lost') await stub.resolveMintPrefixes(params)
							throw new Error('Durable Object storage operation exceeded timeout')
						}
						return await stub.resolveMintPrefixes(params)
					},
				}
			},
		}
		const signatures = countIssuerSignatures(TEST_IDENTITY.issuer)
		try {
			const wf = new (testWorkflowClass())({} as ExecutionContext, h.env)
			const cache = new Map<string, unknown>()
			// First attempt: signed, relayed once, FAILED receipt checkpointed, settlement hits the fault.
			const first = createWorkflowStep(cache)
			await assert.rejects(wf.run(event as never, first.step as never),
				(e: unknown) => e instanceof Error && e.name !== 'NonRetryableError' && /exceeded timeout/.test(e.message), fault)
			assert.deepEqual(first.executed.map(({ name }) => name), [
				'sign transaction', 'record mint submit intent', 'submit transaction', 'record submitted mint', 'confirm transaction', 'settle failed mint locks',
			])
			assert.deepEqual(cache.get('confirm transaction#1'), { failedOnChain: true }, 'the failed receipt is checkpointed')
			assert.equal(signatures.count, 1)
			assert.equal(h.relayed.length, 1)
			assert.equal(h.batchRow(event.instanceId)?.Phase, 'submitted', `${fault}: D1 never reports failed before the lock settles`)
			assert.deepEqual(lockState(h), [[event.instanceId, fault === 'lost' ? 'failed' : 'dispatched']])

			// The engine retries: only the settlement step re-runs, then D1 records failed.
			const retry = createWorkflowStep(cache)
			await assert.rejects(wf.run(event as never, retry.step as never), isTerminal(/^Mint transaction failed on-chain$/))
			assert.deepEqual(retry.executed.map(({ name }) => name), ['settle failed mint locks', 'record failed mint'], 'zero re-sign, zero re-submit')
			assert.equal(signatures.count, 1, 'never signed again')
			assert.equal(h.relayed.length, 1, 'never relayed again')
			assert.deepEqual(lockState(h), [[event.instanceId, 'failed']], 'the lock settled')
			assert.equal(h.batchRow(event.instanceId)?.Phase, 'failed')
			assert.equal(h.batchRow(event.instanceId)?.Tx_Hash, 'ab'.repeat(32))

			// A further replay is idempotent and changes nothing.
			const again = createWorkflowStep(cache)
			await assert.rejects(wf.run(event as never, again.step as never), isTerminal(/^Mint transaction failed on-chain$/))
			assert.deepEqual(again.executed, [])

			// A future admission for the song succeeds and takes over the failed lock.
			const admitted = await h.send(`/mint/${id}`, { xdr: await feCoinIt(c.tracks[0], 401n) }, FE_MINTER)
			assert.equal(admitted.status, 202, fault)
			const { workflowId } = await json(admitted) as { workflowId: string }
			assert.deepEqual(lockState(h), [[workflowId, 'reserved']])
		} finally {
			signatures.restore()
			h.db.close()
		}
	}
})

// ---------------------------------------------------------------------------
// Pass 5: expiry recovery is bound to the observed lease generation; a fresh attempt clears the
// previous attempt's receipt; a submitted batch whose workflow is gone reads as uncertain
// ---------------------------------------------------------------------------

test('P2 pass 5: a recovery whose absence check ran BEFORE a join, delayed past the renewed deadline, cannot delete the joined owner\'s reservation; only a fresh observation can reclaim', async () => {
	const id = mainnetSingle.tracks[0].id
	const h = harness()
	h.tracksOf(mainnetSingle)
	const workflows = workflowsOf(h)
	const { create, get } = workflows
	// Admission 1: creation fails and existence cannot be established, so its claim is retained.
	workflows.create = async () => { throw new Error('workflow service unavailable') }
	workflows.get = async () => { throw new Error('Workflows API unavailable') }
	assert.equal((await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)).status, 503)
	workflows.create = create
	const [{ workflow_id: owner }] = h.locks()
	assert.deepEqual(lockRows(h), [[id, owner, 'reserved']])

	// The competing admission's absence check for the owner is held open (a slow status lookup), and
	// answers "not found": true when it was asked, before the joiner queued the workflow.
	let release!: () => void
	const gate = new Promise<void>((resolve) => { release = resolve })
	let observed = false
	workflows.get = async (instanceId: string) => {
		if (instanceId === owner && !observed) {
			observed = true
			await gate
			throw new Error('instance.not_found')
		}
		return await get(instanceId)
	}
	const realNow = Date.now
	let offset = AFTER_LEASE
	Date.now = () => realNow() + offset
	try {
		const rival = await feCoinIt(mainnetSingle.tracks[0], 501n)
		const competing = h.send(`/mint/${id}`, { xdr: rival }, FE_MINTER)
		let competingResponse: Response
		try {
			await until(() => observed, 'the competing admission is inside its absence check')
			// The identical carrier joins the expired claim (renewing its lease), queues the workflow, 202.
			const joined = await h.send(`/mint/${id}`, { xdr: mainnetSingle.xdr }, FE_MINTER)
			assert.equal(joined.status, 202)
			assert.deepEqual(await json(joined), { workflowId: owner })
			assert.deepEqual(h.creates.map((entry) => entry.id), [owner], 'the owner workflow is queued')
			// The stale absence result arrives after the RENEWED lease has also run out.
			offset = AFTER_LEASE * 2 + 1_000
		} finally {
			release()
			competingResponse = await competing
		}
		assert.equal(competingResponse.status, 409, 'the stale recovery reclaims nothing')
		assert.deepEqual(await json(competingResponse), { error: 'mint_in_progress', ids: [id] })
		assert.deepEqual(lockRows(h), [[id, owner, 'reserved']], 'the joined owner keeps its reservation')
		assert.deepEqual(h.creates.map((entry) => entry.id), [owner], 'no competing workflow')

		// A fresh observation sees the renewed lease AND the queued workflow: still refused.
		const again = await h.send(`/mint/${id}`, { xdr: await feCoinIt(mainnetSingle.tracks[0], 503n) }, FE_MINTER)
		assert.equal(again.status, 409)
		assert.deepEqual(lockRows(h), [[id, owner, 'reserved']])
	} finally {
		Date.now = realNow
	}
	// The joined owner still signs; a rival never does.
	assert.equal((await lockStub(h).reserveMintPrefixes({ workflowId: 'mint-rival', ids: [id], stage: 'signing' })).ok, false)
	assert.deepEqual(await lockStub(h).reserveMintPrefixes({ workflowId: owner, ids: [id], stage: 'signing' }), { ok: true })
	assert.deepEqual(lockRows(h), [[id, owner, 'signing']])
	h.db.close()
})

test('P2 pass 5: attempt 1 fails on-chain with hash H1 -> full restart -> attempt 2 relay response lost: /mint/status is uncertain with NO stale H1 hash', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const H1 = 'ab'.repeat(32)
	for (const lookup of ['errored', 'not_found'] as const) {
		const h = harness()
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		const event = batchEvent(c, `restart-after-failed-${lookup}`)
		claim(h, event)
		await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN })
		const kale = h.env.KALE_WORKER as unknown as { getTx: unknown; submitTransaction: (arg: { xdr: string }) => Promise<unknown> }
		kale.getTx = async () => ({ status: 'FAILED', latestLedger: TIP + 2 })
		const signatures = countIssuerSignatures(TEST_IDENTITY.issuer)
		try {
			const wf = new (testWorkflowClass())({} as ExecutionContext, h.env)
			// Attempt 1: signed, relayed (hash H1), FAILED receipt: a definite failure recorded with H1.
			await assert.rejects(wf.run(event as never, createWorkflowStep(new Map()).step as never), isTerminal(/^Mint transaction failed on-chain$/))
			assert.deepEqual([h.batchRow(event.instanceId)?.Phase, h.batchRow(event.instanceId)?.Tx_Hash], ['failed', H1])
			assert.deepEqual(lockState(h), [[event.instanceId, 'failed']])

			// Attempt 2 (a full restart): signs again, records a fresh submit intent, and the relay accepts
			// the transaction but its response is lost.
			const relay = kale.submitTransaction
			kale.submitTransaction = async (arg) => { await relay(arg); throw new Error('Network connection lost') }
			const restart = createWorkflowStep(new Map())
			await assert.rejects(wf.run(event as never, restart.step as never), isTerminal(/Relay submission outcome unknown/))
			assert.deepEqual(restart.executed.map(({ name }) => name), ['sign transaction', 'record mint submit intent', 'submit transaction'])
			assert.equal(signatures.count, 2)
			assert.equal(h.relayed.length, 2)
			assert.deepEqual(lockState(h), [[event.instanceId, 'ambiguous']])
			const row = h.batchRow(event.instanceId)!
			assert.deepEqual([row.Phase, row.Tx_Hash, row.Confirmed_Ledger], ['submitting', null, null], 'the fresh attempt cleared H1')

			// The status API: uncertain, and never H1.
			;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = lookup === 'errored'
				? async () => ({ status: async () => ({ status: 'errored' }) })
				: async () => { throw new Error('instance.not_found') }
			const status = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
			assert.equal(status.status, 200)
			const { batches } = await json(status) as { batches: Array<Record<string, unknown>> }
			assert.deepEqual(batches, [{ workflowId: event.instanceId, ids: [id], phase: 'uncertain' }], lookup)
			assert.equal(JSON.stringify(batches).includes(H1), false, 'no stale H1 hash')
		} finally {
			signatures.restore()
			h.db.close()
		}
	}
})

test('P2 pass 6: submitted with H1, confirmation fails, named-step restart at "record mint submit intent" reuses the signing checkpoint: D1 keeps submitted + H1, the dispatch guard refuses a second relay, /mint/status still returns H1', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const H1 = 'ab'.repeat(32)
	for (const lookup of ['errored', 'not_found', 'running'] as const) {
		const h = harness()
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		const event = batchEvent(c, `named-restart-submit-intent-${lookup}`)
		claim(h, event)
		await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN })
		const kale = h.env.KALE_WORKER as unknown as { getTx: unknown }
		kale.getTx = async () => { throw new Error('RPC unavailable') }
		const signatures = countIssuerSignatures(TEST_IDENTITY.issuer)
		try {
			const wf = new (testWorkflowClass())({} as ExecutionContext, h.env)
			const cache = new Map<string, unknown>()
			// Attempt 1: signed, relayed (H1), D1 records submitted + H1, then confirmation fails.
			const first = createWorkflowStep(cache)
			await assert.rejects(wf.run(event as never, first.step as never),
				(e: unknown) => e instanceof Error && e.name !== 'NonRetryableError' && /receipt lookup unavailable/.test(e.message))
			assert.deepEqual(first.executed.map(({ name }) => name), [
				'sign transaction', 'record mint submit intent', 'submit transaction', 'record submitted mint', 'confirm transaction',
			])
			assert.deepEqual([h.batchRow(event.instanceId)?.Phase, h.batchRow(event.instanceId)?.Tx_Hash], ['submitted', H1])
			assert.deepEqual(lockState(h), [[event.instanceId, 'dispatched']])
			assert.equal(signatures.count, 1)
			assert.equal(h.relayed.length, 1)

			// Operator restarts at "record mint submit intent": Cloudflare keeps the earlier steps'
			// checkpoints (the signing checkpoint) and re-runs this step and every later one.
			const restartCache = new Map([...cache].filter(([key]) => key === 'sign transaction#1'))
			const restart = createWorkflowStep(restartCache)
			await assert.rejects(wf.run(event as never, restart.step as never), isTerminal(/submit replayed after dispatch started/))
			assert.deepEqual(restart.executed.map(({ name }) => name), ['record mint submit intent', 'submit transaction'])
			assert.equal(signatures.count, 1, 'the signing checkpoint was reused')
			assert.equal(h.relayed.length, 1, 'the dispatch guard refused a second relay')
			assert.deepEqual(lockState(h), [[event.instanceId, 'ambiguous']])
			const row = h.batchRow(event.instanceId)!
			assert.deepEqual([row.Phase, row.Tx_Hash], ['submitted', H1], 'the replayed submit intent kept the phase and H1')

			// The status API still points reconciliation at H1.
			;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = lookup === 'not_found'
				? async () => { throw new Error('instance.not_found') }
				: async () => ({ status: async () => ({ status: lookup }) })
			const status = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
			assert.equal(status.status, 200)
			const { batches } = await json(status) as { batches: Array<Record<string, unknown>> }
			assert.deepEqual(batches, [{
				workflowId: event.instanceId, ids: [id], phase: lookup === 'running' ? 'submitted' : 'uncertain', txHash: H1,
			}], lookup)
		} finally {
			signatures.restore()
			h.db.close()
		}
	}
})

test('P2 pass 6/10: a submit intent never clears or downgrades an unresolved or final receipt; only a genuinely new (signing, undispatched) attempt over a pre-submit or definite failed row resets it', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const H = 'ef'.repeat(32)
	const cases: Array<[string, string | null, number | null, string, [string, string | null, number | null], boolean]> = [
		// [D1 phase, hash, ledger, lock state, expected D1 after the submit intent, expected preSubmit]
		['submitted', H, null, 'dispatched', ['submitted', H, null], false],
		['submitted', H, null, 'ambiguous', ['submitted', H, null], false],
		['failed', H, null, 'failed', ['failed', H, null], false],
		['confirmed', H, TIP, 'minted', ['confirmed', H, TIP], false],
		['submitting', null, null, 'dispatched', ['submitting', null, null], false],
		['queued', null, null, 'dispatched', ['submitting', null, null], false],
		// A genuinely new attempt (lock `signing`): only a definite `failed` (or pre-submit) row is reset.
		['failed', H, TIP, 'signing', ['submitting', null, null], true],
		['queued', null, null, 'signing', ['submitting', null, null], true],
		// This attempt's own intent, replayed (the signer refuses to sign over any other `submitting` row).
		['submitting', null, null, 'signing', ['submitting', null, null], true],
		// An unresolved or final receipt is never cleared, and the attempt proves nothing.
		['submitted', H, null, 'signing', ['submitted', H, null], false],
		['confirmed', H, TIP, 'signing', ['confirmed', H, TIP], false],
		['persisted', H, TIP, 'signing', ['persisted', H, TIP], false],
	]
	for (const [phase, hash, ledger, lock, expected, expectedPreSubmit] of cases) {
		const h = harness()
		h.tracksOf(c)
		const event = batchEvent(c, `intent-${phase}-${lock}`)
		claim(h, event)
		h.db.prepare('UPDATE MintBatchStatus SET Phase = ?, Tx_Hash = ?, Confirmed_Ledger = ? WHERE Workflow_Id = ?').run(phase, hash, ledger, event.instanceId)
		await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN })
		await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'signing' })
		if (lock === 'dispatched' || lock === 'ambiguous') await lockStub(h).markMintDispatched({ workflowId: event.instanceId, ids: [id] })
		if (lock === 'ambiguous') await lockStub(h).resolveMintPrefixes({ workflowId: event.instanceId, ids: [id], outcome: 'ambiguous' })
		if (lock === 'failed') await lockStub(h).resolveMintPrefixes({ workflowId: event.instanceId, ids: [id], outcome: 'failed' })
		if (lock === 'minted') await lockStub(h).resolveMintPrefixes({ workflowId: event.instanceId, ids: [id], outcome: 'minted' })
		assert.deepEqual(lockState(h), [[event.instanceId, lock]])
		const wf = new (testWorkflowClass())({} as ExecutionContext, h.env)
		// Every step but the submit intent is already checkpointed; run only that step.
		let intent: unknown
		const step = {
			do: async (name: string, _config: unknown, fn: () => Promise<unknown>) => {
				if (name === 'record mint submit intent') return intent = await fn()
				if (name === 'sign transaction') return { version: 1, xdr: 'AAAA' }
				throw new Error(`stop before ${name}`)
			},
		}
		await assert.rejects(wf.run(event as never, step as never), /stop before submit transaction/)
		const row = h.batchRow(event.instanceId)!
		assert.deepEqual([row.Phase, row.Tx_Hash, row.Confirmed_Ledger], expected, `${phase} / ${lock}`)
		assert.deepEqual(intent, { preSubmit: expectedPreSubmit }, `${phase} / ${lock}: preSubmit`)
		assert.deepEqual(lockState(h), [[event.instanceId, lock]], `${phase} / ${lock}: the intent never moves a lock`)
		h.db.close()
	}
})

test('status: D1 still submitted (or submitting) and the workflow is definitively instance.not_found -> uncertain, never submitted indefinitely; a transient lookup failure keeps the D1 checkpoint', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const H = 'cd'.repeat(32)
	const cases: Array<[string, string | null, () => Promise<never | { status: () => Promise<{ status: string }> }>, Record<string, unknown>]> = [
		['submitted', H, async () => { throw new Error('instance.not_found') }, { phase: 'uncertain', txHash: H }],
		['submitting', null, async () => { throw new Error('instance.not_found') }, { phase: 'uncertain' }],
		['submitted', H, async () => { throw new Error('Workflows API unavailable') }, { phase: 'submitted', txHash: H }],
		['submitted', H, async () => ({ status: async () => ({ status: 'running' }) }), { phase: 'submitted', txHash: H }],
		['submitting', null, async () => { throw new Error('Workflows API unavailable') }, { phase: 'queued' }],
	]
	for (const [phase, hash, get, expected] of cases) {
		const h = harness()
		h.tracksOf(c)
		const event = batchEvent(c, `status-${phase}-${expected.phase}`)
		claim(h, event)
		h.db.prepare('UPDATE MintBatchStatus SET Phase = ?, Tx_Hash = ? WHERE Workflow_Id = ?').run(phase, hash, event.instanceId)
		;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = get
		const response = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
		assert.equal(response.status, 200)
		const { batches } = await json(response) as { batches: Array<Record<string, unknown>> }
		assert.deepEqual(batches, [{ workflowId: event.instanceId, ids: [id], ...expected }], `${phase} / ${String(expected.phase)}`)
		h.db.close()
	}
})

/** The exact `UserQuotaDO` SQLite layout at schema v6 (base `ac4307e`), captured from `sqlite_master`. */
const V6_SCHEMA = `
	CREATE TABLE _sql_schema_migrations (
		id INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
	CREATE TABLE quota_reservations (
		reservation_id TEXT PRIMARY KEY,
		day_key TEXT NOT NULL,
		provider TEXT NOT NULL CHECK(provider IN ('aisonggenerator', 'elevenlabs')),
		initial_provider TEXT NOT NULL CHECK(initial_provider IN ('aisonggenerator', 'elevenlabs')),
		status TEXT NOT NULL CHECK(status IN ('reserved', 'committed', 'ambiguous', 'refunded')),
		claim_count INTEGER NOT NULL DEFAULT 1,
		admitted INTEGER NOT NULL DEFAULT 0,
		generation INTEGER NOT NULL DEFAULT 1,
		superseded_day_key TEXT,
		created_at_ms INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL,
		fallback_from TEXT CHECK(fallback_from IS NULL OR fallback_from IN ('aisonggenerator', 'elevenlabs')),
		reason TEXT
	);
	CREATE INDEX idx_quota_res_day_provider_status ON quota_reservations (day_key, provider, status);
	CREATE INDEX idx_quota_res_created ON quota_reservations (created_at_ms);
	CREATE TABLE play_beacon_dedupe (
		dedupe_key TEXT PRIMARY KEY,
		expires_at_ms INTEGER NOT NULL
	);
	CREATE INDEX idx_play_beacon_dedupe_exp ON play_beacon_dedupe (expires_at_ms);
	CREATE TABLE play_beacon_rate (
		bucket_key TEXT PRIMARY KEY,
		count INTEGER NOT NULL,
		expires_at_ms INTEGER NOT NULL
	);
	CREATE INDEX idx_play_beacon_rate_exp ON play_beacon_rate (expires_at_ms);
	CREATE TABLE quota_reservation_claims (
		reservation_id TEXT NOT NULL,
		generation INTEGER NOT NULL,
		claim_id TEXT NOT NULL,
		state TEXT NOT NULL CHECK(state IN ('pending', 'admitted', 'released')),
		updated_at_ms INTEGER NOT NULL,
		PRIMARY KEY (reservation_id, generation, claim_id)
	);
	CREATE INDEX idx_quota_claims_res_gen_state ON quota_reservation_claims (reservation_id, generation, state);
	CREATE TABLE pending_user_releases (
		id TEXT PRIMARY KEY,
		user_key TEXT NOT NULL,
		reservation_id TEXT NOT NULL,
		generation INTEGER NOT NULL,
		day_key TEXT NOT NULL,
		claim_id TEXT NOT NULL,
		rollback_unshared_admitted INTEGER NOT NULL DEFAULT 0,
		reason TEXT,
		created_at_ms INTEGER NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_retry_at_ms INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX idx_pending_user_releases_created ON pending_user_releases (created_at_ms);
	CREATE INDEX idx_pending_user_releases_due ON pending_user_releases (next_retry_at_ms, attempts, created_at_ms);
	INSERT INTO _sql_schema_migrations (id) VALUES (1), (2), (3), (4), (5), (6);
`

test('DO migration v6 -> v7: a populated v6 object upgrades in place, keeps its quota rows, and runs the full v7 mint lock lifecycle (dispatch marker, ambiguity, never-signed release)', async () => {
	const db = new DatabaseSync(':memory:')
	const nowMs = Date.parse('2026-11-24T12:00:00.000Z')
	const dayKey = '2026-11-24'
	db.exec(V6_SCHEMA)
	db.exec(`
		INSERT INTO quota_reservations (reservation_id, day_key, provider, initial_provider, status, claim_count, admitted, generation,
			created_at_ms, updated_at_ms) VALUES
			('v6-committed', '${dayKey}', 'elevenlabs', 'elevenlabs', 'committed', 1, 1, 1, ${nowMs}, ${nowMs}),
			('v6-reserved', '${dayKey}', 'aisonggenerator', 'aisonggenerator', 'reserved', 1, 0, 2, ${nowMs}, ${nowMs});
		INSERT INTO pending_user_releases (id, user_key, reservation_id, generation, day_key, claim_id, created_at_ms)
			VALUES ('v6-release', 'user:G', 'v6-reserved', 2, '${dayKey}', 'claim-1', ${nowMs});
	`)
	assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'mint_prefix_locks'`).get(), undefined)
	const open = () => {
		const { storage } = createSqliteBackedStorage(db)
		return new UserQuotaDO({ storage, blockConcurrencyWhile: <R>(fn: () => Promise<R>) => fn(), waitUntil: () => {} } as unknown as DurableObjectState, {} as Env)
	}
	const quota = open()
	assert.deepEqual(db.prepare(`SELECT id FROM _sql_schema_migrations ORDER BY id`).all().map(({ id }) => id), [1, 2, 3, 4, 5, 6, 7])
	assert.deepEqual(db.prepare(`PRAGMA table_info('mint_prefix_locks')`).all().map(({ name }) => name), [
		'prefix', 'smol_id', 'workflow_id', 'status', 'claim_token', 'lease_until_ms', 'lease_version', 'reserved_at_ms', 'signed_at_ms',
		'dispatched_at_ms', 'joined_at_ms', 'updated_at_ms',
	])
	// The v6 rows are untouched and still served.
	assert.equal((await quota.getReservation('v6-committed'))?.status, 'committed')
	assert.equal((await quota.getReservation('v6-reserved'))?.generation, 2)
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM pending_user_releases`).get()!.n, 1)

	// The v7 lock lifecycle on the upgraded object.
	const prefixOf = (label: string) => hash(Buffer.from(label)).toString('hex')
	const [A, N] = [prefixOf('v7-upgrade-dispatch'), prefixOf('v7-upgrade-never-signed')]
	const twinOfN = `${N.slice(0, 12)}${'0'.repeat(52)}`
	const status = (id: string) => (db.prepare(`SELECT status FROM mint_prefix_locks WHERE smol_id = ?`).get(id) as { status?: string } | undefined)?.status
	assert.deepEqual(await quota.reserveMintPrefixes({ workflowId: 'wA', ids: [A], stage: 'admission', claimToken: TOKEN, nowMs }), { ok: true })
	assert.deepEqual(await quota.reserveMintPrefixes({ workflowId: 'wA', ids: [A], stage: 'signing', nowMs }), { ok: true })
	assert.deepEqual(await quota.markMintDispatched({ workflowId: 'wA', ids: [A], nowMs }), { ok: true })
	assert.equal(status(A), 'dispatched')
	assert.deepEqual(await quota.resolveMintPrefixes({ workflowId: 'wA', ids: [A], outcome: 'failed', nowMs }), { resolved: 1, state: 'uncertain' })
	assert.equal(status(A), 'ambiguous')
	assert.equal((await quota.reserveMintPrefixes({ workflowId: 'wB', ids: [A], stage: 'admission', claimToken: TOKEN, nowMs })).ok, false)
	assert.deepEqual(await quota.reserveMintPrefixes({ workflowId: 'wN', ids: [N], stage: 'admission', claimToken: TOKEN, nowMs }), { ok: true })
	assert.deepEqual(await quota.resolveMintPrefixes({ workflowId: 'wN', ids: [N], outcome: 'failed', nowMs }), { resolved: 1, state: 'released' })
	assert.equal(status(N), undefined)
	assert.deepEqual(await quota.reserveMintPrefixes({ workflowId: 'wT', ids: [twinOfN], stage: 'admission', claimToken: TOKEN, nowMs }), { ok: true })
	// A join on the upgraded object bumps the lease generation.
	assert.deepEqual(await quota.reserveMintPrefixes({ workflowId: 'wT', ids: [twinOfN], stage: 'admission', claimToken: 'v7-joining-admission', nowMs }), { ok: true })
	const leaseOf = (id: string) => ({ ...db.prepare(`SELECT lease_until_ms, lease_version FROM mint_prefix_locks WHERE smol_id = ?`).get(id) })
	assert.deepEqual(leaseOf(twinOfN), { lease_until_ms: nowMs + MINT_ADMISSION_LEASE_MS, lease_version: 2 })

	// Reopening runs no migration again and keeps every row.
	const reopened = open()
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM _sql_schema_migrations`).get()!.n, 7)
	assert.equal(status(A), 'ambiguous')
	assert.equal(status(twinOfN), 'reserved')
	assert.deepEqual(leaseOf(twinOfN), { lease_until_ms: nowMs + MINT_ADMISSION_LEASE_MS, lease_version: 2 })
	// A stale (generation 1) recovery is refused on the reopened object; the observed generation 2 is not.
	const recoverT = (leaseVersion: number) => reopened.releaseMintPrefixes({
		workflowId: 'wT', ids: [twinOfN], claimToken: TOKEN, expiredLeaseOnly: true, nowMs: nowMs + AFTER_LEASE,
		observedLeases: [{ id: twinOfN, leaseUntilMs: nowMs + MINT_ADMISSION_LEASE_MS, leaseVersion }],
	})
	assert.deepEqual(await recoverT(1), { released: 0 })
	assert.deepEqual(await recoverT(2), { released: 1 })
	assert.deepEqual(await reopened.resolveMintPrefixes({ workflowId: 'wA', ids: [A], outcome: 'minted', nowMs }), { resolved: 1, state: 'minted' })
	assert.equal((await reopened.getReservation('v6-committed'))?.status, 'committed')
	db.close()
})

test('P2 pass 7/8: a paused pre-v7 (legacy) restart with no v7 lock, or only a fresh never-signed v7 reservation, never downgrades a submitted, submitting, confirmed or persisted receipt to failed; /mint/status keeps uncertain + H1', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const H1 = 'ab'.repeat(32)
	// Checkpoints a pre-v7 execution left behind: a bare (blind-signer) signature, a submit intent with
	// no output, and possibly a completed submit. The operator restarts at each named step in turn.
	const legacy: Array<[string, unknown]> = [
		['sign transaction#1', 'legacy-blind-signed-xdr'],
		['record mint submit intent#1', undefined],
	]
	const restarts: Array<[string, Array<[string, unknown]>, string[]]> = [
		['sign transaction', [], ['sign transaction']],
		['record mint submit intent', legacy.slice(0, 1), ['record mint submit intent', 'submit transaction']],
		['submit transaction', legacy, ['submit transaction']],
	]
	const errored = async () => ({ status: async () => ({ status: 'errored' }) })
	const notFound = async () => { throw new Error('instance.not_found') }
	// [D1 phase, hash, ledger, D1 after the paused restart, /mint/status progress]
	const rows: Array<[string, string | null, number | null, [string, string | null, number | null], Record<string, unknown>]> = [
		['submitted', H1, null, ['submitted', H1, null], { phase: 'uncertain', txHash: H1 }],
		['submitting', null, null, ['submitting', null, null], { phase: 'uncertain' }],
		['confirmed', H1, TIP, ['confirmed', H1, TIP], { phase: 'confirmed', txHash: H1, confirmedLedger: TIP }],
		['persisted', H1, TIP, ['persisted', H1, TIP], { phase: 'persisted', txHash: H1, confirmedLedger: TIP }],
		// Control: a row that never reached submit is a definite refusal.
		['queued', null, null, ['failed', null, null], { phase: 'failed' }],
	]
	// `reserved`: after the upgrade, an identical duplicate admission reserved afresh (a never-signed v7
	// claim) before discovering the pre-v7 instance already existed. Releasing it proves nothing about
	// the pre-v7 dispatch.
	for (const lock of ['none', 'reserved'] as const)
	for (const [restartAt, cached, executed] of restarts) {
		for (const [phase, hash, ledger, expected, progress] of rows) {
			for (const lookup of [errored, notFound]) {
				const label = `${lock} / ${restartAt} / ${phase} / ${lookup === errored ? 'errored' : 'not_found'}`
				const h = harness({ enabled: 'false' })
				h.tracksOf(c)
				h.env.SK = TEST_ISSUER.secret()
				const event = batchEvent(c, `legacy-paused-${phase}`)
				claim(h, event)
				h.db.prepare('UPDATE MintBatchStatus SET Phase = ?, Tx_Hash = ?, Confirmed_Ledger = ? WHERE Workflow_Id = ?')
					.run(phase, hash, ledger, event.instanceId)
				if (lock === 'reserved') {
					assert.deepEqual(await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN }), { ok: true })
				}
				const signatures = countIssuerSignatures(TEST_IDENTITY.issuer)
				try {
					assert.deepEqual(lockState(h), lock === 'none' ? [] : [[event.instanceId, 'reserved']], label)
					const restart = createWorkflowStep(new Map(cached))
					await assert.rejects(new (testWorkflowClass())({} as ExecutionContext, h.env).run(event as never, restart.step as never),
						isTerminal(/^Mint signing is paused$/), label)
					assert.deepEqual(restart.executed.map(({ name }) => name), executed, label)
					assert.equal(signatures.count, 0, label)
					assert.deepEqual(h.relayed, [], `${label}: zero relay`)
					assert.deepEqual(h.calls, [], label)
					assert.deepEqual(lockState(h), [], `${label}: a never-signed reservation is released`)
					const row = h.batchRow(event.instanceId)!
					assert.deepEqual([row.Phase, row.Tx_Hash, row.Confirmed_Ledger], expected, label)

					;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = lookup
					const status = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
					assert.equal(status.status, 200)
					const { batches } = await json(status) as { batches: Array<Record<string, unknown>> }
					assert.deepEqual(batches, [{ workflowId: event.instanceId, ids: [id], ...progress }], label)
				} finally {
					signatures.restore()
					h.db.close()
				}
			}
		}
	}
})

test('P2 pass 7/8/9: the refusal write keeps every receipt; it fails a submitting row only when this v7 run\'s own submit intent (preSubmit) AND its owned signing claim (signing -> failed) both prove nothing was relayed', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const H = 'ef'.repeat(32)
	// [D1 phase, hash, v7 lock before the paused submit (none = pre-v7), submit-intent checkpoint
	//  (true/false = v7 preSubmit, legacy = a pre-v7 checkpoint with no output), expected D1 after,
	//  /mint/status phase with the instance errored]
	type Lock = 'none' | 'reserved' | 'signing'
	type Intent = true | false | 'legacy'
	const cases: Array<[string, string | null, Lock, Intent, [string, string | null], string]> = [
		['submitted', H, 'none', false, ['submitted', H], 'uncertain'],
		['confirmed', H, 'none', false, ['confirmed', H], 'confirmed'],
		['persisted', H, 'none', false, ['persisted', H], 'persisted'],
		['submitting', null, 'none', false, ['submitting', null], 'uncertain'],
		['failed', H, 'none', false, ['failed', H], 'failed'],
		// A fresh v7 admission reservation (e.g. a post-upgrade duplicate admission for a pre-v7 instance
		// that already wrote `submitting`): the never-signed reservation is released, but that proves
		// nothing about the earlier dispatch, so `submitting` (and any receipt) is kept.
		['submitting', null, 'reserved', false, ['submitting', null], 'uncertain'],
		['submitted', H, 'reserved', false, ['submitted', H], 'uncertain'],
		// Submit-stage control: this run's own submit intent proved the attempt pre-submit AND the lock
		// store moved its own signing claim to failed: a definite failure.
		['submitting', null, 'signing', true, ['failed', null], 'failed'],
		// The signing claim alone is not proof about the row: without this run's own preSubmit (a v7
		// intent that proved nothing, or a pre-v7 intent checkpoint) `submitting` is kept as uncertain.
		['submitting', null, 'signing', false, ['submitting', null], 'uncertain'],
		['submitting', null, 'signing', 'legacy', ['submitting', null], 'uncertain'],
		// preSubmit alone is not proof either: the lock store must report signing -> failed.
		['submitting', null, 'none', true, ['submitting', null], 'uncertain'],
		['submitting', null, 'reserved', true, ['submitting', null], 'uncertain'],
		['submitted', H, 'signing', true, ['submitted', H], 'uncertain'],
		['submitted', H, 'signing', false, ['submitted', H], 'uncertain'],
		// Controls: a row that never reached submit is a definite refusal whatever the lock.
		['queued', null, 'none', false, ['failed', null], 'failed'],
		['queued', null, 'reserved', false, ['failed', null], 'failed'],
		['queued', null, 'signing', false, ['failed', null], 'failed'],
		['queued', null, 'signing', 'legacy', ['failed', null], 'failed'],
	]
	for (const [phase, hash, lock, intent, expected, statusPhase] of cases) {
		const label = `${phase} / ${lock} / preSubmit ${intent}`
		const h = harness({ enabled: 'false' })
		h.tracksOf(c)
		const event = batchEvent(c, `refusal-guard-${phase}-${lock}-${intent}`)
		claim(h, event)
		h.db.prepare('UPDATE MintBatchStatus SET Phase = ?, Tx_Hash = ? WHERE Workflow_Id = ?').run(phase, hash, event.instanceId)
		if (lock === 'reserved') {
			assert.deepEqual(await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN }), { ok: true })
		}
		if (lock === 'signing') await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'signing' })
		assert.deepEqual(lockState(h), lock === 'none' ? [] : [[event.instanceId, lock]], label)
		const signatures = countIssuerSignatures(TEST_IDENTITY.issuer)
		try {
		// Signing and submit intent already checkpointed: only the submit runs.
			const run = createWorkflowStep(new Map<string, unknown>([
				['sign transaction#1', { version: 'wf0-v1', xdr: c.xdr }],
				['record mint submit intent#1', intent === 'legacy' ? undefined : { preSubmit: intent }],
			]))
			await assert.rejects(new TxWorkflow({} as ExecutionContext, h.env).run(event as never, run.step as never),
				isTerminal(/^Mint signing is paused$/), label)
			assert.equal(signatures.count, 0, `${label}: zero signatures`)
			assert.deepEqual(h.relayed, [], `${label}: zero relay`)
			assert.deepEqual(h.calls, [], label)
			// A never-signed reservation is deleted; a signing claim becomes `failed`.
			assert.deepEqual(lockState(h), lock === 'signing' ? [[event.instanceId, 'failed']] : [], label)
			const row = h.batchRow(event.instanceId)!
			assert.deepEqual([row.Phase, row.Tx_Hash], expected, label)

			;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = async () => ({ status: async () => ({ status: 'errored' }) })
			const status = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
			assert.equal(status.status, 200)
			const { batches } = await json(status) as { batches: Array<Record<string, unknown>> }
			assert.equal(batches[0]?.phase, statusPhase, label)
			assert.equal(batches[0]?.txHash, expected[1] ?? undefined, label)
		} finally {
			signatures.restore()
			h.db.close()
		}
	}
})

test('P2 pass 9/10: legacy D1 submitting -> full restart (signing enabled) is refused before any v7 signing claim (zero lock, zero signatures, zero relays, D1 STAYS submitting, /mint/status uncertain); queued control: the claim commits, its response is lost, wallet auth expires, the retry refuses: lock signing -> failed, D1 failed', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	// [D1 phase before the restart, expected D1 after, /mint/status (errored), /mint/status (not_found)]
	const rows: Array<[string, string, string, string]> = [
		// A pre-v7 execution wrote `submitting`; its relay outcome is unknown.
		['submitting', 'submitting', 'uncertain', 'uncertain'],
		// Control: a row that never reached submit is a definite refusal.
		['queued', 'failed', 'failed', 'failed'],
	]
	for (const [phase, expected, errored, notFound] of rows) {
		const label = `legacy ${phase}`
		const h = harness()
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		const event = batchEvent(c, `pass9-signing-retry-${phase}`)
		claim(h, event)
		h.db.prepare('UPDATE MintBatchStatus SET Phase = ? WHERE Workflow_Id = ?').run(phase, event.instanceId)
		assert.deepEqual(lockState(h), [], `${label}: a pre-v7 instance holds no v7 lock`)

		// The signing claim commits in the lock store, but its RPC response is lost (once).
		const quota = h.env.USER_QUOTA
		let lose = 1
		;(h.env as unknown as { USER_QUOTA: unknown }).USER_QUOTA = {
			idFromName: (name: string) => quota.idFromName(name),
			get: (doId: DurableObjectId) => {
				const stub = quota.get(doId) as unknown as Record<string, (params: unknown) => Promise<unknown>>
				return new Proxy(stub, {
					get(target, prop) {
						const method = target[prop as string]
						if (typeof method !== 'function') return method
						if (prop === 'reserveMintPrefixes') {
							return async (params: { stage?: string }) => {
								const result = await method.call(target, params)
								if (params.stage === 'signing' && lose > 0) {
									lose -= 1
									throw new Error('Network connection lost')
								}
								return result
							}
						}
						return method.bind(target)
					},
				})
			},
		}

		const signatures = countIssuerSignatures(TEST_ISSUER.publicKey())
		try {
			// Full restart: no checkpoints survive. The signing step's claim commits; the step errors (retryable).
			const cache = new Map<string, unknown>()
			const attempt1 = createWorkflowStep(cache)
			if (phase === 'submitting') {
				// Pass 10: the unresolved legacy receipt refuses a replacement before any lock claim.
				await assert.rejects(new (testWorkflowClass())({} as ExecutionContext, h.env).run(event as never, attempt1.step as never),
					isTerminal(/dispatch outcome uncertain.*batch already submitting, refusing to sign a replacement/), label)
				assert.deepEqual(attempt1.executed.map(({ name }) => name), ['sign transaction'], label)
				assert.deepEqual(lockState(h), [], `${label}: zero lock claim`)
				assert.equal(lose, 1, `${label}: the signing claim was never even attempted`)
				assert.equal(signatures.count, 0, `${label}: zero issuer signatures`)
				assert.deepEqual(h.relayed, [], `${label}: zero relays`)
				assert.deepEqual(h.calls, [], `${label}: no tip read`)
				assert.equal(h.batchRow(event.instanceId)!.Phase, expected, label)
				for (const [lookup, statusPhase] of [
					[async () => ({ status: async () => ({ status: 'errored' }) }), errored],
					[async () => { throw new Error('instance.not_found') }, notFound],
				] as const) {
					;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = lookup
					const status = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
					const { batches } = await json(status) as { batches: Array<Record<string, unknown>> }
					assert.deepEqual(batches, [{ workflowId: event.instanceId, ids: [id], phase: statusPhase }], label)
				}
				continue
			}
			await assert.rejects(new (testWorkflowClass())({} as ExecutionContext, h.env).run(event as never, attempt1.step as never),
				(e: unknown) => e instanceof Error && e.name !== 'NonRetryableError' && /connection lost/.test(e.message), label)
			assert.deepEqual(attempt1.executed.map(({ name }) => name), ['sign transaction'], label)
			assert.deepEqual(lockState(h), [[event.instanceId, 'signing']], `${label}: the signing claim committed`)
			assert.equal(signatures.count, 0, `${label}: nothing signed yet`)
			assert.equal(h.batchRow(event.instanceId)!.Phase, phase, `${label}: the lost claim response records nothing`)

			// The wallet authorization expires before the engine retries the signing step.
			h.setTip(c.userExpirationLedger)
			const attempt2 = createWorkflowStep(cache)
			await assert.rejects(new (testWorkflowClass())({} as ExecutionContext, h.env).run(event as never, attempt2.step as never),
				isTerminal(/^Mint user authorization has expired$/), label)
			assert.deepEqual(attempt2.executed.map(({ name }) => name), ['sign transaction'], `${label}: submit intent never ran`)

			assert.equal(signatures.count, 0, `${label}: zero issuer signatures`)
			assert.deepEqual(h.relayed, [], `${label}: zero relays`)
			assert.ok(!h.calls.includes('submit'), label)
			// The DO settles this run's own signing claim cleanly...
			assert.deepEqual(lockState(h), [[event.instanceId, 'failed']], `${label}: lock signing -> failed`)
			// ...but that proves nothing about the earlier attempt's `submitting` row.
			assert.equal(h.batchRow(event.instanceId)!.Phase, expected, label)

			for (const [lookup, statusPhase] of [
				[async () => ({ status: async () => ({ status: 'errored' }) }), errored],
				[async () => { throw new Error('instance.not_found') }, notFound],
			] as const) {
				;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = lookup
				const status = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
				assert.equal(status.status, 200)
				const { batches } = await json(status) as { batches: Array<Record<string, unknown>> }
				assert.deepEqual(batches, [{ workflowId: event.instanceId, ids: [id], phase: statusPhase }], label)
			}
		} finally {
			signatures.restore()
			h.db.close()
		}
	}
})

test('P2 pass 10: a fresh signing step never authorizes a replacement over an unresolved or final legacy receipt (zero lock claim, zero signature, zero relay, D1 phase + hash intact); a definite failed + H1 still resets cleanly and re-signs', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const H1 = 'cd'.repeat(32)
	const RELAY_HASH = 'ab'.repeat(32)
	const errored = async () => ({ status: async () => ({ status: 'errored' }) })
	const notFound = async () => { throw new Error('instance.not_found') }
	// [D1 phase, hash, ledger, refusal, /mint/status progress (errored and not_found alike)]
	const rows: Array<[string, string | null, number | null, RegExp, Record<string, unknown>]> = [
		['submitted', H1, null, /dispatch outcome uncertain.*batch already submitted, refusing to sign a replacement$/, { phase: 'uncertain', txHash: H1 }],
		['submitting', null, null, /dispatch outcome uncertain.*batch already submitting, refusing to sign a replacement$/, { phase: 'uncertain' }],
		['confirmed', H1, TIP, /^Mint batch already confirmed, refusing to sign a replacement$/, { phase: 'confirmed', txHash: H1, confirmedLedger: TIP }],
		['persisted', H1, TIP, /^Mint batch already persisted, refusing to sign a replacement$/, { phase: 'persisted', txHash: H1, confirmedLedger: TIP }],
	]
	// `none`: a pre-v7 instance holds no v7 lock. `reserved`: a post-upgrade duplicate admission reserved
	// afresh (a never-signed v7 claim). Neither proves anything about the earlier relay.
	for (const lock of ['none', 'reserved'] as const) {
		for (const [phase, hash, ledger, refusal, progress] of rows) {
			const label = `${lock} / ${phase}`
			const h = harness()
			h.tracksOf(c)
			h.env.SK = TEST_ISSUER.secret()
			const event = batchEvent(c, `pass10-legacy-${phase}-${lock}`)
			claim(h, event)
			h.db.prepare('UPDATE MintBatchStatus SET Phase = ?, Tx_Hash = ?, Confirmed_Ledger = ? WHERE Workflow_Id = ?')
				.run(phase, hash, ledger, event.instanceId)
			if (lock === 'reserved') {
				await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN })
			}
			const locksBefore = lockState(h)
			const signatures = countIssuerSignatures(TEST_ISSUER.publicKey())
			try {
				const wf = new (testWorkflowClass())({} as ExecutionContext, h.env)
				// A full restart (no checkpoints) and a direct re-entry of the signer: the same refusal.
				const restart = createWorkflowStep(new Map())
				await assert.rejects(wf.run(event as never, restart.step as never), isTerminal(refusal), label)
				assert.deepEqual(restart.executed.map(({ name }) => name), ['sign transaction'], `${label}: no submit intent, no submit`)
				await assert.rejects(wf.signTransaction(event as never), isTerminal(refusal), label)
				assert.equal(signatures.count, 0, `${label}: zero issuer signatures`)
				assert.deepEqual(h.relayed, [], `${label}: zero relays`)
				assert.deepEqual(h.calls, [], `${label}: no tip read`)
				assert.deepEqual(lockState(h), locksBefore, `${label}: zero lock claim (nothing claimed, nothing released)`)
				const row = h.batchRow(event.instanceId)!
				assert.deepEqual([row.Phase, row.Tx_Hash, row.Confirmed_Ledger], [phase, hash, ledger], `${label}: D1 untouched`)
				for (const lookup of [errored, notFound]) {
					;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = lookup
					const status = await h.send('/mint/status', { workflowIds: [event.instanceId] }, FE_MINTER)
					assert.equal(status.status, 200)
					const { batches } = await json(status) as { batches: Array<Record<string, unknown>> }
					assert.deepEqual(batches, [{ workflowId: event.instanceId, ids: [id], ...progress }], label)
				}
			} finally {
				signatures.restore()
				h.db.close()
			}
		}
	}

	// Control: a definite `failed` with H1 is cleanly reset by the new attempt's submit intent and re-signed.
	for (const lock of ['none', 'reserved'] as const) {
		const label = `failed / ${lock}`
		const h = harness()
		h.tracksOf(c)
		h.env.SK = TEST_ISSUER.secret()
		const event = batchEvent(c, `pass10-failed-${lock}`)
		claim(h, event)
		h.db.prepare('UPDATE MintBatchStatus SET Phase = ?, Tx_Hash = ?, Confirmed_Ledger = ? WHERE Workflow_Id = ?')
			.run('failed', H1, TIP, event.instanceId)
		if (lock === 'reserved') {
			await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [id], stage: 'admission', claimToken: TOKEN })
		}
		;(h.env.KALE_WORKER as unknown as { getTx: unknown }).getTx = async () => { throw new Error('RPC unavailable') }
		const signatures = countIssuerSignatures(TEST_ISSUER.publicKey())
		try {
			const wf = new (testWorkflowClass())({} as ExecutionContext, h.env)
			const base = createWorkflowStep(new Map())
			let afterIntent: unknown[] | undefined
			const step = {
				...base.step,
				do: async (name: string, config: unknown, fn?: unknown) => {
					const result = await base.step.do(name, config as never, fn as never)
					if (name === 'record mint submit intent') {
						const row = h.batchRow(event.instanceId)!
						afterIntent = [row.Phase, row.Tx_Hash, row.Confirmed_Ledger, result]
					}
					return result
				},
			}
			await assert.rejects(wf.run(event as never, step as never),
				(e: unknown) => e instanceof Error && e.name !== 'NonRetryableError' && /receipt lookup unavailable/.test(e.message), label)
			assert.deepEqual(base.executed.map(({ name }) => name), [
				'sign transaction', 'record mint submit intent', 'submit transaction', 'record submitted mint', 'confirm transaction',
			], label)
			assert.deepEqual(afterIntent, ['submitting', null, null, { preSubmit: true }], `${label}: H1 cleared by the fresh attempt`)
			assert.equal(signatures.count, 1, `${label}: re-signed once`)
			assert.equal(h.relayed.length, 1, `${label}: relayed once`)
			const row = h.batchRow(event.instanceId)!
			assert.deepEqual([row.Phase, row.Tx_Hash, row.Confirmed_Ledger], ['submitted', RELAY_HASH, null], label)
			assert.deepEqual(lockState(h), [[event.instanceId, 'dispatched']], label)
		} finally {
			signatures.restore()
			h.db.close()
		}
	}
})

// ---------------------------------------------------------------------------
// Pass 11: an unresolved receipt (any workflow, any wallet) protects its songs and 12-hex prefixes
// ---------------------------------------------------------------------------

const D1_WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i
const d1Writes = (h: ReturnType<typeof harness>, from: number) => h.stats.statements.slice(from).filter((sql) => D1_WRITE.test(sql))

/** A song, a different song sharing its 12-hex prefix, and an unrelated song. */
function pass11Songs(h: ReturnType<typeof harness>) {
	const c = carrier('test/coin_it-split')
	const song = c.tracks[0]
	const twin = { id: `${song.id.slice(0, 12)}${song.id.at(12) === 'd' ? 'e' : 'd'}${'d'.repeat(51)}`, creator: OTHER_WALLET }
	const other = { id: hash(Buffer.from('pass11-unrelated')).toString('hex'), creator: OTHER_WALLET }
	assert.notEqual(twin.id, song.id)
	assert.notEqual(other.id.slice(0, 12), song.id.slice(0, 12))
	h.tracksOf(c)
	h.track(twin.id, { creator: OTHER_WALLET })
	h.track(other.id, { creator: OTHER_WALLET })
	return { song, twin, other }
}

/** A tracked coin_it workflow (signed with the test identity) for `track`, already queued in D1. */
async function queuedCoinIt(h: ReturnType<typeof harness>, track: { id: string; creator: string }, instanceId: string, nonce: bigint) {
	const xdrValue = await feCoinIt(track, nonce, TEST_IDENTITY)
	const event = batchEvent({ name: instanceId, kind: 'coin_it', sub: FE_MINTER, tracks: [track], userExpirationLedger: TIP + 500, xdr: xdrValue }, instanceId)
	claim(h, event)
	return event
}

test('P2 pass 11: a pre-v7 submitting/submitted (+ H1) receipt with no v7 lock and NULL Smols mint columns blocks a DIFFERENT workflow (new wallet authorization) for the same song or a 12-hex prefix twin: 409 at admission (zero lock claims), NonRetryableError at signing (zero lock claims, signatures, relays, D1 writes; legacy row untouched)', async () => {
	const H1 = 'cd'.repeat(32)
	const LEGACY = 'mint-legacy-pre-v7-receipt'
	for (const [phase, hashValue] of [['submitting', null], ['submitted', H1], ['confirmed', H1]] as const) {
		for (const legacyWallet of [FE_MINTER, OTHER_WALLET]) {
			const label = `${phase} / ${legacyWallet === FE_MINTER ? 'same wallet' : 'other wallet'}`
			const h = harness()
			h.env.SK = TEST_ISSUER.secret()
			const { song, twin, other } = pass11Songs(h)
			h.db.prepare(`INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase, Tx_Hash) VALUES (?, ?, ?, ?, ?)`)
				.run(LEGACY, legacyWallet, JSON.stringify([song.id]), phase, hashValue)
			const legacyRow = () => ({ ...h.batchRow(LEGACY) })
			const legacyBefore = legacyRow()
			assert.deepEqual(lockState(h), [], `${label}: a pre-v7 receipt holds no v7 lock`)
			assert.equal(h.db.prepare('SELECT Mint_Token FROM Smols WHERE Id = ?').get(song.id)!.Mint_Token, null, `${label}: Smols still unminted`)

			// (a) Admission: a new wallet authorization gets a different workflow id and is refused before any claim.
			const same = await h.send(`/mint/${song.id}`, { xdr: await feCoinIt(song, 301n) }, FE_MINTER)
			assert.equal(same.status, 409, label)
			assert.deepEqual(await json(same), { error: 'mint_in_progress', ids: [song.id] }, label)
			const twinSingle = await h.send(`/mint/${twin.id}`, { xdr: await feCoinIt(twin, 303n) }, FE_MINTER)
			assert.equal(twinSingle.status, 409, label)
			assert.deepEqual(await json(twinSingle), { error: 'prefix_conflict', code: 'prefix_reserved' }, label)
			const twinBatch = await h.send('/mint', { xdr: await feCoinThem([other, twin], 305n), ids: [other.id, twin.id] }, FE_MINTER)
			assert.equal(twinBatch.status, 409, label)
			assert.deepEqual(await json(twinBatch), { error: 'prefix_conflict', code: 'prefix_reserved' }, label)
			assert.deepEqual(lockState(h), [], `${label}: zero lock claims (nothing acquired, nothing leaked)`)
			assert.equal(h.creates.length, 0, `${label}: no workflow created`)
			assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM MintBatchStatus').get()!.n, 1, `${label}: no claim row`)
			assert.deepEqual(legacyRow(), legacyBefore, `${label}: legacy row untouched by admission`)

			// (b) Signing: a workflow that is already queued (no lock, or a provisional admission claim) for the
			// same song or the twin refuses before validation, any lock claim, any signature or any D1 write.
			for (const [target, code, nonce] of [[song, 'mint_in_progress', 401n], [twin, 'prefix_reserved', 403n]] as const) {
				for (const lock of ['none', 'reserved'] as const) {
					const sublabel = `${label} / ${code} / ${lock}`
					const event = await queuedCoinIt(h, target, `pass11-${code}-${lock}`, nonce)
					if (lock === 'reserved') {
						await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [target.id], stage: 'admission', claimToken: TOKEN })
					}
					const locksBefore = lockState(h)
					const statementsBefore = h.stats.statements.length
					const refusal = new RegExp(`^Unresolved mint receipt covers this batch \\(${code}, requires reconciliation\\), refusing to sign$`)
					const signatures = countIssuerSignatures(TEST_ISSUER.publicKey())
					try {
						const wf = new (testWorkflowClass())({} as ExecutionContext, h.env)
						const restart = createWorkflowStep(new Map())
						await assert.rejects(wf.run(event as never, restart.step as never), isTerminal(refusal), sublabel)
						assert.deepEqual(restart.executed.map(({ name }) => name), ['sign transaction'], `${sublabel}: no submit intent, no submit`)
						await assert.rejects(wf.signTransaction(event as never), isTerminal(refusal), sublabel)
						assert.equal(signatures.count, 0, `${sublabel}: zero issuer signatures`)
					} finally {
						signatures.restore()
					}
					assert.deepEqual(h.relayed, [], `${sublabel}: zero relays`)
					assert.deepEqual(h.calls, [], `${sublabel}: no tip read`)
					assert.deepEqual(lockState(h), locksBefore, `${sublabel}: zero lock claims (nothing claimed, nothing released)`)
					assert.deepEqual(d1Writes(h, statementsBefore), [], `${sublabel}: zero D1 writes`)
					assert.equal(h.batchRow(event.instanceId)!.Phase, 'queued', sublabel)
					assert.deepEqual(legacyRow(), legacyBefore, `${sublabel}: legacy row untouched`)
					if (lock === 'reserved') {
						await lockStub(h).releaseMintPrefixes({ workflowId: event.instanceId, ids: [target.id], claimToken: TOKEN })
					}
				}
			}

			// An unrelated song (different prefix) is not blocked by the receipt.
			const unrelated = await h.send(`/mint/${other.id}`, { xdr: await feCoinIt(other, 501n) }, FE_MINTER)
			assert.equal(unrelated.status, 202, label)
			h.db.close()
		}
	}
})

test('P2 pass 11: an unresolved receipt whose Ids cannot be parsed fails closed at admission (503 mint_unavailable, zero claims) and at signing (NonRetryableError, zero claims, signatures, D1 writes); the same garbage in a resolved row blocks nothing', async () => {
	const corrupt = ['not json', '[]', '{"ids":[]}', '"abc"', JSON.stringify(['abc']), JSON.stringify([7]), 'null']
	for (const [i, ids] of corrupt.entries()) {
		for (const phase of ['submitting', 'submitted', 'confirmed'] as const) {
			const label = `${phase} / ${ids}`
			const h = harness()
			h.env.SK = TEST_ISSUER.secret()
			const { song, other } = pass11Songs(h)
			h.db.prepare(`INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase) VALUES (?, ?, ?, ?)`)
				.run(`mint-corrupt-${i}`, OTHER_WALLET, ids, phase)
			// Even a song the corrupt row cannot be shown to cover is refused: its prefixes are unknown.
			for (const target of [song, other]) {
				const response = await h.send(`/mint/${target.id}`, { xdr: await feCoinIt(target, 601n) }, FE_MINTER)
				assert.equal(response.status, 503, label)
				assert.deepEqual(await json(response), { error: 'mint_unavailable' }, label)
			}
			const batch = await h.send('/mint', { xdr: await feCoinThem([song, other], 603n), ids: [song.id, other.id] }, FE_MINTER)
			assert.equal(batch.status, 503, label)
			assert.deepEqual(lockState(h), [], `${label}: zero lock claims`)
			assert.equal(h.creates.length, 0, label)

			const event = await queuedCoinIt(h, other, `pass11-corrupt-${i}-${phase}`, 605n)
			const statementsBefore = h.stats.statements.length
			const signatures = countIssuerSignatures(TEST_ISSUER.publicKey())
			try {
				await assert.rejects(new (testWorkflowClass())({} as ExecutionContext, h.env).signTransaction(event as never),
					isTerminal(/^Unresolved mint receipt covers this batch \(receipt_unreadable, requires reconciliation\), refusing to sign$/), label)
				assert.equal(signatures.count, 0, `${label}: zero issuer signatures`)
			} finally {
				signatures.restore()
			}
			assert.deepEqual(lockState(h), [], `${label}: zero lock claims`)
			assert.deepEqual(d1Writes(h, statementsBefore), [], `${label}: zero D1 writes`)
			assert.deepEqual(h.relayed, [], label)
			h.db.close()
		}
	}

	// Control: resolved and pre-submit phases are never parsed as receipts, so the same garbage blocks nothing.
	for (const phase of ['failed', 'persisted', 'queued', 'unverified', 'existing'] as const) {
		const h = harness()
		const { other } = pass11Songs(h)
		h.db.prepare(`INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase) VALUES (?, ?, ?, ?)`)
			.run('mint-corrupt-resolved', OTHER_WALLET, 'not json', phase)
		const response = await h.send(`/mint/${other.id}`, { xdr: await feCoinIt(other, 701n) }, FE_MINTER)
		assert.equal(response.status, 202, phase)
		h.db.close()
	}
})

test('P2 pass 11: a definite failed (+ H1), pre-submit or persisted receipt of another workflow never blocks a new valid attempt: admission 202 and the signer claims and signs once', async () => {
	const H1 = 'cd'.repeat(32)
	for (const phase of ['failed', 'queued', 'unverified', 'existing', 'persisted'] as const) {
		for (const target of ['song', 'twin'] as const) {
			const label = `${phase} / ${target}`
			const h = harness()
			h.env.SK = TEST_ISSUER.secret()
			const songs = pass11Songs(h)
			const track = songs[target]
			// The other workflow's receipt covers `song` (whose Smols mint columns are still NULL).
			h.db.prepare(`INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase, Tx_Hash) VALUES (?, ?, ?, ?, ?)`)
				.run('mint-other-attempt', OTHER_WALLET, JSON.stringify([songs.song.id]), phase, phase === 'failed' || phase === 'persisted' ? H1 : null)

			const admitted = await h.send(`/mint/${track.id}`, { xdr: await feCoinIt(track, 801n) }, FE_MINTER)
			assert.equal(admitted.status, 202, label)
			const { workflowId } = await json(admitted) as { workflowId: string }
			assert.deepEqual(lockState(h), [[workflowId, 'reserved']], label)

			// Signing: a separate queued workflow with its own provisional claim (the admitted one is dropped).
			h.db.prepare('DELETE FROM MintBatchStatus WHERE Workflow_Id = ?').run(workflowId)
			const lockDb = h.quota.instances.get(MINT_PREFIX_LOCK_OBJECT)!.db
			lockDb.prepare('DELETE FROM mint_prefix_locks').run()
			const event = await queuedCoinIt(h, track, `pass11-control-${phase}-${target}`, 803n)
			await lockStub(h).reserveMintPrefixes({ workflowId: event.instanceId, ids: [track.id], stage: 'admission', claimToken: TOKEN })
			const signatures = countIssuerSignatures(TEST_ISSUER.publicKey())
			try {
				const signed = await new (testWorkflowClass())({} as ExecutionContext, h.env).signTransaction(event as never)
				assert.equal(typeof signed, 'string', label)
				assert.equal(signatures.count, 1, `${label}: signed once`)
			} finally {
				signatures.restore()
			}
			assert.deepEqual(lockState(h), [[event.instanceId, 'signing']], label)
			assert.equal(h.batchRow('mint-other-attempt')!.Phase, phase, `${label}: the other receipt is untouched`)
			h.db.close()
		}
	}
})

// ---------------------------------------------------------------------------
// Pass 12: a signer refusal leaves its own `queued` row untouched (zero D1 writes), so /mint/status must
// not fall back to `queued` once the errored instance is definitively gone (instance.not_found).
// ---------------------------------------------------------------------------

type StatusLookup = () => Promise<never | { status: () => Promise<{ status: string }> }>
const lookupErrored: StatusLookup = async () => ({ status: async () => ({ status: 'errored' }) })
const lookupNotFound: StatusLookup = async () => { throw new Error('instance.not_found') }
const lookupNotFoundCode: StatusLookup = async () => { throw Object.assign(new Error('Missing instance'), { code: 'instance.not_found' }) }
const lookupTransient: StatusLookup = async () => { throw new Error('Workflows API unavailable') }

async function statusOf(h: ReturnType<typeof harness>, workflowId: string, get: StatusLookup) {
	;(h.env.TX_WORKFLOW as unknown as { get: unknown }).get = get
	const statementsBefore = h.stats.statements.length
	const response = await h.send('/mint/status', { workflowIds: [workflowId] }, FE_MINTER)
	assert.equal(response.status, 200)
	assert.deepEqual(d1Writes(h, statementsBefore), [], 'the status reader never writes D1')
	const { batches } = await json(response) as { batches: Array<Record<string, unknown>> }
	assert.equal(batches.length, 1)
	return batches[0]
}

test('P2 pass 12: a signer refused by (a) a conflicting unresolved receipt or (b) an unreadable receipt writes zero D1 rows; /mint/status reads failed while the errored instance exists and uncertain (never queued) after definitive instance.not_found; a transient lookup failure keeps the D1 checkpoint', async () => {
	const H1 = 'cd'.repeat(32)
	const refusals = [
		{ kind: 'conflicting', code: 'mint_in_progress', receipt: (song: { id: string }) => [JSON.stringify([song.id]), 'submitted', H1] },
		{ kind: 'conflicting prefix', code: 'prefix_reserved', receipt: (song: { id: string }) => [JSON.stringify([song.id]), 'submitting', null] },
		{ kind: 'unreadable', code: 'receipt_unreadable', receipt: () => ['not json', 'submitted', H1] },
		{ kind: 'unreadable', code: 'receipt_unreadable', receipt: () => [JSON.stringify(['abc']), 'confirmed', H1] },
	] as const
	for (const [i, { kind, code, receipt }] of refusals.entries()) {
		const h = harness()
		h.env.SK = TEST_ISSUER.secret()
		const { song, twin, other } = pass11Songs(h)
		const [ids, phase, hashValue] = receipt(song)
		const label = `${kind} / ${code} / ${phase}`
		h.db.prepare(`INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase, Tx_Hash) VALUES (?, ?, ?, ?, ?)`)
			.run(`mint-blocking-${i}`, OTHER_WALLET, ids, phase, hashValue)
		const blockingBefore = { ...h.batchRow(`mint-blocking-${i}`) }
		const target = code === 'prefix_reserved' ? twin : code === 'receipt_unreadable' ? other : song
		const event = await queuedCoinIt(h, target, `pass12-refused-${i}`, 901n + BigInt(i))
		const rowBefore = { ...h.batchRow(event.instanceId) }
		assert.equal(rowBefore.Phase, 'queued', label)

		// The signer refuses before any lock claim, signature, relay or D1 write.
		const statementsBefore = h.stats.statements.length
		const signatures = countIssuerSignatures(TEST_ISSUER.publicKey())
		const refusal = new RegExp(`^Unresolved mint receipt covers this batch \\(${code}, requires reconciliation\\), refusing to sign$`)
		try {
			const restart = createWorkflowStep(new Map())
			await assert.rejects(new (testWorkflowClass())({} as ExecutionContext, h.env).run(event as never, restart.step as never), isTerminal(refusal), label)
			assert.deepEqual(restart.executed.map(({ name }) => name), ['sign transaction'], `${label}: no submit intent, no submit`)
			assert.equal(signatures.count, 0, `${label}: zero issuer signatures`)
		} finally {
			signatures.restore()
		}
		assert.deepEqual(d1Writes(h, statementsBefore), [], `${label}: zero D1 writes by the signer`)
		assert.deepEqual(h.relayed, [], `${label}: zero relays`)
		assert.deepEqual(lockState(h), [], `${label}: zero lock claims`)
		assert.deepEqual({ ...h.batchRow(event.instanceId) }, rowBefore, `${label}: own queued row untouched`)
		assert.deepEqual({ ...h.batchRow(`mint-blocking-${i}`) }, blockingBefore, `${label}: blocking receipt untouched`)

		// Errored instance still retained: failed.
		assert.deepEqual(await statusOf(h, event.instanceId, lookupErrored), { workflowId: event.instanceId, ids: [target.id], phase: 'failed' }, `${label}: errored`)
		// Instance expired (both error shapes): never queued again; the row needs no pending UI.
		for (const get of [lookupNotFound, lookupNotFoundCode]) {
			assert.deepEqual(await statusOf(h, event.instanceId, get), { workflowId: event.instanceId, ids: [target.id], phase: 'uncertain' }, `${label}: instance.not_found`)
		}
		// A transient lookup failure is not absence: the durable D1 checkpoint (queued) is reported.
		assert.deepEqual(await statusOf(h, event.instanceId, lookupTransient), { workflowId: event.instanceId, ids: [target.id], phase: 'queued' }, `${label}: transient`)
		assert.deepEqual({ ...h.batchRow(event.instanceId) }, rowBefore, `${label}: status reads leave the row untouched`)
		h.db.close()
	}
})

test('P2 pass 12: /mint/status per D1 phase — definitive instance.not_found never reports queued (queued/existing/submitting/submitted -> uncertain, unverified -> failed, confirmed stays confirmed); a transient lookup failure keeps the D1 checkpoint', async () => {
	const c = carrier('test/coin_it-split')
	const id = c.tracks[0].id
	const H = 'cd'.repeat(32)
	// [D1 phase, hash, ledger, expected on not_found, expected on transient lookup failure]
	const cases: Array<[string, string | null, number | null, Record<string, unknown>, Record<string, unknown>]> = [
		['queued', null, null, { phase: 'uncertain' }, { phase: 'queued' }],
		['existing', null, null, { phase: 'uncertain' }, { phase: 'uncertain' }],
		// Existing contract (flow-chain-and-cache): an ambiguous create proven absent never signed.
		['unverified', null, null, { phase: 'failed' }, { phase: 'uncertain' }],
		['submitting', null, null, { phase: 'uncertain' }, { phase: 'queued' }],
		['submitted', H, null, { phase: 'uncertain', txHash: H }, { phase: 'submitted', txHash: H }],
		['confirmed', H, TIP, { phase: 'confirmed', txHash: H, confirmedLedger: TIP }, { phase: 'confirmed', txHash: H, confirmedLedger: TIP }],
		['failed', H, null, { phase: 'failed', txHash: H }, { phase: 'failed', txHash: H }],
		['persisted', H, TIP, { phase: 'persisted', txHash: H, confirmedLedger: TIP }, { phase: 'persisted', txHash: H, confirmedLedger: TIP }],
	]
	for (const [phase, hashValue, ledger, onNotFound, onTransient] of cases) {
		const h = harness()
		h.tracksOf(c)
		const event = batchEvent(c, `pass12-status-${phase}`)
		claim(h, event)
		h.db.prepare('UPDATE MintBatchStatus SET Phase = ?, Tx_Hash = ?, Confirmed_Ledger = ? WHERE Workflow_Id = ?').run(phase, hashValue, ledger, event.instanceId)
		for (const get of [lookupNotFound, lookupNotFoundCode]) {
			const batch = await statusOf(h, event.instanceId, get)
			assert.deepEqual(batch, { workflowId: event.instanceId, ids: [id], ...onNotFound }, `${phase}: instance.not_found`)
			assert.notEqual(batch.phase, 'queued', `${phase}: never queued after instance.not_found`)
		}
		assert.deepEqual(await statusOf(h, event.instanceId, lookupTransient), { workflowId: event.instanceId, ids: [id], ...onTransient }, `${phase}: transient`)
		h.db.close()
	}
})
