import { Keypair, Networks, scValToNative, xdr } from "@stellar/stellar-sdk/base";
import { Server } from "@stellar/stellar-sdk/rpc";
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
	assertMintConfig,
	assertUnsignedMintEnvelope,
	buildMintExpectation,
	decodeMintCarrier,
	mintKindForRoute,
	MintRejected,
	signValidatedMint,
	type MintIdentity,
	type ValidatedUnsignedMint,
} from "./chain/mint-authorization";
import { purgeCacheByTags } from "./utils/cache";
import { artistSmolsCacheTag, playlistCacheTags } from "./utils/cache-tags";
import { deriveMintPair, isLedgerSequence, type MainnetChainReads } from "./utils/chain";
import type { MintPhase } from "./utils/chain-target";
import {
	assertMintEligible,
	assertNoUnresolvedMintReceipt,
	markMintDispatched,
	MintIneligible,
	MintReceiptUnreadable,
	readMintAttemptState,
	readMintFacts,
	reserveMintPrefixes,
	resolveMintPrefixes,
	settleMintPrefixes,
} from "./utils/mint-eligibility";

const TX_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The `sign transaction` step result. Only this revision's validated signer produces it; a bare
 * string checkpoint was produced by the pre-WF-0 blind signer and must never be relayed.
 */
export const SIGNED_MINT_CHECKPOINT_VERSION = 'wf0-v1';
export interface SignedMintCheckpoint {
	version: typeof SIGNED_MINT_CHECKPOINT_VERSION;
	xdr: string;
}

/** Returns the signed XDR of a versioned checkpoint; refuses anything else non-retryably. */
export function signedCheckpointXdr(checkpoint: unknown): string {
	if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
		throw new NonRetryableError('Unversioned signing checkpoint refused (requires reconciliation)');
	}
	const { version, xdr: signed } = checkpoint as Record<string, unknown>;
	if (version !== SIGNED_MINT_CHECKPOINT_VERSION || typeof signed !== 'string' || !signed
		|| Object.keys(checkpoint).length !== 2) {
		throw new NonRetryableError('Unversioned signing checkpoint refused (requires reconciliation)');
	}
	return signed;
}

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

/**
 * Owner-checked lock settlement after a confirmed on-chain outcome. Read-only towards the chain and
 * idempotent in the lock store, so it retries independently: never re-signs, never re-submits.
 */
