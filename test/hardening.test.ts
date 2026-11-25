import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test, { after, before } from 'node:test'
import { Address, hash, Keypair, Networks, StrKey, xdr } from '@stellar/stellar-sdk/base'
import { derivePasskeyKitContractId } from '../src/passkey'
import { instanceKey, type LedgerPage } from '../src/utils/chain'
import {
	createAuthToken,
	createMockExecutionContext,
	createSqliteD1,
	installCloudflareStubs,
} from './helpers/harness'

const SECRET = 'hardening-test-jwt-secret-only'
const ADMIN_SECRET = 'hardening-test-admin-secret-distinct'
const LEDGER = 65_635_400
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
const MIGRATION_0004 = readFileSync(new URL('../migrations/0004_users_address_unique.sql', import.meta.url), 'utf8')

let app: typeof import('../src/index').app
let getSmolFailure: typeof import('../src/api/smols').getSmolFailure
let cleanup: () => void

before(async () => {
	const stubs = installCloudflareStubs({ CF_API_TOKEN: 'fixture-purge-token', CF_ZONE_ID: 'fixture-zone' })
	cleanup = stubs.cleanup
	;({ app } = await import('../src/index'))
	;({ getSmolFailure } = await import('../src/api/smols'))
})

after(() => cleanup())

function encodeCborUint(majorType: number, value: number): Buffer {
	const prefix = majorType << 5
	if (value < 24) return Buffer.from([prefix | value])
	if (value < 256) return Buffer.from([prefix | 24, value])
	const buf = Buffer.alloc(3)
	buf[0] = prefix | 25
	buf.writeUInt16BE(value, 1)
	return buf
}

function encodeCborBytes(bytes: Buffer): Buffer {
	return Buffer.concat([encodeCborUint(2, bytes.length), bytes])
}

function encodeCborText(text: string): Buffer {
	const raw = Buffer.from(text, 'utf8')
	return Buffer.concat([encodeCborUint(3, raw.length), raw])
}

function encodeCborNegInt(n: number): Buffer {
	return encodeCborUint(1, -1 - n)
}

function buildCosePublicKeyFromSpki(spkiDer: Buffer): Buffer {
	const uncompressed = spkiDer.subarray(spkiDer.length - 65)
	const x = uncompressed.subarray(1, 33)
	const y = uncompressed.subarray(33, 65)
	return Buffer.concat([
		Buffer.from([0xa5]),
		encodeCborUint(0, 1), encodeCborUint(0, 2),
		encodeCborUint(0, 3), encodeCborNegInt(-7),
		encodeCborNegInt(-1), encodeCborUint(0, 1),
		encodeCborNegInt(-2), encodeCborBytes(x),
		encodeCborNegInt(-3), encodeCborBytes(y),
	])
}

function buildRegistrationResponse(params: {
	origin: string
	rpId: string
	credentialId: Buffer
	responseIdOverride?: string
}) {
	const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
	const cosePublicKey = buildCosePublicKeyFromSpki(spkiDer)
	const rpIdHash = createHash('sha256').update(params.rpId).digest()
	const flags = Buffer.from([0x41])
	const signCount = Buffer.alloc(4, 0)
	const aaguid = Buffer.alloc(16, 0)
	const credIdLen = Buffer.alloc(2)
	credIdLen.writeUInt16BE(params.credentialId.length, 0)
	const authData = Buffer.concat([rpIdHash, flags, signCount, aaguid, credIdLen, params.credentialId, cosePublicKey])

	const attestationObject = Buffer.concat([
		Buffer.from([0xa3]),
		encodeCborText('fmt'), encodeCborText('none'),
		encodeCborText('attStmt'), Buffer.from([0xa0]),
		encodeCborText('authData'), encodeCborBytes(authData),
	])

	const challenge = Buffer.from('stellaristhebetterblockchain').toString('base64url')
	const clientDataJSON = Buffer.from(JSON.stringify({
		type: 'webauthn.create',
		challenge,
		origin: params.origin,
		crossOrigin: false,
	}))

	const id = params.responseIdOverride ?? params.credentialId.toString('base64url')
	return {
		id,
		rawId: id,
		type: 'public-key' as const,
		response: {
			clientDataJSON: clientDataJSON.toString('base64url'),
			attestationObject: attestationObject.toString('base64url'),
		},
		clientExtensionResults: {},
	}
}

