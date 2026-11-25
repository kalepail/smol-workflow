/**
 * Nearest-neighbor integer upscaling of non-interlaced PNGs with no dependencies beyond `node:zlib`.
 *
 * Every size is checked before anything large is allocated: input bytes, source pixels, output
 * dimensions and output raw bytes are capped. The image data is inflated with `maxOutputLength` set to
 * the size the header declares plus `INFLATE_HEADROOM`, so a decompression bomb stops there. Anything
 * that is not exactly the declared size is then rejected.
 *
 * The output keeps the source colour type and bit depth. PLTE, tRNS and the colour-space chunks are
 * copied verbatim (integer upscaling does not change a single sample). Malformed, oversized or
 * unsupported input throws `HTTPException(422)`.
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { HTTPException } from 'hono/http-exception'

export const PNG_MAX_INPUT_BYTES = 8 * 1024 * 1024
/**
 * workerd's sync zlib reserves output in fixed 40 KiB steps (`ZLIB_PERFORMANT_CHUNK_SIZE`, whatever
 * `chunkSize` says) and throws `RangeError: Memory limit exceeded` as soon as a reservation would pass
 * `maxOutputLength`, even when the data itself fits. An exact bound therefore rejects valid images
 * (e.g. 128x128 RGBA = 65,664 bytes). One step of headroom is always enough; 64 KiB leaves margin.
 */
export const INFLATE_HEADROOM = 64 * 1024
const PNG_MAX_SOURCE_PIXELS = 2048 * 2048
const PNG_MAX_OUTPUT_SIDE = 4096
/** Raw (filtered, uncompressed) output bytes: a 4096×4096 8-bit RGBA image and nothing larger. */
const PNG_MAX_OUTPUT_RAW_BYTES = PNG_MAX_OUTPUT_SIDE * (1 + PNG_MAX_OUTPUT_SIDE * 4)
const PNG_MAX_SCALE = 32

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
/** Allowed bit depths and channel count per colour type. */
const COLOR_TYPES: Record<number, { channels: number; depths: readonly number[] }> = {
	0: { channels: 1, depths: [1, 2, 4, 8, 16] }, // grayscale
	2: { channels: 3, depths: [8, 16] }, // RGB
	3: { channels: 1, depths: [1, 2, 4, 8] }, // indexed
	4: { channels: 2, depths: [8, 16] }, // grayscale + alpha
	6: { channels: 4, depths: [8, 16] }, // RGBA
}
/** Pre-IDAT chunks that stay valid after upscaling, copied verbatim (pHYs, text, time etc. are dropped). */
const COPIED_CHUNKS = new Set(['PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD'])

export interface PngHeader {
	width: number
	height: number
	bitDepth: number
	colorType: number
}

export interface DecodedPng extends PngHeader {
	/** Bytes per unfiltered row. */
	stride: number
	/** Unfiltered rows, `height * stride` bytes, no filter-type bytes. */
	pixels: Uint8Array
	/** Copied chunks (length, type, data and CRC), in source order. */
	copiedChunks: Uint8Array[]
}

interface ParsedPng extends PngHeader {
	idat: Uint8Array
	copiedChunks: Uint8Array[]
}

function fail(reason: string): never {
	throw new HTTPException(422, { message: `Unsupported or malformed PNG: ${reason}` })
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table[n] = c >>> 0
	}
	return table
})()

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff
	for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}

function bitsPerPixel({ bitDepth, colorType }: PngHeader): number {
	return COLOR_TYPES[colorType].channels * bitDepth
}

function rowBytes(header: PngHeader, width: number): number {
	return Math.ceil((width * bitsPerPixel(header)) / 8)
}

