/**
 * Strict matcher for recognized Cloudflare Workflows instance-specific absence errors.
 * Matches ONLY exact Workflows error codes, error class names, or narrowly anchored binding
 * formats — NEVER loose substring pairs like "Instance lookup failed: upstream route not found"
 * or generic HTTP 404/not-found text — so indeterminate errors preserve quota and return 503.
 */
export function isWorkflowNotFoundError(error: unknown): boolean {
	const name = error instanceof Error ? error.name.trim() : ''
	const message = error instanceof Error ? error.message.trim() : String(error).trim()
	const code = typeof (error as { code?: unknown })?.code === 'string'
		? (error as { code: string }).code.trim()
		: ''

	const normalizedCode = code.toLowerCase()
	if (normalizedCode === 'instance.not_found' || normalizedCode === 'workflow.instance_not_found') {
		return true
	}
	if (/^(?:Workflow|Instance|WorkflowInstance)NotFound(?:Error)?$/.test(name)) {
		return true
	}
	return (
		/(?:^|[\s:(])(?:instance\.not_found|workflow\.instance_not_found)(?:$|[\s:),])/i.test(message)
		|| /^(?:error:\s*)?(?:workflow\s+)?instance\s+(?:not\s+found|does\s+not\s+exist)(?:\s*[:.]|$)/i.test(message)
		|| /^(?:error:\s*)?(?:workflow\s+)?instance\s+(?:with\s+(?:the\s+)?id\s+["'`]?[A-Za-z0-9_.:-]+["'`]?|["'`][A-Za-z0-9_.:-]+["'`]|(?=[A-Za-z0-9_.:-]*\d)[A-Za-z0-9_.:-]+)\s+(?:not\s+found|does\s+not\s+exist)(?:\s*[:.]|$)/i.test(message)
		|| /^(?:error:\s*)?unknown\s+(?:workflow\s+)?instance(?:\s+(?:["'`][A-Za-z0-9_.:-]+["'`]|(?=[A-Za-z0-9_.:-]*\d)[A-Za-z0-9_.:-]+))?(?:\s*[:.]|$)/i.test(message)
	)
}

/**
 * Strict matcher for recognized Cloudflare Workflows instance-already-exists errors.
 * Matches ONLY exact Workflows error codes, error class names, or narrowly anchored binding
 * formats — NEVER loose substring pairs like "Could not determine whether the instance exists"
 * — so uncertain create errors always reconcile or return 503 instead of silently returning 200.
 */
export function isWorkflowAlreadyExistsError(error: unknown): boolean {
	const name = error instanceof Error ? error.name.trim() : ''
	const message = error instanceof Error ? error.message.trim() : String(error).trim()
	const code = typeof (error as { code?: unknown })?.code === 'string'
		? (error as { code: string }).code.trim()
		: ''

	const normalizedCode = code.toLowerCase()
	if (normalizedCode === 'instance.already_exists' || normalizedCode === 'workflow.instance_already_exists') {
		return true
	}
	if (/^(?:Workflow|Instance|WorkflowInstance)AlreadyExists(?:Error)?$/.test(name)) {
		return true
	}
	return (
		/(?:^|[\s:(])(?:instance\.already_exists|workflow\.instance_already_exists)(?:$|[\s:),])/i.test(message)
		|| /^(?:error:\s*)?(?:a\s+|an\s+)?(?:workflow\s+)?instance\s+already\s+exists(?:\s*[:.]|$)/i.test(message)
		|| /^(?:error:\s*)?(?:a\s+|an\s+)?(?:workflow\s+)?instance\s+(?:with\s+(?:the\s+)?id\s+["'`]?[A-Za-z0-9_.:-]+["'`]?|["'`][A-Za-z0-9_.:-]+["'`]|(?=[A-Za-z0-9_.:-]*\d)[A-Za-z0-9_.:-]+)\s+already\s+exists(?:\s*[:.]|$)/i.test(message)
	)
}
