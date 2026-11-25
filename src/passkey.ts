import { verifyRegistrationResponse, verifyAuthenticationResponse, AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server"
import { Address, hash, Keypair, Networks, StrKey, xdr } from "@stellar/stellar-sdk/base";
import { Server } from "@stellar/stellar-sdk/rpc";
import { HTTPException } from "hono/http-exception";
import { contractDataKey, decodeLedgerPage, instanceKey, LEDGER_KEY_LIMIT, storageKey, type MainnetChainReads } from "./utils/chain";
import { bytesEqual } from "./utils/bytes";

// Protocol types for different smart account implementations
export type Protocol = 'passkey-kit' | 'smart-account-kit';

// Constants
const SECP256R1_PUBLIC_KEY_SIZE = 65; // Uncompressed EC point: 0x04 + 32 bytes X + 32 bytes Y
const ROOT_SMOL_RP_ID = 'smol.xyz';
const PASSKEY_KIT_DEPLOYER_ADDRESS = Address.fromString(
    Keypair.fromRawEd25519Seed(hash(Buffer.from('kalepail'))).publicKey()
).toScAddress();
const MAINNET_NETWORK_ID = hash(Buffer.from(Networks.PUBLIC));

export const APPROVED_SMOL_RP_HOSTS = [
    'smol.xyz',
    'noot.smol.xyz',
] as const;

const APPROVED_SMOL_RP_HOST_SET = new Set<string>(APPROVED_SMOL_RP_HOSTS);
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1']);

export interface PasskeyVerificationTarget {
    expectedOrigin: string;
    expectedRPID: string[];
}

export interface PasskeyOriginOptions {
    allowLocalhost?: boolean;
}

export interface VerifyRegistrationOptions extends PasskeyOriginOptions {
    expectedKeyId?: string;
}

export function normalizeBase64UrlId(value: unknown): { canonical: string; buffer: Buffer } | null {
    if (typeof value !== 'string') {
        return null;
    }
    const stripped = value.replace(/=+$/, '');
    if (!stripped || value.length - stripped.length > 2 || !/^[A-Za-z0-9_-]+$/.test(stripped)) {
        return null;
    }
    const buffer = Buffer.from(stripped, 'base64url');
    if (buffer.length === 0 || buffer.toString('base64url') !== stripped) {
        return null;
    }
    return { canonical: stripped, buffer };
}

/**
 * Derive the deterministic mainnet passkey-kit@0.12.0 wallet contract address
 * for a WebAuthn credential ID (deployer seed hash('kalepail'), salt hash(keyId)).
 */
export function derivePasskeyKitContractId(keyId: string | Buffer): string {
    const keyIdBuffer = typeof keyId === 'string'
        ? (normalizeBase64UrlId(keyId)?.buffer ?? Buffer.from(keyId, 'base64url'))
        : keyId;
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
        new xdr.HashIdPreimageContractId({
            networkId: MAINNET_NETWORK_ID,
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                new xdr.ContractIdPreimageFromAddress({
                    address: PASSKEY_KIT_DEPLOYER_ADDRESS,
                    salt: hash(keyIdBuffer),
                })
            ),
        })
    );
    return StrKey.encodeContract(hash(preimage.toXDR()));
}

/**
 * Verify on mainnet that a wallet contract instance does not yet exist on-chain.
 * Requires an authoritative archive-aware absence reply from KALE_WORKER.readEntries.
 * - 409 if the contract instance already exists (live or archived; existing accounts must use type='connect').
 * - 503 if KALE_WORKER.readEntries is unavailable, throws, or cannot prove archive-aware absence (fail closed).
 */
export async function assertContractUndeployed(
    contractId: string,
    binding?: MainnetChainReads,
): Promise<void> {
    const gateway = typeof binding?.readEntries === 'function' ? binding : undefined;
    if (!gateway) {
        throw new HTTPException(503, { message: 'Unable to verify contract state; please try again' });
    }

    const key = instanceKey(contractId);
    const keyXdr = key.toXDR('base64');

    let state: 'present' | 'absent' | 'unknown';
    try {
        const page = await gateway.readEntries({ keys: [keyXdr] });
        const { values } = decodeLedgerPage(page, [keyXdr]);
        state = values.get(keyXdr)?.state ?? 'unknown';
    } catch (err) {
        if (err instanceof HTTPException) {
            throw err;
        }
        throw new HTTPException(503, { message: 'Unable to verify contract state; please try again' });
    }

    if (state === 'present') {
        throw new HTTPException(409, { message: 'Account already exists; please sign in instead' });
    }
    if (state !== 'absent') {
        throw new HTTPException(503, { message: 'Unable to verify contract state; please try again' });
    }
}

