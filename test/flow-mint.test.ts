import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import { nativeToScVal, Networks, xdr } from '@stellar/stellar-sdk/minimal'
import { deriveMintPair } from '../src/utils/chain'
import { reserveMintPrefixes } from '../src/utils/mint-eligibility'
import {
	createAuthToken,
	createMockExecutionContext,
	createMockUserQuotaNamespace,
	createWorkflowStep,
	installCloudflareStubs,
	type CloudflareStubHandle,
} from './helpers/harness'

let stubs: CloudflareStubHandle
let txWorkflowModule: typeof import('../src/tx-workflow')
let appModule: typeof import('../src/index')

const TEST_SECRET = 'test-jwt-secret-32-chars-minimum!'
const MINTER_SUB = 'GMINTERSUB00000000000000'
const SINGLE_ID = 'a'.repeat(64)
const SINGLE_PAIR = deriveMintPair(SINGLE_ID)!
const OWNER_SUB = 'GOWNERSUB000000000000000'

before(async () => {
	stubs = installCloudflareStubs({
		CF_API_TOKEN: 'cf-token',
		CF_ZONE_ID: 'cf-zone',
	})
	txWorkflowModule = await import('../src/tx-workflow')
	appModule = await import('../src/index')
})

after(() => {
	stubs.cleanup()
})

function buildMockEnvelopeAndResultXdr() {
	const envelopeXdr = new xdr.TransactionEnvelope.envelopeTypeTx(
		new xdr.TransactionV1Envelope({
			tx: new xdr.Transaction({
				sourceAccount: xdr.MuxedAccount.keyTypeEd25519(Buffer.alloc(32, 1)),
				fee: 100,
				seqNum: xdr.Int64.fromString('1'),
				cond: xdr.Preconditions.precondNone(),
				memo: xdr.Memo.memoNone(),
				operations: [],
				ext: new xdr.TransactionExt(0),
			}),
			signatures: [],
		})
	).toXDR('base64')

	const resultXdr = new xdr.TransactionResult({
		feeCharged: xdr.Int64.fromString('100'),
		result: xdr.TransactionResultResult.txSuccess([]),
		ext: new xdr.TransactionResultExt(0),
	}).toXDR('base64')

	return { envelopeXdr, resultXdr }
}

function buildReturnValueMetaB64(nativeVal: unknown): string {
	const scVal = nativeToScVal(nativeVal)
	const meta = new xdr.TransactionMeta(3, new xdr.TransactionMetaV3({
		ext: new xdr.ExtensionPoint(0),
		txChangesBefore: [],
		operations: [],
		txChangesAfter: [],
		sorobanMeta: new xdr.SorobanTransactionMeta({
			ext: new xdr.SorobanTransactionMetaExt(0),
			events: [],
			returnValue: scVal,
			diagnosticEvents: [],
		}),
	}))
	return meta.toXDR('base64')
}

/**
 * Replaces the issuer signer with a stub that behaves like production at its boundary: it takes the
 * authoritative `signing` claim first (the submit step's durable dispatch marker requires it), then
 * returns the stub output. The lock store is reset so independent sub-cases never share claims.
 */
function stubClaimingSigner(
	wf: InstanceType<typeof import('../src/tx-workflow').TxWorkflow>,
	env: Env,
	output: (event: { payload: WorkflowTxParams }) => string,
) {
	resetMintLocks(env)
	wf.signTransaction = async (event) => {
		const ids = event.payload.type === 'mint' ? [event.payload.entropy!] : event.payload.mintableIds ?? event.payload.ids ?? []
		await reserveMintPrefixes(env, event.instanceId, ids, 'signing')
		return output(event)
	}
}

function resetMintLocks(env: Env) {
	delete (env as unknown as { USER_QUOTA?: unknown }).USER_QUOTA
	createMockUserQuotaNamespace(appModule.UserQuotaDO, env)
}