const settleConfig: WorkflowStepConfig = {
	retries: {
		limit: 10,
		delay: '10 second',
		backoff: 'exponential',
	},
	timeout: '1 minute',
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

/** The `confirm transaction` checkpoint of a confirmed on-chain FAILED receipt for the relayed hash. */
type FailedMintCheckpoint = { failedOnChain: true };
const FAILED_ONCHAIN_MESSAGE = 'Mint transaction failed on-chain';

function isFailedMintCheckpoint(receipt: unknown): receipt is FailedMintCheckpoint {
	return !!receipt && typeof receipt === 'object' && (receipt as Record<string, unknown>).failedOnChain === true;
}

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
			throw new FailedMintReceipt(FAILED_ONCHAIN_MESSAGE);
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
		SELECT 'mixtape:' || m.mix_id AS Tag, NULL AS Playlist
		FROM ids CROSS JOIN MixtapeMember m ON m.smol_id = ids.Id
		UNION
		SELECT NULL AS Tag, p.Title AS Playlist
		FROM ids CROSS JOIN Playlists p ON p.Id = ids.Id
	`).bind(JSON.stringify(ids)).all<{ Tag: string | null; Playlist: string | null }>();
	const playlistTags = await playlistCacheTags(results.flatMap(({ Playlist }) => Playlist === null ? [] : [Playlist]));
	const mixtapeTags = results.flatMap(({ Tag }) => Tag === null ? [] : [Tag]);
	await purgeCacheByTags(['mixtapes', 'public-smols', ...tags, ...mixtapeTags, ...playlistTags]);
}

/** Records the batch's phase. It only ever adds this attempt's own receipt (never clears one). */
async function recordMintPhase(
	env: Env, event: WorkflowEvent<WorkflowTxParams>, phase: MintPhase, hash?: string, ledger?: number,
) {
	if (!event.payload.trackStatus) return;
	await env.SMOL_D1.prepare(`
		UPDATE MintBatchStatus SET Phase = ?1, Tx_Hash = coalesce(?2, Tx_Hash), Confirmed_Ledger = coalesce(?3, Confirmed_Ledger)
		WHERE Workflow_Id = ?4 AND "Address" = ?5
	`).bind(phase, hash ?? null, ledger ?? null, event.instanceId, event.payload.sub).run();
}

/**
 * Records the submit intent of the signed attempt this execution is about to submit. The lock store
 * decides whether that attempt is genuinely new: only a fresh signature leaves every claim in
 * `signing` (signed, never dispatched), and only such an attempt can pass the dispatch marker.
 *
 * - New attempt (`undispatched`: a first run, or a full restart that signed again after a definite
 *   failure): a row still before submit (`unverified`/`existing`/`queued`) or definitely `failed`
 *   becomes `submitting`, and only then are the receipt fields a failed attempt left behind
 *   (`Tx_Hash`, `Confirmed_Ledger`) cleared, so a lost relay response for THIS attempt reports
 *   `uncertain` without pointing reconciliation at the previous, failed transaction. A `submitting`
 *   row keeps its fields (the signer refuses to sign over one, so here it is this attempt's own intent,
 *   replayed). A `submitted`, `confirmed` or `persisted` row is never touched: its phase and receipt
 *   stay for reconciliation, and the attempt proves nothing (`preSubmit` false).
 * - Replay of an attempt whose dispatch already started (`dispatch_started`; a named-step restart here
 *   reuses the earlier signing checkpoint): the phase and receipt are preserved; only a row still
 *   before submit advances to `submitting`, so status never reads a possibly relayed attempt as queued.
 *   A `submitted` row keeps its hash for reconciliation.
 * - Anything else (`other`: a pre-v7 blind-signer checkpoint, no v7 claim, an admission reservation,
 *   a concluded attempt): the row is left exactly as it is. This execution can never relay such an
 *   attempt, so it records no intent, and a row still before submit stays there for a later refusal to
 *   fail definitively, while an earlier attempt's `submitting` row is preserved as `uncertain`.
 *
 * Returns the attempt-scoped proof `preSubmit`: true only for a new attempt whose row this step holds
 * at `submitting` for THIS attempt. Together with the lock store moving the same claims `signing` ->
 * `failed`, it proves a later refusal happened before dispatch (see `recordRefusedPhase`). A
 * checkpoint a pre-v7 execution wrote without this output proves nothing.
 */
async function recordMintSubmitIntent(env: Env, event: WorkflowEvent<WorkflowTxParams>): Promise<boolean> {
	if (!event.payload.trackStatus) return false;
	const state = await readMintAttemptState(env, event.instanceId, mintLockIds(event.payload));
	if (state === 'other') return false;
	const fresh = state === 'undispatched' ? 1 : 0;
	// A receipt is cleared only on the way out of a pre-submit or definite `failed` phase, never from an
	// unresolved (`submitting`/`submitted`) or final (`confirmed`/`persisted`) one.
	const result = await env.SMOL_D1.prepare(`
		UPDATE MintBatchStatus SET Phase = 'submitting',
			Tx_Hash = CASE WHEN ?1 = 1 AND Phase IN ('unverified', 'existing', 'queued', 'failed') THEN NULL ELSE Tx_Hash END,
			Confirmed_Ledger = CASE WHEN ?1 = 1 AND Phase IN ('unverified', 'existing', 'queued', 'failed') THEN NULL ELSE Confirmed_Ledger END
		WHERE Workflow_Id = ?2 AND "Address" = ?3
			AND Phase NOT IN ('submitted', 'confirmed', 'persisted')
			AND (?1 = 1 OR Phase IN ('unverified', 'existing', 'queued'))
	`).bind(fresh, event.instanceId, event.payload.sub).run();
	return fresh === 1 && (result.meta?.changes ?? 0) > 0;
}

/**
 * Phases in which an earlier attempt's transaction may be (or is) on its way to the network, or already
 * landed. A fresh signature for the same batch could replace an unresolved receipt, so the signer
 * refuses to produce one.
 */
const RECEIPT_PHASES: ReadonlySet<string> = new Set(['submitting', 'submitted', 'confirmed', 'persisted']);

/** This batch's tracked phase, or null when the batch is untracked or has no status row. */
async function readMintBatchPhase(env: Env, event: WorkflowEvent<WorkflowTxParams>): Promise<string | null> {
	if (!event.payload.trackStatus) return null;
	const row = await env.SMOL_D1.prepare(`
		SELECT Phase FROM MintBatchStatus WHERE Workflow_Id = ?1 AND "Address" = ?2
	`).bind(event.instanceId, event.payload.sub).first<{ Phase: string }>();
	return row?.Phase ?? null;
}

/** The submit-intent step's checkpoint. A pre-v7 checkpoint (no output) proves nothing. */
type MintSubmitIntentCheckpoint = { preSubmit: boolean };

function intentProvedPreSubmit(checkpoint: unknown): boolean {
	return typeof checkpoint === 'object' && checkpoint !== null
		&& (checkpoint as Partial<MintSubmitIntentCheckpoint>).preSubmit === true;
}

/** The ids this workflow claims prefix locks for (the carrier salts the route admitted). */
function mintLockIds(payload: WorkflowTxParams): unknown[] {
	return payload.type === 'mint' ? [payload.entropy] : payload.mintableIds ?? payload.ids ?? [];
}

/**
 * Records `failed` for a refusal made before this execution dispatched anything. A refusal never proves
 * an earlier attempt's outcome, so the write is guarded:
 *
 * - `submitted`, `confirmed` and `persisted` are never touched: the row's phase and `Tx_Hash` stay intact,
 *   so `/mint/status` keeps reporting the receipt (or `uncertain` with its hash) for reconciliation.
 * - `submitting` becomes `failed` only when `proven`: this v7 run's own submit-intent step proved the
 *   attempt was before submit (`preSubmit`) AND the lock store moved this workflow's own `signing` claim
 *   to `failed` (signed, never dispatched). Either alone is not enough. A signing-stage refusal runs
 *   before any submit intent, so a `submitting` row it finds belongs to an earlier attempt (e.g. a
 *   pre-v7 execution whose relay outcome is unknown) even when this run's fresh `signing` claim is the
 *   one that failed. With no v7 lock (`none`), a released never-signed reservation (`released`), or a
 *   pre-v7 intent checkpoint, the row is likewise left for status to report as `uncertain`.
 * - Rows still before submit (`unverified`/`existing`/`queued`) become `failed`.
 *
 * Best effort: a D1 fault while recording `failed` never changes the terminal refusal that follows.
 */
async function recordRefusedPhase(env: Env, event: WorkflowEvent<WorkflowTxParams>, proven: boolean) {
	if (!event.payload.trackStatus) return;
	try {
		await env.SMOL_D1.prepare(`
			UPDATE MintBatchStatus SET Phase = 'failed'
			WHERE Workflow_Id = ?1 AND "Address" = ?2
				AND Phase NOT IN ('submitted', 'confirmed', 'persisted')
				AND (?3 = 1 OR Phase <> 'submitting')
		`).bind(event.instanceId, event.payload.sub, proven ? 1 : 0).run();
	} catch (error) {
		console.warn(JSON.stringify({
			event: 'mint_phase_record_failed',
			workflow_id: event.instanceId,
			error: String(error).slice(0, 200),
		}));
	}
}

export const DISPATCH_UNCERTAIN_MESSAGE = 'Mint dispatch outcome uncertain (requires reconciliation)';

/**
 * Concludes a refusal that happens before this execution dispatches anything. The lock store decides
 * atomically whether it is definite, because a replayed submit or a fully restarted instance may be
 * re-running after an earlier execution already dispatched:
 *
 * - `failed`: this workflow's own `signing` claim became `failed` (this v7 attempt never dispatched).
 *   The lock is settled. The status row records `failed` if it is still before submit; a `submitting`
 *   row is failed too only when `preSubmit` (this run's own submit-intent proof) is also true. A
 *   signing-stage refusal passes no `preSubmit`, so it never downgrades an earlier attempt's
 *   `submitting` row (best effort, guarded by `recordRefusedPhase`).
 * - `released` / `none`: this workflow held no `signing` claim: only an admission reservation (a
 *   never-signed one is released) or no v7 claim at all. That proves nothing about an earlier dispatch,
 *   e.g. a pre-v7 execution that wrote `submitting` and relayed before the lock store existed, followed
 *   by a post-upgrade duplicate admission that reserved afresh. The status row records `failed` only if
 *   it is still before submit; a `submitting`, submitted or later row is never downgraded.
 * - `uncertain`: this workflow's dispatch may have started. Its claims are retained as `ambiguous`
 *   (never `failed`, never released, never taken over) and the status row is left alone.
 * - `minted`/`unknown`: settled already, or the lock store is unreachable; nothing is recorded.
 *
 * `preSubmit` must be this v7 run's own submit-intent proof; signing-stage callers never pass it.
 *
 * Always returns the terminal error for the caller to throw.
 */
async function concludeMintRefusal(
	env: Env, event: WorkflowEvent<WorkflowTxParams>, message: string, preSubmit = false,
): Promise<NonRetryableError> {
	const state = await resolveMintPrefixes(env, event.instanceId, mintLockIds(event.payload), 'failed');
	if (state === 'uncertain') return new NonRetryableError(`${DISPATCH_UNCERTAIN_MESSAGE}: ${message}`);
	if (state === 'failed' || state === 'released' || state === 'none') {
		// A `submitting` row is proven pre-dispatch only by BOTH this run's own submit-intent proof and the
		// lock store moving this workflow's own `signing` claim to `failed`.
		await recordRefusedPhase(env, event, state === 'failed' && preSubmit);
	}
	return new NonRetryableError(message);
}

/**
 * The relay call may have reached the network: retain the claims as `ambiguous` (best effort; a
 * `dispatched` claim is already retained if this fails) and never record `failed`.
 */
async function retainAmbiguousDispatch(env: Env, event: WorkflowEvent<WorkflowTxParams>, message: string): Promise<NonRetryableError> {
	await resolveMintPrefixes(env, event.instanceId, mintLockIds(event.payload), 'ambiguous');
	return new NonRetryableError(message);
}

export class TxWorkflow extends WorkflowEntrypoint<Env, WorkflowTxParams> {
	async run(event: WorkflowEvent<WorkflowTxParams>, step: WorkflowStep) {
		if (event.payload.type !== 'mint' && event.payload.type !== 'batch-mint') {
			throw new NonRetryableError(`Invalid transaction type: ${String((event.payload as { type?: unknown }).type)}`);
		}

		// Step 1: Validated single-entry issuer signing, checkpointed (versioned) before relay submit.
		const signed: unknown = await step.do('sign transaction', config, async (): Promise<SignedMintCheckpoint> => ({
			version: SIGNED_MINT_CHECKPOINT_VERSION,
			xdr: await this.signTransaction(event),
		}));

		// Whether this execution proved the attempt had not reached submit (see recordMintSubmitIntent).
		let intent: unknown;
		if (event.payload.trackStatus) {
			intent = await step.do('record mint submit intent', config, async (): Promise<MintSubmitIntentCheckpoint> => ({
				preSubmit: await recordMintSubmitIntent(this.env, event),
			}));
		}
		const preSubmit = intentProvedPreSubmit(intent);

		// Step 2: Single non-retried submission to kale-worker relay; checkpoints returned relay hash.
		const submitted = await step.do(
			'submit transaction',
			submitConfig,
			async (): Promise<{ hash: string }> => {
				// The kill switch also holds signed-but-undispatched work (including checkpoints signed
				// by an earlier deployment). A replay of this callback may follow a dispatch that already
				// started, so the lock store decides whether the refusal is definite; a started dispatch
				// is retained as ambiguous, never failed or released.
				if (this.env.MINT_SIGNING_ENABLED !== 'true') {
					throw await concludeMintRefusal(this.env, event, 'Mint signing is paused', preSubmit);
				}
				// Only a versioned checkpoint from this revision's validated signer may be relayed. A
				// bare string is pre-WF-0 blind-signer output. It is refused here, inside the step, so a
				// submit step that already completed keeps its checkpoint for confirmation.
				// The refusal is settled like any other pre-dispatch refusal: a row still before submit
				// records `failed` durably (it outlives the instance), while an earlier attempt's
				// `submitting`, `submitted` or later row is left for reconciliation.
				let signedXdr: string;
				try {
					signedXdr = signedCheckpointXdr(signed);
				} catch (error) {
					const message = error instanceof Error ? error.message : 'Unversioned signing checkpoint refused (requires reconciliation)';
					throw await concludeMintRefusal(this.env, event, message, preSubmit);
				}
				// The submit intent is now in D1 (a racing delete's guarded batch sees it), so a target row
				// a delete already removed (or one minted meanwhile) stops the mint before dispatch.
				const targets = [...new Set(mintLockIds(event.payload))];
				const present = await this.env.SMOL_D1.prepare(`
					SELECT count(*) AS n FROM Smols WHERE Id IN (SELECT value FROM json_each(?1)) AND Mint_Token IS NULL AND Mint_Amm IS NULL
				`).bind(JSON.stringify(targets)).first<number>('n').catch(() => null);
				if (present !== targets.length) {
					throw await concludeMintRefusal(this.env, event, 'Mint target song missing or minted before dispatch (nothing relayed)', preSubmit);
				}
				// Durable, owner-checked dispatch marker, written BEFORE the relay call. Only this
				// workflow's `signing` claim can become `dispatched`; a replay finds `dispatched` (or
				// `ambiguous`) and is refused without relaying, retaining the claim as ambiguous.
				let marked: Awaited<ReturnType<typeof markMintDispatched>>;
				try {
					marked = await markMintDispatched(this.env, event.instanceId, mintLockIds(event.payload));
				} catch {
					// Nothing was relayed. The marker may still have committed (lost response), so the
					// lock store, not this execution, decides whether the outcome is definite.
					throw await concludeMintRefusal(this.env, event, 'Mint dispatch marker unavailable (nothing relayed)', preSubmit);
				}
				if (!marked.ok) {
					if (marked.state === 'uncertain') {
						throw new NonRetryableError(`${DISPATCH_UNCERTAIN_MESSAGE}: submit replayed after dispatch started`);
					}
					throw await concludeMintRefusal(this.env, event, 'Mint dispatch refused: this workflow does not hold its signing claim', preSubmit);
				}
				let result: Awaited<ReturnType<KaleWorkerBinding['submitTransaction']>>;
				try {
					result = await this.env.KALE_WORKER.submitTransaction({ xdr: signedXdr });
				} catch {
					throw await retainAmbiguousDispatch(this.env, event, 'Relay submission outcome unknown (requires reconciliation)');
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
					throw await retainAmbiguousDispatch(this.env, event, 'Relay could not confirm submission');
				}

				if (!result?.hash || typeof result.hash !== 'string') {
					throw await retainAmbiguousDispatch(this.env, event,
						'Relay response missing transaction hash (ambiguous submission, refusing duplicate submit)');
				}

				return { hash: result.hash };
			}
		);

		if (event.payload.trackStatus) {
			await step.do('record submitted mint', config, async () => {
				await recordMintPhase(this.env, event, 'submitted', submitted.hash);
			});
		}

		// Step 3: Read-only confirmation step using the durable relay hash. A confirmed FAILED receipt is
		// checkpointed (not thrown), so its settlement below retries without re-running anything earlier.
		const receipt = await step.do(
			'confirm transaction',
			confirmConfig,
			async (): Promise<ConfirmedMint | FailedMintCheckpoint | string> => {
				const binding = this.env.NETWORK_PASSPHRASE === Networks.PUBLIC ? this.env.KALE_WORKER : undefined;
				try {
					return await confirmMint(submitted.hash, this.env.RPC_URL, binding);
				} catch (error) {
					if (error instanceof FailedMintReceipt) return { failedOnChain: true };
					throw error;
				}
			}
		);
		if (isFailedMintCheckpoint(receipt)) {
			// Definite for this workflow's own (single) dispatch. The owner-checked lock settlement runs in
			// its own retryable step and throws on a lock-store fault, so a transient fault is retried
			// here alone (zero re-sign, zero re-submit). D1 records `failed` only after the lock settled,
			// so status never reports failed while the lock still reads dispatched.
			const settled = await step.do('settle failed mint locks', settleConfig, async () => ({
				state: await settleMintPrefixes(this.env, event.instanceId, mintLockIds(event.payload), 'failed_onchain'),
			}));
			if (settled.state === 'uncertain' || settled.state === 'minted') {
				// Another dispatch may be unresolved, or the lock already reads minted: never record failed.
				throw new NonRetryableError(`${DISPATCH_UNCERTAIN_MESSAGE}: ${FAILED_ONCHAIN_MESSAGE} (lock ${settled.state})`);
			}
			if (event.payload.trackStatus) {
				await step.do('record failed mint', config, async () => {
					await recordMintPhase(this.env, event, 'failed', submitted.hash);
				});
			}
			throw new NonRetryableError(FAILED_ONCHAIN_MESSAGE);
		}
		// In-flight legacy runs may already have checkpointed a raw return-value string.
		const confirmed = typeof receipt === 'string' ? { returnValue: receipt } : receipt;
		// The mint is final on chain: its prefixes can never be claimed by another workflow.
		await step.do('settle mint locks', config, async () => {
			await resolveMintPrefixes(this.env, event.instanceId, mintLockIds(event.payload), 'minted');
		});
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
				await purgeMintCaches(this.env, [id], [artistSmolsCacheTag(ownerSub), `smol:${id}:anonymous`]);
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

	/**
	 * The only use of `env.SK`. Refuses (non-retryably) while the kill switch is closed or when the
	 * carrier is not exactly the mint the server would have built from current D1 facts; otherwise
	 * signs the single issuer auth entry and verifies the signed output.
	 *
	 * A full restart of an instance re-enters here under the same owner. Fresh signing is allowed only
	 * while the batch's tracked phase is absent, before submit, or a definite `failed`. A `submitting`,
	 * `submitted`, `confirmed` or `persisted` row is refused right after the kill switch (whose own
	 * guarded refusal never touches such a row), before validation, any lock claim or any signature. A
	 * `submitting` row this workflow wrote for a never-dispatched attempt is indistinguishable from a
	 * pre-v7 one, so it is refused too and left for reconciliation. The same refusal applies when ANY
	 * workflow's unresolved receipt (`submitting`/`submitted`/`confirmed`, e.g. a pre-v7 one with no v7
	 * lock) covers one of this batch's songs or 12-hex prefixes, or such a receipt is unreadable
	 * (`assertNoUnresolvedMintReceipt`). If the owner's dispatch may already
	 * have started, every other path refuses without signing as well: the authoritative claim reports
	 * `dispatch_uncertain`, and any earlier refusal is concluded by the lock store, which retains the
	 * claim as ambiguous instead of recording `failed`.
	 */
	async signTransaction(event: WorkflowEvent<WorkflowTxParams>): Promise<string> {
		// Recording a refusal is best effort and can never make it retryable. No submit intent has run for
		// this attempt yet (no `preSubmit`), so an existing `submitting` row is never downgraded from here.
		const refuse = (message: string) => concludeMintRefusal(this.env, event, message);
		if (this.env.MINT_SIGNING_ENABLED !== 'true') throw await refuse('Mint signing is paused');

		// A fresh signature may never replace an earlier attempt whose receipt is unresolved
		// (`submitting`/`submitted`, e.g. a pre-v7 execution that relayed before the lock store existed)
		// or final (`confirmed`/`persisted`). Refused before validation, any lock claim, any signature
		// or any D1 write, so the phase and `Tx_Hash` stay intact for reconciliation. The only lock
		// change is retaining this workflow's own started dispatch (`dispatched` -> `ambiguous`); nothing
		// is claimed or released.
		const priorPhase = await readMintBatchPhase(this.env, event);
		if (priorPhase !== null && RECEIPT_PHASES.has(priorPhase)) {
			await resolveMintPrefixes(this.env, event.instanceId, mintLockIds(event.payload), 'ambiguous');
			console.warn(JSON.stringify({ event: 'mint_resign_refused', workflow_id: event.instanceId, phase: priorPhase }));
			throw new NonRetryableError(priorPhase === 'submitting' || priorPhase === 'submitted'
				? `${DISPATCH_UNCERTAIN_MESSAGE}: batch already ${priorPhase}, refusing to sign a replacement`
				: `Mint batch already ${priorPhase}, refusing to sign a replacement`);
		}

		// Nor may it race any workflow's unresolved receipt (`submitting`/`submitted`/`confirmed`) that
		// covers one of its songs or 12-hex prefixes: a pre-v7 receipt holds no v7 prefix lock, and its
		// songs' `Smols` mint columns stay NULL until it is reconciled. Same refusal shape as above:
		// before validation, any lock claim, any signature or any D1 write. An unreadable receipt fails
		// closed. A D1 fault stays retryable (nothing has been claimed or signed).
		try {
			await assertNoUnresolvedMintReceipt(this.env, mintLockIds(event.payload));
		} catch (error) {
			if (!(error instanceof MintIneligible || error instanceof MintReceiptUnreadable)) throw error;
			await resolveMintPrefixes(this.env, event.instanceId, mintLockIds(event.payload), 'ambiguous');
			const detail = error instanceof MintIneligible ? error.code : 'receipt_unreadable';
			console.warn(JSON.stringify({ event: 'mint_sign_receipt_refused', workflow_id: event.instanceId, code: detail }));
			throw new NonRetryableError(`Unresolved mint receipt covers this batch (${detail}, requires reconciliation), refusing to sign`);
		}

		const refuseRejected = async (error: unknown) => {
			if (!(error instanceof MintRejected || error instanceof MintIneligible)) return error;
			console.warn(JSON.stringify({
				event: 'mint_sign_refused',
				code: error.code,
				workflow_id: event.instanceId,
				sub: typeof event.payload.sub === 'string' ? event.payload.sub : null,
			}));
			return await refuse(`Mint authorization rejected: ${error.code}`);
		};

		let validated: ValidatedUnsignedMint;
		try {
			validated = await this.validateMint(event);
		} catch (error) {
			throw await refuseRejected(error);
		}

		let keypair: Keypair;
		try {
			keypair = Keypair.fromSecret(this.env.SK);
		} catch {
			throw await refuse('Mint signer key is invalid');
		}
		if (keypair.publicKey() !== validated.identity.issuer) {
			throw await refuse('Mint signer key does not match the SMOL issuer');
		}

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
		// The wallet's own authorization must still be usable, or the relay would spend fees on a failure.
		if (validated.userExpirationLedger <= sequence) throw await refuse('Mint user authorization has expired');

		// The authoritative claim, last before signing: only the owning workflow of every prefix (and
		// smol id) may sign while its outcome is unresolved. It moves the claims to `signing`, which no
		// release ever undoes. An owner whose dispatch may have started (a full restart) is refused
		// here, and the same transaction retains its claim as ambiguous.
		try {
			await reserveMintPrefixes(this.env, event.instanceId, validated.ids, 'signing');
		} catch (error) {
			if (error instanceof MintIneligible && error.code === 'dispatch_uncertain') {
				console.warn(JSON.stringify({ event: 'mint_resign_refused', workflow_id: event.instanceId }));
				throw new NonRetryableError(`${DISPATCH_UNCERTAIN_MESSAGE}: refusing to sign again`);
			}
			throw await refuseRejected(error);
		}

		try {
			return await signValidatedMint(validated, keypair, expiration, validated.identity.networkPassphrase);
		} catch (error) {
			if (error instanceof MintRejected) throw await refuse(`Mint signature rejected: ${error.code}`);
			throw error;
		}
	}

	/** The pinned mainnet identity; the Worker's configured factory and passphrase must match it. */
	protected mintIdentity(): MintIdentity {
		return assertMintConfig(this.env);
	}

	/** Re-reads D1 and rebuilds the expectation immediately before signing. */
	private async validateMint(event: WorkflowEvent<WorkflowTxParams>): Promise<ValidatedUnsignedMint> {
		const { payload } = event;
		if (payload.type !== 'mint' && payload.type !== 'batch-mint') throw new MintRejected('function_mismatch');
		const identity = this.mintIdentity();
		const kind = mintKindForRoute(payload.type);
		const carrier = decodeMintCarrier(payload.xdr, kind, identity);
		const requested = payload.type === 'mint' ? [payload.entropy] : payload.mintableIds ?? payload.ids ?? [];
		if (requested.length !== carrier.ids.length || !carrier.ids.every((id) => requested.includes(id))) {
			throw new MintRejected('ids_mismatch');
		}
		const tracks = assertMintEligible(carrier.ids, await readMintFacts(this.env, carrier.ids));
		const expectation = buildMintExpectation({ identity, kind, sub: payload.sub, tracks });
		return assertUnsignedMintEnvelope(carrier, expectation);
	}
}