function contractInstanceEntry(contractId: string, archived = false): LedgerPage['entries'][number] {
	const key = instanceKey(contractId)
	const data = key.contractData()
	const instanceVal = xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({
		executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 7)),
		storage: [],
	}))
	return {
		key: key.toXDR('base64'),
		xdr: xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({
			ext: new xdr.ExtensionPoint(0),
			contract: data.contract(),
			key: data.key(),
			durability: data.durability(),
			val: instanceVal,
		})).toXDR('base64'),
		lastModifiedLedgerSeq: LEDGER - 10,
		liveUntilLedgerSeq: archived ? LEDGER - 1 : LEDGER + 1000,
	}
}

function createHarness(envOverrides: Partial<Env> = {}) {
	const db = new DatabaseSync(':memory:')
	db.exec(SCHEMA)
	const { d1 } = createSqliteD1(db)
	const kvStore = new Map<string, string>()

	const env = {
		SECRET,
		RPC_URL: 'https://mainnet-unused.invalid',
		NETWORK_PASSPHRASE: Networks.PUBLIC,
		SMOL_D1: d1,
		SMOL_KV: {
			get: async (key: string, type?: string) => {
				const raw = kvStore.get(key)
				if (raw === undefined) return null
				return type === 'json' ? JSON.parse(raw) : raw
			},
			put: async (key: string, value: string) => {
				kvStore.set(key, value)
			},
			delete: async (key: string) => {
				kvStore.delete(key)
			},
		} as unknown as KVNamespace,
		SMOL_BUCKET: {
			delete: async () => {},
		} as unknown as R2Bucket,
		KALE_WORKER: {
			readEntries: async () => ({ latestLedger: LEDGER, archiveAware: true, entries: [] }),
		} as unknown as Env['KALE_WORKER'],
		...envOverrides,
	} as Env

	async function request(path: string, init: RequestInit = {}) {
		const ctx = createMockExecutionContext()
		const res = await app.fetch(new Request(`https://api.smol.xyz${path}`, init), env, ctx.ctx)
		await ctx.flush()
		return res
	}

	return { db, env, kvStore, request }
}

test('P0-1: passkey-kit contractId derivation matches passkey-kit@0.12.0 formula exactly', () => {
	const credentialId = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
	const keyId = credentialId.toString('base64url')

	// Independent recomputation of passkey-kit@0.12.0 kit.ts:51,86,597-610
	const deployer = Keypair.fromRawEd25519Seed(hash(Buffer.from('kalepail'))).publicKey()
	const expected = StrKey.encodeContract(hash(xdr.HashIdPreimage.envelopeTypeContractId(
		new xdr.HashIdPreimageContractId({
			networkId: hash(Buffer.from(Networks.PUBLIC)),
			contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
				new xdr.ContractIdPreimageFromAddress({
					address: Address.fromString(deployer).toScAddress(),
					salt: hash(credentialId),
				})
			),
		})
	).toXDR()))

	assert.equal(derivePasskeyKitContractId(keyId), expected)
	assert.equal(derivePasskeyKitContractId(credentialId), expected)
})

