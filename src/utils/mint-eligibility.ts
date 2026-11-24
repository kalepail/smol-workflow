import { isCanonicalMintId, type MintTrack } from '../chain/mint-authorization'
import type {
	MintAttemptState,
	MintDispatchMarkResult,
	MintPrefixClaimStage,
	MintPrefixConflict,
	MintPrefixOutcome,
	MintPrefixResolution,
} from '../quota-do'
import { isWorkflowNotFoundError } from './workflow-errors'

/** Singleton `UserQuotaDO` that holds the atomic 12-hex asset-code prefix locks. */
export const MINT_PREFIX_LOCK_OBJECT = 'mint-prefix-locks'

/**
 * How long a provisional claim is protected while its admission creates the Workflow instance. Until
 * it expires, no competing admission inspects the owner instance (which may not exist yet) or
 * reclaims the claim. Creation normally takes well under a second.
 */
export const MINT_ADMISSION_LEASE_MS = 120_000

/**
 * 12-hex asset-code prefixes that are minted on mainnet but have no `Smols` row, so neither the D1
 * minted-prefix check nor the (initially empty) prefix lock table can see them. A new id with one of
 * these prefixes would reuse the existing SAC and mint another 10M, so it is refused permanently.
 *
 * Source: `reports/M-wf-0-d1-reconciliation.md` section 4, A1 (the only confirmed on-chain mint
 * whose row is absent, within the Horizon window from ledger 59,341,681):
 * - `c9a369e2aef3`: smol `c9a369e2aef338077c788959598a0c13b78b948514c068b9fdcf73576936b9d4`, `coin_it`,
 *   tx `d003c3668eeffd8b6045f812ce056c86ca0f54ef1209857de62b81e758fdf77d`, ledger 60,461,011
 *   (2025-12-25), SAC `CD3JQFKACS254HK7FAXEDFEO4I7OKAGHIBCN5Q5VM6HFFSHU6UFUVTRT`.
 *
 * Add a prefix here whenever a minted song's row is deleted or a full-history source finds another.
 */
export const HISTORICAL_DELETED_MINT_PREFIXES: ReadonlySet<string> = Object.freeze(new Set([
	'c9a369e2aef3',
]))

const D1_IN_CHUNK_SIZE = 90

export type MintIneligibleCode =
	| 'not_found'
	| 'not_public'
	| 'missing_creator'
	| 'already_minted'
	| 'prefix_minted'
	| 'prefix_reserved'
	| 'mint_in_progress'
	/** This workflow's own dispatch may have started: it may never sign again until reconciled. */
	| 'dispatch_uncertain'

export class MintIneligible extends Error {
	readonly code: MintIneligibleCode
	readonly ids: readonly string[]
	constructor(code: MintIneligibleCode, ids: readonly string[]) {
		super(`Mint not eligible: ${code}`)
		this.name = 'MintIneligible'
		this.code = code
		this.ids = ids
	}
}

export interface MintRow {
	Id: string
	Address: string | null
	Public: number | null
	Mint_Token: string | null
	Mint_Amm: string | null
}

export interface MintFacts {
	rows: Map<string, MintRow>
	/** Every minted smol (requested or not) whose 12-hex asset code matches a requested id, by prefix. */
	mintedByPrefix: Map<string, string[]>
}

function chunks<T>(values: readonly T[]): T[][] {
	const out: T[][] = []
	for (let i = 0; i < values.length; i += D1_IN_CHUNK_SIZE) out.push(values.slice(i, i + D1_IN_CHUNK_SIZE))
	return out
}

/** One read of every fact the mint decision depends on. Used at admission and again before signing. */
export async function readMintFacts(env: Env, ids: readonly string[]): Promise<MintFacts> {
	const rows = new Map<string, MintRow>()
	const mintedByPrefix = new Map<string, string[]>()
	for (const chunk of chunks(ids)) {
		const placeholders = chunk.map(() => '?').join(', ')
		const { results } = await env.SMOL_D1.prepare(
			`SELECT Id, "Address" AS Address, Public, Mint_Token, Mint_Amm FROM Smols WHERE Id IN (${placeholders})`
		).bind(...chunk).all<MintRow>()
		for (const row of results ?? []) rows.set(row.Id, row)

		const prefixes = chunk.map((id) => id.slice(0, 12))
		const { results: minted } = await env.SMOL_D1.prepare(
			`SELECT Id FROM Smols WHERE substr(Id, 1, 12) IN (${placeholders})
				AND (Mint_Token IS NOT NULL OR Mint_Amm IS NOT NULL)`
		).bind(...prefixes).all<{ Id: string }>()
		for (const { Id } of minted ?? []) {
			const holders = mintedByPrefix.get(Id.slice(0, 12)) ?? []
			if (!holders.includes(Id)) holders.push(Id)
			mintedByPrefix.set(Id.slice(0, 12), holders)
		}
	}
	return { rows, mintedByPrefix }
}

