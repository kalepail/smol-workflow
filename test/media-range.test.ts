import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { Jimp } from 'jimp'
import {
	createMockEdgeCache,
	createMockExecutionContext,
	createMockR2Bucket,
	installCloudflareStubs,
	type CloudflareStubHandle,
} from './helpers/harness'
import { parseByteRange } from '../src/utils'

let stubs: CloudflareStubHandle
let appModule: typeof import('../src/index')

before(async () => {
	stubs = installCloudflareStubs()
	appModule = await import('../src/index')
})

after(() => {
	stubs.cleanup()
	Reflect.deleteProperty(globalThis, 'caches')
})

function buildSampleBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length)
	for (let i = 0; i < length; i++) {
		bytes[i] = (i * 31 + 7) & 0xff
	}
	return bytes
}

async function createMediaTestHarness(audioBytes = buildSampleBytes(1024)) {
	const r2 = createMockR2Bucket()
	const edgeCache = createMockEdgeCache()
	Reflect.set(globalThis, 'caches', { default: edgeCache.cache })

	const songKey = 'track-abc.mp3'
	await r2.bucket.put(songKey, audioBytes, {
		httpMetadata: { contentType: 'audio/mpeg' },
		customMetadata: { smolId: 'smol-media-1', provider: 'elevenlabs' },
	})

	const emptyKey = 'empty-track.mp3'
	await r2.bucket.put(emptyKey, new Uint8Array(0), {
		httpMetadata: { contentType: 'audio/mpeg' },
	})

	// Real 4x4 PNG for image scaling tests
	const pngImage = new Jimp({ width: 4, height: 4, color: 0xff0088ff })
	const pngBuffer = await pngImage.getBuffer('image/png')
	await r2.bucket.put('smol-img.png', pngBuffer, {
		httpMetadata: { contentType: 'image/png' },
	})

	let playIncrements = 0
	let d1ReadCalls = 0
	const env = {
		SMOL_BUCKET: r2.bucket,
		SMOL_D1: {
			prepare(sql: string) {
				return {
					bind(..._args: unknown[]) {
						return {
							run: async () => {
								if (sql.includes('SET Plays = Plays + 1')) {
									playIncrements += 1
								}
								return { success: true, meta: { changes: 1 } }
							},
							first: async () => {
								d1ReadCalls += 1
								return null
							},
							all: async () => {
								d1ReadCalls += 1
								return { results: [] }
							},
						}
					},
				}
			},
		},
	} as unknown as Env

	async function send(path: string, init: RequestInit = {}) {
		const mockCtx = createMockExecutionContext()
		const req = new Request(`https://api.smol.xyz${path}`, init)
		const res = await appModule.app.fetch(req, env, mockCtx.ctx)
		await mockCtx.flush()
		return res
	}

	return {
		r2,
		edgeCache,
		audioBytes,
		send,
		getPlayIncrements: () => playIncrements,
		getD1ReadCalls: () => d1ReadCalls,
	}
}

