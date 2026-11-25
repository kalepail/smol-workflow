export const ALLOWED_CORS_ORIGINS = new Set([
	'https://smol.xyz',
	'https://noot.smol.xyz',
])

const DEV_CORS_ORIGINS = new Set([
	'http://localhost:3000',
	'http://localhost:5173',
	'http://127.0.0.1:3000',
	'http://127.0.0.1:5173',
])

export function allowedCorsOrigin(origin: string, allowLocalhost = false): string | null {
	if (ALLOWED_CORS_ORIGINS.has(origin)) return origin
	if (allowLocalhost && DEV_CORS_ORIGINS.has(origin)) return origin
	return null
}
