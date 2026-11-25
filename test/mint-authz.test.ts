import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Address, Asset, hash, Keypair, nativeToScVal, Networks, StrKey, xdr } from '@stellar/stellar-sdk/minimal'
import {
	assertSignedMintEnvelope,
	assertUnsignedMintEnvelope,
	buildMintExpectation,
	compareScVal,
	decodeMintCarrier,
	deriveMintAddresses,
	MAINNET_MINT_IDENTITY,
	MAX_SIGNED_MINT_XDR_BYTES,
	MAX_UNSIGNED_MINT_XDR_BASE64_CHARS,
	MINT_REJECT_CODES,
	MintRejected,
	signValidatedMint,
	type MintIdentity,
	type MintKind,
	type MintRejectCode,
	type ValidatedUnsignedMint,
} from '../src/chain/mint-authorization'
import { SMOL_SPEC_ENTRIES } from '../src/chain/smol-spec'
import { deriveMintPair, KALE_SAC, SMOL_FACTORY, SMOL_ISSUER } from '../src/utils/chain'
import { testIdentity, testIssuerKeypair } from './fixtures/mint-authz/generate'

const FIXTURES = join(__dirname, 'fixtures', 'mint-authz')
const mainnetTrees = JSON.parse(readFileSync(join(FIXTURES, 'mainnet-trees.json'), 'utf8')) as {
	transactions: Array<{
		hash: string
		label: string
		ledger: number
		protocolVersion: number
		envelopeSha256: string
		envelopeXdr: string
		kind: MintKind
		sub: string
		tracks: Array<{ id: string; creator: string; recipients: number }>
		preMintFacts: Array<{ id: string; creator: string; public: number }>
		d1Snapshot: { rows: Array<{ id: string; address?: string; absent?: boolean }> } | null
		projection: {
			authOrder: string[]
			hostFunctionXdr: string
			userAuthEntryXdr: string
			adminAuthEntryXdr: string
			userRootInvocationXdr: string
			adminRootInvocationXdr: string
		}
	}>
}
const feCarriers = JSON.parse(readFileSync(join(FIXTURES, 'fe-carriers.json'), 'utf8')) as {
	carriers: Array<{
		name: string
		identity: 'mainnet' | 'test'
		kind: MintKind
		sub: string
		tracks: Array<{ id: string; creator: string }>
		userExpirationLedger: number
		xdrSha256: string
		xdr: string
	}>
}
const factorySpec = JSON.parse(readFileSync(join(FIXTURES, 'factory-spec.json'), 'utf8')) as { wasmHash: string; entries: string[] }

const TEST_IDENTITY: MintIdentity = Object.freeze({ ...testIdentity() })
const TEST_ISSUER = testIssuerKeypair()
const identityOf = (name: 'mainnet' | 'test') => (name === 'mainnet' ? MAINNET_MINT_IDENTITY : TEST_IDENTITY)
const ATTACKER = StrKey.encodeContract(hash(Buffer.from('attacker-wallet')))
const ATTACKER_G = Keypair.fromRawEd25519Seed(hash(Buffer.from('attacker-account'))).publicKey()

type Carrier = (typeof feCarriers.carriers)[number]
const carrier = (name: string) => feCarriers.carriers.find((entry) => entry.name === name)!

function validate(xdrB64: string, c: Pick<Carrier, 'kind' | 'sub' | 'tracks'>, identity: MintIdentity): ValidatedUnsignedMint {
	const decoded = decodeMintCarrier(xdrB64, c.kind, identity)
	return assertUnsignedMintEnvelope(decoded, buildMintExpectation({ identity, kind: c.kind, sub: c.sub, tracks: c.tracks }))
}

function rejectionCode(run: () => unknown): MintRejectCode {
	try {
		run()
	} catch (error) {
		assert.ok(error instanceof MintRejected, `expected MintRejected, got ${(error as Error)?.stack ?? error}`)
		return error.code
	}
	assert.fail('expected the mint to be rejected')
}

// ---------------------------------------------------------------------------
// XDR mutation helpers
// ---------------------------------------------------------------------------

function mutate(xdrB64: string, edit: (envelope: xdr.TransactionEnvelope) => xdr.TransactionEnvelope | void): string {
	const envelope = xdr.TransactionEnvelope.fromXDR(xdrB64, 'base64')
	return (edit(envelope) ?? envelope).toXDR('base64')
}
const txOf = (envelope: xdr.TransactionEnvelope) => envelope.v1().tx()
const opOf = (envelope: xdr.TransactionEnvelope) => txOf(envelope).operations()[0].body().invokeHostFunctionOp()
const argsOf = (envelope: xdr.TransactionEnvelope) => opOf(envelope).hostFunction().invokeContract().args()
function entryFor(envelope: xdr.TransactionEnvelope, role: 'admin' | 'user', issuer: string) {
	return opOf(envelope).auth().find((entry) => {
		const address = Address.fromScAddress(entry.credentials().address().address()).toString()
		return role === 'admin' ? address === issuer : address !== issuer
	})!
}
const scAddr = (value: string) => new Address(value).toScVal()
const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' })
function invocation(contract: string, fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) {
	return new xdr.SorobanAuthorizedInvocation({
		function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
			contractAddress: new Address(contract).toScAddress(),
			functionName: fn,
			args,
		})),
		subInvocations: subs,
	})
}
function setHostFunction(envelope: xdr.TransactionEnvelope, contract: string, fn: string, args: xdr.ScVal[]) {
	opOf(envelope).hostFunction(xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
		contractAddress: new Address(contract).toScAddress(),
		functionName: fn,
		args,
	})))
}
function mapField(map: xdr.ScVal, name: string): xdr.ScMapEntry {
	return map.map()!.find((entry) => entry.key().sym().toString() === name)!
}

/** The carrier a frontend would have posted for a historical mint: on-chain func/auth, admin unsigned. */
function carrierFromMainnet(tx: (typeof mainnetTrees.transactions)[number], adminSigned = false): string {
	const original = xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, 'base64')
	const inner = original.feeBump().tx().innerTx().v1().tx()
	const ihf = inner.operations()[0].body().invokeHostFunctionOp()
	const auth = ihf.auth().map((entry) => {
		const copy = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR())
		const credentials = copy.credentials().address()
		if (!adminSigned && Address.fromScAddress(credentials.address()).toString() === SMOL_ISSUER) {
			credentials.signature(xdr.ScVal.scvVoid())
			credentials.signatureExpirationLedger(0)
		}
		return copy
	})
	return xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({
		tx: new xdr.Transaction({
			sourceAccount: xdr.MuxedAccount.keyTypeEd25519(Buffer.alloc(32)),
			fee: inner.fee(),
			seqNum: xdr.Int64.fromString('1'),
			cond: inner.cond(),
			memo: xdr.Memo.memoNone(),
			operations: [new xdr.Operation({
				body: xdr.OperationBody.invokeHostFunction(new xdr.InvokeHostFunctionOp({ hostFunction: ihf.hostFunction(), auth })),
			})],
			ext: inner.ext(),
		}),
		signatures: [],
	})).toXDR('base64')
}

// ---------------------------------------------------------------------------
// Spec + constants
// ---------------------------------------------------------------------------

test('smol-spec pins exactly the contractspecv0 of the live factory Wasm', () => {
	assert.equal(factorySpec.wasmHash, '1199117e0bd80b2a4863984c826c89326dff650381407f27ef5485d5f0468925')
	assert.deepEqual([...SMOL_SPEC_ENTRIES], factorySpec.entries)
})

test('mainnet identity is the pinned factory/issuer and matches deriveMintPair for every fixture id', () => {
	assert.equal(MAINNET_MINT_IDENTITY.factory, SMOL_FACTORY)
	assert.equal(MAINNET_MINT_IDENTITY.issuer, SMOL_ISSUER)
	assert.equal(MAINNET_MINT_IDENTITY.kaleSac, KALE_SAC)
	assert.equal(MAINNET_MINT_IDENTITY.networkPassphrase, Networks.PUBLIC)
	for (const tx of mainnetTrees.transactions) {
		for (const { id } of tx.tracks) assert.deepEqual(deriveMintAddresses(MAINNET_MINT_IDENTITY, id), deriveMintPair(id))
	}
	assert.equal(new Set(MINT_REJECT_CODES).size, MINT_REJECT_CODES.length)
})

// ---------------------------------------------------------------------------
// Boundary A: real mainnet trees
// ---------------------------------------------------------------------------