test('parseByteRange handles bounded, open-ended, suffix, EOF-clamp, unsatisfiable, and malformed ranges per RFC 9110', () => {
	assert.deepEqual(parseByteRange('bytes=0-1', 1000), {
		kind: 'range', offset: 0, end: 1, length: 2, isSuffix: false, isOpenEnded: false,
	})
	assert.deepEqual(parseByteRange('bytes=100-199', 1000), {
		kind: 'range', offset: 100, end: 199, length: 100, isSuffix: false, isOpenEnded: false,
	})
	assert.deepEqual(parseByteRange('bytes=100-', 1000), {
		kind: 'range', offset: 100, end: 999, length: 900, isSuffix: false, isOpenEnded: true,
	})
	assert.deepEqual(parseByteRange('bytes=0-99999999', 1000), {
		kind: 'range', offset: 0, end: 999, length: 1000, isSuffix: false, isOpenEnded: false,
	})
	assert.deepEqual(parseByteRange('bytes=-128', 1000), {
		kind: 'range', offset: 872, end: 999, length: 128, isSuffix: true, isOpenEnded: false,
	})
	assert.deepEqual(parseByteRange('bytes=-5000', 1000), {
		kind: 'range', offset: 0, end: 999, length: 1000, isSuffix: true, isOpenEnded: false,
	})
	assert.deepEqual(parseByteRange('bytes=1000-', 1000), { kind: 'unsatisfiable' })
	assert.deepEqual(parseByteRange('bytes=1000-1005', 1000), { kind: 'unsatisfiable' })
	assert.deepEqual(parseByteRange('bytes=-0', 1000), { kind: 'unsatisfiable' })
	assert.deepEqual(parseByteRange('bytes=0-0', 0), { kind: 'unsatisfiable' })
	assert.deepEqual(parseByteRange('bytes=-10', 0), { kind: 'unsatisfiable' })
	assert.deepEqual(parseByteRange('bytes=0-1, 2-3', 1000), { kind: 'ignore' })
	assert.deepEqual(parseByteRange('bytes=50-10', 1000), { kind: 'ignore' })
	assert.deepEqual(parseByteRange('bytes=1abc-2', 1000), { kind: 'ignore' })
	assert.deepEqual(parseByteRange('bytes=-', 1000), { kind: 'ignore' })
	assert.deepEqual(parseByteRange('items=0-10', 1000), { kind: 'ignore' })
})

