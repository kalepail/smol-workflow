import { Keypair, Networks, scValToNative, xdr } from "@stellar/stellar-sdk/minimal";
import { Server } from "@stellar/stellar-sdk/minimal/rpc";
import { basicNodeSigner } from "@stellar/stellar-sdk/minimal/contract";
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Client as SmolClient } from "smol-sdk";
import { purgeCacheByTags } from "./utils/cache";
import { artistSmolsCacheTag } from "./utils/cache-tags";
import { deriveMintPair, isLedgerSequence, type MainnetChainReads } from "./utils/chain";
import type { MintPhase } from "./utils/chain-target";

const TX_HASH_RE = /^[0-9a-f]{64}$/;

const config: WorkflowStepConfig = {
	retries: {
		limit: 5,
		delay: '10 second',
		backoff: 'exponential',
	},
	timeout: '5 minutes',
};

const submitConfig: WorkflowStepConfig = {
	// Never blindly re-submit a signed Stellar transaction if a relay response is lost;
	// reconciliation must inspect relay/on-chain state instead of sending a duplicate tx.
	retries: {
		limit: 0,
		delay: '1 second',
	},
	timeout: '2 minutes',
};

const confirmConfig: WorkflowStepConfig = {
	retries: {
		limit: 6,
		delay: '5 second',
		backoff: 'exponential',
	},
	timeout: '5 minutes',
};

/**
 * Extract the ordered list of 32-byte hex salts from a signed `coin_them` Soroban invocation XDR.
 * The `smol` contract's `coin_them(user, asset_bytes, salts, fee_rules)` builds its return vector
 * via `results.push_front(...)`, which REVERSES the returned tuples relative to `salts`.
 * Extracting `salts` from the signed invocation ensures exact attribution even if payload IDs
 * differ in ordering or padding.
 */
export function extractCoinThemSaltHexes(xdrEnvelope: string): string[] {
	let envelope: xdr.TransactionEnvelope;
	try {
		envelope = xdr.TransactionEnvelope.fromXDR(xdrEnvelope, 'base64');
	} catch {
		throw new NonRetryableError('Invalid batch-mint transaction XDR');
	}

	let operations: xdr.Operation[] = [];
	const switchName = envelope.switch().name;
	if (switchName === 'envelopeTypeTx') {
		operations = envelope.v1().tx().operations();
	} else if (switchName === 'envelopeTypeTxV0') {
		operations = envelope.v0().tx().operations();
	} else if (switchName === 'envelopeTypeTxFeeBump') {
		operations = envelope.feeBump().tx().innerTx().v1().tx().operations();
	}

	for (const op of operations) {
		if (op.body().switch().name !== 'invokeHostFunction') {
			continue;
		}
		const hostFn = op.body().invokeHostFunctionOp().hostFunction();
		if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') {
			continue;
		}
		const invokeArgs = hostFn.invokeContract();
		const fnName = invokeArgs.functionName().toString('utf8');
		if (fnName !== 'coin_them') {
			continue;
		}

		// coin_them(user, asset_bytes, salts, fee_rules) -> args[2] is Vec<BytesN<32>>
		const args = invokeArgs.args();
		if (args.length < 3 || args[2].switch().name !== 'scvVec') {
			throw new NonRetryableError('Batch-mint coin_them invocation is missing salts vector');
		}
		const saltVals = args[2].vec() ?? [];
		const hexSalts: string[] = [];
		for (const val of saltVals) {
			if (val.switch().name !== 'scvBytes') {
				throw new NonRetryableError('Batch-mint coin_them salt entry is not bytes');
			}
			const bytes = val.bytes();
			if (bytes.length !== 32) {
				throw new NonRetryableError(`Batch-mint coin_them salt must be 32 bytes (got ${bytes.length})`);
			}
			hexSalts.push(Buffer.from(bytes).toString('hex').toLowerCase());
		}
		return hexSalts;
	}

	throw new NonRetryableError('Batch-mint XDR does not contain a coin_them contract invocation');
}

