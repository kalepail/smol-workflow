/**
 * Boundary B: reproduces the frozen `smol-fe` mint request builders end to end so the server can
 * be tested against the exact unsigned carrier the browser POSTs.
 *
 * Provenance (smol-fe `next` @ 94d71b3, SDK 14.4.3, passkey-kit 0.12.0):
 *   - single:  src/utils/mint.ts:19-65            `createMintTransaction` -> smolClient.coin_it(...)
 *   - batch:   src/hooks/useMixtapeMinting.ts:66-95 `submitMintBatch`      -> smolClient.coin_them(...)
 *   - signing: src/utils/passkeySign.ts:15-33     `tx.signAuthEntries({ address, expiration, authorizeEntry })`
 *              passkey-kit 0.12.0 src/kit.ts:235-380 `signAuthEntry` (Secp256r1 WebAuthn signature map)
 *
 * The real SDK `contract.Client` builds, simulates and assembles the transaction. Only the RPC is
 * mocked: `simulateTransaction` answers with the authorization trees the factory records, derived
 * here independently from the contract source (`smol-contracts` contracts/smol/src/lib.rs:137-260)
 * from the *submitted* arguments (the SAC comes from the posted asset bytes, the pool from the salt).
 * The WebAuthn signature is a real P-256 signature over the real Soroban auth payload.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto'
import { Address, Asset, hash, nativeToScVal, SorobanDataBuilder, StrKey, xdr } from '@stellar/stellar-sdk/base'
import { Client, Spec } from '@stellar/stellar-sdk/contract'
import { SMOL_SPEC_ENTRIES } from '../../../src/chain/smol-spec'

export interface FeIdentity {
	factory: string
	issuer: string
	kaleSac: string
	networkPassphrase: string
}

/** smol-fe src/utils/mint.ts:19-29, verbatim logic. */
export function buildMintFeeRule(creatorAddress: string, minterAddress: string, kaleSacId: string) {
	return creatorAddress === minterAddress
		? { fee_asset: kaleSacId, recipients: [{ percent: 50_00000n, recipient: creatorAddress }] }
		: {
			fee_asset: kaleSacId,
			recipients: [
				{ percent: 25_00000n, recipient: creatorAddress },
				{ percent: 25_00000n, recipient: minterAddress },
			],
		}
}

// ---------------------------------------------------------------------------
// Synthetic passkey (real P-256 WebAuthn assertion over the real payload)
// ---------------------------------------------------------------------------

export interface FePasskey {
	credentialId: Buffer
	privateKey: KeyObject
	rpId: string
	origin: string
}

export function createPasskey(seed: string, rpId = 'smol.xyz'): FePasskey {
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
	return {
		credentialId: createHash('sha256').update(`credential:${seed}`).digest().subarray(0, 16),
		privateKey: createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })),
		rpId,
		origin: `https://${rpId}`,
	}
}

const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')

/** passkey-kit `compactSignature`: r || s with low-S normalization. */
function lowS(signature: Buffer): Buffer {
	const r = signature.subarray(0, 32)
	let s = BigInt(`0x${signature.subarray(32).toString('hex')}`)
	if (s > P256_N / 2n) s = P256_N - s
	return Buffer.concat([r, Buffer.from(s.toString(16).padStart(64, '0'), 'hex')])
}

function webAuthnSignature(passkey: FePasskey, payload: Buffer) {
	const clientDataJson = Buffer.from(JSON.stringify({
		type: 'webauthn.get',
		challenge: payload.toString('base64url'),
		origin: passkey.origin,
		crossOrigin: false,
	}))
	const authenticatorData = Buffer.concat([
		createHash('sha256').update(passkey.rpId).digest(),
		Buffer.from([0x05]),
		Buffer.from([0, 0, 0, 0]),
	])
	const signed = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJson).digest()])
	const signature = lowS(nodeSign('sha256', signed, { key: passkey.privateKey, dsaEncoding: 'ieee-p1363' }))
	return { authenticatorData, clientDataJson, signature }
}

/** passkey-kit 0.12.0 `signAuthEntry` for a Secp256r1 signer, encoded as the wallet spec does. */
export function passkeySignAuthEntry(
	entry: xdr.SorobanAuthorizationEntry,
	passkey: FePasskey,
	expiration: number,
	networkPassphrase: string,
): xdr.SorobanAuthorizationEntry {
	const credentials = entry.credentials().address()
	credentials.signatureExpirationLedger(expiration)
	const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
		networkId: hash(Buffer.from(networkPassphrase)),
		nonce: credentials.nonce(),
		signatureExpirationLedger: credentials.signatureExpirationLedger(),
		invocation: entry.rootInvocation(),
	}))
	const { authenticatorData, clientDataJson, signature } = webAuthnSignature(passkey, hash(preimage.toXDR()))
	const sym = (value: string) => xdr.ScVal.scvSymbol(value)
	const bytes = (value: Buffer) => xdr.ScVal.scvBytes(value)
	const scEntry = new xdr.ScMapEntry({
		key: xdr.ScVal.scvVec([sym('Secp256r1'), bytes(passkey.credentialId)]),
		val: xdr.ScVal.scvVec([sym('Secp256r1'), xdr.ScVal.scvMap([
			new xdr.ScMapEntry({ key: sym('authenticator_data'), val: bytes(authenticatorData) }),
			new xdr.ScMapEntry({ key: sym('client_data_json'), val: bytes(clientDataJson) }),
			new xdr.ScMapEntry({ key: sym('signature'), val: bytes(signature) }),
		])]),
	})
	credentials.signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap([scEntry])]))
	return entry
}

