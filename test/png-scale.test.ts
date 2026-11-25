import assert from 'node:assert/strict'
import test from 'node:test'
import zlib, { deflateSync } from 'node:zlib'
import { HTTPException } from 'hono/http-exception'
import { decodePng, INFLATE_HEADROOM, PNG_MAX_INPUT_BYTES, scalePng } from '../src/utils/png-scale'
import { CHANNELS, encodeTestPng, ihdr, inflateIdat, packRows, pngChunk, readChunks, type TestPngSpec } from './helpers/png'

const ALL_FILTERS = [0, 1, 2, 3, 4]

/** Deterministic pseudo-random samples (so Sub/Up/Average/Paeth all see non-trivial neighbours). */
function samplePixels(width: number, height: number, bitDepth: number, colorType: number, seed = 1): number[][] {
	const max = colorType === 3 ? Math.min(2 ** bitDepth, 4) - 1 : 2 ** bitDepth - 1
	let state = seed
	const next = () => ((state = (state * 1103515245 + 12345) >>> 0) % (max + 1))
	return Array.from({ length: width * height }, () => Array.from({ length: CHANNELS[colorType] }, next))
}

function nearest(spec: { width: number; height: number; pixels: number[][] }, scale: number): number[][] {
	const out: number[][] = []
	for (let y = 0; y < spec.height * scale; y++) {
		for (let x = 0; x < spec.width * scale; x++) out.push(spec.pixels[Math.floor(y / scale) * spec.width + Math.floor(x / scale)])
	}
	return out
}

/** Independently unfilter (Node inflate + the only filters the encoder emits) and compare to the expected scanlines. */
function assertScaled(output: Uint8Array, spec: TestPngSpec, scale: number, label: string) {
	const chunks = readChunks(output)
	assert.deepEqual(chunks.map((c) => c.type).at(0), 'IHDR', label)
	assert.deepEqual(chunks.map((c) => c.type).slice(-2), ['IDAT', 'IEND'], label)
	const [w, h] = [spec.width * scale, spec.height * scale]
	assert.deepEqual(chunks[0].data, ihdr(w, h, spec.bitDepth, spec.colorType), `${label} IHDR`)

	const expected = packRows(w, h, spec.bitDepth, spec.colorType, nearest(spec, scale))
	const stride = expected[0].length
	const bpp = Math.max(1, (CHANNELS[spec.colorType] * spec.bitDepth) >> 3)
	const raw = inflateIdat(output)
	assert.equal(raw.length, h * (stride + 1), `${label} raw size`)
	let prev = new Uint8Array(stride)
	for (let y = 0; y < h; y++) {
		const filter = raw[y * (stride + 1)]
		const row = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
		if (filter === 1) for (let i = bpp; i < stride; i++) row[i] = (row[i] + row[i - bpp]) & 0xff
		else if (filter === 2) for (let i = 0; i < stride; i++) row[i] = (row[i] + prev[i]) & 0xff
		else assert.fail(`${label} unexpected output filter ${filter}`)
		assert.deepEqual(row, expected[y], `${label} row ${y}`)
		prev = row
	}

	const decoded = decodePng(output)
	assert.deepEqual([decoded.width, decoded.height, decoded.bitDepth, decoded.colorType], [w, h, spec.bitDepth, spec.colorType])
	assert.deepEqual(decoded.pixels, new Uint8Array(Buffer.concat(expected)), `${label} round trip`)
}

function assert422(fn: () => unknown, pattern: RegExp, label = String(pattern)) {
	assert.throws(fn, (error: unknown) => {
		assert.ok(error instanceof HTTPException, label)
		assert.equal(error.status, 422, label)
		assert.match(error.message, pattern, label)
		return true
	})
}

const FORMATS: Array<[colorType: number, bitDepth: number]> = [
	[0, 1], [0, 2], [0, 4], [0, 8], [0, 16],
	[2, 8], [2, 16],
	[3, 1], [3, 2], [3, 4], [3, 8],
	[4, 8], [4, 16],
	[6, 8], [6, 16],
]

