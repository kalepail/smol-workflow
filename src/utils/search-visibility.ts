import { HTTPException } from 'hono/http-exception'
import { hideSmolFromSearch, queueSearchIndexingById } from './search'

type UpdatedVisibilityRow = {
	Public: number
}

export function requireOwnedVisibilityToggle(updated: UpdatedVisibilityRow | null): UpdatedVisibilityRow {
	if (!updated) {
		throw new HTTPException(404, { message: 'Smol not found' })
	}

	return updated
}

export async function syncSearchVisibilityAfterToggle(
	env: Env,
	smolId: string,
	updated: UpdatedVisibilityRow
): Promise<void> {
	if (updated.Public === 1) {
		await queueSearchIndexingById(env, smolId)
		return
	}

	await hideSmolFromSearch(env, smolId)
}