// ---------------------------------------------------------------------------
// Mock RPC: what the factory records under simulation
// ---------------------------------------------------------------------------

const scAddress = (value: string) => new Address(value).toScVal()
const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' })

function call(contract: string, fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) {
	return new xdr.SorobanAuthorizedInvocation({
		function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
			contractAddress: new Address(contract).toScAddress(),
			functionName: fn,
			args,
		})),
		subInvocations: subs,
	})
}

function poolAddress(factory: string, salt: Buffer, networkPassphrase: string): string {
	const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
		networkId: hash(Buffer.from(networkPassphrase)),
		contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({
			address: new Address(factory).toScAddress(),
			salt,
		})),
	}))
	return StrKey.encodeContract(hash(preimage.toXDR()))
}

/** contracts/smol/src/lib.rs `coin_it` (internal fn), as recorded per track. */
function recordTrack(identity: FeIdentity, user: string, assetBytes: Buffer, salt: Buffer, feeRule: xdr.ScVal) {
	// Decode the posted asset bytes the way the host does (an XDR `Asset`).
	const asset = Asset.fromOperation(xdr.Asset.fromXDR(assetBytes))
	const sac = asset.contractId(identity.networkPassphrase)
	const admin = asset.getIssuer()!
	const pool = poolAddress(identity.factory, salt, identity.networkPassphrase)
	const coin = 10_000_000_0000000n
	const base = 100_0000000n
	return {
		admin,
		adminSubs: [
			call(sac, 'mint', [scAddress(user), i128(coin)]),
			call(pool, '__constructor', [
				scAddress(admin),
				xdr.ScVal.scvVec([scAddress(sac), scAddress(identity.kaleSac)]),
				xdr.ScVal.scvVec([i128(50_00000n), i128(50_00000n)]),
				xdr.ScVal.scvVec([i128(990_000_000_0000000n), i128(base)]),
				i128(5_00000n),
				i128(95_00000n),
				scAddress(identity.kaleSac),
				i128(base),
				i128(70_000_0000000n),
				feeRule,
			], [
				call(sac, 'transfer', [scAddress(admin), scAddress(pool), i128(990_000_000_0000000n)]),
				call(identity.kaleSac, 'transfer', [scAddress(admin), scAddress(pool), i128(base)]),
			]),
		],
		userSubs: [call(identity.kaleSac, 'transfer', [scAddress(user), scAddress(admin), i128(base)])],
	}
}

function simulate(identity: FeIdentity, txXdr: string, nonces: [bigint, bigint], latestLedger: number) {
	const envelope = xdr.TransactionEnvelope.fromXDR(txXdr, 'base64')
	const invokeArgs = envelope.v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().invokeContract()
	const fn = invokeArgs.functionName().toString()
	const args = invokeArgs.args()
	const user = Address.fromScVal(args[0]).toString()
	const tracks = fn === 'coin_it'
		? [recordTrack(identity, user, Buffer.from(args[1].bytes()), Buffer.from(args[2].bytes()), args[3])]
		: args[2].vec()!.map((salt, i) =>
			recordTrack(identity, user, Buffer.from(args[1].vec()![i].bytes()), Buffer.from(salt.bytes()), args[3].vec()![i]))
	const root = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs)
	const entry = (address: string, nonce: bigint, subs: xdr.SorobanAuthorizedInvocation[]) => new xdr.SorobanAuthorizationEntry({
		credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
			address: new Address(address).toScAddress(),
			nonce: xdr.Int64.fromString(nonce.toString()),
			signatureExpirationLedger: 0,
			signature: xdr.ScVal.scvVoid(),
		})),
		rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: root, subInvocations: subs }),
	})
	// Recording order: `user.require_auth()` runs first, then the admin's.
	const auth = [
		entry(user, nonces[0], tracks.flatMap((track) => track.userSubs)),
		entry(tracks[0].admin, nonces[1], tracks.flatMap((track) => track.adminSubs)),
	]
	const footprintKey = (contract: string) => xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
		contract: new Address(contract).toScAddress(),
		key: xdr.ScVal.scvLedgerKeyContractInstance(),
		durability: xdr.ContractDataDurability.persistent(),
	}))
	const transactionData = new SorobanDataBuilder()
		.setResources(28_000_000 * tracks.length, 40_000, 12_000 * tracks.length)
		.setResourceFee(4_200_000 * tracks.length)
		.setReadOnly([footprintKey(identity.factory), footprintKey(identity.kaleSac)])
		.setReadWrite([])
		.build()
	return {
		latestLedger,
		minResourceFee: String(4_200_000 * tracks.length),
		results: [{ auth: auth.map((a) => a.toXDR('base64')), xdr: xdr.ScVal.scvVoid().toXDR('base64') }],
		transactionData: transactionData.toXDR('base64'),
		events: [],
		cost: { cpuInsns: '0', memBytes: '0' },
	}
}

