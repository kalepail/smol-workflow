import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { HTTPException } from 'hono/http-exception'
import {
	VIDEO_MAX_MP3_BYTES,
	VIDEO_MUX_VERSION,
	muxCoverAndMp3ToMp4,
	parseMp3Frames,
} from '../src/utils/mp4-mux'
import { encodeTestPng } from './helpers/png'
import {
	createMockExecutionContext,
	installCloudflareStubs,
	type CloudflareStubHandle,
} from './helpers/harness'

let stubs: CloudflareStubHandle
let appModule: typeof import('../src/index')

before(async () => {
	stubs = installCloudflareStubs()
	appModule = await import('../src/index')
})

after(() => {
	stubs.cleanup()
})

function makeMp3Frame(bitrateIdx = 11, srIdx = 1, padding = 0, mpegVersion = 3, fill = 0x55): Uint8Array {
	// Default: MPEG-1 Layer III, 192 kbps (idx 11), 48 kHz (idx 1), stereo => 576 bytes / 24 ms
	const v1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
	const v2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
	const srs: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }
	const br = (mpegVersion === 3 ? v1 : v2)[bitrateIdx] * 1000
	const sr = srs[mpegVersion][srIdx]
	const size = Math.floor(((mpegVersion === 3 ? 144 : 72) * br) / sr) + padding
	const f = new Uint8Array(size)
	f.fill(fill)
	f[0] = 0xff
	f[1] = 0xe0 | (mpegVersion << 3) | (1 << 1) | 1
	f[2] = (bitrateIdx << 4) | (srIdx << 2) | (padding << 1)
	f[3] = 0x00 // stereo
	return f
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((s, p) => s + p.byteLength, 0)
	const out = new Uint8Array(total)
	let off = 0
	for (const p of parts) {
		out.set(p, off)
		off += p.byteLength
	}
	return out
}

function makeTestMp3(frameCount = 1500): Uint8Array {
	// 1500 frames * 24ms = 36s (exercises 30s IDR boundary + frame_num wrap at 15->0)
	const id3 = new Uint8Array(20)
	id3.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a], 0)
	const frame = makeMp3Frame()
	const body = new Uint8Array(frame.byteLength * frameCount)
	for (let i = 0; i < frameCount; i++) body.set(frame, i * frame.byteLength)
	const id3v1 = new Uint8Array(128)
	id3v1.set([0x54, 0x41, 0x47], 0) // "TAG"
	return concat(id3, body, id3v1)
}

function makeCoverPng(side = 8): Uint8Array {
	const pixels: number[][] = []
	for (let y = 0; y < side; y++) {
		for (let x = 0; x < side; x++) {
			pixels.push([(x * 31) & 255, (y * 29) & 255, ((x + y) * 17) & 255, 255])
		}
	}
	return encodeTestPng({ width: side, height: side, bitDepth: 8, colorType: 6, pixels })
}

function findAscii(buf: Uint8Array, tag: string, fromOffset = 0): number {
	const needle = Buffer.from(tag, 'ascii')
	return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).indexOf(needle, fromOffset)
}

test('muxCoverAndMp3ToMp4 emits faststart H.264 + .mp3 fourcc MP4 interleaved under 500 KB', () => {
	const png = makeCoverPng(8)
	const mp3 = makeTestMp3(1500) // 36s
	const res = muxCoverAndMp3ToMp4(png, mp3)

	assert.equal(res.sampleRate, 48000)
	assert.equal(res.channels, 2)
	assert.equal(res.audioFrames, 1500)
	assert.equal(res.videoFrames, 36)
	assert.equal(res.durationMs, 36000)
	assert.ok(res.maxInterleaveGapBytes < 100_000, `interleave gap ${res.maxInterleaveGapBytes} must be << 500 KB`)

	const ftypPos = findAscii(res.mp4, 'ftyp')
	const moovPos = findAscii(res.mp4, 'moov')
	const mdatPos = findAscii(res.mp4, 'mdat')
	assert.ok(ftypPos === 4 && moovPos > ftypPos && mdatPos > moovPos, 'must be faststart ftyp->moov->mdat')

	// Uses .mp3 fourcc (0x2e6d7033) instead of mp4a+esds 0x6B for Apple AVFoundation compatibility
	assert.ok(findAscii(res.mp4, '.mp3') > moovPos, 'must contain .mp3 audio sample entry')
	assert.equal(findAscii(res.mp4, 'mp4a'), -1, 'must not emit silent-on-iOS mp4a sample entry')
	assert.ok(findAscii(res.mp4, 'avc1', moovPos) > moovPos && findAscii(res.mp4, 'avcC', moovPos) > moovPos)

	// Verify stss has 2 IDR sync samples for 36s (sample 1 and sample 31)
	const stssPos = findAscii(res.mp4, 'stss')
	assert.ok(stssPos > 0)
	const dv = new DataView(res.mp4.buffer, res.mp4.byteOffset, res.mp4.byteLength)
	assert.equal(dv.getUint32(stssPos + 8), 2)
	assert.equal(dv.getUint32(stssPos + 12), 1)
	assert.equal(dv.getUint32(stssPos + 16), 31)
})

