/**
 * Independent PNG test encoder: Node's `zlib.crc32` and `deflateSync`, and a forward implementation
 * of all five scanline filters, so `src/utils/png-scale.ts` is checked against code it does not share.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib'

export const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export interface TestPngSpec {
	width: number
	height: number
	bitDepth: number
	colorType: number
	/** One entry per pixel, row-major: the samples (or palette index) of that pixel. */
	pixels: number[][]
	/** Filter type per row (cycled); defaults to 0. */
	filters?: number[]
	interlace?: number
	/** Extra chunks inserted after IHDR (before IDAT), e.g. PLTE/tRNS/gAMA/tEXt. */
	before?: Array<[string, Uint8Array]>
	/** Extra chunks inserted after IDAT. */
	after?: Array<[string, Uint8Array]>
	/** Override the zlib stream (for bombs / truncated data); `pixels` is then ignored. */
	idat?: Uint8Array
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = Buffer.alloc(12 + data.byteLength)
	out.writeUInt32BE(data.byteLength, 0)
	out.write(type, 4, 'latin1')
	out.set(data, 8)
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
	return out
}

export function ihdr(width: number, height: number, bitDepth: number, colorType: number, interlace = 0): Uint8Array {
	const data = Buffer.alloc(13)
	data.writeUInt32BE(width, 0)
	data.writeUInt32BE(height, 4)
	data.set([bitDepth, colorType, 0, 0, interlace], 8)
	return data
}

/** Pack row-major pixels into unfiltered scanlines (MSB-first for sub-byte depths, big-endian 16-bit). */
export function packRows(width: number, height: number, bitDepth: number, colorType: number, pixels: number[][]): Uint8Array[] {
	const channels = CHANNELS[colorType]
	const stride = Math.ceil((width * channels * bitDepth) / 8)
	const rows: Uint8Array[] = []
	for (let y = 0; y < height; y++) {
		const row = new Uint8Array(stride)
		let bit = 0
		for (let x = 0; x < width; x++) {
			for (const sample of pixels[y * width + x]) {
				if (bitDepth === 16) {
					row[bit >> 3] = sample >> 8
					row[(bit >> 3) + 1] = sample & 0xff
				} else {
					row[bit >> 3] |= sample << (8 - bitDepth - (bit & 7))
				}
				bit += bitDepth
			}
		}
		rows.push(row)
	}
	return rows
}

function filterRow(type: number, row: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
	const out = new Uint8Array(row.length + 1)
	out[0] = type
	for (let i = 0; i < row.length; i++) {
		const a = i >= bpp ? row[i - bpp] : 0
		const b = prev[i]
		const c = i >= bpp ? prev[i - bpp] : 0
		let predictor = 0
		if (type === 1) predictor = a
		else if (type === 2) predictor = b
		else if (type === 3) predictor = Math.floor((a + b) / 2)
		else if (type === 4) {
			const p = a + b - c
			const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
			predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
		}
		out[i + 1] = (row[i] - predictor) & 0xff
	}
	return out
}

function filterRows({ width, height, bitDepth, colorType, pixels, filters = [0] }: TestPngSpec): Uint8Array[] {
	const rows = packRows(width, height, bitDepth, colorType, pixels)
	const bpp = Math.max(1, (CHANNELS[colorType] * bitDepth) >> 3)
	return rows.map((row, y) => filterRow(filters[y % filters.length], row, rows[y - 1] ?? new Uint8Array(row.length), bpp))
}

export function encodeTestPng(spec: TestPngSpec): Uint8Array {
	const { width, height, bitDepth, colorType } = spec
	const idat = spec.idat ?? deflateSync(Buffer.concat(filterRows(spec)))
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr(width, height, bitDepth, colorType, spec.interlace ?? 0)),
		...(spec.before ?? []).map(([type, data]) => pngChunk(type, data)),
		pngChunk('IDAT', idat),
		...(spec.after ?? []).map(([type, data]) => pngChunk(type, data)),
		pngChunk('IEND', new Uint8Array(0)),
	])
}

/** Every chunk in a PNG, with its CRC checked by Node's zlib. */
export function readChunks(png: Uint8Array): Array<{ type: string; data: Uint8Array; raw: Uint8Array }> {
	const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
	const chunks = []
	for (let pos = 8; pos < buf.length; ) {
		const length = buf.readUInt32BE(pos)
		const end = pos + 12 + length
		if (crc32(buf.subarray(pos + 4, end - 4)) !== buf.readUInt32BE(end - 4)) throw new Error('bad CRC')
		chunks.push({ type: buf.toString('latin1', pos + 4, pos + 8), data: buf.subarray(pos + 8, end - 4), raw: buf.subarray(pos, end) })
		pos = end
	}
	return chunks
}

/** Inflate the concatenated IDAT of a PNG (raw filtered scanlines). */
export function inflateIdat(png: Uint8Array): Uint8Array {
	return inflateSync(Buffer.concat(readChunks(png).filter((c) => c.type === 'IDAT').map((c) => c.data)))
}
