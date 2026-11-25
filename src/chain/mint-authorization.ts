/**
 * Mint authorization: the only path by which the SMOL issuer key (`env.SK`) may sign.
 *
 * Construct-and-compare. The server builds the exact host function and both authorization trees
 * a legitimate frontend mint produces (from the route, the verified session and D1 facts), then
 * requires the submitted carrier to match them byte for byte. It never walks an attacker-supplied
 * tree looking for bad things, and the signer only accepts a value this module validated.
 *
 * Pure: no I/O. Stages:
 *   1. `decodeMintCarrier`        size limits, base64, canonical XDR, carrier profile, op shape
 *   2. `buildMintExpectation`     server-constructed host function + admin/user invocation trees
 *   3. `assertUnsignedMintEnvelope` unsigned-input predicate (admin entry must arrive unsigned)
 *   4. `signValidatedMint`        signs only the single admin entry with `authorizeEntry`
 *   5. `assertSignedMintEnvelope` signed-output predicate (only admin signature + expiry changed)
 */
import { Address, Asset, authorizeEntry, hash, Keypair, nativeToScVal, Networks, StrKey, xdr } from '@stellar/stellar-sdk/base'
import { isLedgerSequence, KALE_SAC, SMOL_FACTORY, SMOL_ISSUER } from '../utils/chain'
import { smolSpec } from './smol-spec'
import { bytesEqual, compareBytes } from '../utils/bytes'

/** Live mainnet `contract_bandwidth_v0.tx_max_size_bytes`. The signed envelope must fit. */
export const MAX_SIGNED_MINT_XDR_BYTES = 132_096
/** Head-room for the issuer's `[{ public_key, signature }]` credential (actual growth: 172 bytes). */
export const ISSUER_SIGNATURE_RESERVE_BYTES = 1_024
export const MAX_UNSIGNED_MINT_XDR_BYTES = MAX_SIGNED_MINT_XDR_BYTES - ISSUER_SIGNATURE_RESERVE_BYTES
export const MAX_UNSIGNED_MINT_XDR_BASE64_CHARS = 4 * Math.ceil(MAX_UNSIGNED_MINT_XDR_BYTES / 3)
/** `smol-fe` MINT_BATCH_SIZE: one `coin_them` carries at most five tracks. */
export const MAX_COIN_THEM_TRACKS = 5
/** Request body cap for both mint routes: the base64 carrier plus ids and JSON framing. */
export const MAX_MINT_REQUEST_BODY_BYTES = MAX_UNSIGNED_MINT_XDR_BASE64_CHARS + 16 * 1024

const CANONICAL_ID = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const MINT_AMOUNT = 10_000_000_0000000n
const POOL_TRACK_BALANCE = 990_000_000_0000000n
const MINT_FEE_KALE = 100_0000000n
const POOL_WEIGHT = 50_00000n
const POOL_MIN_FEE = 5_00000n
const POOL_MAX_FEE = 95_00000n
const POOL_HIGH_UTIL = 70_000_0000000n
const SELF_MINT_FEE_PERCENT = 50_00000n
const SPLIT_FEE_PERCENT = 25_00000n

export type MintKind = 'coin_it' | 'coin_them'

export const MINT_REJECT_CODES = [
	'xdr_missing',
	'xdr_too_large',
	'xdr_not_base64',
	'xdr_malformed',
	'xdr_noncanonical',
	'envelope_type',
	'envelope_signed',
	'carrier_source',
	'carrier_sequence',
	'carrier_preconditions',
	'carrier_memo',
	'carrier_ext',
	'op_count',
	'op_source',
	'op_type',
	'host_function_type',
	'contract_mismatch',
	'function_mismatch',
	'arg_shape',
	'batch_size',
	'id_invalid',
	'id_duplicate',
	'prefix_duplicate',
	'ids_mismatch',
	'session_invalid',
	'creator_invalid',
	'host_function_mismatch',
	'auth_count',
	'auth_credentials',
	'auth_unexpected_address',
	'auth_duplicate',
	'auth_admin_missing',
	'auth_user_missing',
	'admin_root_mismatch',
	'admin_tree_mismatch',
	'admin_presigned',
	'user_root_mismatch',
	'user_tree_mismatch',
	'user_unsigned',
	'user_signature_shape',
	'config_mismatch',
	'network_mismatch',
	'signer_mismatch',
	'expiration_invalid',
	'not_validated',
	'signed_too_large',
	'signed_malformed',
	'signed_mismatch',
	'signature_invalid',
] as const

export type MintRejectCode = (typeof MINT_REJECT_CODES)[number]

export class MintRejected extends Error {
	readonly code: MintRejectCode
	constructor(code: MintRejectCode) {
		super(`Mint authorization rejected: ${code}`)
		this.name = 'MintRejected'
		this.code = code
	}
}

function reject(code: MintRejectCode): never {
	throw new MintRejected(code)
}