test('P0-1 & Item 2: POST /login type=create enforces derivation, undeployed on-chain state, fail-closed 503, unique Users.Address, no testnet, and Cache-Control: no-store', async () => {
	const credentialId = Buffer.from('11223344556677889900aabbccddeeff', 'hex')
	const keyId = credentialId.toString('base64url')
	const derivedContractId = derivePasskeyKitContractId(credentialId)
	const victimContractId = StrKey.encodeContract(Buffer.alloc(32, 42))
	const origin = 'https://smol.xyz'
	const response = buildRegistrationResponse({ origin, rpId: 'smol.xyz', credentialId })

	// 1. Mismatched contractId -> 403, no Users row written
	{
		const { db, request } = createHarness()
		try {
			const res = await request('/login', {
				method: 'POST',
				headers: { Origin: origin, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'create',
					keyId,
					contractId: victimContractId,
					response,
					username: 'attacker',
				}),
			})
			assert.equal(res.status, 403)
			assert.equal(db.prepare('SELECT count(*) AS n FROM Users').get()?.n, 0)
		} finally {
			db.close()
		}
	}

	// 2. Invalid contractId / response.id mismatch -> 400
	{
		const { db, request } = createHarness()
		try {
			const badContract = await request('/login', {
				method: 'POST',
				headers: { Origin: origin, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'create',
					keyId,
					contractId: 'not-a-contract',
					response,
					username: 'bob',
				}),
			})
			assert.equal(badContract.status, 400)

			const wrongIdResp = buildRegistrationResponse({
				origin,
				rpId: 'smol.xyz',
				credentialId: Buffer.from('ffeeddccbbaa00998877665544332211', 'hex'),
			})
			const mismatchedId = await request('/login', {
				method: 'POST',
				headers: { Origin: origin, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'create',
					keyId,
					contractId: derivedContractId,
					response: wrongIdResp,
					username: 'bob',
				}),
			})
			assert.equal(mismatchedId.status, 400)
			assert.equal(db.prepare('SELECT count(*) AS n FROM Users').get()?.n, 0)
		} finally {
			db.close()
		}
	}

	// 3. Already-deployed contract on-chain (live AND archived) -> 409, no Users row written
	for (const archived of [false, true]) {
		const { db, request } = createHarness({
			KALE_WORKER: {
				readEntries: async () => ({
					latestLedger: LEDGER,
					archiveAware: true,
					entries: [contractInstanceEntry(derivedContractId, archived)],
				}),
			} as unknown as Env['KALE_WORKER'],
		})
		try {
			const res = await request('/login', {
				method: 'POST',
				headers: { Origin: origin, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'create',
					keyId,
					contractId: derivedContractId,
					response,
					username: 'alice',
				}),
			})
			assert.equal(res.status, 409)
			assert.equal(db.prepare('SELECT count(*) AS n FROM Users').get()?.n, 0)
		} finally {
			db.close()
		}
	}

	// 4. Missing KALE_WORKER binding, non-RPC binding, gateway error, OR archiveAware:false -> 503 (fail closed, no archive-blind RPC fallback)
	const fetchBefore = globalThis.fetch
	let directRpcCalled = false
	globalThis.fetch = (async () => {
		directRpcCalled = true
		return Response.json({ jsonrpc: '2.0', id: 1, result: { latestLedger: LEDGER, entries: [] } })
	}) as typeof fetch
	try {
		for (const badBinding of [
			undefined,
			{},
			{ readEntries: async () => { throw new Error('RPC timeout') } },
			{ readEntries: async () => ({ latestLedger: LEDGER, archiveAware: false, entries: [] }) },
		]) {
			const { db, request } = createHarness({
				KALE_WORKER: badBinding as unknown as Env['KALE_WORKER'],
			})
			try {
				const res = await request('/login', {
					method: 'POST',
					headers: { Origin: origin, 'Content-Type': 'application/json' },
					body: JSON.stringify({
						type: 'create',
						keyId,
						contractId: derivedContractId,
						response,
						username: 'alice',
					}),
				})
				assert.equal(res.status, 503)
				assert.equal(res.headers.get('Cache-Control'), 'no-store')
				assert.equal(db.prepare('SELECT count(*) AS n FROM Users').get()?.n, 0)
			} finally {
				db.close()
			}
		}
		assert.equal(directRpcCalled, false, 'create signup must never fall back to archive-blind direct RPC')
	} finally {
		globalThis.fetch = fetchBefore
	}

	// 5. network='testnet' and non-object JSON bodies (null/array/primitive/malformed) -> 400 with Cache-Control: no-store
	{
		const { db, request } = createHarness()
		try {
			const testnetRes = await request('/login', {
				method: 'POST',
				headers: { Origin: origin, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'create',
					network: 'testnet',
					keyId,
					contractId: derivedContractId,
					response,
					username: 'alice',
				}),
			})
			assert.equal(testnetRes.status, 400)
			assert.equal(testnetRes.headers.get('Cache-Control'), 'no-store')

			for (const rawBody of ['null', '[]', '"hello"', '123', '{bad-json']) {
				const badJsonRes = await request('/login', {
					method: 'POST',
					headers: { Origin: origin, 'Content-Type': 'application/json' },
					body: rawBody,
				})
				assert.equal(badJsonRes.status, 400, `Expected 400 for raw body: ${rawBody}`)
				assert.equal(badJsonRes.headers.get('Cache-Control'), 'no-store', `Expected no-store for raw body: ${rawBody}`)
			}
			assert.equal(db.prepare('SELECT count(*) AS n FROM Users').get()?.n, 0)
		} finally {
			db.close()
		}
	}

	// 6. Happy path (undeployed contract, base64url padded keyId normalization) -> 200, then repeat -> 409
	{
		const { db, request } = createHarness()
		try {
			const paddedKeyId = `${keyId}==`
			const res = await request('/login', {
				method: 'POST',
				headers: { Origin: origin, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'create',
					keyId: paddedKeyId,
					contractId: derivedContractId,
					response,
					username: 'alice',
				}),
			})
			assert.equal(res.status, 200)
			assert.equal(res.headers.get('Cache-Control'), 'no-store')
			const setCookie = res.headers.get('Set-Cookie') ?? ''
			assert.match(setCookie, /smol_token=/)
			assert.doesNotMatch(setCookie, /HttpOnly/i, 'httpOnly must stay off until after cutover + noot resolution')
			assert.equal(db.prepare('SELECT Username FROM Users WHERE "Address" = ?').get(derivedContractId)?.Username, 'alice')

			// Second create for same Users.Address -> 409
			const dup = await request('/login', {
				method: 'POST',
				headers: { Origin: origin, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'create',
					keyId,
					contractId: derivedContractId,
					response,
					username: 'alice-two',
				}),
			})
			assert.equal(dup.status, 409)
			assert.equal(db.prepare('SELECT count(*) AS n FROM Users WHERE "Address" = ?').get(derivedContractId)?.n, 1)

			// Logout also sets Cache-Control: no-store and keeps non-HttpOnly cookie
			const logoutRes = await request('/logout', { method: 'POST', headers: { Origin: origin } })
			assert.equal(logoutRes.status, 204)
			assert.equal(logoutRes.headers.get('Cache-Control'), 'no-store')
			assert.doesNotMatch(logoutRes.headers.get('Set-Cookie') ?? '', /HttpOnly/i)
		} finally {
			db.close()
		}
	}

	// 7. Migration 0004 enforces Users("Address") uniqueness cleanly on SQLite
	{
		const migDb = new DatabaseSync(':memory:')
		migDb.exec('CREATE TABLE Users (Username TEXT NOT NULL, "Address" TEXT NOT NULL, UNIQUE (Username, "Address"));')
		migDb.exec(MIGRATION_0004)
		migDb.prepare('INSERT INTO Users (Username, "Address") VALUES (?, ?)').run('alice', derivedContractId)
		assert.throws(
			() => migDb.prepare('INSERT INTO Users (Username, "Address") VALUES (?, ?)').run('impostor', derivedContractId),
			/UNIQUE constraint failed/i,
		)
		migDb.close()
	}
})

