import { isWorkflowNotFoundError } from './workflow-errors'

const PRUNE_BATCH_SIZE = 25
const TERMINAL_PHASES = `('persisted', 'failed')`

/**
 * Hourly pruning of terminal (`persisted` / `failed`) `MintBatchStatus` rows older than 30 days.
 * The table has no timestamp, so age comes from the TxWorkflow instance: `TX_WORKFLOW` retains
 * finished instances for 30 days (`default_retention` in wrangler.jsonc), so a definitive
 * `instance.not_found` for a terminal row means it finished at least that long ago. Any other
 * lookup error keeps the row. Unresolved phases, mint prefix locks and SmolDurableObject receipts
 * are never touched. Oldest rows (insertion order) are checked first, a bounded batch per run.
 */
export async function pruneExpiredMintBatchStatus(env: Env): Promise<number> {
	const { results } = await env.SMOL_D1.prepare(`
		SELECT Workflow_Id FROM MintBatchStatus WHERE Phase IN ${TERMINAL_PHASES} ORDER BY rowid LIMIT ?1
	`).bind(PRUNE_BATCH_SIZE).all<{ Workflow_Id: string }>()

	const expired: string[] = []
	for (const { Workflow_Id: workflowId } of results ?? []) {
		try {
			await (await env.TX_WORKFLOW.get(workflowId)).status()
		} catch (error) {
			if (isWorkflowNotFoundError(error)) expired.push(workflowId)
		}
	}
	if (!expired.length) return 0

	const placeholders = expired.map((_, index) => `?${index + 1}`).join(', ')
	const deleted = await env.SMOL_D1.prepare(`
		DELETE FROM MintBatchStatus WHERE Workflow_Id IN (${placeholders}) AND Phase IN ${TERMINAL_PHASES}
	`).bind(...expired).run()
	const count = deleted.meta?.changes ?? 0
	console.log(JSON.stringify({ event: 'mint_status_pruned', count }))
	return count
}