function createMintEnv(initialRows: Record<string, { Address: string; Mint_Token: string | null; Mint_Amm: string | null }>) {
	const rows = new Map(Object.entries(initialRows).map(([k, v]) => [k, { Id: k, Title: `Smol ${k}`, ...v }]))
	let batchCalls = 0
	const txWorkflowCreates: Array<{ id?: string; params: WorkflowTxParams }> = []
	const seenWorkflowIds = new Set<string>()
	const workflowOwners = new Map<string, string>()
	let relaySubmitCalls = 0
	let relayResponder: (input: { xdr: string }) => Promise<{ hash?: string; error?: string; errorCode?: string }> = async () => ({
		hash: 'relay-hash-abc123',
	})

	const d1 = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					const run = async () => {
						if (sql.includes('UPDATE Smols') && sql.includes('SET Mint_Token = ?1, Mint_Amm = ?2')) {
							const [token, amm, id] = args.map(String)
							const row = rows.get(id)
							if (row && row.Mint_Token === null && row.Mint_Amm === null) {
								row.Mint_Token = token
								row.Mint_Amm = amm
								return { success: true, meta: { changes: 1 } }
							}
							return { success: true, meta: { changes: 0 } }
						}
						return { success: true, meta: { changes: 0 } }
					}
					return {
						run,
						first: async () => {
							if (sql.includes('INSERT INTO MintBatchStatus')) {
								const [id, owner] = args.map(String)
								if (workflowOwners.has(id) && workflowOwners.get(id) !== owner) return null
								workflowOwners.set(id, owner)
								return { Workflow_Id: id }
							}
							if (sql.includes('FROM Smols WHERE Id = ?1')) {
								return rows.get(String(args[0])) ?? null
							}
							return null
						},
						all: async () => {
							if (sql.includes('FROM Smols WHERE Id IN')) {
								const matched = args.map((id) => rows.get(String(id))).filter(Boolean)
								return { results: matched }
							}
							return { results: [] }
						},
					}
				},
			}
		},
		async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
			batchCalls += 1
			const out = []
			for (const stmt of stmts) out.push(await stmt.run())
			return out
		},
	}

	const env = {
		SECRET: TEST_SECRET,
		RPC_URL: 'https://rpc.test.local/',
		NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
		MINT_SIGNING_ENABLED: 'true',
		SMOL_CONTRACT_ID: 'CBRNUVLGFM5OYWAGZVGU7CTMP2UJLKZCLFY2ANUCK5UGKND6BBAA5PLA',
		SK: 'SB7ZMPZB3Y23V4M7D6R5W3Q4A2V4X5J7H7Y5A2K6R3M5W7Q4P2Z5X6A7',
		SMOL_D1: d1,
		KALE_WORKER: {
			submitTransaction: async (input: { xdr: string }) => {
				relaySubmitCalls += 1
				return await relayResponder(input)
			},
		},
		TX_WORKFLOW: {
			create: async ({ id, params }: { id?: string; params: WorkflowTxParams }) => {
				if (id && seenWorkflowIds.has(id)) {
					throw new Error(`Workflow instance ${id} already exists`)
				}
				if (id) seenWorkflowIds.add(id)
				txWorkflowCreates.push({ id, params })
				return { id }
			},
		},
	} as unknown as Env

	return {
		env,
		rows,
		getBatchCalls: () => batchCalls,
		getRelaySubmitCalls: () => relaySubmitCalls,
		setRelayResponder: (fn: typeof relayResponder) => { relayResponder = fn },
		txWorkflowCreates,
	}
}