/** Any unexpected failure while inspecting untrusted XDR still ends in a closed-set code. */
function closedSet<T>(fallback: MintRejectCode, run: () => T): T {
	try {
		return run()
	} catch (error) {
		if (error instanceof MintRejected) throw error
		reject(fallback)
	}
}

function addressOf(scAddress: xdr.ScAddress, code: MintRejectCode): string {
	try {
		return Address.fromScAddress(scAddress).toString()
	} catch {
		reject(code)
	}
}

// ---------------------------------------------------------------------------
// Identity (asserted at admission and at the signer boundary)
// ---------------------------------------------------------------------------

/** Everything an expected mint tree is derived from. Production only ever uses the mainnet one. */
export interface MintIdentity {
	readonly factory: string
	readonly issuer: string
	readonly kaleSac: string
	readonly networkPassphrase: string
}

export const MAINNET_MINT_IDENTITY: MintIdentity = Object.freeze({
	factory: SMOL_FACTORY,
	issuer: SMOL_ISSUER,
	kaleSac: KALE_SAC,
	networkPassphrase: Networks.PUBLIC,
})

/**
 * The Worker must be configured for the pinned mainnet factory and passphrase; anything else
 * (another factory, a test network) must not admit or sign mints.
 */
export function assertMintConfig(env: { SMOL_CONTRACT_ID?: string; NETWORK_PASSPHRASE?: string }): MintIdentity {
	if (env.SMOL_CONTRACT_ID !== MAINNET_MINT_IDENTITY.factory) reject('config_mismatch')
	if (env.NETWORK_PASSPHRASE !== MAINNET_MINT_IDENTITY.networkPassphrase) reject('network_mismatch')
	return MAINNET_MINT_IDENTITY
}

/** The SAC for `id`'s asset code and the pool the factory deploys with salt `id`. */
export function deriveMintAddresses(identity: MintIdentity, id: string): { sac: string; pool: string } {
	const sac = new Asset(id.slice(0, 12), identity.issuer).contractId(identity.networkPassphrase)
	const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
		networkId: hash(Buffer.from(identity.networkPassphrase)),
		contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({
			address: new Address(identity.factory).toScAddress(),
			salt: Buffer.from(id, 'hex'),
		})),
	}))
	return { sac, pool: StrKey.encodeContract(hash(preimage.toXDR())) }
}

export function mintKindForRoute(type: 'mint' | 'batch-mint'): MintKind {
	return type === 'mint' ? 'coin_it' : 'coin_them'
}

export function isCanonicalMintId(id: unknown): id is string {
	return typeof id === 'string' && CANONICAL_ID.test(id)
}

// ---------------------------------------------------------------------------
// Stage 1: decode the unsigned carrier (no D1 needed)
// ---------------------------------------------------------------------------

export interface DecodedMintCarrier {
	readonly identity: MintIdentity
	readonly kind: MintKind
	/** Exact decoded bytes; canonical (re-encoding reproduces them). */
	readonly bytes: Buffer
	/** Track ids in the carrier's salt order (lowercase canonical hex). */
	readonly ids: readonly string[]
}

const NULL_ACCOUNT_KEY = new Uint8Array(32)

export function decodeMintCarrier(value: unknown, kind: MintKind, identity: MintIdentity = MAINNET_MINT_IDENTITY): DecodedMintCarrier {
	return closedSet('xdr_malformed', () => decodeCarrier(value, kind, identity))
}

function decodeCarrier(value: unknown, kind: MintKind, identity: MintIdentity): DecodedMintCarrier {
	if (typeof value !== 'string' || value.length === 0) reject('xdr_missing')
	// Size before any allocation proportional to the payload or XDR decoding.
	if (value.length > MAX_UNSIGNED_MINT_XDR_BASE64_CHARS) reject('xdr_too_large')
	if (value.length % 4 !== 0 || !BASE64.test(value)) reject('xdr_not_base64')
	const bytes = Buffer.from(value, 'base64')
	if (bytes.toString('base64') !== value) reject('xdr_not_base64')
	if (bytes.length > MAX_UNSIGNED_MINT_XDR_BYTES) reject('xdr_too_large')

	let envelope: xdr.TransactionEnvelope
	try {
		envelope = xdr.TransactionEnvelope.fromXDR(bytes)
	} catch {
		reject('xdr_malformed')
	}
	if (!bytesEqual(envelope.toXDR(), bytes)) reject('xdr_noncanonical')

	const invokeArgs = carrierInvokeArgs(envelope)
	if (addressOf(invokeArgs.contractAddress(), 'contract_mismatch') !== identity.factory) reject('contract_mismatch')
	if (invokeArgs.functionName().toString() !== kind) reject('function_mismatch')

	const args = invokeArgs.args()
	if (args.length !== 4) reject('arg_shape')
	const ids = kind === 'coin_it' ? [saltId(args[2])] : coinThemSaltIds(args)
	if (new Set(ids).size !== ids.length) reject('id_duplicate')
	if (new Set(ids.map((id) => id.slice(0, 12))).size !== ids.length) reject('prefix_duplicate')

	return Object.freeze({ identity, kind, bytes, ids: Object.freeze(ids) })
}