/**
 * Map `coin_them` results (which the contract produces in REVERSE salt order via `push_front`)
 * back to the exact smol IDs from the signed invocation's salts.
 */
export function pairBatchMintResults(params: {
	xdrEnvelope: string;
	rawResults: unknown[];
	requestedIds: string[];
	mintableIds: string[];
}): Array<{ id: string; token: string; amm: string }> {
	const { xdrEnvelope, rawResults, requestedIds, mintableIds } = params;
	const saltHexes = extractCoinThemSaltHexes(xdrEnvelope);

	if (saltHexes.length !== rawResults.length) {
		throw new NonRetryableError(
			`Batch mint result count (${rawResults.length}) does not match signed coin_them salts (${saltHexes.length})`
		);
	}

	const candidateIds = [...new Set([...requestedIds, ...mintableIds])];
	const idBySaltHex = new Map<string, string>();
	for (const id of candidateIds) {
		const normalized = id.trim().toLowerCase().padStart(64, '0');
		idBySaltHex.set(normalized, id);
	}

	const paired: Array<{ id: string; token: string; amm: string }> = [];
	const seenIds = new Set<string>();
	const count = saltHexes.length;

	for (let i = 0; i < count; i++) {
		const saltHex = saltHexes[i];
		const id = idBySaltHex.get(saltHex);
		if (!id) {
			throw new NonRetryableError(`Signed coin_them salt ${saltHex} does not match any requested smol ID`);
		}
		if (seenIds.has(id)) {
			throw new NonRetryableError(`Duplicate smol salt ${saltHex} in coin_them invocation`);
		}
		seenIds.add(id);

		// Contract `coin_them` calls `results.push_front(coin_it(...))` for each salt in forward order,
		// so the tuple for `saltHexes[i]` is at index `count - 1 - i` in `rawResults`.
		const resultForSalt = rawResults[count - 1 - i];
		const [token, amm] = assertMintPair(resultForSalt, id);
		paired.push({ id, token, amm });
	}

	return paired;
}

type ConfirmedMint = { returnValue: string; ledger?: number };
class FailedMintReceipt extends NonRetryableError {}

async function confirmMint(
	hash: string,
	rpcUrl: string,
	binding?: MainnetChainReads,
): Promise<ConfirmedMint> {
	let getTx: MainnetChainReads['getTx'];
	let pollInterval: number;
	if (typeof binding?.getTx === 'function') {
		getTx = (txHash) => binding.getTx(txHash);
		pollInterval = 4_000;
	} else {
		const server = new Server(rpcUrl);
		getTx = async (txHash) => {
			const result = await server.getTransaction(txHash);
			return {
				status: result.status,
				latestLedger: result.latestLedger,
				...(result.status === 'SUCCESS' ? {
					ledger: result.ledger,
					returnValueXdr: result.returnValue?.toXDR('base64'),
				} : {}),
			};
		};
		pollInterval = 1_000;
	}
	const deadline = Date.now() + 25_000;
	while (true) {
		let result;
		try {
			result = await getTx(hash);
		} catch {
			throw new Error('Mint receipt lookup unavailable');
		}
		if (result.status === 'SUCCESS') {
			if (!result.returnValueXdr || (binding && typeof binding.getTx === 'function' && !isLedgerSequence(result.ledger))) {
				throw new NonRetryableError('Mint succeeded on-chain but its receipt is incomplete');
			}
			return { returnValue: result.returnValueXdr, ledger: result.ledger };
		}
		if (result.status === 'FAILED') {
			throw new FailedMintReceipt('Mint transaction failed on-chain');
		}
		if (result.status !== 'NOT_FOUND' || Date.now() >= deadline) {
			throw new Error('Mint receipt is still unavailable');
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(pollInterval, deadline - Date.now())));
	}
}

