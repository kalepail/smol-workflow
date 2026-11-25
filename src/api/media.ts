import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { Jimp, ResizeStrategy } from 'jimp'
import type { HonoEnv } from '../types'
import { parseByteRange, type ParsedByteRange } from '../utils'
import { getPlayCountMode } from './plays'
import { stripOriginSpecificHeaders } from '../utils/public-cache'

// Separate routers so /song serves only MP3s and /image only PNGs (cross-media GET/HEAD is 404).
export const song = new Hono<HonoEnv>()
export const image = new Hono<HonoEnv>()
export const MEDIA_CACHE_CONTROL = 'public, max-age=2592000, stale-while-revalidate=86400'
const CANONICAL_MEDIA_ORIGIN = 'https://api.smol.xyz'
const MAX_PROBE_BYTES = 2
const MAX_RANGE_WARM_BYTES = 16 * 1024 * 1024
const songCacheWarms = new Map<string, Promise<void>>()

function getEdgeCache(): Cache | undefined {
	if (typeof caches === 'undefined') {
		return undefined
	}
	return (caches as unknown as { default?: Cache }).default
}

function runInBackground(c: Context<HonoEnv>, task: Promise<unknown>): void {
	const safeTask = task.catch(() => {
		console.warn('Media background task failed')
	})
	try {
		c.executionCtx.waitUntil(safeTask)
	} catch {
		void safeTask
	}
}

function normalizeEtag(value: string | null | undefined): string | null {
	if (!value) {
		return null
	}
	const trimmed = value.trim()
	return trimmed || null
}

function matchesIfNoneMatch(header: string | undefined, etag: string | null): boolean {
	if (!header || !etag) {
		return false
	}
	const trimmed = header.trim()
	if (trimmed === '*') {
		return true
	}
	const stripWeak = (tag: string) => tag.trim().replace(/^W\//i, '')
	const target = stripWeak(etag)
	return trimmed.split(',').some((candidate) => stripWeak(candidate) === target)
}

/**
 * RFC 9110 §13.1.5 If-Range validator check.
 * Returns true if Range should be applied, false if full 200 must be returned instead.
 */
function matchesIfRange(
	ifRange: string | undefined,
	etag: string | null,
	lastModified: string | null
): boolean {
	if (!ifRange) {
		return true
	}
	const trimmed = ifRange.trim()
	if (!trimmed) {
		return false
	}

	if (trimmed.startsWith('"') || trimmed.startsWith('W/') || trimmed.startsWith('w/')) {
		if (!etag || trimmed.startsWith('W/') || trimmed.startsWith('w/') || etag.startsWith('W/') || etag.startsWith('w/')) {
			return false
		}
		return trimmed === etag
	}

	if (!lastModified) {
		return false
	}
	if (trimmed === lastModified) {
		return true
	}
	const parsedIfRange = Date.parse(trimmed)
	const parsedLastModified = Date.parse(lastModified)
	return !Number.isNaN(parsedIfRange) && !Number.isNaN(parsedLastModified) && parsedIfRange === parsedLastModified
}

/**
 * Determine whether a song request represents a real play start.
 * Always evaluated against the ORIGINAL Range header so e.g. a `bytes=0-1` probe
 * with a stale `If-Range` (which legitimately returns full 200) still counts zero plays.
 */
export function shouldIncrementSongPlays(
	method: string,
	parsedRange: ParsedByteRange | null,
	objectSize: number
): boolean {
	if (method === 'HEAD' || objectSize <= 0) {
		return false
	}
	if (!parsedRange || parsedRange.kind === 'ignore') {
		return true
	}
	if (parsedRange.kind !== 'range') {
		return false
	}
	if (parsedRange.isSuffix || parsedRange.offset !== 0) {
		return false
	}
	if (!parsedRange.isOpenEnded && parsedRange.length <= MAX_PROBE_BYTES && objectSize > parsedRange.length) {
		return false
	}
	return true
}

/**
 * Stream-slice [offset, offset + length) from a ReadableStream in O(1) memory,
 * cancelling the upstream reader immediately once `length` bytes have been emitted.
 */
function sliceReadableStream(
	source: ReadableStream<Uint8Array>,
	offset: number,
	length: number
): ReadableStream<Uint8Array> {
	const reader = source.getReader()
	let position = 0
	let remaining = length

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				while (remaining > 0) {
					const { done, value } = await reader.read()
					if (done) {
						controller.close()
						return
					}
					if (!value || value.byteLength === 0) {
						continue
					}

					const chunkStart = position
					const chunkEnd = position + value.byteLength
					position = chunkEnd

					if (chunkEnd <= offset) {
						continue
					}

					const sliceStart = Math.max(0, offset - chunkStart)
					const sliceEnd = Math.min(value.byteLength, sliceStart + remaining)
					if (sliceEnd > sliceStart) {
						const out = value.subarray(sliceStart, sliceEnd)
						remaining -= out.byteLength
						controller.enqueue(out)
						if (remaining <= 0) {
							await reader.cancel('Requested byte range satisfied').catch(() => {})
							controller.close()
						}
						return
					}
				}
				await reader.cancel('Requested byte range satisfied').catch(() => {})
				controller.close()
			} catch (err) {
				controller.error(err)
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {})
		},
	})
}