test('parseMp3Frames skips layout-specific Xing header, resyncs small junk, and rejects low-coverage streams', () => {
	const xingFrame = makeMp3Frame(11, 1, 0, 3, 0x00)
	// MPEG-1 stereo sideInfoSize=32 -> Xing at byte offset 36
	xingFrame.set([0x58, 0x69, 0x6e, 0x67], 36)
	const goodFrames = Array.from({ length: 100 }, () => makeMp3Frame())
	const parsed = parseMp3Frames(concat(xingFrame, ...goodFrames))
	assert.equal(parsed.offsets.length, 100)
	assert.ok(parsed.coverage >= 0.99)

	// Mid-stream garbage > 2% of payload must throw 422 instead of truncating silently
	const bigJunk = new Uint8Array(3000).fill(0x41)
	assert.throws(
		() => parseMp3Frames(concat(...goodFrames.slice(0, 50), bigJunk, ...goodFrames.slice(50))),
		(err: unknown) => err instanceof HTTPException && err.status === 422
	)
})

test('muxCoverAndMp3ToMp4 rejects oversized PNG dimensions (>256x256) before decode', () => {
	// Minimal valid PNG header claiming 512x512
	const fakeBigPng = new Uint8Array(32)
	fakeBigPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
	fakeBigPng.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
	const dv = new DataView(fakeBigPng.buffer)
	dv.setUint32(16, 512)
	dv.setUint32(20, 512)
	assert.throws(
		() => muxCoverAndMp3ToMp4(fakeBigPng, makeTestMp3(50)),
		(err: unknown) => err instanceof HTTPException && err.status === 422
	)
})

function createMockBucket(initial: Record<string, Uint8Array>) {
	const store = new Map<string, { bytes: Uint8Array; etag: string; uploaded: Date }>()
	for (const [k, v] of Object.entries(initial)) {
		store.set(k, { bytes: v, etag: `"etag-${k}-${v.byteLength}"`, uploaded: new Date('2026-11-26T00:00:00Z') })
	}
	const counts = { head: new Map<string, number>(), get: new Map<string, number>(), put: new Map<string, number>() }
	const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)

	const bucket = {
		counts,
		store,
		async head(key: string) {
			bump(counts.head, key)
			const item = store.get(key)
			if (!item) return null
			return {
				size: item.bytes.byteLength,
				httpEtag: item.etag,
				uploaded: item.uploaded,
				writeHttpMetadata: () => {},
			}
		},
		async get(key: string, opts?: { range?: { offset?: number; length?: number } }) {
			bump(counts.get, key)
			const item = store.get(key)
			if (!item) return null
			let slice = item.bytes
			let range: { offset: number; length: number } | undefined
			if (opts?.range && typeof opts.range.offset === 'number') {
				const offset = opts.range.offset
				const length = Math.min(opts.range.length ?? item.bytes.byteLength - offset, item.bytes.byteLength - offset)
				slice = item.bytes.subarray(offset, offset + length)
				range = { offset, length }
			}
			return {
				size: item.bytes.byteLength,
				httpEtag: item.etag,
				uploaded: item.uploaded,
				range,
				writeHttpMetadata: () => {},
				arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
				body: new ReadableStream({
					start(ctrl) {
						ctrl.enqueue(slice)
						ctrl.close()
					},
				}),
			}
		},
		async put(key: string, value: Uint8Array) {
			bump(counts.put, key)
			const bytes = new Uint8Array(value)
			const entry = { bytes, etag: `"etag-${key}-${bytes.byteLength}"`, uploaded: new Date('2026-11-26T00:00:00Z') }
			store.set(key, entry)
			return {
				size: bytes.byteLength,
				httpEtag: entry.etag,
				uploaded: entry.uploaded,
				writeHttpMetadata: () => {},
			}
		},
	}
	return bucket
}