async function withMockRpc<T>(identity: FeIdentity, nonces: [bigint, bigint], latestLedger: number, run: (rpcUrl: string) => Promise<T>) {
	const rpcUrl = 'https://rpc.fe-fixture.invalid/'
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		if (!url.startsWith(rpcUrl)) return originalFetch(input, init)
		const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}')))
		if (body.method !== 'simulateTransaction') throw new Error(`Unexpected RPC ${body.method}`)
		const result = simulate(identity, body.params.transaction, nonces, latestLedger)
		return Response.json({ jsonrpc: '2.0', id: body.id, result })
	}) as typeof fetch
	try {
		return await run(rpcUrl)
	} finally {
		globalThis.fetch = originalFetch
	}
}

// ---------------------------------------------------------------------------
// The two FE builders
// ---------------------------------------------------------------------------

export interface FeTrack {
	id: string
	creator: string
}

export interface FeBuildOptions {
	identity: FeIdentity
	user: string
	passkey: FePasskey
	expiration: number
	nonces: [bigint, bigint]
	latestLedger?: number
}

async function signAndSerialize(tx: { signAuthEntries: Function; built?: { toXDR(): string } }, options: FeBuildOptions) {
	// smol-fe src/utils/passkeySign.ts: only the wallet's own entry is signed; the issuer entry is untouched.
	await tx.signAuthEntries({
		address: options.user,
		expiration: options.expiration,
		authorizeEntry: async (entry: xdr.SorobanAuthorizationEntry) =>
			passkeySignAuthEntry(xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR()), options.passkey, options.expiration, options.identity.networkPassphrase),
	})
	const built = tx.built?.toXDR()
	if (!built) throw new Error('FE builder produced no transaction')
	return built
}

/** smol-fe `createMintTransaction` (POST /mint/:id). */
export async function buildFeCoinItCarrier(options: FeBuildOptions & { track: FeTrack }): Promise<string> {
	const { identity, user, track } = options
	return withMockRpc(identity, options.nonces, options.latestLedger ?? options.expiration - 60, async (rpcUrl) => {
		const salt = Buffer.from(track.id.padStart(64, '0'), 'hex')
		const client = new Client(new Spec([...SMOL_SPEC_ENTRIES]), { contractId: identity.factory, rpcUrl, networkPassphrase: identity.networkPassphrase }) as Client & Record<string, Function>
		const asset = new Asset(track.id.padStart(64, '0').substring(0, 12), identity.issuer)
		const tx = await client.coin_it({
			user,
			asset_bytes: asset.toXDRObject().toXDR(),
			salt,
			fee_rule: buildMintFeeRule(track.creator, user, identity.kaleSac),
		})
		return signAndSerialize(tx, options)
	})
}

/** smol-fe `submitMintBatch` (POST /mint). */
export async function buildFeCoinThemCarrier(options: FeBuildOptions & { tracks: FeTrack[] }): Promise<string> {
	const { identity, user, tracks } = options
	return withMockRpc(identity, options.nonces, options.latestLedger ?? options.expiration - 60, async (rpcUrl) => {
		const asset_bytes: Buffer[] = []
		const salts: Buffer[] = []
		const fee_rules: ReturnType<typeof buildMintFeeRule>[] = []
		for (const track of tracks) {
			if (!/^[0-9a-f]{64}$/.test(track.id)) throw new Error(`Non-canonical smol id: ${track.id}`)
			asset_bytes.push(Buffer.from(new Asset(track.id.substring(0, 12), identity.issuer).toXDRObject().toXDR()))
			salts.push(Buffer.from(track.id, 'hex'))
			fee_rules.push(buildMintFeeRule(track.creator, user, identity.kaleSac))
		}
		const client = new Client(new Spec([...SMOL_SPEC_ENTRIES]), { contractId: identity.factory, rpcUrl, networkPassphrase: identity.networkPassphrase }) as Client & Record<string, Function>
		const tx = await client.coin_them({ user, asset_bytes, salts, fee_rules })
		return signAndSerialize(tx, options)
	})
}
