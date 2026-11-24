# Mint authorization fixtures

Two separate boundaries, with separate provenance. Regenerate with `generate.ts` (every network call is a public read).

## Boundary A: real mainnet trees (`mainnet-trees.json`)

Untouched Horizon receipts. Each entry keeps the original fee-bump `envelopeXdr` (sha256 recorded) and its projection: host function, user entry, admin entry and both root invocations. Tests rebuild the expectation from the pre-mint row facts and compare it byte for byte with the projection. They also accept an FE-shaped carrier rebuilt from the same `func`/`auth`, and they verify the real issuer signature with the signed-output predicate.

| Tx hash | Ledger | Protocol | Shape |
|---|---|---|---|
| `d2d11a95de072c3a8c84ab32b840d0e00db7fac576e444269a84ce51ea2422da` | 64,920,567 | 29 | `coin_it`, creator self-mint (one 50% recipient) |
| `7352b187760d81dab7ed4fb1504e295d23873296197c22839a0fcaf95ddbf84b` | 62,803,627 | 26 | `coin_it`, split fee |
| `6a5923d763eb0ad5fc2769959c414a1095bf9239db19820d61a6db69d9d58ed4` | 60,664,468 | 24 | `coin_them`, 5 tracks, split fees |
| `314dd414ac302ef617cc424a3efd1b3f6d2fbe98ce6bfdcc219b2ea7f6a5ca69` | 59,479,888 | 23 | `coin_them`, 3 tracks, split fees |

`d1Snapshot` is a read-only `SELECT` of the current `smol-d1` rows. It shows that `Smols.Address` equals the on-chain fee-rule creator for every track.

## Boundary B: FE carriers (`fe-carriers.json`, `fe-builder.ts`)

These are unsigned `envelopeTypeTx` carriers, built the way the frozen `smol-fe` (`next@94d71b3`) builds them. The real SDK 14.4.3 `contract.Client` builds, simulates and assembles each one. `signAuthEntries` then signs only the wallet entry, using the passkey-kit 0.12.0 Secp256r1 encoding and a real P-256 WebAuthn assertion. The admin entry stays unsigned (`scvVoid`, expiry 0). Only the RPC is mocked: its recorded auth trees are derived from the submitted arguments, following the contract source, independently of `src/chain`.

There are two identities:

- `mainnet`: the production factory and issuer. Ingress tests use it.
- `test`: a throwaway factory, with an issuer derived from `sha256('smol-wf0-test-issuer')`. It lets tests run the real signer and the output verification.

## `factory-spec.json`

Holds the `contractspecv0` entries extracted from the live factory Wasm (`1199117e…`, read with `getLedgerEntries`). `src/chain/smol-spec.ts` must equal it.