test('HEAD, iOS bytes=0-1 probe, full matrix (cold + warm), 416 headers, If-Range, CORS, and play counting', async () => {
	const harness = await createMediaTestHarness(buildSampleBytes(1024))
	const { audioBytes, r2, send } = harness

	// 1. Cold HEAD ignores Range, returns Content-Length + ETag, 0 R2 GETs, 0 plays, 0 D1 reads
	const coldHead = await send('/song/track-abc.mp3', {
		method: 'HEAD',
		headers: { Range: 'bytes=0-10', Origin: 'https://noot.smol.xyz' },
	})
	assert.equal(coldHead.status, 200)
	assert.equal(coldHead.headers.get('Content-Type'), 'audio/mpeg')
	assert.equal(coldHead.headers.get('Accept-Ranges'), 'bytes')
	assert.equal(coldHead.headers.get('Content-Length'), '1024')
	const etag = coldHead.headers.get('ETag')
	assert.ok(etag)
	assert.equal((await coldHead.arrayBuffer()).byteLength, 0)
	assert.equal(r2.stats.getCalls, 0, 'HEAD must not read R2 body')
	assert.equal(harness.getPlayIncrements(), 0, 'HEAD must not increment Plays')
	assert.equal(harness.getD1ReadCalls(), 0, 'Media requests must not perform D1 reads')
	assert.equal(coldHead.headers.get('Access-Control-Allow-Origin'), 'https://noot.smol.xyz')
	const exposed = coldHead.headers.get('Access-Control-Expose-Headers') ?? ''
	for (const hdr of ['Content-Range', 'Accept-Ranges', 'Content-Length', 'ETag']) {
		assert.ok(exposed.includes(hdr), `Expected ${hdr} in Access-Control-Expose-Headers: ${exposed}`)
	}

	// 2. Cold iOS bytes=0-1 probe returns 206 (2 bytes), 0 plays, and does NOT poison canonical full-GET cache!
	const probe = await send('/song/track-abc.mp3', {
		headers: { Range: 'bytes=0-1', Origin: 'https://smol.xyz' },
	})
	assert.equal(probe.status, 206)
	assert.equal(probe.headers.get('Content-Range'), 'bytes 0-1/1024')
	assert.equal(probe.headers.get('Content-Length'), '2')
	assert.deepEqual(new Uint8Array(await probe.arrayBuffer()), audioBytes.subarray(0, 2))
	assert.equal(harness.getPlayIncrements(), 0, 'iOS bytes=0-1 probe must not increment Plays')
	assert.equal(harness.edgeCache.entries.size, 0, 'Cold 206 probe must not populate canonical full-GET cache')

	// 3. Cold EOF overshoot, suffix, and 416 (all cold before full GET populates cache)
	const coldOvershoot = await send('/song/track-abc.mp3', { headers: { Range: 'bytes=900-999999' } })
	assert.equal(coldOvershoot.status, 206)
	assert.equal(coldOvershoot.headers.get('Content-Range'), 'bytes 900-1023/1024')
	assert.equal(coldOvershoot.headers.get('Content-Length'), '124')
	assert.deepEqual(new Uint8Array(await coldOvershoot.arrayBuffer()), audioBytes.subarray(900, 1024))
	assert.equal(harness.getPlayIncrements(), 0, 'Mid-file seek must not increment Plays')

	const coldSuffix = await send('/song/track-abc.mp3', { headers: { Range: 'bytes=-128' } })
	assert.equal(coldSuffix.status, 206)
	assert.equal(coldSuffix.headers.get('Content-Range'), 'bytes 896-1023/1024')
	assert.equal(coldSuffix.headers.get('Content-Length'), '128')
	assert.deepEqual(new Uint8Array(await coldSuffix.arrayBuffer()), audioBytes.subarray(896, 1024))
	assert.equal(harness.getPlayIncrements(), 0, 'Suffix probe must not increment Plays')

	const cold416 = await send('/song/track-abc.mp3', { headers: { Range: 'bytes=1024-' } })
	assert.equal(cold416.status, 416)
	assert.equal(cold416.headers.get('Content-Range'), 'bytes */1024')
	assert.equal(harness.getPlayIncrements(), 0)

	const zeroSuffix416 = await send('/song/track-abc.mp3', { headers: { Range: 'bytes=-0' } })
	assert.equal(zeroSuffix416.status, 416)
	assert.equal(zeroSuffix416.headers.get('Content-Range'), 'bytes */1024')

	// 4. Full GET populates canonical origin-neutral cache and counts 1 real play start
	const fullCold = await send('/song/track-abc.mp3', { headers: { Origin: 'https://smol.xyz' } })
	assert.equal(fullCold.status, 200)
	assert.equal(fullCold.headers.get('Content-Length'), '1024')
	assert.deepEqual(new Uint8Array(await fullCold.arrayBuffer()), audioBytes)
	assert.equal(harness.getPlayIncrements(), 1, 'Full GET counts as 1 real play start')
	assert.equal(harness.edgeCache.entries.size, 1, 'Full 200 should populate edge cache')

	// Verify cached copy is origin-neutral (no ACAO stored in cache)
	const cachedEntry = [...harness.edgeCache.entries.values()][0]
	assert.ok(!cachedEntry.headers.some(([k]) => k.toLowerCase() === 'access-control-allow-origin'))

	const r2GetsBeforeWarm = r2.stats.getCalls
	const r2HeadsBeforeWarm = r2.stats.headCalls

	// 5. Warm path tests (ZERO new R2 ops, exact bytes, per-origin CORS applied after cache lookup)
	const warmHead = await send('/song/track-abc.mp3', {
		method: 'HEAD',
		headers: { Origin: 'https://noot.smol.xyz' },
	})
	assert.equal(warmHead.status, 200)
	assert.equal(warmHead.headers.get('Content-Length'), '1024')
	assert.equal(warmHead.headers.get('Access-Control-Allow-Origin'), 'https://noot.smol.xyz')
	assert.equal(harness.getPlayIncrements(), 1)

	const warmProbe = await send('/song/track-abc.mp3', {
		headers: { Range: 'bytes=0-1', Origin: 'https://evil.example.com' },
	})
	assert.equal(warmProbe.status, 206)
	assert.equal(warmProbe.headers.get('Content-Range'), 'bytes 0-1/1024')
	assert.equal(warmProbe.headers.get('Access-Control-Allow-Origin'), null, 'Disallowed origin must not get ACAO')
	assert.deepEqual(new Uint8Array(await warmProbe.arrayBuffer()), audioBytes.subarray(0, 2))
	assert.equal(harness.getPlayIncrements(), 1)

	const warmOpen = await send('/song/track-abc.mp3', { headers: { Range: 'bytes=0-' } })
	assert.equal(warmOpen.status, 206)
	assert.equal(warmOpen.headers.get('Content-Range'), 'bytes 0-1023/1024')
	assert.deepEqual(new Uint8Array(await warmOpen.arrayBuffer()), audioBytes)
	assert.equal(harness.getPlayIncrements(), 2, 'Warm bytes=0- play start still counts plays')

	const warmLargeSuffix = await send('/song/track-abc.mp3', { headers: { Range: 'bytes=-99999' } })
	assert.equal(warmLargeSuffix.status, 206)
	assert.equal(warmLargeSuffix.headers.get('Content-Range'), 'bytes 0-1023/1024')
	assert.deepEqual(new Uint8Array(await warmLargeSuffix.arrayBuffer()), audioBytes)
	assert.equal(harness.getPlayIncrements(), 2)

	// Malformed & multipart ranges fall back to full 200 (never silently serving just the first range)
	for (const badRange of ['bytes=0-1, 2-3', 'bytes=50-10', 'bytes=abc-def', 'items=0-5']) {
		const res = await send('/song/track-abc.mp3', { headers: { Range: badRange } })
		assert.equal(res.status, 200, `Expected full 200 fallback for ${badRange}`)
		assert.equal(res.headers.get('Content-Range'), null)
		assert.deepEqual(new Uint8Array(await res.arrayBuffer()), audioBytes)
	}

	// If-Range: matching strong ETag -> 206; mismatched ETag -> full 200
	const ifRangeMatch = await send('/song/track-abc.mp3', {
		headers: { Range: 'bytes=10-19', 'If-Range': etag! },
	})
	assert.equal(ifRangeMatch.status, 206)
	assert.deepEqual(new Uint8Array(await ifRangeMatch.arrayBuffer()), audioBytes.subarray(10, 20))

	const ifRangeMismatch = await send('/song/track-abc.mp3', {
		headers: { Range: 'bytes=10-19', 'If-Range': '"stale-etag"' },
	})
	assert.equal(ifRangeMismatch.status, 200)
	assert.deepEqual(new Uint8Array(await ifRangeMismatch.arrayBuffer()), audioBytes)

	// If-None-Match -> 304 Not Modified
	const notModified = await send('/song/track-abc.mp3', { headers: { 'If-None-Match': etag! } })
	assert.equal(notModified.status, 304)

	// Warm 416 preserves Content-Range
	const warm416 = await send('/song/track-abc.mp3', { headers: { Range: 'bytes=2000-2010' } })
	assert.equal(warm416.status, 416)
	assert.equal(warm416.headers.get('Content-Range'), 'bytes */1024')

	// Confirm ZERO R2 reads happened on all warm requests!
	assert.equal(r2.stats.getCalls, r2GetsBeforeWarm, 'Warm requests must not call R2.get')
	assert.equal(r2.stats.headCalls, r2HeadsBeforeWarm, 'Warm requests must not call R2.head')

	// 6. Empty 0-byte file handling + missing 404
	const emptyFull = await send('/song/empty-track.mp3')
	assert.equal(emptyFull.status, 200)
	assert.equal(emptyFull.headers.get('Content-Length'), '0')
	assert.equal((await emptyFull.arrayBuffer()).byteLength, 0)

	const emptyRange = await send('/song/empty-track.mp3', { headers: { Range: 'bytes=0-0' } })
	assert.equal(emptyRange.status, 416)
	assert.equal(emptyRange.headers.get('Content-Range'), 'bytes */0')

	const missing = await send('/song/does-not-exist.mp3')
	assert.equal(missing.status, 404)
})