/** Carrier profile of the frozen FE builder (SDK 14 `AssembledTransaction`, no public key). */
function carrierInvokeArgs(envelope: xdr.TransactionEnvelope): xdr.InvokeContractArgs {
	// v0 and fee-bump envelopes are never an FE carrier; a signed envelope would take the relay's
	// pass-through path instead of the func/auth path.
	if (envelope.switch().name !== 'envelopeTypeTx') reject('envelope_type')
	const v1 = envelope.v1()
	if (v1.signatures().length !== 0) reject('envelope_signed')
	const tx = v1.tx()

	const source = tx.sourceAccount()
	if (source.switch().name !== 'keyTypeEd25519' || !bytesEqual(source.ed25519(), NULL_ACCOUNT_KEY)) {
		reject('carrier_source')
	}
	if (tx.seqNum().toString() !== '1') reject('carrier_sequence')
	const cond = tx.cond().switch().name
	if (cond !== 'precondNone' && cond !== 'precondTime') reject('carrier_preconditions')
	if (tx.memo().switch().name !== 'memoNone') reject('carrier_memo')
	const ext = tx.ext()
	if (ext.switch() !== 0 && ext.switch() !== 1) reject('carrier_ext')
	if (ext.switch() === 1) {
		const dataExt = ext.sorobanData().ext().switch()
		if (dataExt !== 0 && dataExt !== 1) reject('carrier_ext')
	}

	const operations = tx.operations()
	if (operations.length !== 1) reject('op_count')
	const op = operations[0]
	if (op.sourceAccount()) reject('op_source')
	if (op.body().switch().name !== 'invokeHostFunction') reject('op_type')
	const fn = op.body().invokeHostFunctionOp().hostFunction()
	if (fn.switch().name !== 'hostFunctionTypeInvokeContract') reject('host_function_type')
	return fn.invokeContract()
}

function invokeOp(envelope: xdr.TransactionEnvelope): xdr.InvokeHostFunctionOp {
	return envelope.v1().tx().operations()[0].body().invokeHostFunctionOp()
}

function saltId(value: xdr.ScVal): string {
	if (value.switch().name !== 'scvBytes') reject('arg_shape')
	const bytes = Buffer.from(value.bytes())
	if (bytes.length !== 32) reject('id_invalid')
	return bytes.toString('hex')
}

function coinThemSaltIds(args: xdr.ScVal[]): string[] {
	const vectors = [args[1], args[2], args[3]].map((arg) => {
		if (arg.switch().name !== 'scvVec') reject('arg_shape')
		return arg.vec() ?? reject('arg_shape')
	})
	const count = vectors[1].length
	if (count < 1 || count > MAX_COIN_THEM_TRACKS) reject('batch_size')
	if (vectors.some((vector) => vector.length !== count)) reject('arg_shape')
	return vectors[1].map(saltId)
}

// ---------------------------------------------------------------------------
// Stage 2: the server-constructed expectation
// ---------------------------------------------------------------------------

export interface MintTrack {
	/** Canonical 64-hex smol id. */
	readonly id: string
	/** `Smols.Address`, the creator who receives the fee share. */
	readonly creator: string
}

export interface MintExpectation {
	readonly identity: MintIdentity
	readonly kind: MintKind
	readonly sub: string
	readonly tracks: readonly MintTrack[]
	readonly hostFunction: Buffer
	readonly rootFunction: Buffer
	readonly invokeArgs: Buffer
	readonly adminInvocation: Buffer
	readonly userInvocation: Buffer
}

/** The FE fee rule: one 50% recipient on a self-mint, otherwise creator then minter at 25% each. */
export function mintFeeRule(creator: string, minter: string, feeAsset: string = KALE_SAC) {
	return creator === minter
		? { fee_asset: feeAsset, recipients: [{ percent: SELF_MINT_FEE_PERCENT, recipient: creator }] }
		: {
			fee_asset: feeAsset,
			recipients: [
				{ percent: SPLIT_FEE_PERCENT, recipient: creator },
				{ percent: SPLIT_FEE_PERCENT, recipient: minter },
			],
		}
}

export function mintAssetBytes(id: string, issuer: string = SMOL_ISSUER): Buffer {
	return new Asset(id.slice(0, 12), issuer).toXDRObject().toXDR()
}

function isValidAddress(value: unknown): value is string {
	return typeof value === 'string' && (StrKey.isValidContract(value) || StrKey.isValidEd25519PublicKey(value))
}

const scAddress = (value: string) => new Address(value).toScVal()
const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' })