test('every colour type and bit depth, all five scanline filters, scales 1/2/3/7: exact nearest-neighbor output', () => {
	for (const [colorType, bitDepth] of FORMATS) {
		// At most 2 ** bitDepth palette entries (2 for 1-bit, 4 otherwise), tRNS no longer than PLTE.
		const entries = Math.min(4, 2 ** bitDepth)
		const palette = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30).subarray(0, entries * 3)
		const trns = Uint8Array.of(255, 0, 128).subarray(0, Math.min(3, entries))
		const spec: TestPngSpec = {
			width: 7, height: 5, bitDepth, colorType, filters: ALL_FILTERS,
			pixels: samplePixels(7, 5, bitDepth, colorType, colorType * 31 + bitDepth),
			before: colorType === 3 ? [['PLTE', palette], ['tRNS', trns]] : [],
		}
		const input = encodeTestPng(spec)
		assert.deepEqual(decodePng(input).pixels, new Uint8Array(Buffer.concat(packRows(7, 5, bitDepth, colorType, spec.pixels))), `${colorType}/${bitDepth} decode`)
		for (const scale of [1, 2, 3, 7]) {
			const output = scalePng(input, scale)
			assertScaled(output, spec, scale, `ct${colorType} bd${bitDepth} x${scale}`)
			if (colorType === 3) {
				const kept = readChunks(output).filter((c) => c.type === 'PLTE' || c.type === 'tRNS').map((c) => Buffer.from(c.raw))
				assert.deepEqual(kept, [pngChunk('PLTE', palette), pngChunk('tRNS', trns)].map((c) => Buffer.from(c)), 'PLTE/tRNS copied verbatim')
			}
		}
	}
})

test('scales 1..32 on 8-bit RGBA (PixelLab output) give exact dimensions and pixels', () => {
	const spec: TestPngSpec = { width: 3, height: 2, bitDepth: 8, colorType: 6, filters: ALL_FILTERS, pixels: samplePixels(3, 2, 8, 6, 99) }
	const input = encodeTestPng(spec)
	for (let scale = 1; scale <= 32; scale++) assertScaled(scalePng(input, scale), spec, scale, `x${scale}`)
	for (const bad of [0, 33, 1.5, Number.NaN]) {
		assert.throws(() => scalePng(input, bad), (error: unknown) => error instanceof HTTPException && error.status === 400)
	}
})

test('64x64 PixelLab-sized RGB and indexed images at scale 32 stay within the 2048x2048 output', () => {
	for (const [colorType, before] of [[2, []], [3, [['PLTE', new Uint8Array(12)]]]] as const) {
		const spec: TestPngSpec = {
			width: 64, height: 64, bitDepth: 8, colorType, filters: ALL_FILTERS,
			pixels: samplePixels(64, 64, 8, colorType, 7), before: before as Array<[string, Uint8Array]>,
		}
		const output = scalePng(encodeTestPng(spec), 32)
		assertScaled(output, spec, 32, `64x64 ct${colorType}`)
		assert.ok(output.byteLength < 200_000, `compressed output stays small (${output.byteLength})`)
	}
})

test('colour-space chunks are copied, pHYs/text and post-IDAT chunks are dropped, multiple IDATs are joined', () => {
	const spec: TestPngSpec = {
		width: 4, height: 4, bitDepth: 8, colorType: 2, pixels: samplePixels(4, 4, 8, 2),
		before: [['gAMA', Uint8Array.of(0, 0, 0xb1, 0x8f)], ['sRGB', Uint8Array.of(0)], ['pHYs', new Uint8Array(9)], ['tEXt', Buffer.from('k\0v')]],
		after: [['tEXt', Buffer.from('late\0x')]],
	}
	const output = scalePng(encodeTestPng(spec), 2)
	assert.deepEqual(readChunks(output).map((c) => c.type), ['IHDR', 'gAMA', 'sRGB', 'IDAT', 'IEND'])
	assertScaled(output, spec, 2, 'ancillary')

	const zlib = deflateSync(Buffer.concat(packRows(4, 4, 8, 2, spec.pixels).map((row) => Buffer.concat([Buffer.of(0), row]))))
	const split = Buffer.concat([
		encodeTestPng({ ...spec, before: [], after: [] }).subarray(0, 33),
		pngChunk('IDAT', zlib.subarray(0, 5)), pngChunk('IDAT', zlib.subarray(5)), pngChunk('IEND', new Uint8Array(0)),
	])
	assertScaled(scalePng(split, 3), { ...spec, before: [] }, 3, 'split IDAT')
})

