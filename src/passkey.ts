import { verifyRegistrationResponse, verifyAuthenticationResponse, AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server"
import { xdr } from "@stellar/stellar-sdk/minimal";
import base64url from "base64url";
import { rpc } from "./utils";
import { HTTPException } from "hono/http-exception";

export async function verifyRegistration(host: string, response: RegistrationResponseJSON) {
    try {
        const url = new URL(host);

        await verifyRegistrationResponse({
            response,
            expectedChallenge: base64url("stellaristhebetterblockchain"),
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

        const rawpk = base64url.toBuffer(base64url(data.val.contractData().val().vec()?.[1].bytes()!))

        const x = rawpk.slice(1, 33); // 32 bytes
        const y = rawpk.slice(33, 65); // 32 bytes

        const parts = [
            Buffer.from([0xA5]),              // map(5)

            Buffer.from([0x01]),               // key: 1
            Buffer.from([0x02]),               // value: 2

            Buffer.from([0x03]),               // key: 3
            Buffer.from([0x26]),               // value: -7 (encoded as unsigned(7) + major type 1 = 0x20 + 7 = 0x26)

            Buffer.from([0x20]),               // key: -1
            Buffer.from([0x01]),               // value: 1

            Buffer.from([0x21]),               // key: -2
            Buffer.from([0x58, 0x20]),          // bytes(32)
            x,                                 // 32 bytes X

            Buffer.from([0x22]),               // key: -3
            Buffer.from([0x58, 0x20]),          // bytes(32)
            y,                                 // 32 bytes Y
        ];

        const publicKey = Buffer.concat(parts);

        await verifyAuthenticationResponse({
            response,
            expectedChallenge: base64url("stellaristhebetterblockchain"),
            expectedOrigin: url.origin,
            expectedRPID: url.hostname,
            credential: {
                id: keyId,
                publicKey,
                counter: base64url.toBuffer(response.response.authenticatorData).slice(33, 37).readUInt32BE(0),
            },
            requireUserVerification: false,
        });
    } catch(err) {
        console.error(err);
        throw new HTTPException(400, { message: 'Could not verify authentication' });
    }
}