function invocation(contract: string, functionName: string, args: xdr.ScVal[], subInvocations: xdr.SorobanAuthorizedInvocation[] = []) {
	return new xdr.SorobanAuthorizedInvocation({
		function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
			contractAddress: new Address(contract).toScAddress(),
			functionName,
			args,
		})),
		subInvocations,
	})
}

export function buildMintExpectation(input: {
	kind: MintKind
	sub: string
	tracks: readonly MintTrack[]
	identity?: MintIdentity
}): MintExpectation {
	return closedSet('arg_shape', () => buildExpectation(input))
}

function buildExpectation(input: Parameters<typeof buildMintExpectation>[0]): MintExpectation {
	const { kind, sub, identity = MAINNET_MINT_IDENTITY } = input
	const { factory, issuer, kaleSac } = identity
	if (typeof sub !== 'string' || !StrKey.isValidContract(sub)) reject('session_invalid')
	const tracks = input.tracks.map(({ id, creator }) => ({ id, creator }))
	if (kind === 'coin_it' ? tracks.length !== 1 : tracks.length < 1 || tracks.length > MAX_COIN_THEM_TRACKS) reject('batch_size')
	const pairs = tracks.map(({ id, creator }) => {
		if (!isCanonicalMintId(id)) reject('id_invalid')
		if (!isValidAddress(creator)) reject('creator_invalid')
		return deriveMintAddresses(identity, id)
	})
	if (new Set(tracks.map(({ id }) => id)).size !== tracks.length) reject('id_duplicate')
	if (new Set(tracks.map(({ id }) => id.slice(0, 12))).size !== tracks.length) reject('prefix_duplicate')

	// The same spec encoder the FE generated factory bindings use, so argument bytes match exactly.
	const spec = smolSpec()
	const args = kind === 'coin_it'
		? spec.funcArgsToScVals('coin_it', {
			user: sub,
			asset_bytes: mintAssetBytes(tracks[0].id, issuer),
			salt: Buffer.from(tracks[0].id, 'hex'),
			fee_rule: mintFeeRule(tracks[0].creator, sub, kaleSac),
		})
		: spec.funcArgsToScVals('coin_them', {
			user: sub,
			asset_bytes: tracks.map(({ id }) => mintAssetBytes(id, issuer)),
			salts: tracks.map(({ id }) => Buffer.from(id, 'hex')),
			fee_rules: tracks.map(({ creator }) => mintFeeRule(creator, sub, kaleSac)),
		})
	const feeRules = kind === 'coin_it' ? [args[3]] : args[3].vec()!
	const invokeArgs = new xdr.InvokeContractArgs({
		contractAddress: new Address(factory).toScAddress(),
		functionName: kind,
		args,
	})
	const rootFunction = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs)

	// Admin tree, in salt order: SAC mint to the minter, then the pool constructor whose controller
	// (the issuer) funds the pool with both reserves.
	const adminSubInvocations = pairs.flatMap(({ sac, pool }, index) => [
		invocation(sac, 'mint', [scAddress(sub), i128(MINT_AMOUNT)]),
		invocation(pool, '__constructor', [
			scAddress(issuer),
			xdr.ScVal.scvVec([scAddress(sac), scAddress(kaleSac)]),
			xdr.ScVal.scvVec([i128(POOL_WEIGHT), i128(POOL_WEIGHT)]),
			xdr.ScVal.scvVec([i128(POOL_TRACK_BALANCE), i128(MINT_FEE_KALE)]),
			i128(POOL_MIN_FEE),
			i128(POOL_MAX_FEE),
			scAddress(kaleSac),
			i128(MINT_FEE_KALE),
			i128(POOL_HIGH_UTIL),
			feeRules[index],
		], [
			invocation(sac, 'transfer', [scAddress(issuer), scAddress(pool), i128(POOL_TRACK_BALANCE)]),
			invocation(kaleSac, 'transfer', [scAddress(issuer), scAddress(pool), i128(MINT_FEE_KALE)]),
		]),
	])
	// User tree: exactly one KALE mint-fee transfer to the issuer per track.
	const userSubInvocations = tracks.map(() =>
		invocation(kaleSac, 'transfer', [scAddress(sub), scAddress(issuer), i128(MINT_FEE_KALE)]))

	return Object.freeze({
		identity,
		kind,
		sub,
		tracks: Object.freeze(tracks.map((track) => Object.freeze(track))),
		hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs).toXDR(),
		rootFunction: rootFunction.toXDR(),
		invokeArgs: invokeArgs.toXDR(),
		adminInvocation: new xdr.SorobanAuthorizedInvocation({ function: rootFunction, subInvocations: adminSubInvocations }).toXDR(),
		userInvocation: new xdr.SorobanAuthorizedInvocation({ function: rootFunction, subInvocations: userSubInvocations }).toXDR(),
	})
}

