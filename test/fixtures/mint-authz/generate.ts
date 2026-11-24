/**
 * Regenerates the mint-authorization fixtures. Every network call is a public, read-only read.
 *
 *   npx tsx test/fixtures/mint-authz/generate.ts mainnet [--cache DIR] [--d1 rows.json]
 *       Horizon mainnet transactions + ledgers -> mainnet-trees.json (Boundary A)
 *   npx tsx test/fixtures/mint-authz/generate.ts spec
 *       Soroban RPC getLedgerEntries (factory instance + code) -> factory-spec.json
 *   npx tsx test/fixtures/mint-authz/generate.ts fe
 *       smol-fe builder reproduction (no network) -> fe-carriers.json (Boundary B)
 *
 * `--d1` takes the JSON output of a read-only
 * `wrangler d1 execute smol-d1 --remote --json --command "SELECT Id, Address, Public, Mint_Token, Mint_Amm FROM Smols WHERE Id IN (...)"`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Address, hash, Keypair, Networks, scValToNative, StrKey, xdr } from '@stellar/stellar-sdk/minimal'
import { KALE_SAC, SMOL_FACTORY, SMOL_ISSUER, instanceKey } from '../../../src/utils/chain'
import { buildFeCoinItCarrier, buildFeCoinThemCarrier, createPasskey, type FeIdentity } from './fe-builder'

const HERE = __dirname
const HORIZON = 'https://horizon.stellar.org'
const RPC = 'https://mainnet.sorobanrpc.com'
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export const MAINNET_FIXTURE_TXS = [
	{ hash: 'd2d11a95de072c3a8c84ab32b840d0e00db7fac576e444269a84ce51ea2422da', label: 'single, creator self-mint (one 50% recipient)' },
	{ hash: '7352b187760d81dab7ed4fb1504e295d23873296197c22839a0fcaf95ddbf84b', label: 'single, split fee (creator then minter 25%)' },
	{ hash: '6a5923d763eb0ad5fc2769959c414a1095bf9239db19820d61a6db69d9d58ed4', label: 'coin_them, 5 tracks, split fees' },
	{ hash: '314dd414ac302ef617cc424a3efd1b3f6d2fbe98ce6bfdcc219b2ea7f6a5ca69', label: 'coin_them, 3 tracks, split fees' },
]

/** Deterministic test-only identity (no funds, no network): lets tests exercise real signing. */
export function testIssuerKeypair(): Keypair {
	return Keypair.fromRawEd25519Seed(hash(Buffer.from('smol-wf0-test-issuer')))
}

export function testIdentity(): FeIdentity {
	return {
		factory: StrKey.encodeContract(hash(Buffer.from('smol-wf0-test-factory'))),
		issuer: testIssuerKeypair().publicKey(),
		kaleSac: KALE_SAC,
		networkPassphrase: Networks.PUBLIC,
	}
}

const MAINNET_IDENTITY: FeIdentity = { factory: SMOL_FACTORY, issuer: SMOL_ISSUER, kaleSac: KALE_SAC, networkPassphrase: Networks.PUBLIC }

async function getJson(url: string, cacheDir?: string, cacheName?: string) {
	const cached = cacheDir && cacheName ? join(cacheDir, cacheName) : undefined
	if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'))
	const response = await fetch(url, { headers: { 'User-Agent': 'smol-wf0-fixtures' } })
	if (!response.ok) throw new Error(`${url} -> ${response.status}`)
	return response.json()
}

function project(envelopeXdr: string) {
	const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64')
	const inner = envelope.switch().name === 'envelopeTypeTxFeeBump' ? envelope.feeBump().tx().innerTx().v1() : envelope.v1()
	const op = inner.tx().operations()[0].body().invokeHostFunctionOp()
	const invokeArgs = op.hostFunction().invokeContract()
	const kind = invokeArgs.functionName().toString()
	const args = invokeArgs.args()
	const sub = Address.fromScVal(args[0]).toString()
	const salts = kind === 'coin_it' ? [args[2]] : args[2].vec()!
	const rules = kind === 'coin_it' ? [args[3]] : args[3].vec()!
	const tracks = salts.map((salt, i) => {
		const rule = scValToNative(rules[i]) as { recipients: Array<{ recipient: string }> }
		// The FE fee rule lists the creator first (or alone on a self-mint).
		return { id: Buffer.from(salt.bytes()).toString('hex'), creator: rule.recipients[0].recipient, recipients: rule.recipients.length }
	})
	const auth = op.auth()
	const role = (entry: xdr.SorobanAuthorizationEntry) =>
		Address.fromScAddress(entry.credentials().address().address()).toString() === SMOL_ISSUER ? 'admin' : 'user'
	const admin = auth.find((entry) => role(entry) === 'admin')!
	const user = auth.find((entry) => role(entry) === 'user')!
	return {
		envelopeType: envelope.switch().name,
		kind,
		sub,
		tracks,
		projection: {
			authOrder: auth.map(role),
			hostFunctionXdr: op.hostFunction().toXDR('base64'),
			userAuthEntryXdr: user.toXDR('base64'),
			adminAuthEntryXdr: admin.toXDR('base64'),
			userRootInvocationXdr: user.rootInvocation().toXDR('base64'),
			adminRootInvocationXdr: admin.rootInvocation().toXDR('base64'),
			sorobanDataXdr: inner.tx().ext().sorobanData().toXDR('base64'),
		},
	}
}