test('GET/HEAD /video/v1/:smolId/:musicId.mp4 persists to R2, coalesces cold hits, enforces safety even when warm', async () => {
	const smolId = 'b'.repeat(64)
	const song1 = 'song-take-1'
	const song2 = 'song-take-2'
	const png = makeCoverPng(8)
	const mp3 = makeTestMp3(200)
	const bucket = createMockBucket({
		[`${smolId}.png`]: png,
		[`${song1}.mp3`]: mp3,
		[`${song2}.mp3`]: mp3,
	})

	let kvRecord: Record<string, unknown> | null = { lyrics: { title: 'Test' }, nsfw: { safe: true, categories: [] } }
	let kvThrows = false
	let d1Row: Record<string, unknown> | null = { Id: smolId, Public: 1, Song_1: song1, Song_2: song2 }

	const env = {
		SMOL_BUCKET: bucket,
		SMOL_KV: {
			get: async () => {
				if (kvThrows) throw new Error('KV down')
				return kvRecord
			},
		},
		SMOL_D1: {
			prepare() {
				return {
					bind() {
						return { first: async () => d1Row, run: async () => ({ success: true }) }
					},
				}
			},
		},
	} as unknown as Env

	const url = `https://api.smol.xyz/video/${VIDEO_MUX_VERSION}/${smolId}/${song1}.mp4`

	// 1. Concurrent cold requests coalesce into a SINGLE R2 read + put
	const ctx1 = createMockExecutionContext()
	const [r1, r2, r3] = await Promise.all([
		appModule.app.fetch(new Request(url, { headers: { Range: 'bytes=0-1' } }), env, ctx1.ctx),
		appModule.app.fetch(new Request(url, { method: 'HEAD' }), env, ctx1.ctx),
		appModule.app.fetch(new Request(url), env, ctx1.ctx),
	])
	assert.equal(r1.status, 206)
	assert.equal((await r1.arrayBuffer()).byteLength, 2)
	assert.equal(r2.status, 200)
	assert.equal(r3.status, 200)
	assert.equal(r3.headers.get('Content-Type'), 'video/mp4')
	assert.equal(r3.headers.get('X-Robots-Tag'), 'noindex, nofollow')
	assert.ok(r3.headers.get('Cache-Tag')?.includes(`video-mux:${VIDEO_MUX_VERSION}`))
	assert.equal(bucket.counts.put.get(`video/${VIDEO_MUX_VERSION}/${smolId}/${song1}.mp4`), 1, 'must mux & put only once')
	assert.equal(bucket.counts.get.get(`${song1}.mp3`), 1, 'must read source MP3 only once across concurrent cold requests')

	const fullBytes = new Uint8Array(await r3.arrayBuffer())
	const etag = r3.headers.get('ETag')!

	// 2. Warm path streams from R2 (zero additional source reads), supports 206 / 304 / 416 / HEAD
	const warmRange = await appModule.app.fetch(
		new Request(url, { headers: { Range: 'bytes=0-1023' } }),
		env,
		ctx1.ctx
	)
	assert.equal(warmRange.status, 206)
	assert.equal(warmRange.headers.get('Content-Range'), `bytes 0-1023/${fullBytes.byteLength}`)
	assert.equal((await warmRange.arrayBuffer()).byteLength, 1024)
	assert.equal(bucket.counts.get.get(`${song1}.mp3`), 1, 'warm hit must never re-read source MP3')

	const warm304 = await appModule.app.fetch(
		new Request(url, { headers: { 'If-None-Match': etag } }),
		env,
		ctx1.ctx
	)
	assert.equal(warm304.status, 304)

	const warm416 = await appModule.app.fetch(
		new Request(url, { headers: { Range: `bytes=${fullBytes.byteLength + 100}-` } }),
		env,
		ctx1.ctx
	)
	assert.equal(warm416.status, 416)

	// 3. Song_2 (authorized secondary take) works; unauthorized take returns 404
	const take2Res = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/video/${VIDEO_MUX_VERSION}/${smolId}/${song2}.mp4`, { method: 'HEAD' }),
		env,
		ctx1.ctx
	)
	assert.equal(take2Res.status, 200)
	const badTakeRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/video/${VIDEO_MUX_VERSION}/${smolId}/other-song.mp4`),
		env,
		ctx1.ctx
	)
	assert.equal(badTakeRes.status, 404)

	// 4. Moderation / safety gating blocks ALREADY-WARM R2 objects immediately
	kvRecord = { nsfw: { safe: false, categories: ['explicit'] } }
	assert.equal((await appModule.app.fetch(new Request(url), env, ctx1.ctx)).status, 404)

	kvRecord = { nsfw: { safe: true, unknown: true, categories: [] } }
	assert.equal((await appModule.app.fetch(new Request(url), env, ctx1.ctx)).status, 404)

	// 5. KV outage fails closed with 503 no-store
	kvThrows = true
	const outageRes = await appModule.app.fetch(new Request(url), env, ctx1.ctx)
	assert.equal(outageRes.status, 503)
	assert.equal(outageRes.headers.get('Cache-Control'), 'no-store')
	kvThrows = false
	kvRecord = { nsfw: { safe: true, categories: [] } }

	// 6. Kill switch disables endpoint immediately
	const disabledEnv = { ...env, DISABLE_VIDEO_MUX: 'true' } as unknown as Env
	assert.equal((await appModule.app.fetch(new Request(url), disabledEnv, ctx1.ctx)).status, 404)

	// 7. Unpublished (no D1 row) returns 404 even if R2 object exists
	d1Row = null
	assert.equal((await appModule.app.fetch(new Request(url), env, ctx1.ctx)).status, 404)
})

