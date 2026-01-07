import { verifyRegistrationResponse, verifyAuthenticationResponse, AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server"
import { xdr, Address } from "@stellar/stellar-sdk/minimal";
import { Server } from "@stellar/stellar-sdk/minimal/rpc";
import base64url from "base64url";
import { HTTPException } from "hono/http-exception";

// Protocol types for different smart account implementations
export type Protocol = 'passkey-kit' | 'smart-account-kit';

// Constants
const SECP256R1_PUBLIC_KEY_SIZE = 65; // Uncompressed EC point: 0x04 + 32 bytes X + 32 bytes Y

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

/**
 * Build COSE key for ES256 (ECDSA with P-256 and SHA-256) from raw public key
 * Reference: RFC 8152 - CBOR Object Signing and Encryption (COSE)
 */
function buildCoseKey(rawpk: Buffer): Buffer {
    // Validate public key format
    if (rawpk.length !== SECP256R1_PUBLIC_KEY_SIZE || rawpk[0] !== 0x04) {
        throw new Error('Invalid public key format: expected 65-byte uncompressed EC point');
    }

    const x = rawpk.slice(1, 33); // 32 bytes X coordinate
    const y = rawpk.slice(33, 65); // 32 bytes Y coordinate

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

    return Buffer.concat(parts);
}

/**
 * Lookup public key from passkey-kit contract storage
 * Storage format: ['Secp256r1', keyIdBytes] => publicKey
 */
async function getPublicKeyFromPasskeyKit(rpc: Server, contractId: string, keyId: string): Promise<Buffer> {
    const data = await rpc.getContractData(
        contractId,
        xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol('Secp256r1'),
            xdr.ScVal.scvBytes(base64url.toBuffer(keyId))
        ])
    )
    return Buffer.from(data.val.contractData().val().vec()?.[1].bytes()!)
}

/**
 * Lookup public key from smart-account-kit (OpenZeppelin) contract storage
 * Storage structure:
 *   - Ids(Default) => Vec<u32> rule IDs
 *   - Signers(ruleId) => Vec<Signer>
 *   - Signer::External(verifier, keyData) where keyData = publicKey (65 bytes) + credentialId
 */
async function getPublicKeyFromSmartAccountKit(rpc: Server, contractId: string, keyId: string): Promise<Buffer> {
    const keyIdBuffer = base64url.toBuffer(keyId);
    const contractAddress = Address.fromString(contractId);

    // Step 1: Get rule IDs for Default context
    // SmartAccountStorageKey::Ids(ContextRuleType::Default) => ['Ids', ['Default']]
    // ContextRuleType::Default is a unit variant enum, serialized as ['Default']
    const idsKey = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Ids'),
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Default')])
    ]);

    const idsLedgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: contractAddress.toScAddress(),
            key: idsKey,
            durability: xdr.ContractDataDurability.persistent()
        })
    );

    const idsResponse = await rpc.getLedgerEntries(idsLedgerKey);
    if (!idsResponse.entries || idsResponse.entries.length === 0) {
        throw new Error('No context rules found for contract');
    }

    const idsEntry = idsResponse.entries[0];
    // val is already parsed as xdr.LedgerEntryData
    const ruleIds = idsEntry.val.contractData().val().vec()?.map(v => v.u32()) ?? [];

    // Step 2: For each rule, look up signers and find matching credential
    for (const ruleId of ruleIds) {
        // SmartAccountStorageKey::Signers(ruleId) => ['Signers', ruleId]
        const signersKey = xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol('Signers'),
            xdr.ScVal.scvU32(ruleId)
        ]);

        const signersLedgerKey = xdr.LedgerKey.contractData(
            new xdr.LedgerKeyContractData({
                contract: contractAddress.toScAddress(),
                key: signersKey,
                durability: xdr.ContractDataDurability.persistent()
            })
        );

        const signersResponse = await rpc.getLedgerEntries(signersLedgerKey);
        if (!signersResponse.entries || signersResponse.entries.length === 0) {
            continue;
        }

        const signersEntry = signersResponse.entries[0];
        // val is already parsed as xdr.LedgerEntryData
        const signers = signersEntry.val.contractData().val().vec() ?? [];

        // Step 3: Find External signer with matching credential ID
        for (const signer of signers) {
            const signerVec = signer.vec();
            if (!signerVec || signerVec.length < 1) continue;

            // Check if this is an External signer: ['External', verifier, keyData]
            const tag = signerVec[0].sym().toString();
            if (tag !== 'External' || signerVec.length < 3) continue;

            const keyData = Buffer.from(signerVec[2].bytes());

            // keyData format: publicKey (65 bytes) + credentialId
            if (keyData.length <= SECP256R1_PUBLIC_KEY_SIZE) continue;

            const credentialId = keyData.slice(SECP256R1_PUBLIC_KEY_SIZE);

            // Compare credential IDs
            if (credentialId.equals(keyIdBuffer)) {
                // Found matching signer - extract public key
                return keyData.slice(0, SECP256R1_PUBLIC_KEY_SIZE);
            }
        }
    }

    throw new Error(`No signer found with credential ID: ${keyId}`);
}

export async function verifyAuthentication(
    host: string,
    keyId: string,
    contractId: string,
    response: AuthenticationResponseJSON,
    rpcUrl: string,
    protocol: Protocol = 'passkey-kit'
) {
    try {
        const url = new URL(host);
        const rpc = new Server(rpcUrl);

        // Get raw public key based on protocol
        const rawpk = protocol === 'smart-account-kit'
            ? await getPublicKeyFromSmartAccountKit(rpc, contractId, keyId)
            : await getPublicKeyFromPasskeyKit(rpc, contractId, keyId);

        // Build COSE key from raw public key
        const publicKey = buildCoseKey(rawpk);

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