function buildSongHeaders(musicId: string, objectMeta: R2Object): Headers {
	const headers = new Headers()
	objectMeta.writeHttpMetadata(headers)
	headers.set('Accept-Ranges', 'bytes')
	headers.set('Content-Type', 'audio/mpeg')
	headers.set('Cache-Control', MEDIA_CACHE_CONTROL)

	const etag = normalizeEtag(objectMeta.httpEtag)
	if (etag) {
		headers.set('ETag', etag)
	}
	if (objectMeta.uploaded instanceof Date && !Number.isNaN(objectMeta.uploaded.getTime())) {
		headers.set('Last-Modified', objectMeta.uploaded.toUTCString())
	}

	const tags = [`song:${musicId}:media`]
	const smolId = objectMeta.customMetadata?.smolId
	if (smolId) {
		tags.push(`smol:${smolId}:media`)
	}
	headers.set('Cache-Tag', tags.join(','))

	return headers
}

function warmSongCache(env: Env, cache: Cache, cacheKey: Request, id: string, musicId: string): Promise<void> {
	const active = songCacheWarms.get(musicId)
	if (active) return active

	const warm = (async () => {
		const cached = await cache.match(cacheKey)
		if (cached) {
			await cached.body?.cancel()
			return
		}
		const object = await env.SMOL_BUCKET.get(id)
		if (!object) return
		if (object.size > MAX_RANGE_WARM_BYTES) {
			await object.body?.cancel()
			return
		}
		const headers = stripOriginSpecificHeaders(buildSongHeaders(musicId, object))
		headers.set('Content-Length', String(object.size))
		await cache.put(cacheKey, new Response(object.body, { status: 200, headers }))
	})().finally(() => songCacheWarms.delete(musicId))

	songCacheWarms.set(musicId, warm)
	return warm
}

function resolveR2Range(
	object: R2ObjectBody,
	fallback: { offset: number; end: number; length: number },
	size: number
): { offset: number; end: number; length: number } {
	const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined
	if (!range) {
		return fallback
	}
	if (typeof range.offset === 'number' && typeof range.length === 'number' && range.length > 0) {
		const offset = range.offset
		const length = Math.min(range.length, Math.max(0, size - offset))
		if (length > 0) {
			return { offset, end: offset + length - 1, length }
		}
	}
	return fallback
}

function recordSongPlay(c: Context<HonoEnv>, musicId: string): void {
	runInBackground(
		c,
		c.env.SMOL_D1.prepare('UPDATE Smols SET Plays = Plays + 1 WHERE Song_1 = ?1 OR Song_2 = ?1')
			.bind(musicId)
			.run()
	)
}

function notModifiedResponse(baseHeaders: Headers): Response {
	const headers = new Headers()
	for (const key of ['ETag', 'Last-Modified', 'Cache-Control', 'Accept-Ranges', 'Cache-Tag']) {
		const value = baseHeaders.get(key)
		if (value) {
			headers.set(key, value)
		}
	}
	return new Response(null, { status: 304, headers })
}

function unsatisfiableRangeResponse(baseHeaders: Headers, size: number): Response {
	const headers = new Headers(baseHeaders)
	headers.delete('Content-Length')
	headers.set('Cache-Control', 'no-store')
	headers.set('Content-Range', `bytes */${size}`)
	return new Response('Range Not Satisfiable', {
		status: 416,
		headers,
	})
}