test('corrupt, truncated and structurally invalid PNGs are rejected with 422', () => {
	const spec: TestPngSpec = { width: 4, height: 4, bitDepth: 8, colorType: 6, pixels: samplePixels(4, 4, 8, 6) }
	const good = encodeTestPng(spec)
	const flip = (offset: number) => { const copy = Uint8Array.from(good); copy[offset] ^= 0xff; return copy }
	const idatOffset = 33

	assert422(() => scalePng(new Uint8Array(0), 2), /bad signature/)
	assert422(() => scalePng(flip(1), 2), /bad signature/)
	assert422(() => scalePng(flip(20), 2), /IHDR CRC mismatch/)
	assert422(() => scalePng(flip(idatOffset + 10), 2), /IDAT CRC mismatch/)
	for (const cut of [8, 20, 33, 40, good.length - 12, good.length - 1]) {
		assert422(() => scalePng(good.subarray(0, cut), 2), /truncated/, `cut at ${cut}`)
	}
	const sig = good.subarray(0, 8)
	const ihdrChunk = good.subarray(8, 33)
	const iend = pngChunk('IEND', new Uint8Array(0))
	const idat = good.subarray(idatOffset, good.length - 12)
	assert422(() => scalePng(Buffer.concat([sig, idat, ihdrChunk, iend]), 2), /IHDR must be the first chunk/)
	assert422(() => scalePng(Buffer.concat([sig, ihdrChunk, iend]), 2), /missing IDAT/)
	assert422(() => scalePng(Buffer.concat([sig, ihdrChunk, ihdrChunk, idat, iend]), 2), /unexpected critical chunk IHDR/)
	assert422(() => scalePng(Buffer.concat([sig, ihdrChunk, pngChunk('ABCD', new Uint8Array(1)), idat, iend]), 2), /unexpected critical chunk ABCD/)
	assert422(() => scalePng(Buffer.concat([sig, ihdrChunk, pngChunk('IH!R', new Uint8Array(1)), idat, iend]), 2), /bad chunk type/)
	assert422(() => scalePng(Buffer.concat([sig, ihdrChunk, idat, pngChunk('PLTE', new Uint8Array(3)), iend]), 2), /unexpected critical chunk PLTE/)

	assert422(() => scalePng(encodeTestPng({ ...spec, colorType: 3, bitDepth: 8, pixels: samplePixels(4, 4, 8, 3) }), 2), /indexed PNG without PLTE/)
	assert422(() => scalePng(encodeTestPng({ ...spec, colorType: 3, bitDepth: 8, pixels: samplePixels(4, 4, 8, 3), before: [['PLTE', new Uint8Array(4)]] }), 2), /bad PLTE/)
	assert422(() => scalePng(encodeTestPng({ ...spec, colorType: 0, bitDepth: 8, pixels: samplePixels(4, 4, 8, 0), before: [['PLTE', new Uint8Array(3)]] }), 2), /PLTE in a grayscale/)
	const tiny = deflateSync(Buffer.alloc(1))
	assert422(() => scalePng(encodeTestPng({ ...spec, colorType: 2, bitDepth: 4, idat: tiny }), 2), /colour type 2 with bit depth 4/)
	assert422(() => scalePng(encodeTestPng({ ...spec, colorType: 5, bitDepth: 8, idat: tiny }), 2), /colour type 5/)
	assert422(() => scalePng(encodeTestPng({ ...spec, width: 0, idat: tiny }), 2), /zero dimension/)

	const filtered = Buffer.concat(packRows(4, 4, 8, 6, spec.pixels).map((row) => Buffer.concat([Buffer.of(0), row])))
	filtered[17 * 2] = 5
	assert422(() => scalePng(encodeTestPng({ ...spec, idat: deflateSync(filtered) }), 2), /bad filter type 5/)
	assert422(() => scalePng(encodeTestPng({ ...spec, idat: deflateSync(filtered.subarray(0, 40)) }), 2), /does not inflate to the declared size/)
	assert422(() => scalePng(encodeTestPng({ ...spec, idat: Buffer.from('not zlib at all') }), 2), /does not inflate/)
	assert422(() => scalePng(encodeTestPng({ ...spec, idat: deflateSync(filtered).subarray(0, 20) }), 2), /does not inflate/)
})