test('Item 3: dedicated ADMIN_SECRET fails closed with 404 when unset or equal to SECRET, accepts x-admin-secret/Bearer, and rejects env.SECRET on admin & user routes', async () => {
	// 1. Unset, blank, or identical to SECRET -> 404 (fail closed) on both admin surfaces
	for (const adminVal of [undefined, '', '   ', SECRET, `  ${SECRET}  `]) {
		const { db, request } = createHarness({ ADMIN_SECRET: adminVal })
		try {
			const searchHeaderRes = await request('/search/admin/backfill/status', {
				headers: { 'x-admin-secret': SECRET },
			})
			assert.equal(searchHeaderRes.status, 404)

			const searchBearerRes = await request('/search/admin/backfill/status', {
				headers: { Authorization: `Bearer ${SECRET}` },
			})
			assert.equal(searchBearerRes.status, 404)

			const bulkBearerRes = await request('/admin/bulk', {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids: ['missing-id'] }),
			})
			assert.equal(bulkBearerRes.status, 404)

			const bulkHeaderRes = await request('/admin/bulk', {
				method: 'DELETE',
				headers: { 'x-admin-secret': SECRET, 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids: ['missing-id'] }),
			})
			assert.equal(bulkHeaderRes.status, 404)
		} finally {
			db.close()
		}
	}

	// 2. Configured ADMIN_SECRET: accepts x-admin-secret & Bearer; rejects env.SECRET, user JWT, and wrong secret
	const { db, request } = createHarness({ ADMIN_SECRET })
	try {
		const userJwt = await createAuthToken(StrKey.encodeContract(Buffer.alloc(32, 9)), SECRET)

		// env.SECRET rejected on admin routes (both header styles)
		assert.equal((await request('/search/admin/backfill/status', { headers: { 'x-admin-secret': SECRET } })).status, 401)
		assert.equal((await request('/search/admin/backfill/status', { headers: { Authorization: `Bearer ${SECRET}` } })).status, 401)
		assert.equal((await request('/admin/bulk', {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: ['missing'] }),
		})).status, 401)
		assert.equal((await request('/admin/bulk', {
			method: 'DELETE',
			headers: { 'x-admin-secret': SECRET, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: ['missing'] }),
		})).status, 401)

		// User JWT rejected on admin routes
		assert.equal((await request('/admin/bulk', {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${userJwt}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: ['missing'] }),
		})).status, 401)
		assert.equal((await request('/search/admin/backfill/status', {
			headers: { Authorization: `Bearer ${userJwt}` },
		})).status, 401)

		// Raw env.SECRET and raw ADMIN_SECRET rejected on normal parseAuth routes
		assert.equal((await request('/created', { headers: { Authorization: `Bearer ${SECRET}` } })).status, 401)
		assert.equal((await request('/created', { headers: { Authorization: `Bearer ${ADMIN_SECRET}` } })).status, 401)

		// Valid ADMIN_SECRET succeeds with either x-admin-secret or Bearer on both routes
		assert.equal((await request('/search/admin/backfill/status', { headers: { 'x-admin-secret': ADMIN_SECRET } })).status, 200)
		assert.equal((await request('/search/admin/backfill/status', { headers: { Authorization: `Bearer ${ADMIN_SECRET}` } })).status, 200)

		const bulkViaHeader = await request('/admin/bulk', {
			method: 'DELETE',
			headers: { 'x-admin-secret': ADMIN_SECRET, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: ['nonexistent-smol'] }),
		})
		assert.equal(bulkViaHeader.status, 200)
		assert.deepEqual(await bulkViaHeader.json(), { deleted: 0, skipped: 1, total: 1 })

		const bulkViaBearer = await request('/admin/bulk', {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${ADMIN_SECRET}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: ['nonexistent-smol'] }),
		})
		assert.equal(bulkViaBearer.status, 200)
	} finally {
		db.close()
	}
})

