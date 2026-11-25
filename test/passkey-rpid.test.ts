import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import test from 'node:test'
import base64url from 'base64url'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'
import {
	APPROVED_SMOL_RP_HOSTS,
	resolvePasskeyVerificationTarget,
	verifyRegistration,
} from '../src/passkey'

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
	// CBOR negative integer encodes (-1 - n)
	return encodeCborUint(1, -1 - n)
}

function buildCosePublicKeyFromSpki(spkiDer: Buffer): Buffer {
	// Uncompressed P-256 point is the final 65 bytes of standard SPKI DER (0x04 || X || Y)
	const uncompressed = spkiDer.subarray(spkiDer.length - 65)
	assert.equal(uncompressed[0], 0x04)
	const x = uncompressed.subarray(1, 33)
	const y = uncompressed.subarray(33, 65)
	return Buffer.concat([
		Buffer.from([0xa5]), // map(5)
		encodeCborUint(0, 1), encodeCborUint(0, 2), // 1 (kty): 2 (EC2)
		encodeCborUint(0, 3), encodeCborNegInt(-7), // 3 (alg): -7 (ES256)
		encodeCborNegInt(-1), encodeCborUint(0, 1), // -1 (crv): 1 (P-256)
		encodeCborNegInt(-2), encodeCborBytes(x),   // -2 (x): bstr(32)
		encodeCborNegInt(-3), encodeCborBytes(y),   // -3 (y): bstr(32)
	])
}

function buildMockRegistrationResponse(params: {
	origin: string
	rpId: string
	challenge: string
	credentialId: Buffer
	cosePublicKey: Buffer
}) {
	const rpIdHash = createHash('sha256').update(params.rpId).digest()
	const flags = Buffer.from([0x41]) // UP (0x01) | AT (0x40)
	const signCount = Buffer.alloc(4, 0)
	const aaguid = Buffer.alloc(16, 0)
	const credIdLen = Buffer.alloc(2)
	credIdLen.writeUInt16BE(params.credentialId.length, 0)
	const authData = Buffer.concat([rpIdHash, flags, signCount, aaguid, credIdLen, params.credentialId, params.cosePublicKey])

	// CBOR attestationObject: { "fmt": "none", "attStmt": {}, "authData": bstr }
	const attestationObject = Buffer.concat([
		Buffer.from([0xa3]),
		encodeCborText('fmt'), encodeCborText('none'),
		encodeCborText('attStmt'), Buffer.from([0xa0]),
		encodeCborText('authData'), encodeCborBytes(authData),
	])

	const clientDataJSON = Buffer.from(JSON.stringify({
		type: 'webauthn.create',
		challenge: params.challenge,
		origin: params.origin,
		crossOrigin: false,
	}))

	const id = base64url.encode(params.credentialId)
	return {
		id,
		rawId: id,
		type: 'public-key' as const,
		response: {
			clientDataJSON: base64url.encode(clientDataJSON),
			attestationObject: base64url.encode(attestationObject),
		},
		clientExtensionResults: {},
	}
}

function buildMockAuthenticationResponse(params: {
	origin: string
	rpId: string
	challenge: string
	credentialId: Buffer
	privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
}) {
	const rpIdHash = createHash('sha256').update(params.rpId).digest()
	const flags = Buffer.from([0x01]) // UP
	const signCount = Buffer.alloc(4, 0)
	const authenticatorData = Buffer.concat([rpIdHash, flags, signCount])

	const clientDataJSON = Buffer.from(JSON.stringify({
		type: 'webauthn.get',
		challenge: params.challenge,
		origin: params.origin,
		crossOrigin: false,
	}))
	const clientDataHash = createHash('sha256').update(clientDataJSON).digest()
	const signedPayload = Buffer.concat([authenticatorData, clientDataHash])
	const signature = cryptoSign('sha256', signedPayload, params.privateKey)

	const id = base64url.encode(params.credentialId)
	return {
		id,
		rawId: id,
		type: 'public-key' as const,
		response: {
			clientDataJSON: base64url.encode(clientDataJSON),
			authenticatorData: base64url.encode(authenticatorData),
			signature: base64url.encode(signature),
		},
		clientExtensionResults: {},
	}
}