test('BE-2 regressions: stale If-Range on bytes=0-1 probe counts 0 plays (cold + warm), and warm range slices stream in O(1) memory without buffering full MP3', async () => {
	// 1. Cold stale If-Range + bytes=0-1 probe -> full 200 bytes, 0 play increments!
	const coldHarness = await createMediaTestHarness(buildSampleBytes(1024))
	const coldStaleProbe = await coldHarness.send('/song/track-abc.mp3', {
		headers: {
			Range: 'bytes=0-1',
			'If-Range': '"stale-etag-value"',
		},
	})
	assert.equal(coldStaleProbe.status, 200)
	assert.deepEqual(new Uint8Array(await coldStaleProbe.arrayBuffer()), coldHarness.audioBytes)
	assert.equal(coldHarness.getPlayIncrements(), 0, 'Cold bytes=0-1 probe with stale If-Range must NOT increment Plays')

	// 2. Warm stale If-Range + bytes=0-1 probe -> full 200 bytes, STILL 0 play increments!
	const warmStaleProbe = await coldHarness.send('/song/track-abc.mp3', {
		headers: {
			Range: 'bytes=0-1',
			'If-Range': '"stale-etag-value"',
		},
	})
	assert.equal(warmStaleProbe.status, 200)
	assert.deepEqual(new Uint8Array(await warmStaleProbe.arrayBuffer()), coldHarness.audioBytes)
	assert.equal(coldHarness.getPlayIncrements(), 0, 'Warm bytes=0-1 probe with stale If-Range must NOT increment Plays')

	// 3. Warm bytes=0-1 range cancels a multi-chunk cached stream immediately after chunk 1 (no full-body buffering)
	let chunksPulled = 0
	let streamCancelled = false
	const totalChunks = 64
	const chunkSize = 1024
	const totalSize = totalChunks * chunkSize

	const streamingCache: Cache = {
		async match(request: RequestInfo | URL) {
			const req = request instanceof Request ? request : new Request(String(request))
			// Simulate a cache that returns 200 (forcing the streaming slice path)
			if (req.headers.has('Range')) {
				return undefined
			}
			let emitted = 0
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (emitted >= totalChunks) {
						controller.close()
						return
					}
					chunksPulled += 1
					const chunk = new Uint8Array(chunkSize)
					chunk.fill(emitted + 1)
					emitted += 1
					controller.enqueue(chunk)
				},
				cancel() {
					streamCancelled = true
				},
			})
			return new Response(body, {
				status: 200,
				headers: {
					'Content-Type': 'audio/mpeg',
					'Content-Length': String(totalSize),
					'Accept-Ranges': 'bytes',
					ETag: '"etag-stream-test"',
				},
			})
		},
		async put() {},
		async delete() { return false },
	} as unknown as Cache

	Reflect.set(globalThis, 'caches', { default: streamingCache })
	const mockCtx = createMockExecutionContext()
	const warmRangeRes = await appModule.app.fetch(
		new Request('https://api.smol.xyz/song/streamed.mp3', {
			headers: { Range: 'bytes=0-1' },
		}),
		{
			SMOL_BUCKET: createMockR2Bucket().bucket,
			SMOL_D1: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
		} as unknown as Env,
		mockCtx.ctx
	)
	await mockCtx.flush()
	assert.equal(warmRangeRes.status, 206)
	assert.equal(warmRangeRes.headers.get('Content-Range'), `bytes 0-1/${totalSize}`)
	assert.equal(warmRangeRes.headers.get('Content-Length'), '2')
	assert.deepEqual(new Uint8Array(await warmRangeRes.arrayBuffer()), new Uint8Array([1, 1]))
	assert.equal(streamCancelled, true, 'Upstream cached stream must be cancelled once requested byte range is satisfied')
	assert.ok(chunksPulled <= 2, `Expected O(1) streaming read (<=2 chunks), pulled ${chunksPulled} of ${totalChunks}`)

	// 4. Native ranged 206 cache hit cancels the full cached body with 0 chunks pulled
	let fullBodyChunksPulled = 0
	let fullBodyCancelled = false
	const nativeRangedCache: Cache = {
		async match(request: RequestInfo | URL) {
			const req = request instanceof Request ? request : new Request(String(request))
			if (req.headers.get('Range') === 'bytes=0-1') {
				return new Response(new Uint8Array([42, 43]), {
					status: 206,
					headers: {
						'Content-Type': 'audio/mpeg',
						'Content-Range': `bytes 0-1/${totalSize}`,
						'Content-Length': '2',
					},
				})
			}
			const fullBody = new ReadableStream<Uint8Array>({
				pull(controller) {
					fullBodyChunksPulled += 1
					controller.enqueue(new Uint8Array(chunkSize))
				},
				cancel() {
					fullBodyCancelled = true
				},
			}, { highWaterMark: 0 })
			return new Response(fullBody, {
				status: 200,
				headers: {
					'Content-Type': 'audio/mpeg',
					'Content-Length': String(totalSize),
					'Accept-Ranges': 'bytes',
					ETag: '"etag-native-206"',
				},
			})
		},
		async put() {},
		async delete() { return false },
	} as unknown as Cache

	Reflect.set(globalThis, 'caches', { default: nativeRangedCache })
	const nativeRangeRes = await appModule.app.fetch(
		new Request('https://api.smol.xyz/song/native-ranged.mp3', {
			headers: { Range: 'bytes=0-1' },
		}),
		{
			SMOL_BUCKET: createMockR2Bucket().bucket,
			SMOL_D1: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
		} as unknown as Env,
		mockCtx.ctx
	)
	await mockCtx.flush()
	assert.equal(nativeRangeRes.status, 206)
	assert.deepEqual(new Uint8Array(await nativeRangeRes.arrayBuffer()), new Uint8Array([42, 43]))
	assert.equal(fullBodyCancelled, true, 'Full cached stream must be cancelled when native ranged 206 matches')
	assert.equal(fullBodyChunksPulled, 0, 'Full cached stream must pull 0 chunks when native ranged 206 matches')
})