function assertMintPair(pair: unknown, label: string): [string, string] {
	if (
		!Array.isArray(pair)
		|| pair.length < 2
		|| typeof pair[0] !== 'string'
		|| !pair[0].trim()
		|| typeof pair[1] !== 'string'
		|| !pair[1].trim()
	) {
		throw new NonRetryableError(`Invalid mint result tuple for ${label}`);
	}
	return [pair[0], pair[1]];
}

async function verifyExistingMintRow(
	env: Env,
	id: string,
	expectedToken: string,
	expectedAmm: string
): Promise<void> {
	const existing = await env.SMOL_D1.prepare(
		`SELECT Mint_Token, Mint_Amm FROM Smols WHERE Id = ?1`
	)
		.bind(id)
		.first<{ Mint_Token: string | null; Mint_Amm: string | null }>();

	if (!existing) {
		throw new NonRetryableError(`Smol ${id} not found during mint persistence`);
	}

	if (existing.Mint_Token === expectedToken && existing.Mint_Amm === expectedAmm) {
		return;
	}

	throw new NonRetryableError(
		`Mint metadata conflict for smol ${id}: stored (${existing.Mint_Token}, ${existing.Mint_Amm}) != (${expectedToken}, ${expectedAmm})`
	);
}

async function purgeMintCaches(env: Env, ids: string[], tags: Iterable<string>): Promise<void> {
	if (!ids.length) return;
	const { results } = await env.SMOL_D1.prepare(`
		WITH ids AS (SELECT value AS Id FROM json_each(?1))
		SELECT 'mixtape:' || m.mix_id AS Tag
		FROM ids CROSS JOIN MixtapeMember m ON m.smol_id = ids.Id
		UNION
		SELECT 'playlist:' || p.Title AS Tag
		FROM ids CROSS JOIN Playlists p ON p.Id = ids.Id
	`).bind(JSON.stringify(ids)).all<{ Tag: string }>();
	await purgeCacheByTags(['mixtapes', 'public-smols', ...tags, ...results.map(({ Tag }) => Tag)]);
}

async function recordMintPhase(
	env: Env, event: WorkflowEvent<WorkflowTxParams>, phase: MintPhase, hash?: string, ledger?: number,
) {
	if (!event.payload.trackStatus) return;
	await env.SMOL_D1.prepare(`
		UPDATE MintBatchStatus SET Phase = ?1, Tx_Hash = coalesce(?2, Tx_Hash),
			Confirmed_Ledger = coalesce(?3, Confirmed_Ledger)
		WHERE Workflow_Id = ?4 AND "Address" = ?5
	`).bind(phase, hash ?? null, ledger ?? null, event.instanceId, event.payload.sub).run();
}

