import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { Jimp, ResizeStrategy } from 'jimp'
import type { HonoEnv } from '../types'
import { parseRange } from '../utils'

const media = new Hono<HonoEnv>()
const MEDIA_CACHE_CONTROL = 'public, max-age=2592000, stale-while-revalidate=86400'

async function getSongSmolId(env: Env, musicId: string): Promise<string | null> {
	const row = await env.SMOL_D1.prepare(`
		SELECT Id
		FROM Smols
		WHERE Song_1 = ?1 OR Song_2 = ?1
	`)
		.bind(musicId)
		.first<{ Id: string }>()

	return row?.Id ?? null
}

// Serve songs
media.get('/:id{.+\\.mp3}', async (c) => {
	const { env, req, executionCtx } = c
	const id = req.param('id')
	const musicId = id.replace(/\.mp3$/, '')
	const rangeHeader = req.header('range')
	const smolId = await getSongSmolId(env, musicId)

	const objectMeta = await env.SMOL_BUCKET.head(id)

	if (!objectMeta) {
		throw new HTTPException(404, { message: 'Song not found' })
	}

	const headers = new Headers()
	objectMeta.writeHttpMetadata(headers)
	headers.set('Accept-Ranges', 'bytes')
	headers.set('Content-Type', 'audio/mpeg')
	// Media URLs are intentionally link-shareable by opaque ID. Public/private
	// controls listing and detail visibility, not direct asset playback.
	headers.set('Cache-Control', MEDIA_CACHE_CONTROL)
	if (smolId) {
		headers.set('Cache-Tag', `smol:${smolId}:media`)
	}

	let status = 200
	let body: ReadableStream | null = null

	if (rangeHeader) {
		const range = parseRange(rangeHeader, objectMeta.size)
		if (range) {
			const object = await env.SMOL_BUCKET.get(id, { range })
			if (object) {
				headers.set(
					'Content-Range',
					`bytes ${range.offset}-${range.offset + (range.length !== undefined ? range.length - 1 : objectMeta.size - 1 - range.offset)}/${objectMeta.size}`
				)
				body = object.body
				status = 206
			}
		} else {
			headers.set('Content-Range', `bytes */${objectMeta.size}`)
			throw new HTTPException(416, { message: 'Range Not Satisfiable' })
		}
	}

	if (!body) {
		const object = await env.SMOL_BUCKET.get(id)
		if (object) {
			body = object.body
		} else {
			throw new HTTPException(404, { message: 'Song not found after head request' })
		}
	}

	const shouldIncrementPlays = !rangeHeader || (rangeHeader && rangeHeader.startsWith('bytes=0-'))

	if (shouldIncrementPlays) {
		executionCtx.waitUntil(
			env.SMOL_D1.prepare('UPDATE Smols SET Plays = Plays + 1 WHERE Song_1 = ?1 OR Song_2 = ?1')
				.bind(musicId)
				.run()
		)
	}

	return new Response(body, {
		headers,
		status,
	})
})

// Serve images
media.get(
	'/:id{.+\\.png}',
	async (c) => {
		const { env, req } = c
		const id = req.param('id')
		const smolId = id.replace(/\.png$/, '')
		const scale = req.query('scale')

		const image = await env.SMOL_BUCKET.get(id)

		if (!image) {
			throw new HTTPException(404, { message: 'Image not found' })
		}

		let scaled_image: Buffer | null = null

		if (scale) {
			const scaleValue = parseInt(scale)

			// Prevent DoS via excessive scaling - cap at 32x (64px base * 32 = 2048px)
			if (isNaN(scaleValue) || scaleValue < 1 || scaleValue > 32) {
				throw new HTTPException(400, { message: 'Scale must be between 1 and 32' })
			}

			const jimp_image = await Jimp.fromBuffer(await image.arrayBuffer())

			jimp_image.resize({
				w: jimp_image.width * scaleValue,
				h: jimp_image.height * scaleValue,
				mode: ResizeStrategy.NEAREST_NEIGHBOR,
			})

			scaled_image = await jimp_image.getBuffer('image/png')
		}

		return new Response(scaled_image ?? image.body, {
			headers: {
				'Content-Type': 'image/png',
				// Media URLs are intentionally link-shareable by opaque ID.
				'Cache-Control': MEDIA_CACHE_CONTROL,
				'Cache-Tag': `smol:${smolId}:media`,
			},
		})
	}
)

export default media