test('image serving supports HEAD without R2 GET, scale validation, and separate cached representations', async () => {
	const { r2, send } = await createMediaTestHarness()

	const headImg = await send('/image/smol-img.png', { method: 'HEAD' })
	assert.equal(headImg.status, 200)
	assert.equal(headImg.headers.get('Content-Type'), 'image/png')
	assert.ok(Number(headImg.headers.get('Content-Length')) > 0)
	assert.equal(r2.stats.getCalls, 0, 'Unscaled image HEAD must not call R2.get')

	const badScale = await send('/image/smol-img.png?scale=99')
	assert.equal(badScale.status, 400)
	const badScaleStr = await send('/image/smol-img.png?scale=4abc')
	assert.equal(badScaleStr.status, 400)

	const baseImg = await send('/image/smol-img.png')
	assert.equal(baseImg.status, 200)
	const baseBytes = new Uint8Array(await baseImg.arrayBuffer())

	const scaledImg = await send('/image/smol-img.png?scale=2')
	assert.equal(scaledImg.status, 200)
	const scaledBytes = new Uint8Array(await scaledImg.arrayBuffer())
	assert.notDeepEqual(scaledBytes, baseBytes)

	const getsAfterCold = r2.stats.getCalls
	const warmScaled = await send('/image/smol-img.png?scale=2')
	assert.equal(warmScaled.status, 200)
	assert.deepEqual(new Uint8Array(await warmScaled.arrayBuffer()), scaledBytes)
	assert.equal(r2.stats.getCalls, getsAfterCold, 'Warm scaled image must serve from cache without re-running Jimp')
})