/**
 * Unminted means exactly SQL NULL in both columns, the same predicate persistence writes under
 * (`Mint_Token IS NULL AND Mint_Amm IS NULL`). An empty string or a half-populated pair is not
 * unminted, so it is never signed.
 */
export function isMintedRow(row: MintRow): boolean {
	return !(row.Mint_Token === null && row.Mint_Amm === null)
}

/**
 * Existence, visibility and creator, checked before anything about mint status is revealed: a
 * private or creatorless song never discloses whether it is minted. Returns the rows in order.
 */
export function assertMintVisible(ids: readonly string[], facts: MintFacts): MintRow[] {
	const missing = ids.filter((id) => !facts.rows.has(id))
	if (missing.length) throw new MintIneligible('not_found', missing)
	const rows = ids.map((id) => facts.rows.get(id)!)
	const hidden = rows.filter(({ Public }) => Public !== 1).map(({ Id }) => Id)
	if (hidden.length) throw new MintIneligible('not_public', hidden)
	const creatorless = rows.filter(({ Address }) => typeof Address !== 'string' || !Address.trim()).map(({ Id }) => Id)
	if (creatorless.length) throw new MintIneligible('missing_creator', creatorless)
	return rows
}

/**
 * Every requested row must exist, be public, carry a creator, be unminted (strict SQL NULL), and own
 * its asset-code prefix (no other minted smol in D1, no historical deleted mint). Returns the tracks
 * (in the given order) for the expectation builder.
 */
export function assertMintEligible(ids: readonly string[], facts: MintFacts): MintTrack[] {
	const rows = assertMintVisible(ids, facts)
	const minted = rows.filter(isMintedRow).map(({ Id }) => Id)
	if (minted.length) throw new MintIneligible('already_minted', minted)
	const historical = ids.filter((id) => HISTORICAL_DELETED_MINT_PREFIXES.has(id.slice(0, 12)))
	if (historical.length) throw new MintIneligible('prefix_minted', historical)
	const holders = ids.flatMap((id) => (facts.mintedByPrefix.get(id.slice(0, 12)) ?? []).filter((holder) => holder !== id))
	if (holders.length) throw new MintIneligible('prefix_minted', holders)
	return rows.map(({ Id, Address }) => ({ id: Id, creator: Address! }))
}

/**
 * `MintBatchStatus` phases whose transaction may be on its way to the network (`submitting`,
 * `submitted`) or has landed without its metadata reaching `Smols` yet (`confirmed`). Until such a
 * receipt is reconciled, its songs' 12-hex asset codes may already be (or become) minted on-chain
 * while their `Smols` mint columns are still NULL. A pre-v7 receipt also holds no v7 prefix lock, so
 * neither the D1 eligibility read nor the lock store sees it. `failed` and `persisted` are resolved
 * (persisted mints are visible through `Smols`); pre-submit phases never relayed anything.
 */
export const UNRESOLVED_RECEIPT_PHASES = ['submitting', 'submitted', 'confirmed'] as const

/**
 * An unresolved `MintBatchStatus` row whose `Ids` is not a non-empty JSON array of canonical smol
 * ids. Its prefixes cannot be known, so every mint fails closed until the row is reconciled.
 */
export class MintReceiptUnreadable extends Error {
	readonly workflowIds: readonly string[]
	constructor(workflowIds: readonly string[]) {
		super('Unresolved mint receipt is unreadable (requires reconciliation)')
		this.name = 'MintReceiptUnreadable'
		this.workflowIds = workflowIds
	}
}

export interface UnresolvedMintReceipt {
	workflowId: string
	phase: (typeof UNRESOLVED_RECEIPT_PHASES)[number]
	ids: string[]
}

function parseReceiptIds(stored: unknown): string[] | null {
	if (typeof stored !== 'string') return null
	let ids: unknown
	try {
		ids = JSON.parse(stored)
	} catch {
		return null
	}
	return Array.isArray(ids) && ids.length > 0 && ids.every(isCanonicalMintId) ? ids : null
}