async function mainnet(args: string[]) {
	const cacheDir = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : undefined
	const d1Path = args.includes('--d1') ? args[args.indexOf('--d1') + 1] : undefined
	const d1Rows = d1Path
		? new Map((JSON.parse(readFileSync(d1Path, 'utf8'))[0].results as Array<Record<string, unknown>>).map((row) => [row.Id as string, row]))
		: undefined
	const previous = existsSync(join(HERE, 'mainnet-trees.json')) ? JSON.parse(readFileSync(join(HERE, 'mainnet-trees.json'), 'utf8')) : null
	const transactions = []
	for (const { hash: txHash, label } of MAINNET_FIXTURE_TXS) {
		const tx = await getJson(`${HORIZON}/transactions/${txHash}`, cacheDir, `${txHash}.json`)
		const ledger = await getJson(`${HORIZON}/ledgers/${tx.ledger}`, cacheDir, `ledger-${tx.ledger}.json`)
		const projected = project(tx.envelope_xdr)
		const previousTx = previous?.transactions?.find((entry: { hash: string }) => entry.hash === txHash)
		transactions.push({
			hash: txHash,
			label,
			horizonUrl: `${HORIZON}/transactions/${txHash}`,
			ledger: tx.ledger,
			closedAt: ledger.closed_at,
			protocolVersion: ledger.protocol_version,
			successful: tx.successful,
			envelopeSha256: sha256(Buffer.from(tx.envelope_xdr, 'base64')),
			envelopeXdr: tx.envelope_xdr,
			...projected,
			// Facts as they stood before the mint (the server validates against unminted public rows).
			preMintFacts: projected.tracks.map(({ id, creator }) => ({ id, creator, public: 1, mintToken: null, mintAmm: null })),
			d1Snapshot: d1Rows
				? {
					note: 'read-only SELECT of current smol-d1 rows; Address must equal the on-chain fee-rule creator',
					rows: projected.tracks.map(({ id }) => {
						const row = d1Rows.get(id)
						return row ? { id, address: row.Address, public: row.Public, mintToken: row.Mint_Token, mintAmm: row.Mint_Amm } : { id, absent: true }
					}),
				}
				: previousTx?.d1Snapshot ?? null,
		})
	}
	writeFileSync(join(HERE, 'mainnet-trees.json'), `${JSON.stringify({
		description: 'Boundary A: real mainnet SMOL factory mints (fee-bump receipts) projected to host function + both auth trees',
		source: HORIZON,
		generatedAt: new Date().toISOString(),
		networkPassphrase: Networks.PUBLIC,
		factory: SMOL_FACTORY,
		issuer: SMOL_ISSUER,
		transactions,
	}, null, '\t')}\n`)
}

async function spec() {
	const rpc = async (keys: string[]) => {
		const response = await fetch(RPC, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys } }),
		})
		return ((await response.json()) as { result: { latestLedger: number; entries: Array<{ xdr: string; lastModifiedLedgerSeq: number }> } }).result
	}
	const instance = await rpc([instanceKey(SMOL_FACTORY).toXDR('base64')])
	const wasmHash = Buffer.from(xdr.LedgerEntryData.fromXDR(instance.entries[0].xdr, 'base64').contractData().val().instance().executable().wasmHash())
	const code = await rpc([xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash })).toXDR('base64')])
	const wasm = Buffer.from(xdr.LedgerEntryData.fromXDR(code.entries[0].xdr, 'base64').contractCode().code())
	if (sha256(wasm) !== wasmHash.toString('hex')) throw new Error('Wasm hash mismatch')
	let section = Buffer.alloc(0)
	let i = 8
	const leb = () => {
		let result = 0
		let shift = 0
		let byte: number
		do {
			byte = wasm[i++]
			result |= (byte & 0x7f) << shift
			shift += 7
		} while (byte & 0x80)
		return result >>> 0
	}
	while (i < wasm.length) {
		const id = wasm[i++]
		const size = leb()
		const start = i
		if (id === 0) {
			const nameLength = leb()
			const name = wasm.subarray(i, i + nameLength).toString()
			i += nameLength
			if (name === 'contractspecv0') section = Buffer.concat([section, wasm.subarray(i, start + size)])
		}
		i = start + size
	}
	const entries: string[] = []
	for (let offset = 0; offset < section.length;) {
		let length = 4
		for (; offset + length <= section.length; length += 4) {
			try {
				entries.push(xdr.ScSpecEntry.fromXDR(section.subarray(offset, offset + length)).toXDR('base64'))
				break
			} catch {
				if (offset + length === section.length) throw new Error('Undecodable spec section')
			}
		}
		offset += length
	}
	writeFileSync(join(HERE, 'factory-spec.json'), `${JSON.stringify({
		description: 'contractspecv0 entries of the live SMOL factory Wasm (read-only getLedgerEntries)',
		rpc: RPC,
		factory: SMOL_FACTORY,
		wasmHash: wasmHash.toString('hex'),
		wasmBytes: wasm.length,
		readAtLedger: code.latestLedger,
		entries,
	}, null, '\t')}\n`)
}