// ---------------------------------------------------------------------------
// Stage 3: unsigned-input predicate
// ---------------------------------------------------------------------------

declare const validatedBrand: unique symbol

export type ValidatedUnsignedMint = {
	readonly identity: MintIdentity
	readonly kind: MintKind
	readonly sub: string
	readonly ids: readonly string[]
	/** A fresh copy on every read. The signer uses a private snapshot that callers cannot reach. */
	readonly bytes: Buffer
	readonly adminAuthIndex: number
	readonly userAuthIndex: number
	readonly userExpirationLedger: number
	readonly [validatedBrand]: true
}

/**
 * Runtime proof of provenance, and the only home of the validated bytes: the signer refuses any
 * object this module did not validate, and reads the private snapshot from here. The public
 * `bytes` accessor hands out a fresh copy, so no caller can alias or mutate what gets signed.
 */
const validatedMints = new WeakMap<object, Buffer>()

function validatedSnapshot(validated: ValidatedUnsignedMint): Buffer {
	const snapshot = validatedMints.get(validated)
	if (!snapshot) reject('not_validated')
	return snapshot
}

interface ClassifiedEntry {
	index: number
	credentials: xdr.SorobanAddressCredentials
	rootInvocation: xdr.SorobanAuthorizedInvocation
}

function classifyAuthEntries(entries: xdr.SorobanAuthorizationEntry[], issuer: string, sub: string) {
	if (entries.length !== 2) reject('auth_count')
	let admin: ClassifiedEntry | undefined
	let user: ClassifiedEntry | undefined
	entries.forEach((entry, index) => {
		const credentials = entry.credentials()
		if (credentials.switch().name !== 'sorobanCredentialsAddress') reject('auth_credentials')
		const address = credentials.address()
		const scAddr = address.address()
		const kind = scAddr.switch().name
		const value = addressOf(scAddr, 'auth_unexpected_address')
		const classified = { index, credentials: address, rootInvocation: entry.rootInvocation() }
		if (kind === 'scAddressTypeAccount' && value === issuer) {
			if (admin) reject('auth_duplicate')
			admin = classified
		} else if (kind === 'scAddressTypeContract' && value === sub) {
			if (user) reject('auth_duplicate')
			user = classified
		} else {
			reject('auth_unexpected_address')
		}
	})
	if (!admin) reject('auth_admin_missing')
	if (!user) reject('auth_user_missing')
	return { admin, user }
}

function assertInvocation(
	actual: xdr.SorobanAuthorizedInvocation,
	expected: MintExpectation,
	which: 'admin' | 'user',
): void {
	const fn = actual.function()
	// The full tagged authorized function, then the bare InvokeContractArgs payload.
	if (!bytesEqual(fn.toXDR(), expected.rootFunction)
		|| fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn'
		|| !bytesEqual(fn.contractFn().toXDR(), expected.invokeArgs)) {
		reject(which === 'admin' ? 'admin_root_mismatch' : 'user_root_mismatch')
	}
	const tree = which === 'admin' ? expected.adminInvocation : expected.userInvocation
	if (!bytesEqual(actual.toXDR(), tree)) reject(which === 'admin' ? 'admin_tree_mismatch' : 'user_tree_mismatch')
}

function isUnsignedCredential(credentials: xdr.SorobanAddressCredentials): boolean {
	return credentials.signature().switch().name === 'scvVoid' && credentials.signatureExpirationLedger() === 0
}

/** passkey-kit: at most this many signer entries in one wallet `Signatures` map. */
export const MAX_WALLET_SIGNERS = 4
/** WebAuthn credential ids are at most 1023 bytes. */
const MAX_CREDENTIAL_ID_BYTES = 1023
/** WebAuthn authenticator data: rpIdHash (32) + flags (1) + signCount (4), at least. */
const MIN_AUTHENTICATOR_DATA_BYTES = 37
const SECP256R1_FIELDS = ['authenticator_data', 'client_data_json', 'signature'] as const

/** A contracttype enum value `[Symbol(variant), payload]`. */
function walletVariant(value: xdr.ScVal): [string, xdr.ScVal] {
	if (value.switch().name !== 'scvVec') reject('user_signature_shape')
	const items = value.vec() ?? []
	if (items.length !== 2 || items[0].switch().name !== 'scvSymbol') reject('user_signature_shape')
	return [items[0].sym().toString(), items[1]]
}

function walletBytes(value: xdr.ScVal, min: number, max: number): Buffer {
	if (value.switch().name !== 'scvBytes') reject('user_signature_shape')
	const bytes = Buffer.from(value.bytes())
	if (bytes.length < min || bytes.length > max) reject('user_signature_shape')
	return bytes
}

