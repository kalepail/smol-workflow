import { HTTPException } from 'hono/http-exception'
import { deriveDecisions, parseStoredSmolIds, type MixtapeVisibilityRow } from '../api/mixtapes'

export const MAX_TARGET_TRACKS = 100
export type TrackTarget = { mixtapeId: string; revision?: string } | { trackIds: string[] }

export type ChainTrackRow = {
	Id: string
	Mint_Token: string | null
	Mint_Amm: string | null
}

export type MintPhase = 'queued' | 'submitting' | 'submitted' | 'confirmed' | 'persisted' | 'failed'
export type MintBatchRow = {
	workflowId: string
	ids: string[]
	phase: MintPhase
	txHash: string | null
	confirmedLedger: number | null
}

export function parseIdList(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id || id.length > 128)) {
		throw new HTTPException(400, { message: `Invalid ${name}` })
	}
	const ids = [...new Set<string>(value)]
	if (ids.length > MAX_TARGET_TRACKS) throw new HTTPException(400, { message: `Max ${MAX_TARGET_TRACKS} distinct ${name}` })
	return ids
}

export function parseTrackTarget(value: unknown): TrackTarget {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new HTTPException(400, { message: 'Invalid target' })
	}
	if ('mixtapeId' in value && !('trackIds' in value)) {
		if (typeof value.mixtapeId !== 'string' || !value.mixtapeId || value.mixtapeId.length > 128) {
			throw new HTTPException(400, { message: 'Invalid mixtape ID' })
		}
		const revision = 'revision' in value ? value.revision : undefined
		if (revision !== undefined && (typeof revision !== 'string' || !/^[1-9][0-9]{0,15}$/.test(revision))) {
			throw new HTTPException(400, { message: 'Invalid mixtape revision' })
		}
		return { mixtapeId: value.mixtapeId, revision }
	}
	if ('trackIds' in value && !('mixtapeId' in value)) {
		const trackIds = parseIdList(value.trackIds, 'track IDs')
		if (trackIds.length) return { trackIds }
	}
	throw new HTTPException(400, { message: 'Invalid target' })
}

const BATCHES_SQL = `
	SELECT json_group_array(json_object(
		'workflowId', b.Workflow_Id, 'ids', json(b.Ids), 'phase', b.Phase,
		'txHash', b.Tx_Hash, 'confirmedLedger', b.Confirmed_Ledger
	))
	FROM json_each(?1) requested
	CROSS JOIN MintBatchStatus b ON b.Workflow_Id = requested.value
	WHERE b."Address" = ?2
`
const TRACK_ROW_SQL = `json_object('Id', s.Id, 'Mint_Token', s.Mint_Token, 'Mint_Amm', s.Mint_Amm)`

type TargetRecord = {
	Tracks: string
	Batches: string
	Cohort?: string
	PublicIds?: string
	Requested?: string
}

export async function readChainTarget(env: Env, target: TrackTarget | undefined, sub?: string, workflowIds: string[] = []) {
	const mix = target && 'mixtapeId' in target ? target : undefined
	const ids = target && 'trackIds' in target ? target.trackIds : []
	// Keep poll reads in one D1 snapshot. The batches CTE is keyed by caller-provided
	// workflow IDs and the verified submitter. Neither target variant needs a KV lookup.
	const query = mix ? `
		WITH target AS (
			SELECT Id, "Address" FROM Mixtapes
			WHERE Id = ?3 AND Deleted_At IS NULL AND Visibility != 'deleted'
				AND (Visibility = 'public' OR "Address" = ?2)
		), cohort AS MATERIALIZED (
			SELECT m.* FROM target t CROSS JOIN Mixtapes m ON m."Address" = t."Address"
			WHERE m.Deleted_At IS NULL AND m.Visibility != 'deleted'
				AND (t."Address" IS NOT ?2 OR m.Id = t.Id)
		)
		SELECT
			(SELECT json_group_array(json_object('Id', Id, 'Address', "Address", 'Title', Title,
				'Desc', Desc, 'Smols', Smols, 'Created_At', Created_At, 'Ai_Verdict', Ai_Verdict,
				'Visibility', Visibility, 'Revision', Revision)) FROM cohort) AS Cohort,
			(SELECT json_group_array(DISTINCT s.Id)
				FROM cohort c CROSS JOIN MixtapeMember m ON m.mix_id = c.Id
				CROSS JOIN Smols s ON s.Id = m.smol_id WHERE +s.Public = 1) AS PublicIds,
			(SELECT json_group_array(${TRACK_ROW_SQL})
				FROM target t CROSS JOIN MixtapeMember m ON m.mix_id = t.Id
				CROSS JOIN Smols s ON s.Id = m.smol_id WHERE +s.Public = 1) AS Tracks,
			(${BATCHES_SQL}) AS Batches
	` : `
		WITH batches(body) AS MATERIALIZED (${BATCHES_SQL}), requested AS (
			SELECT value AS Id, key AS pos FROM json_each(?3)
			UNION ALL
			SELECT j.value, 100 + b.key * 100 + j.key
			FROM batches, json_each(batches.body) b, json_each(b.value, '$.ids') j WHERE ?4 = 1
		), ordered AS (
			SELECT Id FROM requested GROUP BY Id ORDER BY min(pos) LIMIT 101
		)
		SELECT (SELECT json_group_array(${TRACK_ROW_SQL}) FROM ordered r
			CROSS JOIN Smols s ON s.Id = r.Id WHERE +s.Public = 1 OR s."Address" = ?2) AS Tracks,
			(SELECT * FROM batches) AS Batches,
			(SELECT json_group_array(Id) FROM ordered) AS Requested
	`
	const params = [JSON.stringify(workflowIds), sub ?? null, mix?.mixtapeId ?? JSON.stringify(ids)]
	const row = await env.SMOL_D1.prepare(query)
		.bind(...(mix ? params : [...params, target ? 0 : 1]))
		.first<TargetRecord>()
	if (!row) throw new Error('Missing target lookup result')

	const tracksById = new Map((JSON.parse(row.Tracks) as ChainTrackRow[]).map((track) => [track.Id, track]))
	const batches = JSON.parse(row.Batches) as MintBatchRow[]
	let ordered: string[]
	let revision: string
	if (mix) {
		const cohort = JSON.parse(row.Cohort!) as MixtapeVisibilityRow[]
		const mixtape = cohort.find(({ Id }) => Id === mix.mixtapeId)
		if (!mixtape) throw new HTTPException(404, { message: 'Mixtape not found' })
		if (mixtape.Address !== sub) {
			const publicIds = JSON.parse(row.PublicIds!) as string[]
			const { decisions } = await deriveDecisions(cohort, new Set(publicIds))
			if (mixtape.Visibility !== 'public' || decisions.get(mixtape.Id)?.visibility !== 'public') {
				throw new HTTPException(404, { message: 'Mixtape not found' })
			}
		}
		revision = String(mixtape.Revision)
		if (mix.revision !== undefined && revision !== mix.revision) {
			throw new HTTPException(409, { message: 'Mixtape revision changed' })
		}
		ordered = parseStoredSmolIds(mixtape.Smols)
	} else {
		ordered = target ? ids : JSON.parse(row.Requested!)
		revision = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ordered)))).toString('hex')
	}
	if (ordered.length > MAX_TARGET_TRACKS) throw new HTTPException(400, { message: 'Max 100 distinct tracks per target' })

	return {
		revision,
		tracks: ordered.flatMap((id) => {
			const track = tracksById.get(id)
			return track ? [track] : []
		}),
		incompleteMembership: ordered.some((id) => !tracksById.has(id)),
		batches,
	}
}