/**
 * Resolve exact expected origin and allowed RP IDs for WebAuthn verification.
 * - Approved https://*.smol.xyz hosts accept the shared registrable RP ID 'smol.xyz'
 *   (used by smol-fe and smol-native) as well as their exact hostname for host-scoped credentials.
 * - https://smol.xyz accepts 'smol.xyz'.
 * - Local dev hosts (localhost / 127.0.0.1) are accepted only when allowLocalhost is true.
 * - Any other origin is rejected with HTTP 400.
 */
export function resolvePasskeyVerificationTarget(
    host: string,
    options: PasskeyOriginOptions = {},
): PasskeyVerificationTarget {
    let url: URL;
    try {
        url = new URL(host);
    } catch {
        throw new HTTPException(400, { message: 'Passkey origin does not match this domain' });
    }

    const hostname = url.hostname.toLowerCase();

    if (url.protocol === 'https:' && url.port === '' && APPROVED_SMOL_RP_HOST_SET.has(hostname)) {
        const expectedRPID = hostname === ROOT_SMOL_RP_ID
            ? [ROOT_SMOL_RP_ID]
            : [ROOT_SMOL_RP_ID, hostname];
        return {
            expectedOrigin: url.origin,
            expectedRPID,
        };
    }

    if (options.allowLocalhost && (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_DEV_HOSTS.has(hostname)) {
        return {
            expectedOrigin: url.origin,
            expectedRPID: [hostname],
        };
    }

    throw new HTTPException(400, { message: 'Passkey origin does not match this domain' });
}

// Validate challenge: accept any canonical base64url challenge that decodes to >= 16 bytes.
// Works for both passkey-kit (static) and smart-account-kit (random) flows; rejects garbage.
export function isValidChallenge(challenge: unknown): boolean {
    const decoded = normalizeBase64UrlId(challenge);
    return decoded !== null && decoded.buffer.length >= 16;
}

export async function verifyRegistration(
    host: string,
    response: RegistrationResponseJSON,
    options: VerifyRegistrationOptions = {},
) {
    const { expectedOrigin, expectedRPID } = resolvePasskeyVerificationTarget(host, options);

    try {
        const verification = await verifyRegistrationResponse({
            response,
            // Use function to validate challenge from response
            expectedChallenge: isValidChallenge,
            expectedOrigin,
            expectedRPID,
            requireUserPresence: false,
            requireUserVerification: false,
        });
        if (!verification.verified) {
            throw new HTTPException(400, { message: 'Could not verify authentication' });
        }
        if (options.expectedKeyId) {
            const expected = normalizeBase64UrlId(options.expectedKeyId);
            const attested = normalizeBase64UrlId(verification.registrationInfo?.credential.id);
            if (!expected || !attested || !bytesEqual(expected.buffer, attested.buffer)) {
                throw new HTTPException(400, { message: 'Passkey credential ID mismatch' });
            }
        }
    } catch(err) {
        if (err instanceof HTTPException) {
            throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Unexpected RP ID hash') || message.includes('origin')) {
            throw new HTTPException(400, { message: 'Passkey origin does not match this domain' });
        }
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

type SignerReader = (keys: xdr.LedgerKey[], minLedger?: number) => Promise<{
    ledger: number;
    values: Map<string, xdr.ScVal>;
}>;

function getSignerReader(rpcUrl: string, binding?: MainnetChainReads): SignerReader {
    if (binding) {
        return async (ledgerKeys, minLedger) => {
            const keys = ledgerKeys.map((key) => key.toXDR('base64'));
            const { ledger, values } = decodeLedgerPage(await binding.readEntries({ keys, minLedger }), keys, minLedger);
            // A stored signer key still verifies assertions after its storage TTL expires.
            return { ledger, values: new Map([...values].flatMap(([key, entry]) =>
                entry.state === 'present' ? [[key, entry.value] as const] : [],
            )) };
        };
    }
    const rpc = new Server(rpcUrl);
    return async (keys) => {
        const result = await rpc.getLedgerEntries(...keys);
        return {
            ledger: result.latestLedger,
            values: new Map(result.entries.map(({ key, val }) => [key.toXDR('base64'), val.contractData().val()])),
        };
    };
}

async function getPublicKeyFromPasskeyKit(read: SignerReader, contractId: string, keyId: string): Promise<Buffer> {
    const key = contractDataKey(contractId, storageKey('Secp256r1', xdr.ScVal.scvBytes(Buffer.from(keyId, 'base64url'))));
    const { values } = await read([key]);
    const signer = values.get(key.toXDR('base64'))?.vec()?.[1];
    if (!signer || signer.switch().name !== 'scvBytes') throw new Error('Passkey signer unavailable');
    return Buffer.from(signer.bytes());
}

/** Read Default context-rule IDs, then read their Signers vectors in bounded pages. */
async function getPublicKeyFromSmartAccountKit(
    read: SignerReader, contractId: string, keyId: string, batchRules: boolean,
): Promise<Buffer> {
    const credential = Buffer.from(keyId, 'base64url');
    const idsKey = contractDataKey(contractId, storageKey('Ids', storageKey('Default')));
    const { ledger, values } = await read([idsKey]);
    const ids = values.get(idsKey.toXDR('base64'))?.vec();
    if (!ids) throw new Error('No context rules found for contract');

    const ruleIds = [...new Set(ids.map((id) => id.u32()))];
    const keys = ruleIds.map((id) => contractDataKey(contractId, storageKey('Signers', xdr.ScVal.scvU32(id))));
    const pageSize = batchRules ? LEDGER_KEY_LIMIT : 1;
    const pages: xdr.LedgerKey[][] = [];
    for (let i = 0; i < keys.length; i += pageSize) pages.push(keys.slice(i, i + pageSize));
    const observations = batchRules ? await Promise.all(pages.map((page) => read(page, ledger))) : [];

    for (const [index, page] of pages.entries()) {
        const { values: signersByKey } = observations[index] ?? await read(page);
        for (const key of page) {
            const signers = signersByKey.get(key.toXDR('base64'))?.vec() ?? [];
            for (const signer of signers) {
                const fields = signer.vec();
                if (!fields || fields.length < 3 || fields[0].sym().toString() !== 'External') continue;
                const keyData = Buffer.from(fields[2].bytes());
                if (keyData.length > SECP256R1_PUBLIC_KEY_SIZE
                    && bytesEqual(keyData.subarray(SECP256R1_PUBLIC_KEY_SIZE), credential)) {
                    return keyData.subarray(0, SECP256R1_PUBLIC_KEY_SIZE);
                }
            }
        }
    }
    throw new Error('No matching signer found');
}

export async function verifyAuthentication(
    host: string,
    keyId: string,
    contractId: string,
    response: AuthenticationResponseJSON,
    rpcUrl: string,
    protocol: Protocol = 'passkey-kit',
    binding?: MainnetChainReads,
    options: PasskeyOriginOptions = {},
) {
    const { expectedOrigin, expectedRPID } = resolvePasskeyVerificationTarget(host, options);

    try {
        const gateway = typeof binding?.readEntries === 'function' ? binding : undefined;
        const read = getSignerReader(rpcUrl, gateway);

        // Get raw public key based on protocol
        const rawpk = protocol === 'smart-account-kit'
            ? await getPublicKeyFromSmartAccountKit(read, contractId, keyId, Boolean(gateway))
            : await getPublicKeyFromPasskeyKit(read, contractId, keyId);

        // Build COSE key from raw public key
        const publicKey = buildCoseKey(rawpk);

        const verification = await verifyAuthenticationResponse({
            response,
            // Use function to validate challenge from response
            expectedChallenge: isValidChallenge,
            expectedOrigin,
            expectedRPID,
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
        if (!verification.verified) {
            throw new HTTPException(400, { message: 'Could not verify authentication' });
        }
    } catch(err) {
        if (err instanceof HTTPException) {
            throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Unexpected RP ID hash') || message.includes('origin')) {
            throw new HTTPException(400, { message: 'Passkey origin does not match this domain' });
        }
        throw new HTTPException(400, { message: 'Could not verify authentication' });
    }
}
