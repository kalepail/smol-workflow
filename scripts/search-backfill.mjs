#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function parseArgs(argv) {
	const options = {
		baseUrl: process.env.SMOL_API_URL ?? 'https://api.smol.xyz',
		adminSecret: process.env.SMOL_ADMIN_SECRET ?? '',
		indexName: process.env.SMOL_SEARCH_INDEX_NAME ?? 'smol-search-index',
		pageLimit: 20,
		maxWaves: Infinity,
		pollIntervalSeconds: 30,
		maxStallPolls: 20,
		cursor: undefined,
		stateFile: path.join(process.cwd(), '.wrangler', 'tmp', 'search-backfill-state.json'),
		force: false,
		resumeFromState: false,
		help: false,
	}

	for (const arg of argv) {
		if (arg === '--help' || arg === '-h') {
			options.help = true
			continue
		}

		if (arg === '--force') {
			options.force = true
			continue
		}

		if (arg === '--resume-from-state') {
			options.resumeFromState = true
			continue
		}

		const [rawKey, rawValue] = arg.split('=', 2)
		const value = rawValue ?? ''

		switch (rawKey) {
			case '--base-url':
				options.baseUrl = value || options.baseUrl
				break
			case '--admin-secret':
				options.adminSecret = value
				break
			case '--index':
				options.indexName = value || options.indexName
				break
			case '--page-limit':
				options.pageLimit = Number(value)
				break
			case '--max-waves':
				options.maxWaves = Number(value)
				break
			case '--poll-interval':
				options.pollIntervalSeconds = Number(value)
				break
			case '--max-stall-polls':
				options.maxStallPolls = Number(value)
				break
			case '--cursor':
				options.cursor = value || undefined
				break
			case '--state-file':
				options.stateFile = value || options.stateFile
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}

	return options
}

function printHelp() {
	console.log(`Usage:
  SMOL_ADMIN_SECRET=... npm run backfill:search -- [options]

Options:
  --base-url=https://api.smol.xyz
  --admin-secret=VALUE
  --index=smol-search-index
  --page-limit=20
  --max-waves=10
  --poll-interval=30
  --max-stall-polls=20
  --cursor=CURSOR
  --state-file=.wrangler/tmp/search-backfill-state.json
  --force
  --resume-from-state
  --help
`)
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractLastJsonObject(value) {
	const trimmed = value.trim()
	const start = trimmed.lastIndexOf('{')
	if (start < 0) {
		throw new Error(`Unable to find JSON in output: ${trimmed}`)
	}

	return JSON.parse(trimmed.slice(start))
}

async function getVectorizeInfo(indexName) {
	const { stdout, stderr } = await execFileAsync('npx', ['wrangler', 'vectorize', 'info', indexName, '--json'], {
		cwd: process.cwd(),
		env: process.env,
	})

	const output = stdout.trim() || stderr.trim()
	if (!output) {
		throw new Error('Wrangler returned no Vectorize info output')
	}

	return extractLastJsonObject(output)
}

async function fetchAdminJson(baseUrl, adminSecret, path, params = {}) {
	const url = new URL(path, baseUrl)
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === '') {
			continue
		}
		url.searchParams.set(key, String(value))
	}

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'x-admin-secret': adminSecret,
		},
	})

	if (!response.ok) {
		throw new Error(`Admin request failed (${response.status} ${response.statusText}) for ${url}`)
	}

	return await response.json()
}

async function writeState(stateFile, payload) {
	await mkdir(path.dirname(stateFile), { recursive: true })
	await writeFile(stateFile, `${JSON.stringify({
		updatedAt: new Date().toISOString(),
		...payload,
	}, null, 2)}\n`)
}

async function readState(stateFile) {
	try {
		const value = await readFile(stateFile, 'utf8')
		return JSON.parse(value)
	} catch {
		return null
	}
}

function formatInfo(info) {
	return [
		`vectorCount=${info.vectorCount}`,
		`processedUpToMutation=${info.processedUpToMutation ?? 'n/a'}`,
		`processedUpToDatetime=${info.processedUpToDatetime ?? 'n/a'}`,
	].join(' ')
}

