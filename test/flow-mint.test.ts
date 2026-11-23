import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { nativeToScVal, xdr } from '@stellar/stellar-sdk/minimal'
import {
	createAuthToken,
	createMockExecutionContext,
	createWorkflowStep,
	installCloudflareStubs,
	type CloudflareStubHandle,
} from './helpers/harness'

let stubs: CloudflareStubHandle
let txWorkflowModule: typeof import('../src/tx-workflow')
let appModule: typeof import('../src/index')

const TEST_SECRET = 'test-jwt-secret-32-chars-minimum!'
const MINTER_SUB = 'GMINTERSUB00000000000000'
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

function createMintEnv(initialRows: Record<string, { Address: string; Mint_Token: string | null; Mint_Amm: string | null }>) {
	const rows = new Map(Object.entries(initialRows).map(([k, v]) => [k, { Id: k, Title: `Smol ${k}`, ...v }]))
	let batchCalls = 0
	const txWorkflowCreates: Array<{ id?: string; params: WorkflowTxParams }> = []
	const seenWorkflowIds = new Set<string>()
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

test('Gate 3a: TxWorkflow splits submit vs confirm so confirmation retry never double-submits relay, and narrows cache purge tags', async () => {
	const harness = createMintEnv({
		'smol-1': { Address: OWNER_SUB, Mint_Token: null, Mint_Amm: null },
	})
	const resultMetaB64 = buildReturnValueMetaB64(['CTOKEN1', 'CAMM1'])
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
		wf.signTransaction = async (x) => `signed:${x}`

		const cache = new Map<string, unknown>()
		const event = {
			payload: {
				type: 'mint' as const,
				entropy: 'smol-1',
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
		assert.equal(harness.rows.get('smol-1')?.Mint_Token, 'CTOKEN1')
		assert.equal(harness.rows.get('smol-1')?.Mint_Amm, 'CAMM1')

		// Narrowed cache purge tags (never global public-smols or mixtapes)
		const allTags = purgedTags.flat()
		assert.equal(allTags.includes('public-smols'), false)
		assert.equal(allTags.includes('mixtapes'), false)
		assert.ok(allTags.includes('smol:smol-1:anonymous'))
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
		wf.signTransaction = async (x) => x

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
	const harness = createMintEnv({
		'm1': { Address: OWNER_SUB, Mint_Token: null, Mint_Amm: null },
		'm2': { Address: OWNER_SUB, Mint_Token: 'CEXIST', Mint_Amm: 'CAMMEXIST' },
	})
	const token = await createAuthToken(MINTER_SUB, TEST_SECRET)
	const ctx = createMockExecutionContext()

	// Build a minimal syntactically valid Stellar TransactionEnvelope XDR
	const emptyEnvelope = new xdr.TransactionEnvelope.envelopeTypeTx(
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

	// Duplicate single mint requests both return 202 empty body, but only 1 workflow is created
	const s1 = await appModule.app.fetch(
		new Request('https://api.smol.xyz/mint/m1', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ xdr: emptyEnvelope }),
		}),
		harness.env,
		ctx.ctx
	)
	const s2 = await appModule.app.fetch(
		new Request('https://api.smol.xyz/mint/m1', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ xdr: emptyEnvelope }),
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(s1.status, 202)
	assert.equal(s2.status, 202)
	assert.equal(harness.txWorkflowCreates.length, 1, 'Duplicate identical mint request must deduplicate')

	// Batch mint skips already-minted m2, returns 202 JSON, and deduplicates repeat calls
	const b1 = await appModule.app.fetch(
		new Request('https://api.smol.xyz/mint', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ xdr: emptyEnvelope, ids: ['m1', 'm2'] }),
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(b1.status, 202)
	assert.deepEqual(await b1.json(), {
		acceptedIds: ['m1'],
		skipped: { alreadyMinted: ['m2'] },
	})
	assert.equal(harness.txWorkflowCreates.length, 2)

	const b2 = await appModule.app.fetch(
		new Request('https://api.smol.xyz/mint', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ xdr: emptyEnvelope, ids: ['m1', 'm2'] }),
		}),
		harness.env,
		ctx.ctx
	)
	assert.equal(b2.status, 202)
	assert.equal(harness.txWorkflowCreates.length, 2, 'Duplicate batch mint request must deduplicate')
})