/**
 * Every unresolved receipt (any workflow, any wallet), with its smol ids. Reads all of them: a
 * truncated read could silently skip a receipt. Throws `MintReceiptUnreadable` if any row's `Ids`
 * cannot be parsed; a D1 fault propagates (transient).
 */
export async function readUnresolvedMintReceipts(env: Env): Promise<UnresolvedMintReceipt[]> {
	const placeholders = UNRESOLVED_RECEIPT_PHASES.map(() => '?').join(', ')
	const { results } = await env.SMOL_D1.prepare(
		`SELECT Workflow_Id, Phase, Ids FROM MintBatchStatus WHERE Phase IN (${placeholders})`
	).bind(...UNRESOLVED_RECEIPT_PHASES).all<{ Workflow_Id: string; Phase: UnresolvedMintReceipt['phase']; Ids: unknown }>()
	const receipts: UnresolvedMintReceipt[] = []
	const unreadable: string[] = []
	for (const { Workflow_Id, Phase, Ids } of results ?? []) {
		const ids = parseReceiptIds(Ids)
		if (ids) receipts.push({ workflowId: Workflow_Id, phase: Phase, ids })
		else unreadable.push(Workflow_Id)
	}
	if (unreadable.length) throw new MintReceiptUnreadable(unreadable)
	return receipts
}

/**
 * Refuses when an unresolved receipt (see `UNRESOLVED_RECEIPT_PHASES`) covers any requested song or
 * its 12-hex asset-code prefix, whichever workflow (and wallet) wrote it. Throws `MintIneligible`
 * `mint_in_progress` (a requested song is in the receipt) or `prefix_reserved` (only a different song
 * sharing the prefix is), or `MintReceiptUnreadable` (fail closed). Reads D1 only; claims nothing.
 *
 * `exceptWorkflowId` skips that workflow's own receipt (an identical-carrier admission joins its
 * existing workflow, whose signer refuses on its own receipt). The signer passes none.
 */
export async function assertNoUnresolvedMintReceipt(
	env: Env,
	ids: readonly unknown[],
	options: { exceptWorkflowId?: string } = {},
): Promise<void> {
	const requested = ids.filter(isCanonicalMintId)
	if (!requested.length) return
	const receipts = (await readUnresolvedMintReceipts(env)).filter(({ workflowId }) => workflowId !== options.exceptWorkflowId)
	const held = new Set(receipts.flatMap((receipt) => receipt.ids))
	const heldPrefixes = new Set([...held].map((id) => id.slice(0, 12)))
	const inProgress = requested.filter((id) => held.has(id))
	if (inProgress.length) throw new MintIneligible('mint_in_progress', inProgress)
	const reserved = requested.filter((id) => heldPrefixes.has(id.slice(0, 12)))
	if (reserved.length) throw new MintIneligible('prefix_reserved', reserved)
}

function mintLockStub(env: Env) {
	if (!env.USER_QUOTA) throw new Error('Mint prefix lock unavailable')
	return env.USER_QUOTA.get(env.USER_QUOTA.idFromName(MINT_PREFIX_LOCK_OBJECT))
}

function conflictError(conflicts: readonly MintPrefixConflict[]): MintIneligible {
	const of = (reason: MintPrefixConflict['reason']) => conflicts.filter((conflict) => conflict.reason === reason)
	if (of('dispatch_uncertain').length) return new MintIneligible('dispatch_uncertain', of('dispatch_uncertain').map(({ id }) => id))
	if (of('prefix_reserved').length) return new MintIneligible('prefix_reserved', of('prefix_reserved').map(({ id }) => id))
	if (of('minted').length) return new MintIneligible('already_minted', of('minted').map(({ id }) => id))
	return new MintIneligible('mint_in_progress', of('mint_in_progress').map(({ id }) => id))
}

/**
 * A provisional (`reserved`) claim whose owning workflow is terminal (errored or terminated) or was
 * never created has definitely not been signed: signing first moves the claim to `signing`. Only
 * asked after the claim's creation lease has expired, so "not found" cannot mean "still being
 * created by the admission that holds the claim" (a joining admission renews the lease).
 */
async function isTerminalBeforeSigning(env: Env, workflowId: string): Promise<boolean> {
	try {
		const { status } = await (await env.TX_WORKFLOW.get(workflowId)).status()
		return status === 'errored' || status === 'terminated'
	} catch (error) {
		return isWorkflowNotFoundError(error)
	}
}