test('interlaced PNGs are rejected', () => {
	const png = encodeTestPng({ width: 4, height: 4, bitDepth: 8, colorType: 6, pixels: samplePixels(4, 4, 8, 6), interlace: 1 })
	assert422(() => scalePng(png, 2), /interlaced PNGs are not supported/)
	assert422(() => decodePng(png), /interlaced/)
	assert422(() => scalePng(encodeTestPng({ width: 1, height: 1, bitDepth: 8, colorType: 0, pixels: [[0]], interlace: 2 }), 2), /unknown interlace/)
})

test('decompression bombs and oversized inputs/outputs fail before large allocations', () => {
	// 1x1 header, ~64 MiB of zeros in ~64 KiB of zlib: inflate stops at the 2 declared bytes + headroom.
	const bomb = encodeTestPng({ width: 1, height: 1, bitDepth: 8, colorType: 0, pixels: [[0]], idat: deflateSync(Buffer.alloc(64 * 1024 * 1024)) })
	assert.ok(bomb.byteLength < 100_000)
	const { inflateSync } = zlib
	const bounds: unknown[] = []
	zlib.inflateSync = ((buffer: zlib.InputType, options?: zlib.ZlibOptions) => (bounds.push(options?.maxOutputLength), inflateSync(buffer, options))) as typeof inflateSync
	try {
		assert422(() => scalePng(bomb, 2), /does not inflate to the declared size/)
	} finally {
		zlib.inflateSync = inflateSync
	}
	assert.deepEqual(bounds, [2 + INFLATE_HEADROOM], 'inflate is capped at the declared 1 x (1 + 1) bytes plus headroom')

	// Overruns that fit inside the headroom are still rejected by the exact-length check.
	const rgba128 = 128 * (1 + 128 * 4)
	for (const extra of [1, 1000, INFLATE_HEADROOM]) {
		const near = encodeTestPng({ width: 128, height: 128, bitDepth: 8, colorType: 6, pixels: [], idat: deflateSync(Buffer.alloc(rgba128 + extra)) })
		assert422(() => scalePng(near, 2), /does not inflate to the declared size/, `+${extra} bytes`)
	}

	const tiny = deflateSync(Buffer.alloc(1))
	const header = (w: number, h: number, bd: number, ct: number) => encodeTestPng({ width: w, height: h, bitDepth: bd, colorType: ct, pixels: [], idat: tiny })
	assert422(() => scalePng(header(4096, 4096, 8, 6), 1), /more than 4194304 pixels/)
	assert422(() => scalePng(header(0xffffffff, 0xffffffff, 8, 6), 1), /more than/)
	assert422(() => scalePng(header(129, 16, 8, 6), 32), /4128x512 output exceeds 4096x4096/)
	assert422(() => scalePng(header(16, 200, 8, 6), 32), /exceeds 4096x4096/)
	assert422(() => scalePng(header(2048, 2048, 16, 6), 2), /output too large/)
	assert422(() => scalePng(header(2048, 2048, 8, 6), 2), /does not inflate/, '4096x4096 RGBA8 passes the size checks and only then inflates')
	assert422(() => scalePng(new Uint8Array(PNG_MAX_INPUT_BYTES + 1), 2), /larger than 8388608 bytes/)
})