test('Item 4: exact-match CORS allowlist and gated localhost in CORS + passkey origin verification', async () => {
	const credentialId = Buffer.from('aabbccddeeff00112233445566778899', 'hex')
	const keyId = credentialId.toString('base64url')
	const derivedContractId = derivePasskeyKitContractId(credentialId)

	// 1. Production defaults (ALLOW_LOCALHOST_ORIGINS unset)
	{
		const { db, request } = createHarness()
		try {
			for (const allowed of ['https://smol.xyz', 'https://noot.smol.xyz']) {
				const res = await request('/logout', { method: 'OPTIONS', headers: { Origin: allowed } })
				assert.equal(res.headers.get('Access-Control-Allow-Origin'), allowed)
				assert.equal(res.headers.get('Access-Control-Allow-Credentials'), 'true')
			}

			for (const blocked of [
				'https://next.smol.xyz',
				'https://evil.smol.xyz',
				'https://app.smol.xyz',
				'https://api.smol.xyz',
				'https://smol.xyz:8443',
				'http://smol.xyz',
				'http://localhost:3000',
				'http://127.0.0.1:5173',
			]) {
				const res = await request('/logout', { method: 'OPTIONS', headers: { Origin: blocked } })
				assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, `Expected blocked CORS origin: ${blocked}`)
			}

			// Localhost passkey login rejected when ALLOW_LOCALHOST_ORIGINS is unset
			const localResp = buildRegistrationResponse({ origin: 'http://localhost:3000', rpId: 'localhost', credentialId })
			const loginRes = await request('/login', {
				method: 'POST',
				headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'create',
					keyId,
					contractId: derivedContractId,
					response: localResp,
					username: 'localuser',
				}),
			})
			assert.equal(loginRes.status, 400)
		} finally {
			db.close()
		}
	}

	// 2. Local dev enabled (ALLOW_LOCALHOST_ORIGINS === 'true')
	{
		const { db, request } = createHarness({ ALLOW_LOCALHOST_ORIGINS: 'true' })
		try {
			for (const localOrigin of ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173']) {
				const res = await request('/logout', { method: 'OPTIONS', headers: { Origin: localOrigin } })
				assert.equal(res.headers.get('Access-Control-Allow-Origin'), localOrigin)
			}
			// Wildcard *.smol.xyz still rejected even with localhost enabled
			const evilRes = await request('/logout', { method: 'OPTIONS', headers: { Origin: 'https://evil.smol.xyz' } })
			assert.equal(evilRes.headers.get('Access-Control-Allow-Origin'), null)

			// Localhost passkey registration succeeds when ALLOW_LOCALHOST_ORIGINS === 'true'
			const localResp = buildRegistrationResponse({ origin: 'http://localhost:3000', rpId: 'localhost', credentialId })
			const loginRes = await request('/login', {
				method: 'POST',
				headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
				body: JSON.stringify({
					type: 'create',
					keyId,
					contractId: derivedContractId,
					response: localResp,
					username: 'localuser',
				}),
			})
			assert.equal(loginRes.status, 200)
		} finally {
			db.close()
		}
	}
})