/**
 * One passkey-kit smart-wallet signer entry, restricted to the variants smol wallets use:
 *   SignerKey::Secp256r1(Bytes credential_id) => Signature::Secp256r1({ authenticator_data,
 *     client_data_json, signature: BytesN<64> })
 *   SignerKey::Ed25519(BytesN<32>)             => Signature::Ed25519(BytesN<64>)
 * Policy signers, unknown variants, mismatched key/signature variants, and missing, extra,
 * reordered or mis-sized fields are refused. The wallet still verifies the cryptography on chain.
 */
function assertWalletSigner(entry: xdr.ScMapEntry): void {
	const [keyVariant, key] = walletVariant(entry.key())
	const [signatureVariant, signature] = walletVariant(entry.val())
	if (keyVariant !== signatureVariant) reject('user_signature_shape')
	if (keyVariant === 'Secp256r1') {
		walletBytes(key, 1, MAX_CREDENTIAL_ID_BYTES)
		if (signature.switch().name !== 'scvMap') reject('user_signature_shape')
		const fields = signature.map() ?? []
		if (fields.length !== SECP256R1_FIELDS.length) reject('user_signature_shape')
		fields.forEach((field, index) => {
			if (field.key().switch().name !== 'scvSymbol' || field.key().sym().toString() !== SECP256R1_FIELDS[index]) {
				reject('user_signature_shape')
			}
		})
		walletBytes(fields[0].val(), MIN_AUTHENTICATOR_DATA_BYTES, MAX_UNSIGNED_MINT_XDR_BYTES)
		walletBytes(fields[1].val(), 1, MAX_UNSIGNED_MINT_XDR_BYTES)
		walletBytes(fields[2].val(), 64, 64)
	} else if (keyVariant === 'Ed25519') {
		walletBytes(key, 32, 32)
		walletBytes(signature, 64, 64)
	} else {
		reject('user_signature_shape')
	}
}

const scValBytes = (value: string | Uint8Array): Uint8Array => (typeof value === 'string' ? new TextEncoder().encode(value) : value)
const u64 = (value: { toString(): string }): bigint => BigInt(value.toString())
const i128Of = (parts: xdr.Int128Parts | xdr.UInt128Parts): bigint => (u64(parts.hi()) << 64n) + u64(parts.lo())
const i256Of = (parts: xdr.Int256Parts | xdr.UInt256Parts): bigint =>
	(u64(parts.hiHi()) << 192n) + (u64(parts.hiLo()) << 128n) + (u64(parts.loHi()) << 64n) + u64(parts.loLo())
const sign = (a: bigint | number, b: bigint | number): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Total order of two `ScVal`s exactly as the Soroban host compares map keys (rs-soroban-env
 * `Compare<ScVal> for Budget` in `host/comparison.rs`, which its tests pin to the derived `Ord` of
 * `ScVal` and to the host's `Val` comparison used by `MeteredOrdMap::from_map`):
 *
 * - different types: by `ScValType` discriminant (Bool 0, Void 1, ..., Bytes 13, String 14,
 *   Symbol 15, Vec 16, Map 17, Address 18, ...).
 * - Bytes, String, Symbol: raw bytes lexicographically, then length (a proper prefix sorts first).
 *   Small symbols iterate their decoded ASCII characters, which is the same order.
 * - Vec: element by element, then length. Map: entry by entry (key, then value), then length.
 * - integers, time points and durations: numerically. Bool: false < true. Void: equal.
 *
 * Address, Error, contract-instance and nonce values are not needed for signer keys and throw.
 */
export function compareScVal(a: xdr.ScVal, b: xdr.ScVal): number {
	const typeOrder = sign(a.switch().value, b.switch().value)
	if (typeOrder !== 0) return typeOrder
	switch (a.switch().name) {
		case 'scvVoid':
		case 'scvLedgerKeyContractInstance':
			return 0
		case 'scvBool':
			return sign(Number(a.b()), Number(b.b()))
		case 'scvU32':
			return sign(a.u32(), b.u32())
		case 'scvI32':
			return sign(a.i32(), b.i32())
		case 'scvU64':
			return sign(u64(a.u64()), u64(b.u64()))
		case 'scvI64':
			return sign(u64(a.i64()), u64(b.i64()))
		case 'scvTimepoint':
			return sign(u64(a.timepoint()), u64(b.timepoint()))
		case 'scvDuration':
			return sign(u64(a.duration()), u64(b.duration()))
		case 'scvU128':
			return sign(i128Of(a.u128()), i128Of(b.u128()))
		case 'scvI128':
			return sign(i128Of(a.i128()), i128Of(b.i128()))
		case 'scvU256':
			return sign(i256Of(a.u256()), i256Of(b.u256()))
		case 'scvI256':
			return sign(i256Of(a.i256()), i256Of(b.i256()))
		case 'scvBytes':
			return compareBytes(a.bytes(), b.bytes())
		case 'scvString':
			return compareBytes(scValBytes(a.str()), scValBytes(b.str()))
		case 'scvSymbol':
			return compareBytes(scValBytes(a.sym()), scValBytes(b.sym()))
		case 'scvVec': {
			const left = a.vec()
			const right = b.vec()
			if (!left || !right) throw new Error('ScVal comparison: Vec body missing')
			for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
				const order = compareScVal(left[i], right[i])
				if (order !== 0) return order
			}
			return sign(left.length, right.length)
		}
		case 'scvMap': {
			const left = a.map()
			const right = b.map()
			if (!left || !right) throw new Error('ScVal comparison: Map body missing')
			for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
				const order = compareScVal(left[i].key(), right[i].key()) || compareScVal(left[i].val(), right[i].val())
				if (order !== 0) return order
			}
			return sign(left.length, right.length)
		}
		default:
			throw new Error(`ScVal comparison: unsupported type ${a.switch().name}`)
	}
}