const id = (label: string) => hash(Buffer.from(`smol-wf0-track:${label}`)).toString('hex')
const contract = (label: string) => StrKey.encodeContract(hash(Buffer.from(`smol-wf0-wallet:${label}`)))

export const FE_MINTER = contract('minter')
export const FE_CREATOR = contract('creator')
export const FE_CREATOR_2 = contract('creator-2')

async function fe() {
	const cases = [
		{ name: 'coin_it-split', kind: 'coin_it', tracks: [{ id: id('single-split'), creator: FE_CREATOR }] },
		{ name: 'coin_it-self', kind: 'coin_it', tracks: [{ id: id('single-self'), creator: FE_MINTER }] },
		{ name: 'coin_them-2', kind: 'coin_them', tracks: [{ id: id('batch2-a'), creator: FE_CREATOR }, { id: id('batch2-b'), creator: FE_MINTER }] },
		{
			name: 'coin_them-5',
			kind: 'coin_them',
			tracks: ['a', 'b', 'c', 'd', 'e'].map((x, i) => ({ id: id(`batch5-${x}`), creator: [FE_CREATOR, FE_CREATOR_2, FE_MINTER][i % 3] })),
		},
	] as const
	const passkey = createPasskey('smol-wf0-fixture')
	const expiration = 65_660_000
	const carriers = []
	for (const [identityName, identity] of [['mainnet', MAINNET_IDENTITY], ['test', testIdentity()]] as const) {
		for (const [index, c] of cases.entries()) {
			const nonces: [bigint, bigint] = [BigInt(`0x${sha256(`${identityName}:${c.name}:user`).slice(0, 15)}`), BigInt(`0x${sha256(`${identityName}:${c.name}:admin`).slice(0, 15)}`)]
			const options = { identity, user: FE_MINTER, passkey, expiration: expiration + index, nonces, latestLedger: expiration - 100 }
			const carrier = c.kind === 'coin_it'
				? await buildFeCoinItCarrier({ ...options, track: c.tracks[0] })
				: await buildFeCoinThemCarrier({ ...options, tracks: [...c.tracks] })
			carriers.push({
				name: `${identityName}/${c.name}`,
				identity: identityName,
				kind: c.kind,
				route: c.kind === 'coin_it' ? 'POST /mint/:id' : 'POST /mint',
				sub: FE_MINTER,
				tracks: c.tracks,
				userExpirationLedger: expiration + index,
				xdrSha256: sha256(Buffer.from(carrier, 'base64')),
				xdr: carrier,
			})
		}
	}
	writeFileSync(join(HERE, 'fe-carriers.json'), `${JSON.stringify({
		description: 'Boundary B: unsigned envelopeTypeTx carriers produced by the smol-fe coin_it / coin_them builders (see fe-builder.ts)',
		provenance: {
			smolFe: 'next@94d71b3 src/utils/mint.ts:19-65, src/hooks/useMixtapeMinting.ts:66-95, src/utils/passkeySign.ts:15-33',
			sdk: '@stellar/stellar-sdk@14.4.3 contract.Client -> AssembledTransaction.build/simulate -> signAuthEntries',
			passkeyKit: 'passkey-kit@0.12.0 src/kit.ts:235-380 Secp256r1 signature encoding (real P-256 WebAuthn assertion)',
			simulation: 'mock RPC records the factory auth trees from the submitted args (contracts/smol/src/lib.rs:137-260)',
		},
		generatedAt: new Date().toISOString(),
		testIdentity: { ...testIdentity(), issuerSeed: "sha256('smol-wf0-test-issuer')" },
		carriers,
	}, null, '\t')}\n`)
}

async function main() {
	const [command, ...args] = process.argv.slice(2)
	if (command === 'mainnet') await mainnet(args)
	else if (command === 'spec') await spec()
	else if (command === 'fe') await fe()
	else throw new Error('usage: generate.ts mainnet|spec|fe')
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error)
		process.exit(1)
	})
}