test('Gate 3a: TxWorkflow splits submit vs confirm so confirmation retry never double-submits relay, and purges all affected cache tags', async () => {
	const harness = createMintEnv({
		[SINGLE_ID]: { Address: OWNER_SUB, Mint_Token: null, Mint_Amm: null },
	})
	const resultMetaB64 = buildReturnValueMetaB64([SINGLE_PAIR.sac, SINGLE_PAIR.pool])
	const { envelopeXdr, resultXdr } = buildMockEnvelopeAndResultXdr()
	const purgedTags: string[][] = []
	let rpcCalls = 0

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('rpc.test.local')) {
			rpcCalls += 1
			// First confirmation attempt hits transient RPC 500; second succeeds with relay hash!
			if (rpcCalls === 1) {
				return new Response('rpc transient error', { status: 500 })
			}
			const body = JSON.parse(String(init?.body ?? '{}'))
			assert.equal(body.params?.hash, 'relay-hash-abc123', 'Confirm step must poll returned relay hash')
			return new Response(JSON.stringify({
				jsonrpc: '2.0',
				id: body.id ?? 1,
				result: {
					status: 'SUCCESS',
					latestLedger: 100,
					latestLedgerCloseTime: '1700000000',
					oldestLedger: 1,
					oldestLedgerCloseTime: '1690000000',
					envelopeXdr,
					resultXdr,
					resultMetaXdr: resultMetaB64,
				},
			}), { status: 200, headers: { 'Content-Type': 'application/json' } })
		}
		if (url.includes('/purge_cache')) {
			const parsed = JSON.parse(String(init?.body ?? '{}')) as { tags: string[] }
			purgedTags.push(parsed.tags)
			return new Response(JSON.stringify({ success: true }), { status: 200 })
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const wf = new txWorkflowModule.TxWorkflow({} as ExecutionContext, harness.env)
		stubClaimingSigner(wf, harness.env, (event) => `signed:${event.payload.xdr}`)

		const cache = new Map<string, unknown>()
		const event = {
			payload: {
				type: 'mint' as const,
				entropy: SINGLE_ID,
				xdr: 'unsigned-xdr',
				sub: MINTER_SUB,
				ownerSub: OWNER_SUB,
			},
			instanceId: 'mint-inst-1',
			timestamp: new Date(),
		}

		// Run 1: sign + submit succeed, confirm fails transiently -> throws
		const run1 = createWorkflowStep(cache)
		await assert.rejects(() => wf.run(event as never, run1.step as never))
		assert.equal(harness.getRelaySubmitCalls(), 1)
		const submitStep = run1.executed.find((s) => s.name === 'submit transaction')
		assert.equal((submitStep?.config as { retries?: { limit: number } })?.retries?.limit, 0)

		// Run 2 (replay): sign + submit come from cache, ONLY confirm + persist run!
		const run2 = createWorkflowStep(cache)
		await wf.run(event as never, run2.step as never)
		assert.equal(harness.getRelaySubmitCalls(), 1, 'Relay submitTransaction must be called EXACTLY ONCE across confirm replay')
		assert.equal(harness.rows.get(SINGLE_ID)?.Mint_Token, SINGLE_PAIR.sac)
		assert.equal(harness.rows.get(SINGLE_ID)?.Mint_Amm, SINGLE_PAIR.pool)

		// Mint changes public list metadata as well as individual Smol metadata.
		const allTags = purgedTags.flat()
		assert.equal(allTags.includes('public-smols'), true)
		assert.equal(allTags.includes('mixtapes'), true)
		assert.ok(allTags.includes(`smol:${SINGLE_ID}:anonymous`))
		assert.ok(allTags.includes(`artist:${OWNER_SUB}:smols`))
	} finally {
		globalThis.fetch = originalFetch
	}
})

function buildCoinThemXdr(smolIds: string[]): string {
	const saltVals = smolIds.map((id) =>
		xdr.ScVal.scvBytes(Buffer.from(id.padStart(64, '0'), 'hex'))
	)
	const invokeOp = new xdr.Operation({
		body: xdr.OperationBody.invokeHostFunction(
			new xdr.InvokeHostFunctionOp({
				hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
					new xdr.InvokeContractArgs({
						contractAddress: xdr.ScAddress.scAddressTypeContract(Buffer.alloc(32, 7)),
						functionName: 'coin_them',
						args: [
							xdr.ScVal.scvBytes(Buffer.alloc(32, 2)), // user placeholder
							xdr.ScVal.scvVec([]), // asset_bytes placeholder
							xdr.ScVal.scvVec(saltVals), // salts: Vec<BytesN<32>>
							xdr.ScVal.scvVec([]), // fee_rules placeholder
						],
					})
				),
				auth: [],
			})
		),
	})

	return new xdr.TransactionEnvelope.envelopeTypeTx(
		new xdr.TransactionV1Envelope({
			tx: new xdr.Transaction({
				sourceAccount: xdr.MuxedAccount.keyTypeEd25519(Buffer.alloc(32, 1)),
				fee: 100,
				seqNum: xdr.Int64.fromString('1'),
				cond: xdr.Preconditions.precondNone(),
				memo: xdr.Memo.memoNone(),
				operations: [invokeOp],
				ext: new xdr.TransactionExt(0),
			}),
			signatures: [],
		})
	).toXDR('base64')
}