test('Boundary A: fixtures are the untouched Horizon receipts (singles, 3- and 5-track, self-mint and split fee)', () => {
	const shapes = mainnetTrees.transactions.map((tx) => `${tx.kind}:${tx.tracks.length}:${tx.tracks.map((t) => t.recipients).join('')}`)
	assert.deepEqual(shapes, ['coin_it:1:1', 'coin_it:1:2', 'coin_them:5:22222', 'coin_them:3:222'])
	for (const tx of mainnetTrees.transactions) {
		const bytes = Buffer.from(tx.envelopeXdr, 'base64')
		assert.equal(createHash('sha256').update(bytes).digest('hex'), tx.envelopeSha256)
		const envelope = xdr.TransactionEnvelope.fromXDR(bytes)
		assert.equal(envelope.switch().name, 'envelopeTypeTxFeeBump')
		// The receipt hash is the fee-bump transaction hash over the public network id.
		const payload = xdr.TransactionSignaturePayload.toXDR(new xdr.TransactionSignaturePayload({
			networkId: hash(Buffer.from(Networks.PUBLIC)),
			taggedTransaction: xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTxFeeBump(envelope.feeBump().tx()),
		}))
		assert.equal(hash(payload).toString('hex'), tx.hash)
		// D1 records the same creator the fee rule pays.
		for (const [i, row] of (tx.d1Snapshot?.rows ?? []).entries()) assert.equal(row.address, tx.tracks[i].creator)
	}
})

test('Boundary A: the server-constructed host function and both auth trees equal all four mainnet mints byte for byte', () => {
	for (const tx of mainnetTrees.transactions) {
		const expected = buildMintExpectation({
			kind: tx.kind,
			sub: tx.sub,
			tracks: tx.preMintFacts.map(({ id, creator }) => ({ id, creator })),
		})
		assert.equal(expected.hostFunction.toString('base64'), tx.projection.hostFunctionXdr, `${tx.hash} host function`)
		assert.equal(expected.adminInvocation.toString('base64'), tx.projection.adminRootInvocationXdr, `${tx.hash} admin tree`)
		assert.equal(expected.userInvocation.toString('base64'), tx.projection.userRootInvocationXdr, `${tx.hash} user tree`)
	}
})

test('Boundary A: every mainnet tree is accepted as an FE-shaped carrier, and the real issuer signature passes the signed-output predicate', () => {
	for (const tx of mainnetTrees.transactions) {
		const c = { kind: tx.kind, sub: tx.sub, tracks: tx.preMintFacts.map(({ id, creator }) => ({ id, creator })) }
		const validated = validate(carrierFromMainnet(tx), c, MAINNET_MINT_IDENTITY)
		assert.deepEqual([...validated.ids], c.tracks.map(({ id }) => id))
		assert.equal(tx.projection.authOrder[validated.adminAuthIndex], 'admin')

		const admin = xdr.SorobanAuthorizationEntry.fromXDR(tx.projection.adminAuthEntryXdr, 'base64').credentials().address()
		assertSignedMintEnvelope(validated, carrierFromMainnet(tx, true), {
			expirationLedger: admin.signatureExpirationLedger(),
			networkPassphrase: Networks.PUBLIC,
		})
		assert.equal(rejectionCode(() => assertSignedMintEnvelope(validated, carrierFromMainnet(tx, true), {
			expirationLedger: admin.signatureExpirationLedger() + 1,
			networkPassphrase: Networks.PUBLIC,
		})), 'signed_mismatch')
	}
})

test('Boundary A: the original receipts are not ingress carriers (fee-bump, signed inner envelope)', () => {
	for (const tx of mainnetTrees.transactions) {
		assert.equal(rejectionCode(() => decodeMintCarrier(tx.envelopeXdr, tx.kind)), 'envelope_type')
		const inner = xdr.TransactionEnvelope.envelopeTypeTx(xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, 'base64').feeBump().tx().innerTx().v1())
		assert.equal(rejectionCode(() => decodeMintCarrier(inner.toXDR('base64'), tx.kind)), 'envelope_signed')
	}
})

// ---------------------------------------------------------------------------
// Boundary B: real FE carriers (ingress + sign + output verification)
// ---------------------------------------------------------------------------

test('Boundary B: FE builder carriers are envelopeTypeTx with a null-account source, signed wallet entry and unsigned issuer entry', () => {
	assert.equal(feCarriers.carriers.length, 8)
	for (const c of feCarriers.carriers) {
		assert.equal(createHash('sha256').update(Buffer.from(c.xdr, 'base64')).digest('hex'), c.xdrSha256)
		const envelope = xdr.TransactionEnvelope.fromXDR(c.xdr, 'base64')
		assert.equal(envelope.switch().name, 'envelopeTypeTx')
		assert.equal(envelope.v1().signatures().length, 0)
		assert.equal(txOf(envelope).cond().switch().name, 'precondTime')
		const identity = identityOf(c.identity)
		const admin = entryFor(envelope, 'admin', identity.issuer).credentials().address()
		const user = entryFor(envelope, 'user', identity.issuer).credentials().address()
		assert.equal(admin.signature().switch().name, 'scvVoid')
		assert.equal(admin.signatureExpirationLedger(), 0)
		assert.equal(user.signatureExpirationLedger(), c.userExpirationLedger)
		assert.equal(user.signature().vec()![0].map()![0].key().vec()![0].sym().toString(), 'Secp256r1')
	}
})

test('Boundary B: every FE carrier passes ingress; test-identity carriers also sign and pass output verification', async () => {
	for (const c of feCarriers.carriers) {
		const identity = identityOf(c.identity)
		const validated = validate(c.xdr, c, identity)
		assert.equal(validated.userExpirationLedger, c.userExpirationLedger)
		if (c.identity !== 'test') continue
		const signed = await signValidatedMint(validated, TEST_ISSUER, 65_700_000, Networks.PUBLIC)
		assert.ok(Buffer.from(signed, 'base64').length <= MAX_SIGNED_MINT_XDR_BYTES)
		assertSignedMintEnvelope(validated, signed, { expirationLedger: 65_700_000, networkPassphrase: Networks.PUBLIC })

		// Exactly the admin signature and expiry changed.
		const before = xdr.TransactionEnvelope.fromXDR(c.xdr, 'base64')
		const after = xdr.TransactionEnvelope.fromXDR(signed, 'base64')
		const adminAfter = opOf(after).auth()[validated.adminAuthIndex].credentials().address()
		assert.equal(adminAfter.signatureExpirationLedger(), 65_700_000)
		assert.equal(adminAfter.signature().vec()![0].map()!.length, 2)
		assert.equal(opOf(after).auth()[validated.userAuthIndex].toXDR('base64'), opOf(before).auth()[validated.userAuthIndex].toXDR('base64'))
		assert.equal(opOf(after).hostFunction().toXDR('base64'), opOf(before).hostFunction().toXDR('base64'))
		assert.equal(txOf(after).ext().toXDR('base64'), txOf(before).ext().toXDR('base64'))
	}
})

test('Boundary B: carriers regenerated live from the FE builder still validate (builder drift guard)', async () => {
	const { buildFeCoinThemCarrier, createPasskey } = await import('./fixtures/mint-authz/fe-builder')
	const base = carrier('test/coin_them-5')
	const fresh = await buildFeCoinThemCarrier({
		identity: TEST_IDENTITY,
		user: base.sub,
		passkey: createPasskey('drift-guard'),
		expiration: 70_000_000,
		nonces: [987654321n, 123456789n],
		tracks: base.tracks,
	})
	const validated = validate(fresh, base, TEST_IDENTITY)
	assertSignedMintEnvelope(validated, await signValidatedMint(validated, TEST_ISSUER, 70_000_050, Networks.PUBLIC), {
		expirationLedger: 70_000_050,
		networkPassphrase: Networks.PUBLIC,
	})
})

// ---------------------------------------------------------------------------
// Attack corpus (each case names the closed-set code it must produce)
// ---------------------------------------------------------------------------

const single = carrier('mainnet/coin_it-split')
const batch = carrier('mainnet/coin_them-5')
const M = MAINNET_MINT_IDENTITY

function nullSourceTx(operations: xdr.Operation[], template: xdr.Transaction) {
	return new xdr.Transaction({
		sourceAccount: template.sourceAccount(),
		fee: template.fee(),
		seqNum: template.seqNum(),
		cond: template.cond(),
		memo: template.memo(),
		operations,
		ext: template.ext(),
	})
}