// Serve songs (handles both GET and HEAD via Hono method dispatch)
song.get('/:id{.+\\.mp3}', async (c) => {
	const { env, req } = c
	const isHead = req.method === 'HEAD'
	const id = req.param('id')
	const musicId = id.replace(/\.mp3$/, '')
	if (!musicId) {
		throw new HTTPException(404, { message: 'Song not found' })
	}

	const rangeHeader = isHead ? undefined : req.header('range')
	const ifNoneMatch = req.header('if-none-match')
	const ifRange = req.header('if-range')
	const edgeCache = getEdgeCache()
	const canonicalUrl = `${CANONICAL_MEDIA_ORIGIN}/song/${encodeURIComponent(id)}`
	const cacheKey = new Request(canonicalUrl, { method: 'GET' })

	// 1. Check canonical full-GET edge cache first (warm path)
	if (edgeCache) {
		const cached = await edgeCache.match(cacheKey)
		if (cached && cached.status === 200) {
			const contentLengthRaw = cached.headers.get('Content-Length')
			const size = contentLengthRaw !== null && /^\d+$/.test(contentLengthRaw) ? Number(contentLengthRaw) : null
			if (size !== null) {
				const headers = stripOriginSpecificHeaders(cached.headers)
				const etag = normalizeEtag(headers.get('ETag'))
				const lastModified = headers.get('Last-Modified')
				const originalParsedRange = rangeHeader ? parseByteRange(rangeHeader, size) : null

				if (matchesIfNoneMatch(ifNoneMatch, etag)) {
					await cached.body?.cancel().catch(() => {})
					return notModifiedResponse(headers)
				}

				if (isHead) {
					await cached.body?.cancel().catch(() => {})
					headers.set('Content-Length', String(size))
					return new Response(null, { status: 200, headers })
				}

				const effectiveRangeHeader = rangeHeader && matchesIfRange(ifRange, etag, lastModified)
					? rangeHeader
					: undefined

				if (effectiveRangeHeader) {
					const parsed = originalParsedRange ?? parseByteRange(effectiveRangeHeader, size)
					if (parsed.kind === 'unsatisfiable') {
						await cached.body?.cancel().catch(() => {})
						return unsatisfiableRangeResponse(headers, size)
					}
					if (parsed.kind === 'range') {
						// Prefer native Cache API ranged 206 match (zero full-body buffering in workerd),
						// falling back to O(1)-memory stream slicing rather than buffering the full MP3.
						const normalizedRange = `bytes=${parsed.offset}-${parsed.end}`
						let rangeBody: ReadableStream<Uint8Array> | null = null

						const expectedContentRange = `bytes ${parsed.offset}-${parsed.end}/${size}`
						const rangedMatch = await edgeCache.match(
							new Request(canonicalUrl, { method: 'GET', headers: { Range: normalizedRange } })
						)
						if (
							rangedMatch
							&& rangedMatch.status === 206
							&& rangedMatch.body
							&& rangedMatch.headers.get('Content-Range') === expectedContentRange
						) {
							await cached.body?.cancel().catch(() => {})
							rangeBody = rangedMatch.body
						} else {
							await rangedMatch?.body?.cancel().catch(() => {})
							if (cached.body) {
								rangeBody = sliceReadableStream(cached.body, parsed.offset, parsed.length)
							}
						}

						if (rangeBody) {
							headers.set('Content-Range', `bytes ${parsed.offset}-${parsed.end}/${size}`)
							headers.set('Content-Length', String(parsed.length))

							if (getPlayCountMode(env) === 'server' && shouldIncrementSongPlays(req.method, originalParsedRange, size)) {
								recordSongPlay(c, musicId)
							}

							return new Response(rangeBody, { status: 206, headers })
						}
					}
					// parsed.kind === 'ignore': fall through to full 200
				}

				headers.set('Content-Length', String(size))
				// Use originalParsedRange so e.g. stale If-Range on bytes=0-1 probe still counts 0 plays!
				if (getPlayCountMode(env) === 'server' && shouldIncrementSongPlays(req.method, originalParsedRange, size)) {
					recordSongPlay(c, musicId)
				}

				return new Response(cached.body, { status: 200, headers })
			}
			await cached.body?.cancel().catch(() => {})
		}
	}

	// 2. Cold path: read R2 metadata via head() only
	const objectMeta = await env.SMOL_BUCKET.head(id)
	if (!objectMeta) {
		throw new HTTPException(404, { message: 'Song not found' })
	}

	const headers = buildSongHeaders(musicId, objectMeta)
	const etag = normalizeEtag(headers.get('ETag'))
	const lastModified = headers.get('Last-Modified')
	const size = objectMeta.size
	const originalParsedRange = rangeHeader ? parseByteRange(rangeHeader, size) : null

	if (matchesIfNoneMatch(ifNoneMatch, etag)) {
		return notModifiedResponse(headers)
	}

	if (isHead) {
		headers.set('Content-Length', String(size))
		return new Response(null, { status: 200, headers })
	}

	const effectiveRangeHeader = rangeHeader && matchesIfRange(ifRange, etag, lastModified)
		? rangeHeader
		: undefined

	if (effectiveRangeHeader) {
		const parsed = originalParsedRange ?? parseByteRange(effectiveRangeHeader, size)
		if (parsed.kind === 'unsatisfiable') {
			return unsatisfiableRangeResponse(headers, size)
		}
		if (parsed.kind === 'range') {
			const object = await env.SMOL_BUCKET.get(id, {
				range: { offset: parsed.offset, length: parsed.length },
			})
			if (!object) {
				throw new HTTPException(404, { message: 'Song not found after head request' })
			}

			const resolved = resolveR2Range(object, parsed, size)
			headers.set('Content-Range', `bytes ${resolved.offset}-${resolved.end}/${size}`)
			headers.set('Content-Length', String(resolved.length))

			if (getPlayCountMode(env) === 'server' && shouldIncrementSongPlays(req.method, originalParsedRange, size)) {
				recordSongPlay(c, musicId)
			}

			if (edgeCache && id.endsWith('.mp3') && size <= MAX_RANGE_WARM_BYTES
				&& (parsed.offset !== 0 || parsed.isOpenEnded || parsed.length > MAX_PROBE_BYTES)) {
				runInBackground(c, warmSongCache(env, edgeCache, cacheKey, id, musicId))
			}

			return new Response(object.body, { status: 206, headers })
		}
		// parsed.kind === 'ignore': serve full 200 below
	}

	// Full 200 GET on cold miss
	const object = await env.SMOL_BUCKET.get(id)
	if (!object) {
		throw new HTTPException(404, { message: 'Song not found after head request' })
	}

	const fullHeaders = buildSongHeaders(musicId, object)
	fullHeaders.set('Content-Length', String(object.size))

	let responseBody: ReadableStream | null = object.body
	if (edgeCache && object.body) {
		const [clientStream, cacheStream] = object.body.tee()
		responseBody = clientStream
		const cacheableResponse = new Response(cacheStream, {
			status: 200,
			headers: stripOriginSpecificHeaders(fullHeaders),
		})
		runInBackground(c, edgeCache.put(cacheKey, cacheableResponse))
	} else if (edgeCache && object.size === 0) {
		const cacheableResponse = new Response(new Uint8Array(0), {
			status: 200,
			headers: stripOriginSpecificHeaders(fullHeaders),
		})
		runInBackground(c, edgeCache.put(cacheKey, cacheableResponse))
	}

	// Preserve originalParsedRange so stale If-Range on a bytes=0-1 probe counts 0 plays!
	if (getPlayCountMode(env) === 'server' && shouldIncrementSongPlays(req.method, originalParsedRange, object.size)) {
		recordSongPlay(c, musicId)
	}

	return new Response(responseBody, {
		status: 200,
		headers: fullHeaders,
	})
})