/**
 * A passkey-kit smart-wallet `Signatures(Map<SignerKey, Signature>)` value, encoded as the
 * one-field tuple struct `[ { signer_key => signature, ... } ]`, with a ledger expiry. Never void.
 * The host converts the map before the wallet runs and rejects it unless its keys are strictly
 * increasing under `compareScVal` (which also excludes duplicates), so that is checked too: an
 * out-of-order map could only spend the relay's fees on a guaranteed failure.
 */
function assertWalletSignature(credentials: xdr.SorobanAddressCredentials): number {
	const signature = credentials.signature()
	const expiration = credentials.signatureExpirationLedger()
	if (signature.switch().name === 'scvVoid' || !isLedgerSequence(expiration)) reject('user_unsigned')
	if (signature.switch().name !== 'scvVec') reject('user_signature_shape')
	const items = signature.vec() ?? []
	if (items.length !== 1 || items[0].switch().name !== 'scvMap') reject('user_signature_shape')
	const signers = items[0].map() ?? []
	if (signers.length < 1 || signers.length > MAX_WALLET_SIGNERS) reject('user_signature_shape')
	signers.forEach(assertWalletSigner)
	for (let i = 1; i < signers.length; i += 1) {
		let order: number
		try {
			order = compareScVal(signers[i - 1].key(), signers[i].key())
		} catch {
			reject('user_signature_shape')
		}
		if (order >= 0) reject('user_signature_shape')
	}
	return expiration
}

export function assertUnsignedMintEnvelope(carrier: DecodedMintCarrier, expected: MintExpectation): ValidatedUnsignedMint {
	return closedSet('xdr_malformed', () => assertUnsigned(carrier, expected))
}

function assertUnsigned(carrier: DecodedMintCarrier, expected: MintExpectation): ValidatedUnsignedMint {
	if (carrier.identity !== expected.identity) reject('config_mismatch')
	if (carrier.kind !== expected.kind) reject('function_mismatch')
	const ids = expected.tracks.map(({ id }) => id)
	if (ids.length !== carrier.ids.length || ids.some((id, index) => id !== carrier.ids[index])) reject('ids_mismatch')

	// Copy first, then decode and validate that private copy: it is exactly what gets signed, and
	// nothing outside this module ever holds a reference to it.
	const snapshot = Buffer.from(carrier.bytes)
	const envelope = xdr.TransactionEnvelope.fromXDR(snapshot)
	carrierInvokeArgs(envelope)
	const op = invokeOp(envelope)
	if (!bytesEqual(op.hostFunction().toXDR(), expected.hostFunction)) reject('host_function_mismatch')

	const { admin, user } = classifyAuthEntries(op.auth(), expected.identity.issuer, expected.sub)
	assertInvocation(admin.rootInvocation, expected, 'admin')
	if (!isUnsignedCredential(admin.credentials)) reject('admin_presigned')
	assertInvocation(user.rootInvocation, expected, 'user')
	const userExpirationLedger = assertWalletSignature(user.credentials)

	const validated = Object.freeze({
		identity: expected.identity,
		kind: expected.kind,
		sub: expected.sub,
		ids: Object.freeze([...ids]),
		/** A defensive copy of the validated bytes; the signer never reads this accessor. */
		get bytes(): Buffer {
			return Buffer.from(snapshot)
		},
		adminAuthIndex: admin.index,
		userAuthIndex: user.index,
		userExpirationLedger,
	}) as ValidatedUnsignedMint
	validatedMints.set(validated, snapshot)
	return validated
}

// ---------------------------------------------------------------------------
// Stage 4/5: sign the admin entry, then verify the signed output
// ---------------------------------------------------------------------------

export function sorobanAuthorizationPayload(
	networkPassphrase: string,
	credentials: xdr.SorobanAddressCredentials,
	rootInvocation: xdr.SorobanAuthorizedInvocation,
): Buffer {
	const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
		networkId: hash(Buffer.from(networkPassphrase)),
		nonce: credentials.nonce(),
		signatureExpirationLedger: credentials.signatureExpirationLedger(),
		invocation: rootInvocation,
	}))
	return hash(preimage.toXDR())
}

