import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk/minimal";
import { Server } from "@stellar/stellar-sdk/minimal/rpc";
import { basicNodeSigner } from "@stellar/stellar-sdk/minimal/contract";
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Client as SmolClient } from "smol-sdk";
import { purgeCacheByTags } from "./utils/cache";
import { artistSmolsCacheTag } from "./utils/cache-tags";

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

/**
 * Poll Stellar RPC for a submitted relay transaction hash and return its base64 returnValue.
 */
export async function confirmTransactionOnRpc(
	hash: string,
	rpcUrl: string,
	options?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<string> {
	const rpcServer = new Server(rpcUrl);
	const timeoutMs = options?.timeoutMs ?? 25_000;
	const pollIntervalMs = options?.pollIntervalMs ?? 1_000;
	const deadline = Date.now() + timeoutMs;

	while (true) {
		const result = await rpcServer.getTransaction(hash);

		if (result.status === 'SUCCESS') {
			if (!result.returnValue) {
				throw new NonRetryableError(`Transaction ${hash} succeeded on-chain but has no returnValue`);
			}
			return result.returnValue.toXDR('base64');
		}

		if (result.status === 'FAILED') {
			throw new NonRetryableError(`Transaction ${hash} failed on-chain`);
		}

		if (Date.now() >= deadline) {
			throw new Error(`Transaction ${hash} still pending on Stellar RPC (NOT_FOUND)`);
		}

		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
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

		// Step 2: Single non-retried submission to kale-worker relay; checkpoints returned relay hash.
		const submitted = await step.do(
			'submit transaction',
			submitConfig,
			async (): Promise<{ hash: string }> => {
				let result: { hash?: string; error?: string; errorCode?: string };
				try {
					result = await (this.env.KALE_WORKER as KaleWorkerBinding).submitTransaction({ xdr: signedXdr });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new NonRetryableError(
						`Relay submission outcome unknown (requires reconciliation, refusing duplicate submit): ${message}`
					);
				}

				if (result?.error) {
					throw new NonRetryableError(`Transaction rejected by relay: ${result.error} (${result.errorCode ?? 'unknown'})`);
				}

				if (!result?.hash || typeof result.hash !== 'string') {
					throw new NonRetryableError(
						'Relay response missing transaction hash (ambiguous submission, refusing duplicate submit)'
					);
				}

				return { hash: result.hash };
			}
		);

		// Step 3: Read-only confirmation step using the durable relay hash
		const returnValue = await step.do(
			'confirm transaction',
			confirmConfig,
			async (): Promise<string> => {
				return await confirmTransactionOnRpc(submitted.hash, this.env.RPC_URL);
			}
		);

		const res = { hash: submitted.hash, returnValue };

		// Step 4: Idempotent D1 persistence + narrowed cache invalidation
		if (event.payload.type === 'mint') {
			await step.do('persist mint metadata', config, async () => {
				const decoded = scValToNative(xdr.ScVal.fromXDR(res.returnValue, 'base64'));
				const [tokenSACAddress, cometAMMAddress] = assertMintPair(decoded, event.payload.entropy ?? 'single-mint');
				const id = event.payload.entropy;
				if (!id) {
					throw new NonRetryableError('Missing smol entropy id for mint persistence');
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

				await purgeCacheByTags([
					...userTags,
					`smol:${id}:anonymous`,
				]);
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
				for (let i = 0; i < verifiedPairs.length; i++) {
					const { id, token, amm } = verifiedPairs[i];
					const changes = runResults[i]?.meta?.changes ?? 0;
					if (changes === 0) {
						await verifyExistingMintRow(this.env, id, token, amm);
					}

					const ownerSub = event.payload.ownerSubsById?.[id] ?? event.payload.sub;
					smolCacheTags.add(artistSmolsCacheTag(ownerSub));
					smolCacheTags.add(`user:${ownerSub}:created`);
					smolCacheTags.add(`user:${ownerSub}:smol:${id}`);
					smolCacheTags.add(`user:${event.payload.sub}:smol:${id}`);
					smolCacheTags.add(`smol:${id}:anonymous`);
				}

				if (smolCacheTags.size > 0) {
					await purgeCacheByTags([...smolCacheTags]);
				}
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

		await at.signAuthEntries({
			address: signerPublicKey,
			signAuthEntry: basicNodeSigner(signerKeypair, this.env.NETWORK_PASSPHRASE).signAuthEntry,
		});

		return at.built!.toXDR();
	}
}