function buildImageHeaders(smolId: string, objectMeta: R2Object, size: number): Headers {
	const headers = new Headers()
	objectMeta.writeHttpMetadata(headers)
	headers.set('Content-Type', 'image/png')
	headers.set('Cache-Control', MEDIA_CACHE_CONTROL)
	headers.set('Cache-Tag', `smol:${smolId}:media`)
	headers.set('Content-Length', String(size))

	const etag = normalizeEtag(objectMeta.httpEtag)
	if (etag) {
		headers.set('ETag', etag)
	}
	if (objectMeta.uploaded instanceof Date && !Number.isNaN(objectMeta.uploaded.getTime())) {
		headers.set('Last-Modified', objectMeta.uploaded.toUTCString())
	}
	return headers
}

// Serve images (handles both GET and HEAD)
image.get('/:id{.+\\.png}', async (c) => {
	const { env, req } = c
	const isHead = req.method === 'HEAD'
	const id = req.param('id')
	const smolId = id.replace(/\.png$/, '')
	const scale = req.query('scale')
	let scaleValue: number | null = null

	if (scale !== undefined) {
		if (!/^\d+$/.test(scale)) {
			throw new HTTPException(400, { message: 'Scale must be between 1 and 32' })
		}
		scaleValue = Number(scale)
		if (!Number.isInteger(scaleValue) || scaleValue < 1 || scaleValue > 32) {
			throw new HTTPException(400, { message: 'Scale must be between 1 and 32' })
		}
	}

	const ifNoneMatch = req.header('if-none-match')
	const edgeCache = getEdgeCache()
	const cacheUrl = `${CANONICAL_MEDIA_ORIGIN}/image/${encodeURIComponent(id)}${scaleValue ? `?scale=${scaleValue}` : ''}`
	const cacheKey = new Request(cacheUrl, { method: 'GET' })

	if (edgeCache) {
		const cached = await edgeCache.match(cacheKey)
		if (cached && cached.status === 200) {
			const headers = stripOriginSpecificHeaders(cached.headers)
			if (matchesIfNoneMatch(ifNoneMatch, normalizeEtag(headers.get('ETag')))) {
				await cached.body?.cancel().catch(() => {})
				return notModifiedResponse(headers)
			}
			if (isHead) {
				await cached.body?.cancel().catch(() => {})
				return new Response(null, { status: 200, headers })
			}
			return new Response(cached.body, { status: 200, headers })
		}
	}

	if (isHead && !scaleValue) {
		const imageMeta = await env.SMOL_BUCKET.head(id)
		if (!imageMeta) {
			throw new HTTPException(404, { message: 'Image not found' })
		}
		const headers = buildImageHeaders(smolId, imageMeta, imageMeta.size)
		if (matchesIfNoneMatch(ifNoneMatch, normalizeEtag(headers.get('ETag')))) {
			return notModifiedResponse(headers)
		}
		return new Response(null, { status: 200, headers })
	}

	const image = await env.SMOL_BUCKET.get(id)
	if (!image) {
		throw new HTTPException(404, { message: 'Image not found' })
	}

	if (scaleValue) {
		const jimpImage = await Jimp.fromBuffer(await image.arrayBuffer())
		jimpImage.resize({
			w: jimpImage.width * scaleValue,
			h: jimpImage.height * scaleValue,
			mode: ResizeStrategy.NEAREST_NEIGHBOR,
		})
		const scaledImage = await jimpImage.getBuffer('image/png')
		const headers = buildImageHeaders(smolId, image, scaledImage.byteLength)
		const baseEtag = normalizeEtag(headers.get('ETag'))
		if (baseEtag) {
			headers.set('ETag', `"${baseEtag.replace(/^W\//i, '').replace(/^"|"$/g, '')}-s${scaleValue}"`)
		}

		if (edgeCache) {
			runInBackground(
				c,
				edgeCache.put(
					cacheKey,
					new Response(new Uint8Array(scaledImage), {
						status: 200,
						headers: stripOriginSpecificHeaders(headers),
					})
				)
			)
		}

		if (matchesIfNoneMatch(ifNoneMatch, normalizeEtag(headers.get('ETag')))) {
			return notModifiedResponse(headers)
		}
		return new Response(isHead ? null : scaledImage, { status: 200, headers })
	}

	const headers = buildImageHeaders(smolId, image, image.size)
	if (matchesIfNoneMatch(ifNoneMatch, normalizeEtag(headers.get('ETag')))) {
		await image.body?.cancel().catch(() => {})
		return notModifiedResponse(headers)
	}

	let responseBody: ReadableStream | null = image.body
	if (edgeCache && image.body) {
		const [clientStream, cacheStream] = image.body.tee()
		responseBody = clientStream
		runInBackground(
			c,
			edgeCache.put(
				cacheKey,
				new Response(cacheStream, {
					status: 200,
					headers: stripOriginSpecificHeaders(headers),
				})
			)
		)
	}

	return new Response(responseBody, { status: 200, headers })
})