test('Gate 3b: batch mint maps reversed contract push_front tuples to signed coin_them salts, uses D1.batch, handles replay/conflicts, and rejects terminal FAILED or lost relay', async () => {
	// Two distinguishable hex smol IDs matching real 64-char smol IDs
	const smolA = 'a'.repeat(64)
	const smolB = 'b'.repeat(64)
	const harness = createMintEnv({
		[smolA]: { Address: OWNER_SUB, Mint_Token: null, Mint_Amm: null },
		[smolB]: { Address: OWNER_SUB, Mint_Token: null, Mint_Amm: null },
		'conflict': { Address: OWNER_SUB, Mint_Token: 'COTHER', Mint_Amm: 'CAMMOTHER' },
	})
	// Signed coin_them invocation has salts in forward order: [smolA, smolB].
	// The Rust contract calls `results.push_front(coin_it(...))` for each salt,
	// so the contract return value is REVERSED: [result_for_smolB, result_for_smolA]!
	const batchXdr = buildCoinThemXdr([smolA, smolB])
	const reversedContractReturn = [['CTOK_B', 'CAMM_B'], ['CTOK_A', 'CAMM_A']]
	const batchMetaB64 = buildReturnValueMetaB64(reversedContractReturn)
	const { envelopeXdr, resultXdr } = buildMockEnvelopeAndResultXdr()
	let rpcStatus: 'SUCCESS' | 'FAILED' = 'SUCCESS'

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('rpc.test.local')) {
			const body = JSON.parse(String(init?.body ?? '{}'))
			return new Response(JSON.stringify({
				jsonrpc: '2.0',
				id: body.id ?? 1,
				result: {
					status: rpcStatus,
					latestLedger: 100,
					latestLedgerCloseTime: '1700000000',
					oldestLedger: 1,
					oldestLedgerCloseTime: '1690000000',
					envelopeXdr,
					resultXdr,
					resultMetaXdr: batchMetaB64,
				},
			}), { status: 200, headers: { 'Content-Type': 'application/json' } })
		}
		if (url.includes('/purge_cache')) {
			return new Response(JSON.stringify({ success: true }), { status: 200 })
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const wf = new txWorkflowModule.TxWorkflow({} as ExecutionContext, harness.env)
		stubClaimingSigner(wf, harness.env, (event) => event.payload.xdr)

		const event = {
			payload: {
				type: 'batch-mint' as const,
				// Deliberately test forward-order ids matching frontend useMixtapeMinting.ts
				ids: [smolA, smolB],
				mintableIds: [smolA, smolB],
				xdr: batchXdr,
				sub: MINTER_SUB,
				ownerSubsById: { [smolA]: OWNER_SUB, [smolB]: OWNER_SUB },
			},
			instanceId: 'batch-1',
			timestamp: new Date(),
		}

		// Happy path uses single D1.batch() AND attributes reversed push_front tuples to the RIGHT smols!
		await wf.run(event as never, createWorkflowStep(new Map()).step as never)
		assert.equal(harness.getBatchCalls(), 1)
		assert.equal(harness.rows.get(smolA)?.Mint_Token, 'CTOK_A', 'smolA must get CTOK_A (reversed from push_front)')
		assert.equal(harness.rows.get(smolA)?.Mint_Amm, 'CAMM_A')
		assert.equal(harness.rows.get(smolB)?.Mint_Token, 'CTOK_B', 'smolB must get CTOK_B (reversed from push_front)')
		assert.equal(harness.rows.get(smolB)?.Mint_Amm, 'CAMM_B')

		// Identical persist replay succeeds idempotently (matching stored token/AMM!)
		const replayCache = new Map<string, unknown>([
			['sign transaction#1', batchXdr],
			['submit transaction#1', { hash: 'relay-hash-abc123' }],
			['confirm transaction#1', nativeToScVal(reversedContractReturn).toXDR('base64')],
		])
		await wf.run(event as never, createWorkflowStep(replayCache).step as never)

		// Non-coin_them XDR is rejected with NonRetryableError instead of silently misattributing
		await assert.rejects(
			() => wf.run(
				{
					payload: { ...event.payload, xdr: envelopeXdr },
					instanceId: 'batch-bad-xdr',
					timestamp: new Date(),
				} as never,
				createWorkflowStep(new Map([
					['sign transaction#1', envelopeXdr],
					['submit transaction#1', { hash: 'relay-hash-abc123' }],
					['confirm transaction#1', nativeToScVal(reversedContractReturn).toXDR('base64')],
				])).step as never
			),
			(err: unknown) => err instanceof Error && err.name === 'NonRetryableError' && /coin_them/i.test(err.message)
		)

		// Conflicting stored token/AMM throws NonRetryableError (observable conflict!)
		const conflictCache = new Map<string, unknown>([
			['sign transaction#1', 'signed:x'],
			['submit transaction#1', { hash: 'relay-hash-abc123' }],
			['confirm transaction#1', nativeToScVal(['CTOK_NEW', 'CAMM_NEW']).toXDR('base64')],
		])
		await assert.rejects(
			() => wf.run(
				{
					payload: { type: 'mint', entropy: 'conflict', xdr: 'x', sub: MINTER_SUB, ownerSub: OWNER_SUB },
					instanceId: 'conflict-1',
					timestamp: new Date(),
				} as never,
				createWorkflowStep(conflictCache).step as never
			),
			(err: unknown) => err instanceof Error && err.name === 'NonRetryableError' && /conflict/i.test(err.message)
		)

		// Terminal on-chain FAILED throws NonRetryableError
		rpcStatus = 'FAILED'
		resetMintLocks(harness.env)
		await assert.rejects(
			() => wf.run(event as never, createWorkflowStep(new Map()).step as never),
			(err: unknown) => err instanceof Error && err.name === 'NonRetryableError' && /failed on-chain/i.test(err.message)
		)

		// Lost relay response throws NonRetryableError without silently resubmitting
		harness.setRelayResponder(async () => {
			throw new Error('relay socket hung up')
		})
		const submitsBefore = harness.getRelaySubmitCalls()
		await assert.rejects(
			() => wf.run(event as never, createWorkflowStep(new Map()).step as never),
			(err: unknown) => err instanceof Error && err.name === 'NonRetryableError' && /unknown/i.test(err.message)
		)
		assert.equal(harness.getRelaySubmitCalls(), submitsBefore + 1)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Gate 3c: POST /mint/:id and POST /mint deduplicate identical submissions and keep 202 response formats', async () => {
	const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'mint-authz', 'fe-carriers.json'), 'utf8')) as {
		carriers: Array<{ name: string; sub: string; xdr: string; tracks: Array<{ id: string; creator: string }> }>
	}
	const single = fixtures.carriers.find((c) => c.name === 'mainnet/coin_it-split')!
	const batch = fixtures.carriers.find((c) => c.name === 'mainnet/coin_them-2')!
	const singleId = single.tracks[0].id
	const batchIds = batch.tracks.map(({ id }) => id)
	const harness = createMintEnv({
		[singleId]: { Address: single.tracks[0].creator, Public: 1, Mint_Token: null, Mint_Amm: null },
		...Object.fromEntries(batch.tracks.map(({ id, creator }) => [id, { Address: creator, Public: 1, Mint_Token: null, Mint_Amm: null }])),
	} as never)
	// Admission validates real mainnet carriers, so the route runs with the production identity.
	const env = harness.env as unknown as Record<string, unknown>
	env.NETWORK_PASSPHRASE = Networks.PUBLIC
	createMockUserQuotaNamespace(appModule.UserQuotaDO, harness.env)
	const token = await createAuthToken(single.sub, TEST_SECRET)
	const ctx = createMockExecutionContext()
	const post = (path: string, body: unknown) => appModule.app.fetch(
		new Request(`https://api.smol.xyz${path}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
		harness.env,
		ctx.ctx
	)

	// Duplicate single mint requests return the same workflow ID and create one instance
	const s1 = await post(`/mint/${singleId}`, { xdr: single.xdr })
	const s2 = await post(`/mint/${singleId}`, { xdr: single.xdr })
	assert.equal(s1.status, 202)
	assert.equal(s2.status, 202)
	const first = await s1.json() as { workflowId: string }
	assert.match(first.workflowId, /^mint-[0-9a-f]{48}$/)
	assert.deepEqual(await s2.json(), first)
	assert.equal(harness.txWorkflowCreates.length, 1, 'Duplicate identical mint request must deduplicate')

	// Batch mint returns 202 JSON and deduplicates repeat calls
	const b1 = await post('/mint', { xdr: batch.xdr, ids: batchIds })
	assert.equal(b1.status, 202)
	const firstBatch = await b1.json() as { workflowId: string }
	assert.match(firstBatch.workflowId, /^batch-mint-[0-9a-f]{48}$/)
	assert.deepEqual(firstBatch, {
		workflowId: firstBatch.workflowId,
		acceptedIds: batchIds,
		skipped: { alreadyMinted: [] },
	})
	assert.equal(harness.txWorkflowCreates.length, 2)

	const b2 = await post('/mint', { xdr: batch.xdr, ids: batchIds })
	assert.equal(b2.status, 202)
	assert.deepEqual(await b2.json(), firstBatch)
	assert.equal(harness.txWorkflowCreates.length, 2, 'Duplicate batch mint request must deduplicate')

	// A signed batch that still contains an already-minted song can never land: 409, no workflow.
	harness.rows.get(batchIds[1])!.Mint_Token = 'CEXIST'
	harness.rows.get(batchIds[1])!.Mint_Amm = 'CAMMEXIST'
	const stale = await post('/mint', { xdr: batch.xdr, ids: batchIds })
	assert.equal(stale.status, 409)
	assert.deepEqual(await stale.json(), { error: 'stale_batch', alreadyMinted: [batchIds[1]] })
	assert.equal(harness.txWorkflowCreates.length, 2)
})

test('A2: a relay error that still carries a valid 64-hex hash is checkpointed and confirmed, never dropped', async () => {
	const harness = createMintEnv({
		[SINGLE_ID]: { Address: OWNER_SUB, Mint_Token: null, Mint_Amm: null },
	})
	const relayHash = 'AB'.repeat(32)
	harness.setRelayResponder(async () => ({ hash: relayHash, error: 'WAIT_TIMEOUT', errorCode: 'WAIT_TIMEOUT' }))
	const resultMetaB64 = buildReturnValueMetaB64([SINGLE_PAIR.sac, SINGLE_PAIR.pool])
	const { envelopeXdr, resultXdr } = buildMockEnvelopeAndResultXdr()
	const polledHashes: string[] = []

	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (url.includes('rpc.test.local')) {
			const body = JSON.parse(String(init?.body ?? '{}'))
			polledHashes.push(body.params?.hash)
			return Response.json({
				jsonrpc: '2.0',
				id: body.id ?? 1,
				result: {
					status: 'SUCCESS',
					latestLedger: 100,
					latestLedgerCloseTime: '1700000000',
					oldestLedger: 1,
					oldestLedgerCloseTime: '1690000000',
					envelopeXdr,
					resultXdr,
					resultMetaXdr: resultMetaB64,
				},
			})
		}
		if (url.includes('/purge_cache')) return Response.json({ success: true })
		throw new Error(`Unexpected fetch: ${url}`)
	}) as typeof fetch

	try {
		const wf = new txWorkflowModule.TxWorkflow({} as ExecutionContext, harness.env)
		stubClaimingSigner(wf, harness.env, (event) => `signed:${event.payload.xdr}`)
		const event = {
			payload: { type: 'mint' as const, entropy: SINGLE_ID, xdr: 'unsigned-xdr', sub: MINTER_SUB, ownerSub: OWNER_SUB },
			instanceId: 'mint-a2-hash',
			timestamp: new Date(),
		}

		const cache = new Map<string, unknown>()
		await wf.run(event as never, createWorkflowStep(cache).step as never)
		assert.equal(harness.getRelaySubmitCalls(), 1)
		assert.deepEqual(cache.get('submit transaction#1'), { hash: relayHash.toLowerCase() }, 'relay hash is checkpointed')
		assert.ok(polledHashes.length > 0 && polledHashes.every((h) => h === relayHash.toLowerCase()), 'confirm polls the relay hash')
		assert.equal(harness.rows.get(SINGLE_ID)?.Mint_Token, SINGLE_PAIR.sac, 'landed mint is persisted')

		// An error with no usable hash is still a hard stop (no confirm, no duplicate submit).
		for (const response of [{ error: 'WAIT_TIMEOUT' }, { hash: 'not-a-hash', error: 'ONCHAIN_FAILED' }]) {
			harness.setRelayResponder(async () => response)
			resetMintLocks(harness.env)
			polledHashes.length = 0
			await assert.rejects(
				() => wf.run({ ...event, instanceId: `mint-a2-${response.error}` } as never, createWorkflowStep(new Map()).step as never),
				/Relay could not confirm submission/
			)
			assert.equal(polledHashes.length, 0)
		}
	} finally {
		globalThis.fetch = originalFetch
	}
})