test('resolvePasskeyVerificationTarget maps approved smol.xyz hosts and local dev origins accurately', () => {
	assert.deepEqual(APPROVED_SMOL_RP_HOSTS, ['smol.xyz', 'noot.smol.xyz'])

	assert.deepEqual(resolvePasskeyVerificationTarget('https://smol.xyz'), {
		expectedOrigin: 'https://smol.xyz',
		expectedRPID: ['smol.xyz'],
	})
	assert.deepEqual(resolvePasskeyVerificationTarget('https://noot.smol.xyz/login'), {
		expectedOrigin: 'https://noot.smol.xyz',
		expectedRPID: ['smol.xyz', 'noot.smol.xyz'],
	})
	assert.deepEqual(resolvePasskeyVerificationTarget('http://localhost:4321', { allowLocalhost: true }), {
		expectedOrigin: 'http://localhost:4321',
		expectedRPID: ['localhost'],
	})
	assert.deepEqual(resolvePasskeyVerificationTarget('https://localhost:5173', { allowLocalhost: true }), {
		expectedOrigin: 'https://localhost:5173',
		expectedRPID: ['localhost'],
	})
	assert.deepEqual(resolvePasskeyVerificationTarget('http://127.0.0.1:3000', { allowLocalhost: true }), {
		expectedOrigin: 'http://127.0.0.1:3000',
		expectedRPID: ['127.0.0.1'],
	})
	for (const localOrigin of ['http://localhost:4321', 'https://localhost:5173', 'http://127.0.0.1:3000']) {
		assert.throws(
			() => resolvePasskeyVerificationTarget(localOrigin),
			(err: unknown) => err instanceof Error && 'status' in err && (err as { status: number }).status === 400,
			`Expected localhost origin to be rejected when allowLocalhost is unset: ${localOrigin}`
		)
	}
})

test('resolvePasskeyVerificationTarget rejects disallowed origins, non-HTTPS prod hosts, and malformed URLs', () => {
	const rejected = [
		'https://evil.com',
		'https://evil.smol.xyz',
		'https://app.smol.xyz',
		'https://next.smol.xyz',
		'https://sub.next.smol.xyz',
		'http://smol.xyz',
		'http://next.smol.xyz',
		'https://smol.xyz:8443',
		'not-a-url',
		'',
	]

	for (const origin of rejected) {
		assert.throws(
			() => resolvePasskeyVerificationTarget(origin),
			(err: unknown) => err instanceof Error && 'status' in err && (err as { status: number }).status === 400,
			`Expected 400 rejection for origin: ${origin}`
		)
	}
})

test('verifyRegistration and WebAuthn authentication accept smol.xyz RP ID on noot.smol.xyz, root smol.xyz, and reject mismatches', async () => {
	const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
	const cosePublicKey = buildCosePublicKeyFromSpki(spkiDer)
	const credentialId = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
	const challenge = base64url.encode(Buffer.from('challenge-at-least-16-bytes-long'))

	// 1. Fresh registration on https://noot.smol.xyz with shared RP ID 'smol.xyz' succeeds
	const nootReg = buildMockRegistrationResponse({
		origin: 'https://noot.smol.xyz',
		rpId: 'smol.xyz',
		challenge,
		credentialId,
		cosePublicKey,
	})
	await verifyRegistration('https://noot.smol.xyz', nootReg)

	// 2. Host-scoped registration on https://noot.smol.xyz with RP ID 'noot.smol.xyz' succeeds
	const nootHostReg = buildMockRegistrationResponse({
		origin: 'https://noot.smol.xyz',
		rpId: 'noot.smol.xyz',
		challenge,
		credentialId,
		cosePublicKey,
	})
	await verifyRegistration('https://noot.smol.xyz', nootHostReg)

	// 3. Root / native registration on https://smol.xyz with RP ID 'smol.xyz' succeeds
	const rootReg = buildMockRegistrationResponse({
		origin: 'https://smol.xyz',
		rpId: 'smol.xyz',
		challenge,
		credentialId,
		cosePublicKey,
	})
	await verifyRegistration('https://smol.xyz', rootReg)

	// 4. Root-registered credential (RP ID 'smol.xyz') authenticates cleanly on https://noot.smol.xyz
	const nootAuth = buildMockAuthenticationResponse({
		origin: 'https://noot.smol.xyz',
		rpId: 'smol.xyz',
		challenge,
		credentialId,
		privateKey,
	})
	const target = resolvePasskeyVerificationTarget('https://noot.smol.xyz')
	const verified = await verifyAuthenticationResponse({
		response: nootAuth,
		expectedChallenge: challenge,
		expectedOrigin: target.expectedOrigin,
		expectedRPID: target.expectedRPID,
		credential: {
			id: base64url.encode(credentialId),
			publicKey: new Uint8Array(cosePublicKey),
			counter: 0,
		},
		requireUserVerification: false,
	})
	assert.equal(verified.verified, true)

	// 5. Wrong RP ID ('next.smol.xyz') presented on https://noot.smol.xyz is rejected with 400
	const wrongRpReg = buildMockRegistrationResponse({
		origin: 'https://noot.smol.xyz',
		rpId: 'next.smol.xyz',
		challenge,
		credentialId,
		cosePublicKey,
	})
	await assert.rejects(
		() => verifyRegistration('https://noot.smol.xyz', wrongRpReg),
		(err: unknown) => err instanceof Error && 'status' in err && (err as { status: number }).status === 400
	)

	// 6. Disallowed origin ('https://evil.smol.xyz') is rejected with 400 even with RP ID 'smol.xyz'
	const evilOriginReg = buildMockRegistrationResponse({
		origin: 'https://evil.smol.xyz',
		rpId: 'smol.xyz',
		challenge,
		credentialId,
		cosePublicKey,
	})
	await assert.rejects(
		() => verifyRegistration('https://evil.smol.xyz', evilOriginReg),
		(err: unknown) => err instanceof Error && 'status' in err && (err as { status: number }).status === 400
	)
})