/** A fresh per-admission token: only the admission that acquired a provisional claim may release it. */
export function newMintClaimToken(): string {
	return crypto.randomUUID()
}

/**
 * A conflict that lease-expiry recovery may inspect: another workflow's provisional (`reserved`) claim,
 * carrying its acquiring token, whose creation lease has run out. For the same song
 * (`mint_in_progress`) the release deletes a never-signed row or returns a once-signed takeover row to
 * `failed`, which this song may then take over. For a different song sharing the 12-hex prefix
 * (`prefix_reserved`) only a never-signed holder qualifies: a once-signed binding is permanent. A
 * signing, dispatched, ambiguous, failed or minted holder, or one inside its lease, never qualifies.
 */
function isExpiredProvisional(conflict: MintPrefixConflict, workflowId: string, now: number): boolean {
	const { reason, status, workflowId: owner, claimToken, leaseUntilMs, leaseVersion, signedAtMs } = conflict
	return (reason === 'mint_in_progress' || (reason === 'prefix_reserved' && signedAtMs === null))
		&& status === 'reserved' && owner !== workflowId && typeof claimToken === 'string'
		&& typeof leaseVersion === 'number' && (leaseUntilMs === null || leaseUntilMs <= now)
}

/**
 * Atomically claims each 12-hex prefix for `workflowId` (see `UserQuotaDO.reserveMintPrefixes`).
 * Throws `MintIneligible` (`prefix_reserved`, `mint_in_progress`, `already_minted`,
 * `dispatch_uncertain`) on a conflict; any other failure is transient.
 *
 * At admission (`claimToken` required), a conflict made only of other workflows' expired provisional
 * claims (see `isExpiredProvisional`) is inspected, and
 * reclaimed, only once every such claim's creation lease has expired and its owner is absent or
 * terminal before signing (definite pre-sign failure). Each release names the STORED holder (its smol
 * id, workflow and exact claim token as observed) and the exact lease observed (its deadline and
 * generation), and the lock store re-checks both atomically. The status check is evidence only about
 * that observed lease: a claim re-acquired, joined or renewed in between (a new lease generation) is
 * never dropped, even if the renewed lease has also expired by the time the release arrives. Such a
 * stale recovery releases nothing and the admission gets 409; a later admission must observe the new
 * lease and the owner's workflow status afresh. While a lease is live the competing admission gets
 * 409 (`mint_in_progress` or `prefix_conflict`).
 */
export async function reserveMintPrefixes(
	env: Env,
	workflowId: string,
	ids: readonly string[],
	stage: MintPrefixClaimStage,
	claimToken?: string,
): Promise<void> {
	const stub = mintLockStub(env)
	const claim = () => stub.reserveMintPrefixes({ workflowId, ids: [...ids], stage, ...(claimToken ? { claimToken } : {}) })
	let result = await claim()
	if (result.ok) return
	const now = Date.now()
	if (stage === 'admission' && result.conflicts.every((conflict) => isExpiredProvisional(conflict, workflowId, now))) {
		// Grouped by the stored holder's workflow and token; the ids are the HOLDERS' smol ids, each with
		// the exact lease (deadline and generation) this observation saw.
		type ObservedLease = { id: string; leaseUntilMs: number | null; leaseVersion: number }
		const claims = new Map<string, { owner: string; token: string; ids: string[]; leases: ObservedLease[] }>()
		for (const { workflowId: owner, claimToken: token, heldBy, leaseUntilMs, leaseVersion } of result.conflicts) {
			const key = `${owner}\n${token}`
			const entry = claims.get(key) ?? { owner, token: token!, ids: [], leases: [] }
			if (!entry.ids.includes(heldBy)) {
				entry.ids.push(heldBy)
				entry.leases.push({ id: heldBy, leaseUntilMs, leaseVersion: leaseVersion! })
			}
			claims.set(key, entry)
		}
		const owners = [...new Set([...claims.values()].map(({ owner }) => owner))]
		const terminal = await Promise.all(owners.map((owner) => isTerminalBeforeSigning(env, owner)))
		if (terminal.every(Boolean)) {
			for (const { owner, token, ids: owned, leases } of claims.values()) {
				await stub.releaseMintPrefixes({
					workflowId: owner, ids: owned, claimToken: token, expiredLeaseOnly: true, observedLeases: leases,
				})
			}
			result = await claim()
			if (result.ok) return
		}
	}
	throw conflictError(result.conflicts)
}

