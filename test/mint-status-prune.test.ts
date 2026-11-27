import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createSqliteD1 } from './helpers/harness'
import { pruneExpiredMintBatchStatus } from '../src/utils/mint-status-prune'

test('hourly prune deletes only terminal MintBatchStatus rows whose TxWorkflow instance has expired', async (t) => {
	t.mock.method(console, 'log', () => {})
	const db = new DatabaseSync(':memory:')
	db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'))
	const rows: Array<[string, string]> = [
		['persisted-expired', 'persisted'],
		['failed-expired', 'failed'],
		['persisted-retained', 'persisted'],
		['failed-lookup-error', 'failed'],
		['submitted-expired', 'submitted'],
		['queued-expired', 'queued'],
	]
	for (const [id, phase] of rows) {
		db.prepare('INSERT INTO MintBatchStatus (Workflow_Id, "Address", Ids, Phase) VALUES (?, ?, ?, ?)').run(id, 'GWALLET', '[]', phase)
	}
	const lookups: string[] = []
	const env = {
		SMOL_D1: createSqliteD1(db).d1,
		TX_WORKFLOW: {
			get: async (id: string) => {
				lookups.push(id)
				if (id.endsWith('-expired')) throw new Error('instance.not_found')
				if (id === 'failed-lookup-error') throw new Error('Workflows API unavailable')
				return { status: async () => ({ status: 'complete' }) }
			},
		},
	} as unknown as Env

	assert.equal(await pruneExpiredMintBatchStatus(env), 2)
	assert.deepEqual(lookups, ['persisted-expired', 'failed-expired', 'persisted-retained', 'failed-lookup-error'], 'only terminal rows are looked up')
	const left = db.prepare('SELECT Workflow_Id FROM MintBatchStatus ORDER BY rowid').all().map((row) => (row as { Workflow_Id: string }).Workflow_Id)
	assert.deepEqual(left, ['persisted-retained', 'failed-lookup-error', 'submitted-expired', 'queued-expired'])
	db.close()
})