export class TxWorkflow extends WorkflowEntrypoint<Env, WorkflowTxParams> {
	async run(event: WorkflowEvent<WorkflowTxParams>, step: WorkflowStep) {
		if (event.payload.type !== 'mint' && event.payload.type !== 'batch-mint') {
			throw new NonRetryableError(`Invalid transaction type: ${String((event.payload as { type?: unknown }).type)}`);
		}

		// Step 1: Deterministic auth-entry signing (checkpointed before relay submit)
		const signedXdr = await step.do('sign transaction', config, async (): Promise<string> => {
			if (!event.payload.xdr) {
				throw new NonRetryableError('Missing transaction XDR');
			}
			return await this.signTransaction(event.payload.xdr);
		});

		if (event.payload.trackStatus) {
			await step.do('record mint submit intent', config, async () => {
				await recordMintPhase(this.env, event, 'submitting');
			});
		}

		// Step 2: Single non-retried submission to kale-worker relay; checkpoints returned relay hash.
		const submitted = await step.do(
			'submit transaction',
			submitConfig,
			async (): Promise<{ hash: string }> => {
				let result: Awaited<ReturnType<KaleWorkerBinding['submitTransaction']>>;
				try {
					result = await this.env.KALE_WORKER.submitTransaction({ xdr: signedXdr });
				} catch {
					throw new NonRetryableError('Relay submission outcome unknown (requires reconciliation)');
				}

				// A valid hash wins over a relay error: WAIT_TIMEOUT / ONCHAIN_FAILED results carry the
				// hash of a transaction that may already be on-chain. Checkpoint it so the read-only
				// confirm step records the real outcome instead of dropping a landed mint.
				if (result?.error) {
					const relayHash = typeof result.hash === 'string' ? result.hash.trim().toLowerCase() : '';
					if (TX_HASH_RE.test(relayHash)) {
						console.warn(JSON.stringify({
							event: 'relay_error_with_hash',
							error_code: typeof result.errorCode === 'string' ? result.errorCode.slice(0, 64) : null,
							hash: relayHash,
						}));
						return { hash: relayHash };
					}
					throw new NonRetryableError('Relay could not confirm submission');
				}

				if (!result?.hash || typeof result.hash !== 'string') {
					throw new NonRetryableError(
						'Relay response missing transaction hash (ambiguous submission, refusing duplicate submit)'
					);
				}

				return { hash: result.hash };
			}
		);

		if (event.payload.trackStatus) {
			await step.do('record submitted mint', config, async () => {
				await recordMintPhase(this.env, event, 'submitted', submitted.hash);
			});
		}

		// Step 3: Read-only confirmation step using the durable relay hash.
		const receipt = await step.do(
			'confirm transaction',
			confirmConfig,
			async (): Promise<ConfirmedMint | string> => {
				const binding = this.env.NETWORK_PASSPHRASE === Networks.PUBLIC ? this.env.KALE_WORKER : undefined;
				try {
					return await confirmMint(submitted.hash, this.env.RPC_URL, binding);
				} catch (error) {
					if (error instanceof FailedMintReceipt) await recordMintPhase(this.env, event, 'failed', submitted.hash);
					throw error;
				}
			}
		);
		// In-flight legacy runs may already have checkpointed a raw return-value string.
		const confirmed = typeof receipt === 'string' ? { returnValue: receipt } : receipt;
		if (event.payload.trackStatus) {
			await step.do('record confirmed mint', config, async () => {
				await recordMintPhase(this.env, event, 'confirmed', submitted.hash, confirmed.ledger);
			});
		}
		const res = { hash: submitted.hash, ...confirmed };

		// Step 4: Idempotent D1 persistence and cache invalidation.
		if (event.payload.type === 'mint') {
			await step.do('persist mint metadata', config, async () => {
				const decoded = scValToNative(xdr.ScVal.fromXDR(res.returnValue, 'base64'));
				const [tokenSACAddress, cometAMMAddress] = assertMintPair(decoded, event.payload.entropy ?? 'single-mint');
				const id = event.payload.entropy;
				if (!id) {
					throw new NonRetryableError('Missing smol entropy id for mint persistence');
				}
				const expected = deriveMintPair(id);
				if (!expected || tokenSACAddress !== expected.sac || cometAMMAddress !== expected.pool) {
					throw new NonRetryableError('Single mint receipt conflicts with the canonical token and pool');
				}

				const result = await this.env.SMOL_D1.prepare(`
					UPDATE Smols
					SET Mint_Token = ?1, Mint_Amm = ?2
					WHERE Id = ?3 AND Mint_Token IS NULL AND Mint_Amm IS NULL
				`)
					.bind(tokenSACAddress, cometAMMAddress, id)
					.run();

				if (result.meta.changes === 0) {
					await verifyExistingMintRow(this.env, id, tokenSACAddress, cometAMMAddress);
				}

				const ownerSub = event.payload.ownerSub ?? event.payload.sub;
				const userTags = new Set([
					artistSmolsCacheTag(ownerSub),
					`user:${ownerSub}:created`,
					`user:${ownerSub}:smol:${id}`,
					`user:${event.payload.sub}:smol:${id}`,
				]);

				await purgeMintCaches(this.env, [id], [...userTags, `smol:${id}:anonymous`]);
			});
		} else if (event.payload.type === 'batch-mint') {
			await step.do('persist batch mint metadata', config, async () => {
				const rawResults = scValToNative(xdr.ScVal.fromXDR(res.returnValue, 'base64'));
				const requestedIds = event.payload.ids ?? [];
				const mintableIds = event.payload.mintableIds ?? requestedIds;

				if (!Array.isArray(rawResults)) {
					throw new NonRetryableError('Batch mint result is not a list');
				}

				// Map reversed `coin_them` push_front tuples to the signed invocation's exact salt order
				const verifiedPairs = pairBatchMintResults({
					xdrEnvelope: event.payload.xdr,
					rawResults,
					requestedIds,
					mintableIds,
				});

				const statements = verifiedPairs.map(({ id, token, amm }) =>
					this.env.SMOL_D1.prepare(`
						UPDATE Smols
						SET Mint_Token = ?1, Mint_Amm = ?2
						WHERE Id = ?3 AND Mint_Token IS NULL AND Mint_Amm IS NULL
					`).bind(token, amm, id)
				);

				let runResults: Array<{ meta?: { changes?: number } }>;
				if (typeof this.env.SMOL_D1.batch === 'function') {
					runResults = await this.env.SMOL_D1.batch(statements);
				} else {
					runResults = [];
					for (const stmt of statements) {
						runResults.push(await stmt.run());
					}
				}

				const smolCacheTags = new Set<string>();
				const persistedIds: string[] = [];
				let conflict: unknown;
				for (let i = 0; i < verifiedPairs.length; i++) {
					const { id, token, amm } = verifiedPairs[i];
					const changes = runResults[i]?.meta?.changes ?? 0;
					if (changes === 0) {
						try {
							await verifyExistingMintRow(this.env, id, token, amm);
						} catch (error) {
							conflict ??= error;
							continue;
						}
					}

					persistedIds.push(id);
					const ownerSub = event.payload.ownerSubsById?.[id] ?? event.payload.sub;
					smolCacheTags.add(artistSmolsCacheTag(ownerSub));
					smolCacheTags.add(`user:${ownerSub}:created`);
					smolCacheTags.add(`user:${ownerSub}:smol:${id}`);
					smolCacheTags.add(`user:${event.payload.sub}:smol:${id}`);
					smolCacheTags.add(`smol:${id}:anonymous`);
				}

				await purgeMintCaches(this.env, persistedIds, smolCacheTags);
				if (conflict) throw conflict;
			});
		}

		if (event.payload.trackStatus) {
			await step.do('record persisted mint', config, async () => {
				await recordMintPhase(this.env, event, 'persisted', submitted.hash, confirmed.ledger);
			});
		}
		return res;
	}