/** True only when the Workflows API definitively reports the instance as not found. */
async function isWorkflowAbsent(env: Env, workflowId: string): Promise<boolean> {
	try {
		await (await env.TX_WORKFLOW.get(workflowId)).status()
		return false
	} catch (error) {
		return isWorkflowNotFoundError(error)
	}
}

/**
 * Admission cleanup after this admission failed (claim row or workflow creation). Drops the
 * provisional claims THIS admission acquired (its exact `claimToken`) only when the workflow is proven
 * absent (`instance.not_found`). The lock store additionally refuses if an identical-carrier admission
 * ever joined the claim, since that joiner may have queued the workflow and answered 202.
 *
 * Anything else retains the claim under its creation lease: the instance exists (a lost or ambiguous
 * creation response, or a joiner created it), or its existence cannot be established. Lease-expiry
 * recovery later reclaims it only after verifying the workflow absent or terminal, so a different
 * carrier can never displace a queued workflow before it signs. A claim this admission merely joined
 * carries another token and is never touched. Returns whether the claims were released; never throws.
 */
export async function releaseMintPrefixesIfAbsent(
	env: Env,
	workflowId: string,
	ids: readonly string[],
	claimToken: string,
): Promise<boolean> {
	try {
		if (!await isWorkflowAbsent(env, workflowId)) {
			console.warn(JSON.stringify({ event: 'mint_lock_retained', workflow_id: workflowId, reason: 'workflow_not_proven_absent' }))
			return false
		}
		const { released } = await mintLockStub(env).releaseMintPrefixes({ workflowId, ids: [...ids], claimToken })
		return released > 0
	} catch (error) {
		console.warn(JSON.stringify({ event: 'mint_lock_release_failed', workflow_id: workflowId, error: String(error).slice(0, 200) }))
		return false
	}
}

function ownedLockIds(ids: readonly unknown[]): string[] | null {
	const owned = ids.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id))
	if (!owned.length || owned.length !== ids.length || new Set(owned.map((id) => id.slice(0, 12))).size !== owned.length) return null
	return owned
}

/**
 * The durable dispatch marker (see `UserQuotaDO.markMintDispatched`). Throws on a lock-store fault;
 * the caller must then treat the dispatch state as unknown and relay nothing.
 */
export async function markMintDispatched(env: Env, workflowId: string, ids: readonly unknown[]): Promise<MintDispatchMarkResult> {
	const owned = ownedLockIds(ids)
	if (!owned) return { ok: false, state: 'not_owned' }
	return await mintLockStub(env).markMintDispatched({ workflowId, ids: owned })
}

/**
 * The lock store's view of this workflow's current signed attempt (`undispatched` = genuinely new:
 * every claim still `signing`). Throws on a lock-store fault so the caller's retryable step retries
 * instead of guessing. Ids this workflow cannot own are never a new attempt (`other`).
 */
export async function readMintAttemptState(env: Env, workflowId: string, ids: readonly unknown[]): Promise<MintAttemptState> {
	const owned = ownedLockIds(ids)
	if (!owned) return 'other'
	return await mintLockStub(env).mintAttemptState({ workflowId, ids: owned })
}

/**
 * Records this workflow's outcome on its claims and returns what the lock store concluded. Throws on a
 * lock-store fault, so a caller inside a retryable Workflow step retries only the settlement (the
 * store is owner-checked and idempotent: a repeat finds the rows already settled).
 */
export async function settleMintPrefixes(
	env: Env,
	workflowId: string,
	ids: readonly unknown[],
	outcome: MintPrefixOutcome,
): Promise<MintPrefixResolution['state']> {
	const owned = ownedLockIds(ids)
	if (!owned) return 'none'
	return (await mintLockStub(env).resolveMintPrefixes({ workflowId, ids: owned, outcome })).state
}

/**
 * Best-effort `settleMintPrefixes`: returns `unknown` if the lock store could not be reached. Never
 * throws: a lock-store fault can never turn a terminal refusal into a retryable one, and never
 * demotes a lock (the store decides atomically).
 */
export async function resolveMintPrefixes(
	env: Env,
	workflowId: string,
	ids: readonly unknown[],
	outcome: MintPrefixOutcome,
): Promise<MintPrefixResolution['state'] | 'unknown'> {
	try {
		return await settleMintPrefixes(env, workflowId, ids, outcome)
	} catch (error) {
		console.warn(JSON.stringify({ event: 'mint_lock_resolve_failed', workflow_id: workflowId, outcome, error: String(error).slice(0, 200) }))
		return 'unknown'
	}
}
