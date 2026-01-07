import { verifyRegistrationResponse, verifyAuthenticationResponse, AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server"
import { xdr } from "@stellar/stellar-sdk/minimal";
import base64url from "base64url";
import { rpc } from "./utils";
import { HTTPException } from "hono/http-exception";

// Validate challenge: accept any valid base64url challenge >= 16 bytes
// Works for both passkey-kit (static) and smart-account-kit (random) flows
function isValidChallenge(challenge: string): boolean {
    try {
        const decoded = base64url.toBuffer(challenge);
        return decoded.length >= 16;
    } catch {
        return false;
    }
}

export async function verifyRegistration(host: string, response: RegistrationResponseJSON) {
    try {
        const url = new URL(host);

        await verifyRegistrationResponse({
            response,
            // Use function to validate challenge from response
            expectedChallenge: isValidChallenge,
            expectedOrigin: url.origin,
            expectedRPID: url.hostname,
            requireUserPresence: false,
            requireUserVerification: false,
        });
    } catch(err) {
        console.error(err);
        throw new HTTPException(400, { message: 'Could not verify authentication' });
    }
}

export async function verifyAuthentication(host: string, keyId: string, contractId: string, response: AuthenticationResponseJSON) {
    try {
        const url = new URL(host);

        const data = await rpc.getContractData(
            contractId,
            xdr.ScVal.scvVec([
                xdr.ScVal.scvSymbol('Secp256r1'),
                xdr.ScVal.scvBytes(base64url.toBuffer(keyId))
            ])
        )

        // Extract the 65-byte uncompressed public key (0x04 + 32 bytes X + 32 bytes Y)
        const rawpk = Buffer.from(data.val.contractData().val().vec()?.[1].bytes()!)

        // Validate public key format
        if (rawpk.length !== 65 || rawpk[0] !== 0x04) {
            throw new Error('Invalid public key format: expected 65-byte uncompressed EC point');
        }

        const x = rawpk.slice(1, 33); // 32 bytes X coordinate
        const y = rawpk.slice(33, 65); // 32 bytes Y coordinate

        // Construct COSE key for ES256 (ECDSA with P-256 and SHA-256)
        // Reference: RFC 8152 - CBOR Object Signing and Encryption (COSE)
        const parts = [
            Buffer.from([0xA5]),               // CBOR map with 5 entries

            Buffer.from([0x01]),               // kty (key type): label 1
            Buffer.from([0x02]),               // EC2 (Elliptic Curve with x,y): value 2

            Buffer.from([0x03]),               // alg (algorithm): label 3
            Buffer.from([0x26]),               // ES256 (-7): CBOR encoding of -7 is 0x26

            Buffer.from([0x20]),               // crv (curve): label -1 (CBOR: 0x20)
            Buffer.from([0x01]),               // P-256: value 1

            Buffer.from([0x21]),               // x coordinate: label -2 (CBOR: 0x21)
            Buffer.from([0x58, 0x20]),         // CBOR byte string of length 32
            x,                                 // 32 bytes X coordinate

            Buffer.from([0x22]),               // y coordinate: label -3 (CBOR: 0x22)
            Buffer.from([0x58, 0x20]),         // CBOR byte string of length 32
            y,                                 // 32 bytes Y coordinate
        ];

        const publicKey = Buffer.concat(parts);

        await verifyAuthenticationResponse({
            response,
            // Use function to validate challenge from response
            expectedChallenge: isValidChallenge,
            expectedOrigin: url.origin,
            expectedRPID: url.hostname,
            credential: {
                id: keyId,
                publicKey: new Uint8Array(publicKey),
                // Pass counter as 0 to disable counter validation
                // Counter tracking would require persistent storage per keyId
                // The actual security is provided by the on-chain signature verification
                counter: 0,
            },
            requireUserVerification: false,
        });
    } catch(err) {
        console.error(err);
        throw new HTTPException(400, { message: 'Could not verify authentication' });
    }
}