	async signTransaction(xdrEnvelope: string) {
		const signerKeypair = Keypair.fromSecret(this.env.SK);
		const signerPublicKey = signerKeypair.publicKey();
		const contract = new SmolClient({
			contractId: this.env.SMOL_CONTRACT_ID,
			rpcUrl: this.env.RPC_URL,
			networkPassphrase: this.env.NETWORK_PASSPHRASE,
		});

		const at = contract.txFromXDR(xdrEnvelope);

		const getSequence = async () => {
			if (this.env.NETWORK_PASSPHRASE === Networks.PUBLIC && typeof this.env.KALE_WORKER?.getTip === 'function') {
				return (await this.env.KALE_WORKER.getTip()).sequence;
			}
			return (await new Server(this.env.RPC_URL).getHealth()).latestLedger;
		};
		let sequence: number;
		try {
			sequence = await getSequence();
		} catch {
			throw new Error('Signing ledger tip unavailable');
		}
		const expiration = sequence + 100;
		if (!isLedgerSequence(sequence) || !isLedgerSequence(expiration)) throw new Error('Invalid signing ledger tip');

		await at.signAuthEntries({
			expiration,
			address: signerPublicKey,
			signAuthEntry: basicNodeSigner(signerKeypair, this.env.NETWORK_PASSPHRASE).signAuthEntry,
		});

		return at.built!.toXDR();
	}
}
