/**
 * Pagination utilities for cursor-based pagination
 * Uses Created_At timestamp + Id for stable, unique ordering
 */

export interface PaginationParams {
	limit: number
	cursor?: string
}

export interface CursorData {
	createdAt: string
	id: string
}

export interface PaginationResponse {
	nextCursor: string | null
	hasMore: boolean
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

/**
 * Parse and validate pagination query parameters
 */
export function parsePaginationParams(url: URL): PaginationParams {
	const limitParam = url.searchParams.get('limit')
	const cursor = url.searchParams.get('cursor') || undefined

	let limit = DEFAULT_LIMIT
	if (limitParam) {
		const parsed = parseInt(limitParam, 10)
		if (!isNaN(parsed) && parsed > 0) {
			limit = Math.min(parsed, MAX_LIMIT)
		}
	}

	return { limit, cursor }
}

/**
 * Encode cursor data to base64 string
 */
export function encodeCursor(createdAt: string, id: string): string {
	const data: CursorData = { createdAt, id }
	return btoa(JSON.stringify(data))
}

/**
 * Decode cursor string to cursor data
 * Returns null if cursor is invalid
 */
export function decodeCursor(cursor: string): CursorData | null {
	try {
		const decoded = atob(cursor)
		const data = JSON.parse(decoded) as CursorData
		if (data.createdAt && data.id) {
			return data
		}
		return null
	} catch {
		return null
	}
}

/**
 * Build pagination response metadata
 * @param results - Query results
 * @param limit - Requested limit
 * @param getCreatedAt - Function to extract Created_At from result
 * @param getId - Function to extract Id from result
 */
export function buildPaginationResponse<T>(
	results: T[],
	limit: number,
	getCreatedAt: (item: T) => string,
	getId: (item: T) => string
): PaginationResponse {
	const hasMore = results.length === limit
	let nextCursor: string | null = null

	if (hasMore && results.length > 0) {
		const lastItem = results[results.length - 1]
		nextCursor = encodeCursor(getCreatedAt(lastItem), getId(lastItem))
	}

	return {
		nextCursor,
		hasMore,
	}
}

/**
 * Build WHERE clause conditions for cursor-based pagination
 * Returns array of [sql, ...bindings]
 * @param cursor - The cursor string from the previous page
 * @param additionalConditions - Additional WHERE conditions to append
 * @param tablePrefix - Table prefix for Created_At and Id columns (e.g., 's.' for Smols table alias)
 */
export function buildCursorWhereClause(
	cursor: string | undefined,
	additionalConditions?: string,
	tablePrefix: string = ''
): [string, string, string, string] | [string] {
	if (!cursor) {
		if (additionalConditions) {
			return [additionalConditions]
		}
		return ['1=1'] // No conditions
	}

	const cursorData = decodeCursor(cursor)
	if (!cursorData) {
		// Invalid cursor, ignore it
		if (additionalConditions) {
			return [additionalConditions]
		}
		return ['1=1']
	}

	// Build cursor condition: (Created_At < ? OR (Created_At = ? AND Id < ?))
	// This works with DESC ordering to get items older than the cursor
	const cursorCondition = `(${tablePrefix}Created_At < ? OR (${tablePrefix}Created_At = ? AND ${tablePrefix}Id < ?))`

	if (additionalConditions) {
		return [
			`${additionalConditions} AND ${cursorCondition}`,
			cursorData.createdAt,
			cursorData.createdAt,
			cursorData.id,
		]
	}

	return [cursorCondition, cursorData.createdAt, cursorData.createdAt, cursorData.id]
}