export async function signValidatedMint(
	validated: ValidatedUnsignedMint,
	keypair: Keypair,
	expirationLedger: number,
	networkPassphrase: string,
): Promise<string> {
	const snapshot = validatedSnapshot(validated)
	if (keypair.publicKey() !== validated.identity.issuer) reject('signer_mismatch')
	if (networkPassphrase !== validated.identity.networkPassphrase) reject('network_mismatch')
	if (!isLedgerSequence(expirationLedger)) reject('expiration_invalid')

	const envelope = xdr.TransactionEnvelope.fromXDR(snapshot)
	const op = invokeOp(envelope)
	const entries = [...op.auth()]
	// Sign exactly one entry: the validated admin entry. Every other byte is carried unchanged.
	entries[validated.adminAuthIndex] = await authorizeEntry(
		entries[validated.adminAuthIndex], keypair, expirationLedger, networkPassphrase)
	op.auth(entries)
	const signed = envelope.toXDR('base64')
	assertSignedMintEnvelope(validated, signed, { expirationLedger, networkPassphrase })
	return signed
}

/**
 * Signed-output predicate. Distinct from the unsigned-input predicate: the admin entry must now
 * carry a valid issuer signature over the expected preimage at the chosen expiry, and resetting
 * those two fields must reproduce the validated input exactly.
 */
export function assertSignedMintEnvelope(
	validated: ValidatedUnsignedMint,
	signedXdr: string,
	expected: { expirationLedger: number; networkPassphrase: string },
): void {
	closedSet('signed_malformed', () => assertSigned(validated, signedXdr, expected))
}

function assertSigned(
	validated: ValidatedUnsignedMint,
	signedXdr: string,
	expected: { expirationLedger: number; networkPassphrase: string },
): void {
	const snapshot = validatedSnapshot(validated)
	if (expected.networkPassphrase !== validated.identity.networkPassphrase) reject('network_mismatch')
	if (typeof signedXdr !== 'string' || signedXdr.length > 4 * Math.ceil(MAX_SIGNED_MINT_XDR_BYTES / 3)) reject('signed_too_large')
	const bytes = Buffer.from(signedXdr, 'base64')
	if (bytes.toString('base64') !== signedXdr) reject('signed_malformed')
	if (bytes.length > MAX_SIGNED_MINT_XDR_BYTES) reject('signed_too_large')
	let envelope: xdr.TransactionEnvelope
	try {
		envelope = xdr.TransactionEnvelope.fromXDR(bytes)
	} catch {
		reject('signed_malformed')
	}
	if (!bytesEqual(envelope.toXDR(), bytes) || envelope.switch().name !== 'envelopeTypeTx') reject('signed_malformed')
	const operations = envelope.v1().tx().operations()
	if (operations.length !== 1 || operations[0].body().switch().name !== 'invokeHostFunction') reject('signed_mismatch')

	const entries = invokeOp(envelope).auth()
	const entry = entries[validated.adminAuthIndex]
	if (!entry || entry.credentials().switch().name !== 'sorobanCredentialsAddress') reject('signed_mismatch')
	const credentials = entry.credentials().address()
	const { issuer } = validated.identity
	if (addressOf(credentials.address(), 'signed_mismatch') !== issuer) reject('signed_mismatch')
	if (credentials.signatureExpirationLedger() !== expected.expirationLedger) reject('signed_mismatch')

	const signature = credentials.signature()
	const items = signature.switch().name === 'scvVec' ? signature.vec() ?? [] : []
	const fields = items.length === 1 && items[0].switch().name === 'scvMap' ? items[0].map() ?? [] : []
	if (fields.length !== 2) reject('signature_invalid')
	const [publicKeyField, signatureField] = fields
	const isField = (field: xdr.ScMapEntry, name: string, size: number) =>
		field.key().switch().name === 'scvSymbol' && field.key().sym().toString() === name
		&& field.val().switch().name === 'scvBytes' && field.val().bytes().length === size
	if (!isField(publicKeyField, 'public_key', 32) || !isField(signatureField, 'signature', 64)) reject('signature_invalid')
	if (!bytesEqual(publicKeyField.val().bytes(), StrKey.decodeEd25519PublicKey(issuer))) reject('signature_invalid')
	const payload = sorobanAuthorizationPayload(expected.networkPassphrase, credentials, entry.rootInvocation())
	if (!Keypair.fromPublicKey(issuer).verify(payload, Buffer.from(signatureField.val().bytes()))) reject('signature_invalid')

	// Only the admin signature and expiry may differ from the validated input.
	credentials.signature(xdr.ScVal.scvVoid())
	credentials.signatureExpirationLedger(0)
	if (!bytesEqual(envelope.toXDR(), snapshot)) reject('signed_mismatch')
}