async function waitForWave(options, wave) {
	const startedAt = Date.now()
	let stallPolls = 0
	let lastMutation = wave.before.processedUpToMutation
	let lastVectorCount = wave.before.vectorCount ?? 0
	let lastPending = wave.backfill.skipped.pending ?? 0

	while (true) {
		await sleep(options.pollIntervalSeconds * 1000)

		const info = await getVectorizeInfo(options.indexName)
		const reconcile = await fetchAdminJson(options.baseUrl, options.adminSecret, '/search/admin/reconcile', {
			limit: options.pageLimit,
			cursor: wave.cursor,
		})

		const pending = reconcile.skipped?.pending ?? 0
		const advanced = info.processedUpToMutation !== lastMutation || (info.vectorCount ?? 0) > lastVectorCount
		const pendingImproved = pending < lastPending
		const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)

		await writeState(options.stateFile, {
			status: 'waiting',
			wave: wave.wave,
			cursor: wave.cursor,
			nextCursor: wave.nextCursor,
			elapsedSeconds,
			pending,
			lastInfo: info,
			lastReconcile: reconcile,
		})

		console.log(
			`poll wave=${wave.wave} elapsed=${elapsedSeconds}s pending=${pending} ready=${reconcile.ready} requeued=${reconcile.requeued} ${formatInfo(info)}`
		)

		if (pending === 0) {
			return { status: 'cleared', info, reconcile }
		}

		if (advanced || pendingImproved) {
			stallPolls = 0
			lastMutation = info.processedUpToMutation
			lastVectorCount = info.vectorCount ?? lastVectorCount
			lastPending = pending
			continue
		}

		stallPolls += 1
		if (stallPolls >= options.maxStallPolls) {
			return { status: 'stalled', info, reconcile }
		}
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	if (options.help) {
		printHelp()
		return
	}

	if (!options.adminSecret) {
		throw new Error('Missing admin secret. Set SMOL_ADMIN_SECRET or pass --admin-secret=...')
	}

	if (!Number.isFinite(options.pageLimit) || options.pageLimit < 1) {
		throw new Error(`Invalid --page-limit value: ${options.pageLimit}`)
	}

	if (!Number.isFinite(options.maxWaves) || options.maxWaves < 1) {
		throw new Error(`Invalid --max-waves value: ${options.maxWaves}`)
	}

	if (!Number.isFinite(options.pollIntervalSeconds) || options.pollIntervalSeconds < 1) {
		throw new Error(`Invalid --poll-interval value: ${options.pollIntervalSeconds}`)
	}

	if (!Number.isFinite(options.maxStallPolls) || options.maxStallPolls < 1) {
		throw new Error(`Invalid --max-stall-polls value: ${options.maxStallPolls}`)
	}

	let cursor = options.cursor
	if (!cursor && options.resumeFromState) {
		const savedState = await readState(options.stateFile)
		cursor = savedState?.resumeCursor ?? savedState?.cursor ?? savedState?.nextCursor ?? undefined
		if (cursor) {
			console.log(`resuming from state file cursor=${cursor}`)
		}
	}

	for (let wave = 1; wave <= options.maxWaves; wave += 1) {
		const before = await getVectorizeInfo(options.indexName)
		const backfill = await fetchAdminJson(options.baseUrl, options.adminSecret, '/search/admin/backfill', {
			limit: options.pageLimit,
			cursor,
			force: options.force ? 'true' : undefined,
		})

		console.log(
			`wave=${wave} queued=${backfill.queued} skipped=${JSON.stringify(backfill.skipped)} hasMore=${backfill.pagination?.hasMore} ${formatInfo(before)}`
		)

		const waveCursor = cursor
		cursor = backfill.pagination?.nextCursor
		await writeState(options.stateFile, {
			status: 'wave-started',
			wave,
			cursor: waveCursor,
			nextCursor: cursor,
			lastInfo: before,
			lastBackfill: backfill,
			resumeCursor: waveCursor ?? cursor,
		})

		const shouldWait = backfill.queued > 0 || (backfill.queued === 0 && (backfill.skipped?.pending ?? 0) > 0)
		if (shouldWait) {
			const outcome = await waitForWave(options, {
				wave,
				cursor: waveCursor,
				nextCursor: cursor,
				before,
				backfill,
			})

			if (outcome.status === 'stalled') {
				await writeState(options.stateFile, {
					status: 'stalled',
					wave,
					cursor: waveCursor,
					nextCursor: cursor,
					resumeCursor: waveCursor ?? cursor,
					lastInfo: outcome.info,
					lastReconcile: outcome.reconcile,
				})
				console.error(`stall detected after wave ${wave}. resume with --cursor=${waveCursor ?? ''}`)
				process.exitCode = 2
				return
			}
		}

		if (!backfill.pagination?.hasMore) {
			await writeState(options.stateFile, {
				status: 'complete',
				wave,
				cursor: waveCursor,
				nextCursor: cursor,
				resumeCursor: cursor,
			})
			console.log('backfill complete for the current cursor range')
			return
		}
	}

	await writeState(options.stateFile, {
		status: 'max-waves-reached',
		nextCursor: cursor,
		resumeCursor: cursor,
	})
	console.log(`stopped after max waves. resume with --cursor=${cursor ?? ''}`)
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