/** Walk the chunk stream: signature, CRCs, IHDR, chunk order and the source-size limits. */
function parsePng(input: Uint8Array): ParsedPng {
	if (input.byteLength > PNG_MAX_INPUT_BYTES) fail(`larger than ${PNG_MAX_INPUT_BYTES} bytes`)
	if (input.byteLength < SIGNATURE.length || SIGNATURE.some((byte, i) => input[i] !== byte)) fail('bad signature')

	const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
	/** One CRC-checked chunk starting at `pos`. */
	const readChunk = (pos: number) => {
		if (pos + 12 > input.byteLength) fail('truncated')
		const length = view.getUint32(pos)
		const end = pos + 12 + length
		if (length > 0x7fffffff || end > input.byteLength) fail('truncated chunk')
		const type = String.fromCharCode(...input.subarray(pos + 4, pos + 8))
		if (!/^[A-Za-z]{4}$/.test(type)) fail('bad chunk type')
		if (crc32(input.subarray(pos + 4, end - 4)) !== view.getUint32(end - 4)) fail(`${type} CRC mismatch`)
		return { type, data: input.subarray(pos + 8, end - 4), raw: input.subarray(pos, end), end }
	}

	const first = readChunk(SIGNATURE.length)
	if (first.type !== 'IHDR' || first.data.byteLength !== 13) fail('IHDR must be the first chunk')
	const header = parseHeader(first.data)
	let hasPalette = false
	const idatParts: Uint8Array[] = []
	const copiedChunks: Uint8Array[] = []

	for (let chunk = readChunk(first.end); chunk.type !== 'IEND'; chunk = readChunk(chunk.end)) {
		const { type, data } = chunk
		if (type === 'IDAT') {
			idatParts.push(data)
		} else if (idatParts.length === 0 && COPIED_CHUNKS.has(type)) {
			if (type === 'PLTE') {
				if (hasPalette || data.byteLength === 0 || data.byteLength % 3 !== 0 || data.byteLength > 256 * 3) fail('bad PLTE')
				if (header.colorType === 0 || header.colorType === 4) fail('PLTE in a grayscale PNG')
				hasPalette = true
			}
			copiedChunks.push(chunk.raw)
		} else if ((type.charCodeAt(0) & 0x20) === 0) {
			// IHDR again, PLTE after IDAT, or a critical chunk this decoder does not know.
			fail(`unexpected critical chunk ${type}`)
		}
	}

	if (idatParts.length === 0) fail('missing IDAT')
	if (header.colorType === 3 && !hasPalette) fail('indexed PNG without PLTE')
	return { ...header, idat: concat(idatParts), copiedChunks }
}

function parseHeader(data: Uint8Array): PngHeader {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
	const width = view.getUint32(0)
	const height = view.getUint32(4)
	const [bitDepth, colorType, compression, filter, interlace] = data.subarray(8, 13)
	if (width === 0 || height === 0) fail('zero dimension')
	if (width * height > PNG_MAX_SOURCE_PIXELS) fail(`more than ${PNG_MAX_SOURCE_PIXELS} pixels`)
	if (!COLOR_TYPES[colorType]?.depths.includes(bitDepth)) fail(`colour type ${colorType} with bit depth ${bitDepth}`)
	if (compression !== 0 || filter !== 0) fail('unknown compression or filter method')
	if (interlace === 1) fail('interlaced PNGs are not supported')
	if (interlace !== 0) fail('unknown interlace method')
	return { width, height, bitDepth, colorType }
}

/** Inflate (bounded to the declared size) and reverse the five scanline filters. */
function inflatePixels(png: ParsedPng): DecodedPng {
	const stride = rowBytes(png, png.width)
	const expected = png.height * (stride + 1)
	let data: Uint8Array
	try {
		data = inflateSync(png.idat, { maxOutputLength: expected + INFLATE_HEADROOM })
	} catch {
		fail('image data does not inflate to the declared size')
	}
	if (data.byteLength !== expected) fail('image data does not inflate to the declared size')

	const bpp = Math.max(1, bitsPerPixel(png) >> 3)
	const pixels = new Uint8Array(png.height * stride)
	for (let y = 0; y < png.height; y++) {
		const filter = data[y * (stride + 1)]
		if (filter > 4) fail(`bad filter type ${filter}`)
		const cur = data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
		const out = pixels.subarray(y * stride, (y + 1) * stride)
		const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride)
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? out[i - bpp] : 0
			const b = up[i]
			switch (filter) {
				case 0: out[i] = cur[i]; break
				case 1: out[i] = cur[i] + a; break
				case 2: out[i] = cur[i] + b; break
				case 3: out[i] = cur[i] + ((a + b) >> 1); break
				case 4: out[i] = cur[i] + paeth(a, b, i >= bpp ? up[i - bpp] : 0); break
			}
		}
	}
	return {
		width: png.width, height: png.height, bitDepth: png.bitDepth, colorType: png.colorType,
		stride, pixels, copiedChunks: png.copiedChunks,
	}
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c
	const pa = Math.abs(p - a)
	const pb = Math.abs(p - b)
	const pc = Math.abs(p - c)
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decode a PNG to unfiltered rows (same limits as `scalePng`). */
export function decodePng(input: Uint8Array): DecodedPng {
	return inflatePixels(parsePng(input))
}