test('oversized MP3 (>9 MiB) returns 422 on head check without reading MP3 body, and GET /:id reports video_eligible=false', async () => {
	const smolId = 'c'.repeat(64)
	const bigSong = 'big-song-1'
	const png = makeCoverPng(8)
	let getCalled = false
	const env = {
		SMOL_BUCKET: {
			head: async (key: string) => {
				if (key === `${smolId}.png`) return { size: png.byteLength, httpEtag: '"p"', uploaded: new Date() }
				if (key === `${bigSong}.mp3`) return { size: VIDEO_MAX_MP3_BYTES + 1, httpEtag: '"m"', uploaded: new Date() }
				return null
			},
			get: async () => {
				getCalled = true
				return null
			},
		},
		SMOL_KV: { get: async () => ({ lyrics: { title: 'Long Song' } }) },
		SMOL_D1: {
			prepare() {
				return {
					bind() {
						return {
							first: async () => ({ Id: smolId, Title: 'Long Song', Public: 1, Song_1: bigSong, Song_2: null }),
							run: async () => ({ success: true }),
						}
					},
				}
			},
		},
	} as unknown as Env

	const ctx = createMockExecutionContext()
	const videoRes = await appModule.app.fetch(
		new Request(`https://api.smol.xyz/video/${VIDEO_MUX_VERSION}/${smolId}/${bigSong}.mp4`),
		env,
		ctx.ctx
	)
	assert.equal(videoRes.status, 422)
	assert.equal(getCalled, false, 'oversized MP3 must fail on head() without calling get()')

	const detailRes = await appModule.app.fetch(new Request(`https://api.smol.xyz/${smolId}?no_view=1`), env, ctx.ctx)
	assert.equal(detailRes.status, 200)
	const detail = (await detailRes.json()) as { video_eligible?: boolean }
	assert.equal(detail.video_eligible, false)
})