// passkey-kit smart-wallet `Signatures(Map<SignerKey, Signature>)` helpers.
const sym = (value: string) => xdr.ScVal.scvSymbol(value)
const filled = (size: number, fill = 7) => xdr.ScVal.scvBytes(Buffer.alloc(size, fill))
const walletCredentials = (e: xdr.TransactionEnvelope, issuer = SMOL_ISSUER) => entryFor(e, 'user', issuer).credentials().address()
const walletSigner = (e: xdr.TransactionEnvelope, issuer = SMOL_ISSUER) => walletCredentials(e, issuer).signature().vec()![0].map()![0]
const secp256r1Fields = (e: xdr.TransactionEnvelope) => walletSigner(e).val().vec()![1].map()!
function setWalletSigners(e: xdr.TransactionEnvelope, signers: xdr.ScMapEntry[], issuer = SMOL_ISSUER) {
	walletCredentials(e, issuer).signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap(signers)]))
}
function signer(keyVariant: string, key: xdr.ScVal, signatureVariant: string, signature: xdr.ScVal | null) {
	return new xdr.ScMapEntry({
		key: xdr.ScVal.scvVec([sym(keyVariant), key]),
		val: xdr.ScVal.scvVec(signature ? [sym(signatureVariant), signature] : [sym(signatureVariant)]),
	})
}
const ed25519Signer = (seed: number) => signer('Ed25519', filled(32, seed), 'Ed25519', filled(64, seed))
/** A Secp256r1 signer entry with `credentialId` as its key and the carrier's real signature value. */
const secp256r1Signer = (e: xdr.TransactionEnvelope, credentialId: Buffer, issuer = SMOL_ISSUER) =>
	new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([sym('Secp256r1'), xdr.ScVal.scvBytes(credentialId)]), val: walletSigner(e, issuer).val() })
function setSecp256r1Field(e: xdr.TransactionEnvelope, name: string, value: xdr.ScVal) {
	secp256r1Fields(e).find((field) => field.key().sym().toString() === name)!.val(value)
}