/** Upscale `input` by an integer `scale` (1..32) with nearest-neighbor sampling. */
export function scalePng(input: Uint8Array, scale: number): Uint8Array {
	if (!Number.isInteger(scale) || scale < 1 || scale > PNG_MAX_SCALE) {
		throw new HTTPException(400, { message: `Scale must be between 1 and ${PNG_MAX_SCALE}` })
	}
	const parsed = parsePng(input)
	const width = parsed.width * scale
	const height = parsed.height * scale
	if (width > PNG_MAX_OUTPUT_SIDE || height > PNG_MAX_OUTPUT_SIDE) {
		fail(`${width}x${height} output exceeds ${PNG_MAX_OUTPUT_SIDE}x${PNG_MAX_OUTPUT_SIDE}`)
	}
	const outStride = rowBytes(parsed, width)
	if (height * (outStride + 1) > PNG_MAX_OUTPUT_RAW_BYTES) fail('output too large')

	const source = inflatePixels(parsed)
	const bits = bitsPerPixel(source)
	const bpp = Math.max(1, bits >> 3)
	const raw = new Uint8Array(height * (outStride + 1))
	for (let y = 0; y < source.height; y++) {
		const start = y * scale * (outStride + 1)
		const row = raw.subarray(start + 1, start + 1 + outStride)
		scaleRow(source.pixels.subarray(y * source.stride, (y + 1) * source.stride), row, source.width, scale, bits)
		// Sub-filter the first copy (repeated pixels become zeros); the scale-1 copies below it are
		// identical, so as Up-filtered rows they are all zeros and need no writes beyond the filter byte.
		raw[start] = 1
		for (let i = outStride - 1; i >= bpp; i--) row[i] -= row[i - bpp]
		for (let r = 1; r < scale; r++) raw[start + r * (outStride + 1)] = 2
	}

	const ihdr = new Uint8Array(13)
	const view = new DataView(ihdr.buffer)
	view.setUint32(0, width)
	view.setUint32(4, height)
	ihdr[8] = source.bitDepth
	ihdr[9] = source.colorType
	return concat([
		SIGNATURE,
		chunk('IHDR', ihdr),
		...source.copiedChunks,
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', new Uint8Array(0)),
	])
}

function scaleRow(src: Uint8Array, out: Uint8Array, width: number, scale: number, bits: number): void {
	if (bits >= 8) {
		const bytes = bits >> 3
		for (let x = 0, o = 0; x < width; x++) {
			for (let k = 0; k < scale; k++) {
				for (let b = 0; b < bytes; b++) out[o++] = src[x * bytes + b]
			}
		}
		return
	}
	// 1/2/4-bit samples, packed most significant bit first; `out` starts zeroed.
	const mask = (1 << bits) - 1
	for (let x = 0, o = 0; x < width; x++) {
		const value = (src[(x * bits) >> 3] >> (8 - bits - ((x * bits) & 7))) & mask
		for (let k = 0; k < scale; k++, o++) out[(o * bits) >> 3] |= value << (8 - bits - ((o * bits) & 7))
	}
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.byteLength)
	const view = new DataView(out.buffer)
	view.setUint32(0, data.byteLength)
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
	out.set(data, 8)
	view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)))
	return out
}

function concat(parts: Uint8Array[]): Uint8Array {
	if (parts.length === 1) return parts[0]
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.byteLength
	}
	return out
}