test('Item 5 (F5): failure and GET /:id detail responses never leak env vars, stack traces, SQL/RPC errors, songs[].error_message, search.last_error, or wf.error.message', async () => {
	// 1. Unit checks on getSmolFailure
	const misconfigured = getSmolFailure({
		provider_attempt: {
			provider: 'elevenlabs',
			status: 'failed',
			error_code: 'provider_misconfigured',
			error_message: 'ElevenLabs AI Gateway BYOK is not configured (missing CF_AI_GATEWAY_ID or CF_AIG_TOKEN)',
			updated_at: '2026-11-23T00:00:00.000Z',
		},
		songs: [{
			music_id: 'el-1',
			status: -4,
			audio: '',
			error_message: 'ElevenLabs AI Gateway BYOK is not configured (missing CF_AI_GATEWAY_ID or CF_AIG_TOKEN)',
		}],
	})
	assert.ok(misconfigured)
	assert.equal(misconfigured.retryable, false)
	assert.equal(misconfigured.suggestAlternate, true)
	assert.doesNotMatch(misconfigured.message, /CF_AI_GATEWAY_ID|CF_AIG_TOKEN|BYOK|AI Gateway/i)

	const sqlStackFailure = getSmolFailure({
		songs: [{
			music_id: 's-1',
			status: -4,
			audio: '',
			error_message: 'no such table: Smols',
		}],
	})
	assert.ok(sqlStackFailure)
	assert.doesNotMatch(sqlStackFailure.message, /no such table|Smols/i)

	const r2Failure = getSmolFailure({
		songs: [{
			music_id: 's-2',
			status: -3,
			audio: '',
			error_message: 'R2 pre-dispatch lookup failed for el-deadbeef.mp3: storage unavailable',
		}],
	})
	assert.ok(r2Failure)
	assert.doesNotMatch(r2Failure.message, /R2|el-deadbeef\.mp3|pre-dispatch/i)

	// Classic credits_exhausted maps to retryable: false + suggestAlternate: true
	const classicCreditsFailure = getSmolFailure({
		provider_attempt: {
			provider: 'aisonggenerator',
			status: 'failed',
			error_code: 'credits_exhausted',
			error_message: 'Insufficient AISG workspace credits',
			updated_at: '2026-11-23T00:00:00.000Z',
		},
		songs: [{
			music_id: 'aisg-1',
			status: -4,
			audio: '',
			error_message: 'Insufficient AISG workspace credits',
		}],
	})
	assert.ok(classicCreditsFailure)
	assert.equal(classicCreditsFailure.retryable, false)
	assert.equal(classicCreditsFailure.suggestAlternate, true)
	assert.doesNotMatch(classicCreditsFailure.message, /AISG|workspace|credits/i)

	// 2. Public published GET /:id strips kv_do.search (last_error/mutation_id/vector_ids) and kv_do.songs[].error_message
	const smolId = 'ab'.repeat(32)
	const owner = StrKey.encodeContract(Buffer.alloc(32, 33))
	const { db, kvStore, request, env } = createHarness()
	try {
		db.prepare(`
			INSERT INTO Smols (Id, Title, Song_1, Address, Public)
			VALUES (?, ?, ?, ?, 1)
		`).run(smolId, 'Published Song', 'song-1', owner)

		kvStore.set(smolId, JSON.stringify({
			payload: { address: owner, prompt: 'ambient synth' },
			songs: [{
				music_id: 'song-1',
				status: 4,
				audio: 'https://api.smol.xyz/song/song-1.mp3',
				error_message: 'internal leak CF_AIG_TOKEN secret',
			}],
			search: {
				status: 'failed',
				version: 'v2',
				last_error: 'Timed out waiting for Vectorize mutation processing (CF_API_TOKEN)',
				mutation_id: 'mut-123',
				vector_ids: ['v1'],
			},
		}))

		const pubRes = await request(`/${smolId}`)
		assert.equal(pubRes.status, 200)
		const pubBody = await pubRes.json() as any
		assert.equal(pubBody.kv_do.search, undefined)
		assert.equal(pubBody.kv_do.songs[0].error_message, undefined)
		assert.equal(pubBody.kv_do.songs[0].music_id, 'song-1')
		assert.doesNotMatch(JSON.stringify(pubBody), /CF_AIG_TOKEN|CF_API_TOKEN|Vectorize|mut-123/)

		// 3. In-progress owner GET /:id sanitizes failure, songs[].error_message, search, and wf.error
		const inProgressId = 'cd'.repeat(32)
		const steps = {
			payload: { address: owner, prompt: 'piano solo' },
			provider_attempt: {
				provider: 'elevenlabs',
				status: 'failed',
				error_code: 'provider_misconfigured',
				error_message: 'missing CF_AI_GATEWAY_ID or CF_AIG_TOKEN',
				updated_at: '2026-11-23T00:00:00.000Z',
			},
			songs: [{
				music_id: `el-${inProgressId}`,
				status: -4,
				audio: '',
				error_message: 'ElevenLabs AI Gateway BYOK is not configured (missing CF_AI_GATEWAY_ID or CF_AIG_TOKEN)',
			}],
			search: {
				status: 'failed',
				version: 'v2',
				last_error: 'SQLITE_ERROR internal detail',
			},
		}
		;(env as unknown as Record<string, unknown>).DURABLE_OBJECT = {
			idFromString: (id: string) => id,
			get: () => ({ getSteps: async () => steps }),
		}
		;(env as unknown as Record<string, unknown>).WORKFLOW = {
			get: async () => ({
				status: async () => ({
					status: 'errored',
					error: {
						name: 'SqliteInternalError',
						message: 'Song generation failed (provider_misconfigured): missing CF_AI_GATEWAY_ID or CF_AIG_TOKEN',
					},
					output: { secret: 'should-not-leak' },
				}),
			}),
		}

		const token = await createAuthToken(owner, SECRET)
		const ownerRes = await request(`/${inProgressId}`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		assert.equal(ownerRes.status, 200)
		const ownerBody = await ownerRes.json() as any
		assert.equal(ownerBody.kv_do.failure.retryable, false)
		assert.equal(ownerBody.kv_do.failure.suggestAlternate, true)
		assert.equal(ownerBody.kv_do.songs[0].error_message, undefined)
		assert.equal(ownerBody.kv_do.search, undefined)
		assert.deepEqual(ownerBody.wf, { status: 'errored', error: { name: 'Error' } })
		assert.doesNotMatch(
			JSON.stringify(ownerBody),
			/CF_AI_GATEWAY_ID|CF_AIG_TOKEN|BYOK|AI Gateway|SQLITE_ERROR|SqliteInternalError|should-not-leak/,
		)
	} finally {
		db.close()
	}
})