const corpus: Array<{ name: string; base: Carrier; code: MintRejectCode; xdr: () => string; expect?: Partial<Pick<Carrier, 'kind' | 'sub' | 'tracks'>> }> = [
	{ name: 'fee-bump wrapper', base: single, code: 'envelope_type', xdr: () => mutate(single.xdr, (e) => xdr.TransactionEnvelope.envelopeTypeTxFeeBump(new xdr.FeeBumpTransactionEnvelope({
		tx: new xdr.FeeBumpTransaction({
			feeSource: xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(ATTACKER_G)),
			fee: xdr.Int64.fromString('10000000'),
			innerTx: xdr.FeeBumpTransactionInnerTx.envelopeTypeTx(e.v1()),
			ext: new xdr.FeeBumpTransactionExt(0),
		}),
		signatures: [],
	}))) },
	{ name: 'v0 envelope', base: single, code: 'envelope_type', xdr: () => mutate(single.xdr, (e) => xdr.TransactionEnvelope.envelopeTypeTxV0(new xdr.TransactionV0Envelope({
		tx: new xdr.TransactionV0({
			sourceAccountEd25519: Buffer.alloc(32),
			fee: txOf(e).fee(),
			seqNum: txOf(e).seqNum(),
			timeBounds: null,
			memo: xdr.Memo.memoNone(),
			operations: txOf(e).operations(),
			ext: new xdr.TransactionV0Ext(0),
		}),
		signatures: [],
	}))) },
	{ name: 'envelope signature present (relay pass-through path)', base: single, code: 'envelope_signed', xdr: () => mutate(single.xdr, (e) => {
		e.v1().signatures([new xdr.DecoratedSignature({ hint: Buffer.alloc(4), signature: Buffer.alloc(64, 1) })])
	}) },
	{ name: 'memo', base: single, code: 'carrier_memo', xdr: () => mutate(single.xdr, (e) => { txOf(e).memo(xdr.Memo.memoText('gm')) }) },
	{ name: 'funded source account', base: single, code: 'carrier_source', xdr: () => mutate(single.xdr, (e) => {
		txOf(e).sourceAccount(xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(ATTACKER_G)))
	}) },
	{ name: 'muxed source account', base: single, code: 'carrier_source', xdr: () => mutate(single.xdr, (e) => {
		txOf(e).sourceAccount(xdr.MuxedAccount.keyTypeMuxedEd25519(new xdr.MuxedAccountMed25519({ id: xdr.Uint64.fromString('7'), ed25519: Buffer.alloc(32) })))
	}) },
	{ name: 'sequence number not 1', base: single, code: 'carrier_sequence', xdr: () => mutate(single.xdr, (e) => { txOf(e).seqNum(xdr.Int64.fromString('2')) }) },
	{ name: 'v2 preconditions (extra signers)', base: single, code: 'carrier_preconditions', xdr: () => mutate(single.xdr, (e) => {
		txOf(e).cond(xdr.Preconditions.precondV2(new xdr.PreconditionsV2({
			timeBounds: null, ledgerBounds: null, minSeqNum: null, minSeqAge: xdr.Uint64.fromString('0'), minSeqLedgerGap: 0,
			extraSigners: [xdr.SignerKey.signerKeyTypeEd25519(StrKey.decodeEd25519PublicKey(ATTACKER_G))],
		})))
	}) },
	{ name: 'second operation', base: single, code: 'op_count', xdr: () => mutate(single.xdr, (e) => {
		const op = txOf(e).operations()[0]
		e.v1().tx(nullSourceTx([op, op], txOf(e)))
	}) },
	{ name: 'operation-level source account', base: single, code: 'op_source', xdr: () => mutate(single.xdr, (e) => {
		txOf(e).operations()[0].sourceAccount(xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(SMOL_ISSUER)))
	}) },
	{ name: 'classic payment op', base: single, code: 'op_type', xdr: () => mutate(single.xdr, (e) => {
		e.v1().tx(nullSourceTx([new xdr.Operation({ body: xdr.OperationBody.payment(new xdr.PaymentOp({
			destination: xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(ATTACKER_G)),
			asset: xdr.Asset.assetTypeNative(),
			amount: xdr.Int64.fromString('1'),
		})) })], txOf(e)))
	}) },
	{ name: 'upload-wasm host function', base: single, code: 'host_function_type', xdr: () => mutate(single.xdr, (e) => {
		opOf(e).hostFunction(xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from('0061736d01000000', 'hex')))
	}) },
	{ name: 'create-contract host function', base: single, code: 'host_function_type', xdr: () => mutate(single.xdr, (e) => {
		opOf(e).hostFunction(xdr.HostFunction.hostFunctionTypeCreateContract(new xdr.CreateContractArgs({
			contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({
				address: new Address(SMOL_ISSUER).toScAddress(), salt: Buffer.alloc(32, 9),
			})),
			executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 1)),
		})))
	}) },
	{ name: 'wrong contract (same function)', base: single, code: 'contract_mismatch', xdr: () => mutate(single.xdr, (e) => {
		setHostFunction(e, ATTACKER, 'coin_it', argsOf(e))
	}) },
	{ name: 'KALE transfer as the host function', base: single, code: 'contract_mismatch', xdr: () => mutate(single.xdr, (e) => {
		setHostFunction(e, KALE_SAC, 'transfer', [scAddr(SMOL_ISSUER), scAddr(ATTACKER), i128(10n ** 15n)])
	}) },
	{ name: 'factory upgrade', base: single, code: 'function_mismatch', xdr: () => mutate(single.xdr, (e) => {
		setHostFunction(e, SMOL_FACTORY, 'upgrade', [xdr.ScVal.scvBytes(Buffer.alloc(32, 1))])
	}) },
	{ name: 'factory update (admin takeover)', base: single, code: 'function_mismatch', xdr: () => mutate(single.xdr, (e) => {
		setHostFunction(e, SMOL_FACTORY, 'update', [scAddr(ATTACKER), xdr.ScVal.scvVoid(), xdr.ScVal.scvVoid()])
	}) },
	{ name: 'factory swap_them_in', base: single, code: 'function_mismatch', xdr: () => mutate(single.xdr, (e) => {
		setHostFunction(e, SMOL_FACTORY, 'swap_them_in', [scAddr(single.sub), xdr.ScVal.scvVec([]), xdr.ScVal.scvVec([]), i128(1n), xdr.ScVal.scvVoid()])
	}) },
	{ name: 'coin_them posted to the single route', base: single, code: 'function_mismatch', xdr: () => batch.xdr },
	{ name: 'altered asset code', base: single, code: 'host_function_mismatch', xdr: () => mutate(single.xdr, (e) => {
		argsOf(e)[1] = xdr.ScVal.scvBytes(new Asset('ffffffffffff', SMOL_ISSUER).toXDRObject().toXDR())
	}) },
	{ name: 'altered asset issuer', base: single, code: 'host_function_mismatch', xdr: () => mutate(single.xdr, (e) => {
		argsOf(e)[1] = xdr.ScVal.scvBytes(new Asset(single.tracks[0].id.slice(0, 12), ATTACKER_G).toXDRObject().toXDR())
	}) },
	{ name: 'altered salt', base: single, code: 'ids_mismatch', xdr: () => mutate(single.xdr, (e) => {
		argsOf(e)[2] = xdr.ScVal.scvBytes(Buffer.alloc(32, 0xab))
	}) },
	{ name: 'altered fee percent', base: single, code: 'host_function_mismatch', xdr: () => mutate(single.xdr, (e) => {
		mapField(mapField(argsOf(e)[3], 'recipients').val().vec()![0], 'percent').val(i128(90_00000n))
	}) },
	{ name: 'altered fee recipient', base: single, code: 'host_function_mismatch', xdr: () => mutate(single.xdr, (e) => {
		mapField(mapField(argsOf(e)[3], 'recipients').val().vec()![0], 'recipient').val(scAddr(ATTACKER))
	}) },
	{ name: 'altered fee asset', base: single, code: 'host_function_mismatch', xdr: () => mutate(single.xdr, (e) => {
		mapField(argsOf(e)[3], 'fee_asset').val(scAddr(ATTACKER))
	}) },
	{ name: 'fee rule removed (None)', base: single, code: 'host_function_mismatch', xdr: () => mutate(single.xdr, (e) => { argsOf(e)[3] = xdr.ScVal.scvVoid() }) },
	{ name: 'user != session sub', base: single, code: 'host_function_mismatch', xdr: () => mutate(single.xdr, (e) => { argsOf(e)[0] = scAddr(ATTACKER) }) },
	{ name: 'duplicate salts', base: batch, code: 'id_duplicate', xdr: () => mutate(batch.xdr, (e) => {
		const salts = argsOf(e)[2].vec()!
		salts[1] = salts[0]
	}) },
	{ name: 'shared 12-hex prefix within the batch', base: batch, code: 'prefix_duplicate', xdr: () => mutate(batch.xdr, (e) => {
		const salts = argsOf(e)[2].vec()!
		salts[1] = xdr.ScVal.scvBytes(Buffer.from(`${batch.tracks[0].id.slice(0, 12)}${'0'.repeat(52)}`, 'hex'))
	}) },
	{ name: 'six-track batch', base: batch, code: 'batch_size', xdr: () => mutate(batch.xdr, (e) => {
		for (const index of [1, 2, 3]) argsOf(e)[index].vec()!.push(argsOf(e)[index].vec()![0])
	}) },
	{ name: 'unequal argument vectors', base: batch, code: 'arg_shape', xdr: () => mutate(batch.xdr, (e) => { argsOf(e)[3].vec()!.pop() }) },
	{ name: 'salt outside the posted ids', base: batch, code: 'ids_mismatch', xdr: () => mutate(batch.xdr, (e) => {
		argsOf(e)[2].vec()![4] = xdr.ScVal.scvBytes(Buffer.alloc(32, 0x5c))
	}) },
	{ name: 'third auth entry', base: single, code: 'auth_count', xdr: () => mutate(single.xdr, (e) => {
		opOf(e).auth([...opOf(e).auth(), opOf(e).auth()[0]])
	}) },
	{ name: 'second admin entry (user entry replaced)', base: single, code: 'auth_duplicate', xdr: () => mutate(single.xdr, (e) => {
		const admin = entryFor(e, 'admin', SMOL_ISSUER)
		opOf(e).auth([admin, admin])
	}) },
	{ name: 'auth entry for an unexpected address', base: single, code: 'auth_unexpected_address', xdr: () => mutate(single.xdr, (e) => {
		entryFor(e, 'user', SMOL_ISSUER).credentials().address().address(new Address(ATTACKER).toScAddress())
	}) },
	{ name: 'issuer key as a muxed auth address', base: single, code: 'auth_unexpected_address', xdr: () => mutate(single.xdr, (e) => {
		entryFor(e, 'admin', SMOL_ISSUER).credentials().address().address(xdr.ScAddress.scAddressTypeMuxedAccount(new xdr.MuxedEd25519Account({
			id: xdr.Uint64.fromString('1'), ed25519: StrKey.decodeEd25519PublicKey(SMOL_ISSUER),
		})))
	}) },
	{ name: 'host function contract as a claimable-balance address', base: single, code: 'contract_mismatch', xdr: () => mutate(single.xdr, (e) => {
		opOf(e).hostFunction().invokeContract().contractAddress(xdr.ScAddress.scAddressTypeClaimableBalance(
			xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(StrKey.decodeContract(SMOL_FACTORY)),
		))
	}) },
	{ name: 'source-account credentials', base: single, code: 'auth_credentials', xdr: () => mutate(single.xdr, (e) => {
		const admin = entryFor(e, 'admin', SMOL_ISSUER)
		admin.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount())
	}) },
	{ name: 'admin root differs from the host function', base: single, code: 'admin_root_mismatch', xdr: () => mutate(single.xdr, (e) => {
		const admin = entryFor(e, 'admin', SMOL_ISSUER)
		admin.rootInvocation().function(xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
			contractAddress: new Address(SMOL_FACTORY).toScAddress(),
			functionName: 'update',
			args: [scAddr(ATTACKER), xdr.ScVal.scvVoid(), xdr.ScVal.scvVoid()],
		})))
	}) },
	{ name: 'admin root as create-contract authorization', base: single, code: 'admin_root_mismatch', xdr: () => mutate(single.xdr, (e) => {
		entryFor(e, 'admin', SMOL_ISSUER).rootInvocation().function(xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(new xdr.CreateContractArgs({
			contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({
				address: new Address(SMOL_ISSUER).toScAddress(), salt: Buffer.alloc(32, 3),
			})),
			executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
		})))
	}) },
	{ name: 'extra admin sub-invocation (KALE drain)', base: single, code: 'admin_tree_mismatch', xdr: () => mutate(single.xdr, (e) => {
		const root = entryFor(e, 'admin', SMOL_ISSUER).rootInvocation()
		root.subInvocations([...root.subInvocations(), invocation(KALE_SAC, 'transfer', [scAddr(SMOL_ISSUER), scAddr(ATTACKER), i128(10n ** 15n)])])
	}) },
	{ name: 'changed SAC mint recipient', base: single, code: 'admin_tree_mismatch', xdr: () => mutate(single.xdr, (e) => {
		entryFor(e, 'admin', SMOL_ISSUER).rootInvocation().subInvocations()[0].function().contractFn().args()[0] = scAddr(ATTACKER)
	}) },
	{ name: 'changed SAC mint amount', base: single, code: 'admin_tree_mismatch', xdr: () => mutate(single.xdr, (e) => {
		entryFor(e, 'admin', SMOL_ISSUER).rootInvocation().subInvocations()[0].function().contractFn().args()[1] = i128(10n ** 18n)
	}) },
	{ name: 'changed pool constructor controller', base: single, code: 'admin_tree_mismatch', xdr: () => mutate(single.xdr, (e) => {
		entryFor(e, 'admin', SMOL_ISSUER).rootInvocation().subInvocations()[1].function().contractFn().args()[0] = scAddr(ATTACKER_G)
	}) },
	{ name: 'admin sub-invocations reordered', base: single, code: 'admin_tree_mismatch', xdr: () => mutate(single.xdr, (e) => {
		const root = entryFor(e, 'admin', SMOL_ISSUER).rootInvocation()
		root.subInvocations([...root.subInvocations()].reverse())
	}) },
	{ name: 'pre-signed admin entry', base: single, code: 'admin_presigned', xdr: () => mutate(single.xdr, (e) => {
		const credentials = entryFor(e, 'admin', SMOL_ISSUER).credentials().address()
		credentials.signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap([])]))
		credentials.signatureExpirationLedger(99)
	}) },
	{ name: 'admin expiry set on an unsigned entry', base: single, code: 'admin_presigned', xdr: () => mutate(single.xdr, (e) => {
		entryFor(e, 'admin', SMOL_ISSUER).credentials().address().signatureExpirationLedger(99)
	}) },
	{ name: 'extra user sub-invocation', base: single, code: 'user_tree_mismatch', xdr: () => mutate(single.xdr, (e) => {
		const root = entryFor(e, 'user', SMOL_ISSUER).rootInvocation()
		root.subInvocations([...root.subInvocations(), invocation(KALE_SAC, 'approve', [scAddr(single.sub), scAddr(ATTACKER), i128(1n), xdr.ScVal.scvU32(1)])])
	}) },
	{ name: 'user root differs from the host function', base: single, code: 'user_root_mismatch', xdr: () => mutate(single.xdr, (e) => {
		entryFor(e, 'user', SMOL_ISSUER).rootInvocation().function().contractFn().functionName('coin_them')
	}) },
	{ name: 'unsigned wallet entry', base: single, code: 'user_unsigned', xdr: () => mutate(single.xdr, (e) => {
		const credentials = entryFor(e, 'user', SMOL_ISSUER).credentials().address()
		credentials.signature(xdr.ScVal.scvVoid())
	}) },
	{ name: 'malformed wallet signature', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		entryFor(e, 'user', SMOL_ISSUER).credentials().address().signature(xdr.ScVal.scvBytes(Buffer.alloc(64)))
	}) },
	// Wallet credential shape: only passkey-kit Secp256r1 and Ed25519 signer entries, fully formed.
	{ name: 'wallet: empty signer map', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => setWalletSigners(e, [])) },
	{ name: 'wallet: Policy signer', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [signer('Policy', scAddr(ATTACKER), 'Policy', null)])
	}) },
	{ name: 'wallet: Policy signer with a payload', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [signer('Policy', scAddr(ATTACKER), 'Policy', xdr.ScVal.scvVoid())])
	}) },
	{ name: 'wallet: unknown signer variant', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [signer('Secp256k1', filled(33), 'Secp256k1', filled(64))])
	}) },
	{ name: 'wallet: Secp256r1 key with an Ed25519 signature', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		walletSigner(e).val(xdr.ScVal.scvVec([sym('Ed25519'), filled(64)]))
	}) },
	{ name: 'wallet: Ed25519 key with a Secp256r1 signature', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		walletSigner(e).key(xdr.ScVal.scvVec([sym('Ed25519'), filled(32)]))
	}) },
	{ name: 'wallet: signer key is not an enum', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		walletSigner(e).key(filled(16))
	}) },
	{ name: 'wallet: variant tag is a string, not a symbol', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		walletSigner(e).key(xdr.ScVal.scvVec([xdr.ScVal.scvString('Secp256r1'), filled(16)]))
	}) },
	{ name: 'wallet: signature enum with an extra element', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		const [tag, value] = walletSigner(e).val().vec()!
		walletSigner(e).val(xdr.ScVal.scvVec([tag, value, xdr.ScVal.scvVoid()]))
	}) },
	{ name: 'wallet: empty Secp256r1 credential id', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		walletSigner(e).key(xdr.ScVal.scvVec([sym('Secp256r1'), filled(0)]))
	}) },
	{ name: 'wallet: oversize Secp256r1 credential id', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		walletSigner(e).key(xdr.ScVal.scvVec([sym('Secp256r1'), filled(1024)]))
	}) },
	{ name: 'wallet: Secp256r1 credential id is not bytes', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		walletSigner(e).key(xdr.ScVal.scvVec([sym('Secp256r1'), xdr.ScVal.scvU32(7)]))
	}) },
	{ name: 'wallet: Secp256r1 signature is not a map', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		walletSigner(e).val(xdr.ScVal.scvVec([sym('Secp256r1'), filled(64)]))
	}) },
	{ name: 'wallet: Secp256r1 signature missing client_data_json', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		const fields = secp256r1Fields(e)
		walletSigner(e).val(xdr.ScVal.scvVec([sym('Secp256r1'), xdr.ScVal.scvMap([fields[0], fields[2]])]))
	}) },
	{ name: 'wallet: Secp256r1 signature with an extra field', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		const fields = secp256r1Fields(e)
		walletSigner(e).val(xdr.ScVal.scvVec([sym('Secp256r1'), xdr.ScVal.scvMap([...fields, new xdr.ScMapEntry({ key: sym('user_handle'), val: filled(8) })])]))
	}) },
	{ name: 'wallet: Secp256r1 signature fields reordered', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		const [a, b, c] = secp256r1Fields(e)
		walletSigner(e).val(xdr.ScVal.scvVec([sym('Secp256r1'), xdr.ScVal.scvMap([b, a, c])]))
	}) },
	{ name: 'wallet: Secp256r1 field renamed', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		secp256r1Fields(e)[2].key(sym('sig'))
	}) },
	{ name: 'wallet: short Secp256r1 signature', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => setSecp256r1Field(e, 'signature', filled(63))) },
	{ name: 'wallet: long Secp256r1 signature', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => setSecp256r1Field(e, 'signature', filled(65))) },
	{ name: 'wallet: short authenticator data', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => setSecp256r1Field(e, 'authenticator_data', filled(36))) },
	{ name: 'wallet: empty client data JSON', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => setSecp256r1Field(e, 'client_data_json', filled(0))) },
	{ name: 'wallet: Secp256r1 field value is not bytes', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => setSecp256r1Field(e, 'signature', xdr.ScVal.scvU32(1))) },
	{ name: 'wallet: Ed25519 key of 31 bytes', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [signer('Ed25519', filled(31), 'Ed25519', filled(64))])
	}) },
	{ name: 'wallet: Ed25519 signature of 65 bytes', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [signer('Ed25519', filled(32), 'Ed25519', filled(65))])
	}) },
	{ name: 'wallet: more signers than the limit', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [1, 2, 3, 4, 5].map(ed25519Signer))
	}) },
	{ name: 'wallet: duplicate signer keys', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [ed25519Signer(1), signer('Ed25519', filled(32, 1), 'Ed25519', filled(64, 9))])
	}) },
	{ name: 'wallet: one good signer next to a malformed one', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [signer('Ed25519', filled(32), 'Ed25519', filled(63)), walletSigner(e)])
	}) },
	// Soroban converts the map before the wallet runs and refuses keys that are not strictly increasing.
	{ name: 'wallet: mixed-variant signer keys in descending order (Secp256r1 before Ed25519)', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [walletSigner(e), ed25519Signer(4)])
	}) },
	{ name: 'wallet: Ed25519 signer keys in descending byte order', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [ed25519Signer(4), ed25519Signer(3)])
	}) },
	{ name: 'wallet: Secp256r1 keys ordered by length, not bytes (XDR order, not Soroban order)', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [secp256r1Signer(e, Buffer.alloc(16, 8)), secp256r1Signer(e, Buffer.alloc(17, 7))])
	}) },
	{ name: 'wallet: Secp256r1 key after a longer key it prefixes', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		setWalletSigners(e, [secp256r1Signer(e, Buffer.alloc(17, 7)), secp256r1Signer(e, Buffer.alloc(16, 7))])
	}) },
	{ name: 'wallet: Signatures tuple with two maps', base: single, code: 'user_signature_shape', xdr: () => mutate(single.xdr, (e) => {
		const map = walletCredentials(e).signature().vec()![0]
		walletCredentials(e).signature(xdr.ScVal.scvVec([map, map]))
	}) },
	{ name: 'trailing bytes', base: single, code: 'xdr_malformed', xdr: () => Buffer.concat([Buffer.from(single.xdr, 'base64'), Buffer.alloc(4)]).toString('base64') },
	{ name: 'non-canonical base64 (embedded newline)', base: single, code: 'xdr_not_base64', xdr: () => `${single.xdr.slice(0, 76)}\n${single.xdr.slice(76)}` },
	{ name: 'non-canonical base64 (base64url alphabet)', base: single, code: 'xdr_not_base64', xdr: () => single.xdr.replace(/\+/g, '-').replace(/\//g, '_') },
	{ name: 'non-canonical base64 (non-zero padding bits)', base: single, code: 'xdr_not_base64', xdr: () => {
		const padded = Buffer.concat([Buffer.from(single.xdr, 'base64'), Buffer.alloc(2)]).toString('base64')
		return `${padded.slice(0, -2)}${padded.at(-2) === 'A' ? 'B' : 'C'}=`
	} },
	{ name: 'not base64', base: single, code: 'xdr_not_base64', xdr: () => `${single.xdr.slice(0, -8)}!!!!====` },
	{ name: 'oversize payload', base: single, code: 'xdr_too_large', xdr: () => 'A'.repeat(MAX_UNSIGNED_MINT_XDR_BASE64_CHARS + 4) },
	{ name: 'empty xdr', base: single, code: 'xdr_missing', xdr: () => '' },
	{ name: 'garbage xdr', base: single, code: 'xdr_malformed', xdr: () => Buffer.alloc(64, 0xff).toString('base64') },
	{ name: 'non-contract session sub', base: single, code: 'session_invalid', xdr: () => single.xdr, expect: { sub: ATTACKER_G } },
]

test(`attack corpus: ${corpus.length} named carriers are rejected with their closed-set code`, () => {
	assert.ok(corpus.length >= 35)
	for (const attack of corpus) {
		const c = { ...attack.base, ...attack.expect }
		const code = rejectionCode(() => validate(attack.xdr(), c, M))
		assert.equal(code, attack.code, attack.name)
	}
})

test('attack corpus: non-canonical base64 variants decode to the same bytes as the carrier but are still refused', () => {
	for (const name of ['non-canonical base64 (embedded newline)', 'non-canonical base64 (base64url alphabet)']) {
		const variant = corpus.find((attack) => attack.name === name)!.xdr()
		assert.notEqual(variant, single.xdr)
		assert.ok(Buffer.from(variant, 'base64').equals(Buffer.from(single.xdr, 'base64')), name)
	}
	assert.match(single.xdr, /[+/]/, 'fixture exercises the base64url substitution')
})

// ---------------------------------------------------------------------------
// Signer and signed-output predicate
// ---------------------------------------------------------------------------

test('signer: refuses unvalidated values, a different key, a different network and a bad expiry', async () => {
	const c = carrier('test/coin_it-split')
	const validated = validate(c.xdr, c, TEST_IDENTITY)
	const forged = { ...validated } as ValidatedUnsignedMint
	await assert.rejects(signValidatedMint(forged, TEST_ISSUER, 100, Networks.PUBLIC), (e: unknown) => e instanceof MintRejected && e.code === 'not_validated')
	await assert.rejects(signValidatedMint(validated, Keypair.random(), 100, Networks.PUBLIC), (e: unknown) => e instanceof MintRejected && e.code === 'signer_mismatch')
	await assert.rejects(signValidatedMint(validated, TEST_ISSUER, 100, Networks.TESTNET), (e: unknown) => e instanceof MintRejected && e.code === 'network_mismatch')
	await assert.rejects(signValidatedMint(validated, TEST_ISSUER, 0, Networks.PUBLIC), (e: unknown) => e instanceof MintRejected && e.code === 'expiration_invalid')
	// Mainnet-identity carriers can only be signed by the real issuer key.
	const mainnet = validate(single.xdr, single, M)
	await assert.rejects(signValidatedMint(mainnet, TEST_ISSUER, 100, Networks.PUBLIC), (e: unknown) => e instanceof MintRejected && e.code === 'signer_mismatch')
})

test('signed-output predicate: only an issuer signature over the expected preimage at the chosen expiry is accepted', async () => {
	const c = carrier('test/coin_them-2')
	const validated = validate(c.xdr, c, TEST_IDENTITY)
	const signed = await signValidatedMint(validated, TEST_ISSUER, 66_000_000, Networks.PUBLIC)
	const opts = { expirationLedger: 66_000_000, networkPassphrase: Networks.PUBLIC }
	const adminOf = (e: xdr.TransactionEnvelope) => opOf(e).auth()[validated.adminAuthIndex].credentials().address()
	const cases: Array<[string, MintRejectCode, string, typeof opts?]> = [
		['wrong expiry', 'signed_mismatch', signed, { ...opts, expirationLedger: 66_000_001 }],
		['wrong network', 'network_mismatch', signed, { ...opts, networkPassphrase: Networks.TESTNET }],
		['unsigned input', 'signature_invalid', c.xdr, { ...opts, expirationLedger: 0 }],
		['flipped signature bit', 'signature_invalid', mutate(signed, (e) => {
			const field = adminOf(e).signature().vec()![0].map()![1]
			const bytes = Buffer.from(field.val().bytes())
			bytes[0] ^= 1
			field.val(xdr.ScVal.scvBytes(bytes))
		})],
		['signature by another key', 'signature_invalid', mutate(signed, (e) => {
			const other = Keypair.random()
			adminOf(e).signature().vec()![0].map()![0].val(xdr.ScVal.scvBytes(other.rawPublicKey()))
		})],
		['expiry changed after signing', 'signature_invalid', mutate(signed, (e) => { adminOf(e).signatureExpirationLedger(66_000_000 + 5) })],
		['user entry swapped after signing', 'signed_mismatch', mutate(signed, (e) => {
			opOf(e).auth()[validated.userAuthIndex].credentials().address().nonce(xdr.Int64.fromString('42'))
		})],
		['host function changed after signing', 'signed_mismatch', mutate(signed, (e) => { argsOf(e)[0] = scAddr(ATTACKER) })],
		['envelope signature added', 'signed_mismatch', mutate(signed, (e) => {
			e.v1().signatures([new xdr.DecoratedSignature({ hint: Buffer.alloc(4), signature: Buffer.alloc(64) })])
		})],
		['fee changed after signing', 'signed_mismatch', mutate(signed, (e) => { txOf(e).fee(txOf(e).fee() + 1) })],
		['trailing bytes', 'signed_malformed', Buffer.concat([Buffer.from(signed, 'base64'), Buffer.alloc(4)]).toString('base64')],
	]
	for (const [name, code, value, options] of cases) {
		const adjusted = name === 'expiry changed after signing' ? { ...opts, expirationLedger: 66_000_005 } : options ?? opts
		assert.equal(rejectionCode(() => assertSignedMintEnvelope(validated, value, adjusted)), code, name)
	}
})

// ---------------------------------------------------------------------------
// Property / mutation tests over authorization fields and canonical encoding
// ---------------------------------------------------------------------------

type Site = { label: string; apply: (e: xdr.TransactionEnvelope) => void }

/** Every leaf a mint's meaning depends on: host-function args and both trees (address, fn, args). */
function authorizationSites(c: Carrier, issuer: string): Site[] {
	const sites: Site[] = []
	const scValSites = (label: string, get: (e: xdr.TransactionEnvelope) => xdr.ScVal, set: (e: xdr.TransactionEnvelope, v: xdr.ScVal) => void, value: xdr.ScVal) => {
		const kind = value.switch().name
		if (kind === 'scvVec') {
			value.vec()!.forEach((item, i) => scValSites(`${label}[${i}]`, (e) => get(e).vec()![i], (e, v) => { get(e).vec()![i] = v }, item))
			sites.push({ label: `${label}+push`, apply: (e) => { get(e).vec()!.push(get(e).vec()![0]) } })
			return
		}
		if (kind === 'scvMap') {
			value.map()!.forEach((entry, i) => scValSites(`${label}.${entry.key().sym().toString()}`, (e) => get(e).map()![i].val(), (e, v) => { get(e).map()![i].val(v) }, entry.val()))
			return
		}
		sites.push({ label, apply: (e) => set(e, perturb(get(e))) })
	}
	const invocationSites = (label: string, get: (e: xdr.TransactionEnvelope) => xdr.SorobanAuthorizedInvocation, value: xdr.SorobanAuthorizedInvocation) => {
		const fn = value.function().contractFn()
		sites.push({ label: `${label}.contract`, apply: (e) => { get(e).function().contractFn().contractAddress(new Address(ATTACKER).toScAddress()) } })
		sites.push({ label: `${label}.fn`, apply: (e) => { get(e).function().contractFn().functionName(`${fn.functionName().toString()}_`) } })
		fn.args().forEach((arg, i) => scValSites(`${label}.args[${i}]`, (e) => get(e).function().contractFn().args()[i], (e, v) => { get(e).function().contractFn().args()[i] = v }, arg))
		if (value.subInvocations().length) {
			sites.push({ label: `${label}.drop`, apply: (e) => { get(e).subInvocations([...get(e).subInvocations()].slice(1)) } })
		}
		value.subInvocations().forEach((sub, i) => invocationSites(`${label}/${i}`, (e) => get(e).subInvocations()[i], sub))
	}
	const envelope = xdr.TransactionEnvelope.fromXDR(c.xdr, 'base64')
	argsOf(envelope).forEach((arg, i) => scValSites(`fn.args[${i}]`, (e) => argsOf(e)[i], (e, v) => { argsOf(e)[i] = v }, arg))
	for (const role of ['admin', 'user'] as const) {
		invocationSites(role, (e) => entryFor(e, role, issuer).rootInvocation(), entryFor(envelope, role, issuer).rootInvocation())
	}
	return sites
}

function perturb(value: xdr.ScVal): xdr.ScVal {
	switch (value.switch().name) {
		case 'scvAddress':
			return Address.fromScVal(value).toString() === ATTACKER ? scAddr(SMOL_ISSUER) : scAddr(ATTACKER)
		case 'scvI128':
			return i128(BigInt(value.i128().lo().toString()) + 1n)
		case 'scvBytes': {
			const bytes = Buffer.from(value.bytes())
			bytes[bytes.length - 1] ^= 1
			return xdr.ScVal.scvBytes(bytes)
		}
		case 'scvSymbol':
			return xdr.ScVal.scvSymbol(`${value.sym().toString()}x`)
		default:
			return xdr.ScVal.scvVoid()
	}
}

test('property: every authorization-relevant field mutation (host fn args, both trees) is rejected', () => {
	let checked = 0
	for (const c of feCarriers.carriers) {
		const identity = identityOf(c.identity)
		for (const site of authorizationSites(c, identity.issuer)) {
			const mutated = mutate(c.xdr, site.apply)
			assert.notEqual(mutated, c.xdr, `${c.name} ${site.label} must change bytes`)
			rejectionCode(() => validate(mutated, c, identity))
			checked += 1
		}
	}
	assert.ok(checked > 1_000, `only ${checked} sites`)
})

test('property: legitimate variation is accepted (nonces, fees, resources, time bounds, entry order, passkey bytes)', async () => {
	for (const c of feCarriers.carriers.filter((entry) => entry.identity === 'test')) {
		const variants = [
			mutate(c.xdr, (e) => { for (const entry of opOf(e).auth()) entry.credentials().address().nonce(xdr.Int64.fromString('-9000000000000000000')) }),
			mutate(c.xdr, (e) => { txOf(e).fee(4_294_967_295) }),
			mutate(c.xdr, (e) => {
				const resources = txOf(e).ext().sorobanData().resources()
				resources.instructions(resources.instructions() + 1)
				txOf(e).ext().sorobanData().resourceFee(xdr.Int64.fromString('1'))
			}),
			mutate(c.xdr, (e) => { txOf(e).cond(xdr.Preconditions.precondNone()) }),
			mutate(c.xdr, (e) => { opOf(e).auth([...opOf(e).auth()].reverse()) }),
			mutate(c.xdr, (e) => {
				const sig = entryFor(e, 'user', TEST_IDENTITY.issuer).credentials().address().signature().vec()![0].map()![0]
				sig.key(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Secp256r1'), xdr.ScVal.scvBytes(Buffer.alloc(16, 7))]))
			}),
		]
		for (const variant of variants) {
			const validated = validate(variant, c, TEST_IDENTITY)
			const signed = await signValidatedMint(validated, TEST_ISSUER, 66_100_000, Networks.PUBLIC)
			assertSignedMintEnvelope(validated, signed, { expirationLedger: 66_100_000, networkPassphrase: Networks.PUBLIC })
		}
	}
})

test('wallet credential: passkey-kit Ed25519 and multi-signer signatures are accepted, signed and verified', async () => {
	for (const c of feCarriers.carriers.filter((entry) => entry.identity === 'test')) {
		const issuer = TEST_IDENTITY.issuer
		const variants = [
			mutate(c.xdr, (e) => setWalletSigners(e, [ed25519Signer(3)], issuer)),
			// Strictly increasing under Soroban's ScVal order: Symbol("Ed25519") < Symbol("Secp256r1").
			mutate(c.xdr, (e) => setWalletSigners(e, [ed25519Signer(4), walletSigner(e, issuer)], issuer)),
			mutate(c.xdr, (e) => setWalletSigners(e, [1, 2, 3, 4].map(ed25519Signer), issuer)),
			// Bytes compare lexicographically before length: 0x07 x17 < 0x08 x16, and a prefix sorts first.
			mutate(c.xdr, (e) => setWalletSigners(e, [
				secp256r1Signer(e, Buffer.alloc(16, 7), issuer), secp256r1Signer(e, Buffer.alloc(17, 7), issuer), secp256r1Signer(e, Buffer.alloc(16, 8), issuer),
			], issuer)),
			mutate(c.xdr, (e) => setWalletSigners(e, [ed25519Signer(9), secp256r1Signer(e, Buffer.alloc(1, 0), issuer), walletSigner(e, issuer)], issuer)),
			mutate(c.xdr, (e) => {
				const fields = walletSigner(e, issuer).val().vec()![1].map()!
				fields[1].val(filled(1))
				fields[0].val(filled(37))
			}),
			mutate(c.xdr, (e) => { walletSigner(e, issuer).key(xdr.ScVal.scvVec([sym('Secp256r1'), filled(1023)])) }),
		]
		for (const variant of variants) {
			const validated = validate(variant, c, TEST_IDENTITY)
			const signed = await signValidatedMint(validated, TEST_ISSUER, 66_200_000, Networks.PUBLIC)
			assertSignedMintEnvelope(validated, signed, { expirationLedger: 66_200_000, networkPassphrase: Networks.PUBLIC })
		}
	}
})

test('wallet credential: signer keys must be strictly increasing in Soroban order (descending or mixed out-of-order maps are refused)', () => {
	for (const c of feCarriers.carriers.filter((entry) => entry.identity === 'test')) {
		const issuer = TEST_IDENTITY.issuer
		const secp = (e: xdr.TransactionEnvelope, fill: number, size = 16) => secp256r1Signer(e, Buffer.alloc(size, fill), issuer)
		const refused: Array<[string, (e: xdr.TransactionEnvelope) => xdr.ScMapEntry[]]> = [
			['mixed variants, descending', (e) => [walletSigner(e, issuer), ed25519Signer(4)]],
			['mixed variants, Ed25519 between Secp256r1 keys', (e) => [secp(e, 1), ed25519Signer(4), secp(e, 2)]],
			['Ed25519, descending', () => [ed25519Signer(2), ed25519Signer(1)]],
			['Ed25519, one pair out of order', () => [ed25519Signer(1), ed25519Signer(3), ed25519Signer(2), ed25519Signer(4)]],
			['Secp256r1, descending bytes', (e) => [secp(e, 2), secp(e, 1)]],
			['Secp256r1, shorter-first by length (XDR order) but bytes descend', (e) => [secp(e, 8, 16), secp(e, 7, 17)]],
			['Secp256r1, longer key before its own prefix', (e) => [secp(e, 7, 17), secp(e, 7, 16)]],
			['equal keys', () => [ed25519Signer(5), ed25519Signer(5)]],
		]
		for (const [label, signers] of refused) {
			const variant = mutate(c.xdr, (e) => setWalletSigners(e, signers(e), issuer))
			assert.equal(rejectionCode(() => validate(variant, c, TEST_IDENTITY)), 'user_signature_shape', `${c.name}: ${label}`)
			// The same entries in ascending order are accepted (except the duplicate pair).
			if (label === 'equal keys') continue
			const ascending = mutate(c.xdr, (e) => setWalletSigners(e, [...signers(e)].sort((a, b) => compareScVal(a.key(), b.key())), issuer))
			validate(ascending, c, TEST_IDENTITY)
		}
	}
})

test('compareScVal: matches the Soroban host order (discriminant, then bytes lexicographically, Vec element-wise, then length)', () => {
	const bytes = (...values: number[]) => xdr.ScVal.scvBytes(Buffer.from(values))
	const vec = (...values: xdr.ScVal[]) => xdr.ScVal.scvVec(values)
	const map = (...entries: Array<[xdr.ScVal, xdr.ScVal]>) => xdr.ScVal.scvMap(entries.map(([key, val]) => new xdr.ScMapEntry({ key, val })))
	const ascending: xdr.ScVal[][] = [
		// ScValType discriminants: Bool 0 < Void 1 < U32 3 < I32 4 < U64 5 < I64 6 < U128 9 < I128 10 < Bytes 13 < String 14 < Symbol 15 < Vec 16 < Map 17.
		[xdr.ScVal.scvBool(true), xdr.ScVal.scvVoid(), xdr.ScVal.scvU32(0), xdr.ScVal.scvI32(-5), xdr.ScVal.scvU64(xdr.Uint64.fromString('0')),
			xdr.ScVal.scvI64(xdr.Int64.fromString('-1')), nativeToScVal(0n, { type: 'u128' }), nativeToScVal(-1n, { type: 'i128' }), bytes(),
			xdr.ScVal.scvString(''), sym('A'), vec(), map()],
		// Bytes: lexicographic, then length.
		[bytes(), bytes(0), bytes(0, 0), bytes(0, 1), bytes(1), bytes(1, 0), bytes(2), bytes(0xff)],
		// Symbols: ASCII bytes ('0' < 'A' < 'Z' < '_' < 'a'), a prefix first.
		[sym('0'), sym('A'), sym('Ed25519'), sym('Policy'), sym('Secp256r1'), sym('Z'), sym('_'), sym('a'), sym('ab'), sym('abc'), sym('b')],
		// Vec: element-wise, then length.
		[vec(), vec(sym('Ed25519')), vec(sym('Ed25519'), bytes(0xff)), vec(sym('Secp256r1'), bytes()), vec(sym('Secp256r1'), bytes(0)),
			vec(sym('Secp256r1'), bytes(0), bytes()), vec(sym('Secp256r1'), bytes(1))],
		// Integers numerically, including signed 128-bit and 64-bit.
		[nativeToScVal(-(2n ** 100n), { type: 'i128' }), nativeToScVal(-1n, { type: 'i128' }), nativeToScVal(0n, { type: 'i128' }), nativeToScVal(2n ** 64n, { type: 'i128' })],
		[xdr.ScVal.scvI64(xdr.Int64.fromString('-9000000000000000000')), xdr.ScVal.scvI64(xdr.Int64.fromString('-1')), xdr.ScVal.scvI64(xdr.Int64.fromString('7'))],
		[xdr.ScVal.scvBool(false), xdr.ScVal.scvBool(true)],
		// Map: entry by entry (key, then value), then length.
		[map(), map([sym('a'), bytes(1)]), map([sym('a'), bytes(2)]), map([sym('a'), bytes(2)], [sym('b'), bytes()]), map([sym('b'), bytes()])],
	]
	for (const row of ascending) {
		for (let i = 0; i < row.length; i += 1) {
			assert.equal(compareScVal(row[i], row[i]), 0)
			for (let j = i + 1; j < row.length; j += 1) {
				assert.equal(compareScVal(row[i], row[j]), -1, `${row[i].toXDR('base64')} < ${row[j].toXDR('base64')}`)
				assert.equal(compareScVal(row[j], row[i]), 1)
			}
		}
	}
	// The wallet signer keys smol wallets use: Ed25519 keys sort before every Secp256r1 key.
	assert.equal(compareScVal(vec(sym('Ed25519'), xdr.ScVal.scvBytes(Buffer.alloc(32, 0xff))), vec(sym('Secp256r1'), bytes(0))), -1)
	// Types a signer key never has are refused rather than guessed.
	assert.throws(() => compareScVal(nativeToScVal(SMOL_ISSUER, { type: 'address' }), nativeToScVal(SMOL_FACTORY, { type: 'address' })))
})

test('validated mint: the byte snapshot is private (fresh copies; carrier or copy mutation never reaches the signer)', async () => {
	const c = carrier('test/coin_them-2')
	const original = Buffer.from(c.xdr, 'base64')
	const decoded = decodeMintCarrier(c.xdr, c.kind, TEST_IDENTITY)
	const validated = assertUnsignedMintEnvelope(decoded, buildMintExpectation({ identity: TEST_IDENTITY, kind: c.kind, sub: c.sub, tracks: c.tracks }))
	assert.ok(Object.isFrozen(validated))
	assert.equal(Object.getOwnPropertyDescriptor(validated, 'bytes')?.value, undefined, 'bytes is an accessor, not a stored field')
	const copy = validated.bytes
	assert.notEqual(copy, validated.bytes, 'every read is a fresh copy')
	assert.ok(copy.equals(original))
	// Mutating the returned copy and the decoded carrier's buffer leaves the validated bytes intact.
	copy.fill(0)
	decoded.bytes.fill(0)
	assert.ok(validated.bytes.equals(original))
	assert.equal(Reflect.set(validated, 'bytes', Buffer.alloc(1)), false, 'bytes cannot be replaced')
	const signed = await signValidatedMint(validated, TEST_ISSUER, 66_300_000, Networks.PUBLIC)
	assertSignedMintEnvelope(validated, signed, { expirationLedger: 66_300_000, networkPassphrase: Networks.PUBLIC })
	// The signed output differs from the original only in the issuer signature and its expiry.
	const reset = xdr.TransactionEnvelope.fromXDR(signed, 'base64')
	const admin = entryFor(reset, 'admin', TEST_IDENTITY.issuer).credentials().address()
	admin.signature(xdr.ScVal.scvVoid())
	admin.signatureExpirationLedger(0)
	assert.ok(reset.toXDR().equals(original))
	// A copied value is not a validated value, even with identical fields and bytes.
	await assert.rejects(signValidatedMint({ ...validated } as ValidatedUnsignedMint, TEST_ISSUER, 66_300_000, Networks.PUBLIC),
		(e: unknown) => e instanceof MintRejected && e.code === 'not_validated')
})

test('property: seeded random byte flips never crash and never pass with a different meaning', () => {
	let seed = 0x5eed_f00d
	const next = () => {
		seed ^= seed << 13
		seed ^= seed >>> 17
		seed ^= seed << 5
		return (seed >>> 0)
	}
	let accepted = 0
	for (const c of feCarriers.carriers.filter((entry) => entry.identity === 'mainnet')) {
		const bytes = Buffer.from(c.xdr, 'base64')
		const expected = buildMintExpectation({ kind: c.kind, sub: c.sub, tracks: c.tracks })
		for (let i = 0; i < 1_500; i += 1) {
			const flipped = Buffer.from(bytes)
			flipped[next() % flipped.length] ^= 1 << (next() % 8)
			try {
				const validated = validate(flipped.toString('base64'), c, M)
				// Only bytes outside the authorized intent (nonce, fees, resources, wallet signature) may vary.
				accepted += 1
				const envelope = xdr.TransactionEnvelope.fromXDR(validated.bytes)
				assert.ok(opOf(envelope).hostFunction().toXDR().equals(expected.hostFunction))
				assert.ok(entryFor(envelope, 'admin', SMOL_ISSUER).rootInvocation().toXDR().equals(expected.adminInvocation))
				assert.ok(entryFor(envelope, 'user', SMOL_ISSUER).rootInvocation().toXDR().equals(expected.userInvocation))
			} catch (error) {
				assert.ok(error instanceof MintRejected, `non-closed-set failure: ${(error as Error).stack}`)
			}
		}
	}
	assert.ok(accepted >= 0)
})

test('canonical encoding: expected values are spec-encoded exactly like the FE (sorted map keys, i128, BytesN<32>)', () => {
	const c = carrier('mainnet/coin_it-self')
	const expected = buildMintExpectation({ kind: c.kind, sub: c.sub, tracks: c.tracks })
	const args = xdr.HostFunction.fromXDR(expected.hostFunction).invokeContract().args()
	assert.deepEqual(args.map((arg) => arg.switch().name), ['scvAddress', 'scvBytes', 'scvBytes', 'scvMap'])
	assert.deepEqual(args[3].map()!.map((entry) => entry.key().sym().toString()), ['fee_asset', 'recipients'])
	const recipients = mapField(args[3], 'recipients').val().vec()!
	assert.equal(recipients.length, 1, 'self-mint pays a single 50% recipient')
	assert.equal(mapField(recipients[0], 'percent').val().switch().name, 'scvI128')
	assert.equal(args[2].bytes().length, 32)
	assert.equal(Buffer.from(args[1].bytes()).toString('base64'), new Asset(c.tracks[0].id.slice(0, 12), SMOL_ISSUER).toXDRObject().toXDR('base64'))
	// Leading zeros in the id are preserved in the salt and the asset code.
	const zeroLed = `000000${'a'.repeat(58)}`
	const zero = buildMintExpectation({ kind: 'coin_it', sub: c.sub, tracks: [{ id: zeroLed, creator: c.sub }] })
	const zeroArgs = xdr.HostFunction.fromXDR(zero.hostFunction).invokeContract().args()
	assert.equal(Buffer.from(zeroArgs[2].bytes()).toString('hex'), zeroLed)
	assert.equal(Asset.fromOperation(xdr.Asset.fromXDR(Buffer.from(zeroArgs[1].bytes()))).getCode(), '000000aaaaaa')
})

test('expectation builder refuses malformed inputs with closed-set codes', () => {
	const sub = single.sub
	const id = single.tracks[0].id
	const cases: Array<[MintRejectCode, Parameters<typeof buildMintExpectation>[0]]> = [
		['session_invalid', { kind: 'coin_it', sub: SMOL_ISSUER, tracks: [{ id, creator: sub }] }],
		['id_invalid', { kind: 'coin_it', sub, tracks: [{ id: id.toUpperCase(), creator: sub }] }],
		['id_invalid', { kind: 'coin_it', sub, tracks: [{ id: id.slice(1), creator: sub }] }],
		['creator_invalid', { kind: 'coin_it', sub, tracks: [{ id, creator: 'not-an-address' }] }],
		['batch_size', { kind: 'coin_it', sub, tracks: [] }],
		['batch_size', { kind: 'coin_them', sub, tracks: Array.from({ length: 6 }, (_, i) => ({ id: hash(Buffer.from(`${i}`)).toString('hex'), creator: sub })) }],
		['id_duplicate', { kind: 'coin_them', sub, tracks: [{ id, creator: sub }, { id, creator: sub }] }],
		['prefix_duplicate', { kind: 'coin_them', sub, tracks: [{ id, creator: sub }, { id: `${id.slice(0, 12)}${'0'.repeat(52)}`, creator: sub }] }],
	]
	for (const [code, input] of cases) assert.equal(rejectionCode(() => buildMintExpectation(input)), code)
})
