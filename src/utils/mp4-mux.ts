/**
 * Pure-TypeScript H.264 + MP3 interleaved MP4 muxer for social link previews (Discord, iMessage).
 *
 * Produces a valid faststart ISO BMFF `.mp4` (`ftyp` + `moov` + `mdat`) with:
 * - Video: 1024x1024 H.264 Constrained Baseline (Level 4.0), 1 fps nominal, IDR every 30s,
 *   bit-exact `I_16x16` DC-only encoding of a 64x64 nearest-neighbor cover grid (`QP_Y = 28`,
 *   `chroma_qp_index_offset = -6`, BT.709 limited range) + SPS `bitstream_restriction`
 *   (`max_num_reorder_frames = 0`, `max_dec_frame_buffering = 1`) for immediate first-frame output.
 * - Audio: original MP3 frames copied verbatim (zero transcoding) under the `.mp3` (`0x2e6d7033`)
 *   audio sample entry, verified natively across Apple iOS/macOS AVFoundation, Chrome/Electron,
 *   Firefox (`mp4parse-rust`), Android Media3/ExoPlayer (`TYPE__mp3`), and FFmpeg.
 * - Interleaving: 1-second interleaved video + audio chunks inside `mdat` (max video/audio offset
 *   gap ~25 KB for smooth progressive streaming and seeking).
 */
import { HTTPException } from 'hono/http-exception'
import { decodePng, type DecodedPng } from './png-scale'

export const VIDEO_MUX_VERSION = 'v2'
export const VIDEO_WIDTH = 1024
export const VIDEO_HEIGHT = 1024
/** 9 MiB MP3 cap keeps MP4 + cover + HTML safely under Apple iMessage's 10 MB total budget. */
export const VIDEO_MAX_MP3_BYTES = 9 * 1024 * 1024
/** SMOL pixel-art covers are 64x64 (~2-15 KiB); cap at 512 KiB / 256x256 before PNG inflate. */
export const VIDEO_MAX_PNG_BYTES = 512 * 1024
export const VIDEO_MAX_COVER_SIDE = 256

const GRID = 64 // 64x64 macroblocks * 16 px = 1024x1024
const GOP_SECONDS = 30
const MP3_RESYNC_LIMIT = 4096
const MP3_MIN_COVERAGE = 0.98

function fail(message: string): never {
	throw new HTTPException(422, { message })
}

// ---------------------------------------------------------------------------
// Bitstream writer with H.264 RBSP emulation-prevention (00 00 00..03 -> 00 00 03 xx)
// ---------------------------------------------------------------------------

interface BitWriter {
	writeBits(val: number, count: number): void
	writeBit(bit: number): void
	writeUE(val: number): void
	writeSE(val: number): void
	rbspTrailingBits(): void
	toNalUnit(nalHeader: number): Uint8Array
}

function createBitWriter(initialCapacity = 1024): BitWriter {
	let buf = new Uint8Array(initialCapacity)
	let byteLen = 0
	let curByte = 0
	let bitCount = 0

	function pushByte(b: number): void {
		if (byteLen >= buf.length) {
			const next = new Uint8Array(buf.length * 2)
			next.set(buf)
			buf = next
		}
		buf[byteLen++] = b & 0xff
	}

	function writeBit(bit: number): void {
		curByte = (curByte << 1) | (bit & 1)
		bitCount++
		if (bitCount === 8) {
			pushByte(curByte)
			curByte = 0
			bitCount = 0
		}
	}

	function writeBits(val: number, count: number): void {
		for (let i = count - 1; i >= 0; i--) {
			writeBit((val >>> i) & 1)
		}
	}

	function writeUE(val: number): void {
		const code = val + 1
		let bits = 0
		for (let tmp = code; tmp > 0; tmp >>>= 1) bits++
		const leadingZeros = bits - 1
		for (let i = 0; i < leadingZeros; i++) writeBit(0)
		writeBits(code, bits)
	}

	function writeSE(val: number): void {
		const mapped = val <= 0 ? -2 * val : 2 * val - 1
		writeUE(mapped)
	}

	function rbspTrailingBits(): void {
		writeBit(1)
		while (bitCount !== 0) writeBit(0)
	}

	function toNalUnit(nalHeader: number): Uint8Array {
		// Worst-case emulation prevention adds 1 byte per 2 bytes
		const out = new Uint8Array(1 + byteLen + ((byteLen >>> 1) + 2))
		let pos = 0
		out[pos++] = nalHeader & 0xff
		let zeros = 0
		for (let i = 0; i < byteLen; i++) {
			const b = buf[i]
			if (zeros >= 2 && b <= 0x03) {
				out[pos++] = 0x03
				zeros = 0
			}
			out[pos++] = b
			zeros = b === 0 ? zeros + 1 : 0
		}
		return out.subarray(0, pos)
	}

	return { writeBits, writeBit, writeUE, writeSE, rbspTrailingBits, toNalUnit }
}

// ---------------------------------------------------------------------------
// PNG -> 64x64 BT.709 limited-range Y/Cb/Cr grid (pre-inflate dimension check)
// ---------------------------------------------------------------------------

function readPngDimensions(pngBytes: Uint8Array): { width: number; height: number } {
	if (pngBytes.byteLength < 24) fail('PNG cover is truncated')
	if (
		pngBytes[0] !== 0x89 ||
		pngBytes[1] !== 0x50 ||
		pngBytes[2] !== 0x4e ||
		pngBytes[3] !== 0x47 ||
		pngBytes[4] !== 0x0d ||
		pngBytes[5] !== 0x0a ||
		pngBytes[6] !== 0x1a ||
		pngBytes[7] !== 0x0a
	) {
		fail('PNG cover has invalid signature')
	}
	if (
		pngBytes[12] !== 0x49 ||
		pngBytes[13] !== 0x48 ||
		pngBytes[14] !== 0x44 ||
		pngBytes[15] !== 0x52
	) {
		fail('PNG cover missing IHDR')
	}
	const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength)
	return {
		width: view.getUint32(16),
		height: view.getUint32(20),
	}
}

function extractPalette(png: DecodedPng): Uint8Array | null {
	for (const raw of png.copiedChunks) {
		const type = String.fromCharCode(raw[4], raw[5], raw[6], raw[7])
		if (type === 'PLTE') return raw.subarray(8, raw.byteLength - 4)
	}
	return null
}

function extractTrns(png: DecodedPng): Uint8Array | null {
	for (const raw of png.copiedChunks) {
		const type = String.fromCharCode(raw[4], raw[5], raw[6], raw[7])
		if (type === 'tRNS') return raw.subarray(8, raw.byteLength - 4)
	}
	return null
}

function sampleRgb8(
	png: DecodedPng,
	palette: Uint8Array | null,
	trns: Uint8Array | null,
	x: number,
	y: number
): [number, number, number] {
	const rowStart = y * png.stride
	const { bitDepth, colorType, pixels } = png

	if (colorType === 3) {
		const mask = (1 << bitDepth) - 1
		const bitPos = x * bitDepth
		const idx = (pixels[rowStart + (bitPos >> 3)] >> (8 - bitDepth - (bitPos & 7))) & mask
		if (!palette || idx * 3 + 2 >= palette.byteLength) return [0, 0, 0]
		const r = palette[idx * 3]
		const g = palette[idx * 3 + 1]
		const b = palette[idx * 3 + 2]
		if (trns && idx < trns.byteLength) {
			const a = trns[idx]
			return [Math.round((r * a) / 255), Math.round((g * a) / 255), Math.round((b * a) / 255)]
		}
		return [r, g, b]
	}

	const sampleBytes = bitDepth === 16 ? 2 : 1
	if (colorType === 0) {
		if (bitDepth < 8) {
			const mask = (1 << bitDepth) - 1
			const bitPos = x * bitDepth
			const v = (pixels[rowStart + (bitPos >> 3)] >> (8 - bitDepth - (bitPos & 7))) & mask
			const gray = Math.round((v * 255) / mask)
			return [gray, gray, gray]
		}
		const v = pixels[rowStart + x * sampleBytes]
		return [v, v, v]
	}

	if (colorType === 4) {
		const o = rowStart + x * 2 * sampleBytes
		const v = pixels[o]
		const a = pixels[o + sampleBytes]
		const blended = Math.round((v * a) / 255)
		return [blended, blended, blended]
	}

	if (colorType === 2) {
		const o = rowStart + x * 3 * sampleBytes
		return [pixels[o], pixels[o + sampleBytes], pixels[o + 2 * sampleBytes]]
	}

	// colorType === 6 (RGBA) — composite onto black
	const o = rowStart + x * 4 * sampleBytes
	const a = pixels[o + 3 * sampleBytes]
	const r = Math.round((pixels[o] * a) / 255)
	const g = Math.round((pixels[o + sampleBytes] * a) / 255)
	const b = Math.round((pixels[o + 2 * sampleBytes] * a) / 255)
	return [r, g, b]
}

interface YuvGrid {
	y: Uint8Array
	cb: Uint8Array
	cr: Uint8Array
}

function pngToYuvGrid64(pngBytes: Uint8Array): YuvGrid {
	if (pngBytes.byteLength > VIDEO_MAX_PNG_BYTES) {
		fail(`PNG cover exceeds ${VIDEO_MAX_PNG_BYTES} byte limit`)
	}
	const dims = readPngDimensions(pngBytes)
	if (dims.width === 0 || dims.height === 0 || dims.width > VIDEO_MAX_COVER_SIDE || dims.height > VIDEO_MAX_COVER_SIDE) {
		fail(`PNG cover dimensions ${dims.width}x${dims.height} exceed ${VIDEO_MAX_COVER_SIDE}x${VIDEO_MAX_COVER_SIDE} limit`)
	}

	const decoded = decodePng(pngBytes)
	const palette = extractPalette(decoded)
	const trns = extractTrns(decoded)
	const yOut = new Uint8Array(GRID * GRID)
	const cbOut = new Uint8Array(GRID * GRID)
	const crOut = new Uint8Array(GRID * GRID)

	for (let gy = 0; gy < GRID; gy++) {
		const sy = Math.min(decoded.height - 1, Math.floor((gy * decoded.height) / GRID))
		for (let gx = 0; gx < GRID; gx++) {
			const sx = Math.min(decoded.width - 1, Math.floor((gx * decoded.width) / GRID))
			const [r, g, b] = sampleRgb8(decoded, palette, trns, sx, sy)
			// BT.709 limited-range (Y: 16..235, Cb/Cr: 16..240)
			const yVal = Math.round(16 + (0.2126 * r + 0.7152 * g + 0.0722 * b) * (219 / 255))
			const cbVal = Math.round(128 + (-0.114572 * r - 0.385428 * g + 0.5 * b) * (224 / 255))
			const crVal = Math.round(128 + (0.5 * r - 0.454153 * g - 0.045847 * b) * (224 / 255))
			const idx = gy * GRID + gx
			yOut[idx] = Math.max(16, Math.min(235, yVal))
			cbOut[idx] = Math.max(16, Math.min(240, cbVal))
			crOut[idx] = Math.max(16, Math.min(240, crVal))
		}
	}

	return { y: yOut, cb: cbOut, cr: crOut }
}

// ---------------------------------------------------------------------------
// H.264 Constrained Baseline SPS / PPS / I_16x16 DC-only IDR / P-skip
// ---------------------------------------------------------------------------

function encodeSps(): Uint8Array {
	const w = createBitWriter(64)
	w.writeBits(66, 8) // profile_idc = 66 (Baseline)
	w.writeBit(1) // constraint_set0_flag = 1
	w.writeBit(1) // constraint_set1_flag = 1 (Constrained Baseline)
	w.writeBit(0) // constraint_set2_flag
	w.writeBit(0) // constraint_set3_flag
	w.writeBit(0) // constraint_set4_flag
	w.writeBit(0) // constraint_set5_flag
	w.writeBits(0, 2) // reserved_zero_2bits
	w.writeBits(40, 8) // level_idc = 40 (Level 4.0: 4096 macroblocks @ 1024x1024)
	w.writeUE(0) // seq_parameter_set_id = 0
	w.writeUE(0) // log2_max_frame_num_minus4 = 0 (maxFrameNum = 16)
	w.writeUE(2) // pic_order_cnt_type = 2 (display order == decode order)
	w.writeUE(1) // max_num_ref_frames = 1
	w.writeBit(0) // gaps_in_frame_num_value_allowed_flag = 0
	w.writeUE(GRID - 1) // pic_width_in_mbs_minus1 = 63 (1024 px)
	w.writeUE(GRID - 1) // pic_height_in_map_units_minus1 = 63 (1024 px)
	w.writeBit(1) // frame_mbs_only_flag = 1
	w.writeBit(1) // direct_8x8_inference_flag = 1
	w.writeBit(0) // frame_cropping_flag = 0

	// VUI parameters: BT.709 limited-range, 1 fps nominal, immediate DPB output (no reorder delay)
	w.writeBit(1) // vui_parameters_present_flag = 1
	w.writeBit(0) // aspect_ratio_info_present_flag = 0
	w.writeBit(0) // overscan_info_present_flag = 0
	w.writeBit(1) // video_signal_type_present_flag = 1
	w.writeBits(5, 3) // video_format = 5 (Unspecified)
	w.writeBit(0) // video_full_range_flag = 0 (limited)
	w.writeBit(1) // colour_description_present_flag = 1
	w.writeBits(1, 8) // colour_primaries = 1 (BT.709)
	w.writeBits(1, 8) // transfer_characteristics = 1 (BT.709)
	w.writeBits(1, 8) // matrix_coefficients = 1 (BT.709)
	w.writeBit(0) // chroma_loc_info_present_flag = 0
	w.writeBit(1) // timing_info_present_flag = 1
	w.writeBits(1, 32) // num_units_in_tick = 1
	w.writeBits(2, 32) // time_scale = 2 (1 fps nominal)
	w.writeBit(0) // fixed_frame_rate_flag = 0 (last frame absorbs remainder)
	w.writeBit(0) // nal_hrd_parameters_present_flag = 0
	w.writeBit(0) // vcl_hrd_parameters_present_flag = 0
	w.writeBit(0) // pic_struct_present_flag = 0
	// bitstream_restriction_flag = 1 (x264-standard zero-reorder / 1-frame DPB)
	w.writeBit(1) // bitstream_restriction_flag = 1
	w.writeBit(1) // motion_vectors_over_pic_boundaries_flag = 1
	w.writeUE(0) // max_bytes_per_pic_denom = 0
	w.writeUE(0) // max_bits_per_mb_denom = 0
	w.writeUE(0) // log2_max_mv_length_horizontal = 0
	w.writeUE(0) // log2_max_mv_length_vertical = 0
	w.writeUE(0) // max_num_reorder_frames = 0
	w.writeUE(1) // max_dec_frame_buffering = 1

	w.rbspTrailingBits()
	return w.toNalUnit(0x67) // nal_ref_idc=3, nal_unit_type=7 (SPS)
}

function encodePps(): Uint8Array {
	const w = createBitWriter(32)
	w.writeUE(0) // pic_parameter_set_id = 0
	w.writeUE(0) // seq_parameter_set_id = 0
	w.writeBit(0) // entropy_coding_mode_flag = 0 (CAVLC)
	w.writeBit(0) // bottom_field_pic_order_in_frame_present_flag = 0
	w.writeUE(0) // num_slice_groups_minus1 = 0
	w.writeUE(0) // num_ref_idx_l0_default_active_minus1 = 0
	w.writeUE(0) // num_ref_idx_l1_default_active_minus1 = 0
	w.writeBit(0) // weighted_pred_flag = 0
	w.writeBits(0, 2) // weighted_bipred_idc = 0
	// Exact 1:1 DC pixel delta:
	//   Luma:   QP_Y = 28 -> LevelScale(28%6=4,0,0)=16*16=256 -> ((f*256)<<2 + 2)>>2 = 256f -> /4 = 64f -> (64f+32)>>6 = f
	//   Chroma: QP_C = 22 -> LevelScale(22%6=4,0,0)=16*16=256 -> (f*256<<3)>>5 = 64f -> (64f+32)>>6 = f
	w.writeSE(2) // pic_init_qp_minus26 = +2 -> QP_Y = 28
	w.writeSE(0) // pic_init_qs_minus26 = 0
	w.writeSE(-6) // chroma_qp_index_offset = -6 -> QP_C = 22
	w.writeBit(1) // deblocking_filter_control_present_flag = 1
	w.writeBit(0) // constrained_intra_pred_flag = 0
	w.writeBit(0) // redundant_pic_cnt_present_flag = 0
	w.rbspTrailingBits()
	return w.toNalUnit(0x68) // nal_ref_idc=3, nal_unit_type=8 (PPS)
}

/**
 * Write a single DC coefficient (`val` at scan index 0, all other coefficients 0) using CAVLC.
 * - `isChroma = false`: Intra16x16 Luma DC (`nC = 0` table, 16-entry block)
 * - `isChroma = true`: 4:2:0 Chroma DC (`nC = -1` table, 4-entry block)
 */
function writeSingleDcCavlc(w: BitWriter, val: number, isChroma: boolean): void {
	if (val === 0) {
		if (isChroma) {
			// Table 9-5 nC=-1: TotalCoeff=0, TrailingOnes=0 -> "01" (2 bits)
			w.writeBits(0b01, 2)
		} else {
			// Table 9-5 0<=nC<2: TotalCoeff=0, TrailingOnes=0 -> "1" (1 bit)
			w.writeBit(1)
		}
		return
	}

	const sign = val < 0 ? 1 : 0
	const absVal = Math.abs(val)

	if (absVal === 1) {
		// TotalCoeff=1, TrailingOnes=1
		if (isChroma) {
			w.writeBit(1) // nC=-1: TC=1, T1=1 -> "1"
		} else {
			w.writeBits(0b01, 2) // 0<=nC<2: TC=1, T1=1 -> "01"
		}
		w.writeBit(sign) // trailing_ones_sign_flag
	} else {
		// TotalCoeff=1, TrailingOnes=0
		if (isChroma) {
			w.writeBits(0b000111, 6) // nC=-1: TC=1, T1=0 -> "000111"
		} else {
			w.writeBits(0b000101, 6) // 0<=nC<2: TC=1, T1=0 -> "000101"
		}
		// Level encoding with suffixLength = 0 (ITU-T H.264 §9.2.2):
		// When i == TrailingOnes and TrailingOnes < 3 (here i=0, T1=0), the decoder adds +2 to
		// levelCode before converting to signed level, so the encoder subtracts 2 (absVal >= 2).
		const levelCode = 2 * (absVal - 2) + sign
		if (levelCode < 14) {
			// level_prefix = levelCode (0..13), 0-bit suffix
			for (let i = 0; i < levelCode; i++) w.writeBit(0)
			w.writeBit(1)
		} else if (levelCode < 30) {
			// Escape 1: level_prefix = 14, 4-bit suffix = levelCode - 14
			for (let i = 0; i < 14; i++) w.writeBit(0)
			w.writeBit(1)
			w.writeBits(levelCode - 14, 4)
		} else {
			// Escape 2: level_prefix = 15, 12-bit suffix = levelCode - 30 (covers up to |val| <= 2063)
			for (let i = 0; i < 15; i++) w.writeBit(0)
			w.writeBit(1)
			w.writeBits(levelCode - 30, 12)
		}
	}

	// total_zeros = 0 (since the single non-zero coeff is at DC index 0):
	//   Chroma DC (maxNumCoeff=4, TC=1): Table 9-9(a) -> "1" (1 bit)
	//   Luma DC   (maxNumCoeff=16, TC=1): Table 9-7   -> "1" (1 bit)
	w.writeBit(1)
}

function encodeIdrSlice(grid: YuvGrid, idrPicId: number): Uint8Array {
	const w = createBitWriter(32768)
	// Slice header (IDR, I-slice)
	w.writeUE(0) // first_mb_in_slice = 0
	w.writeUE(7) // slice_type = 7 (I, all slices in pic are I)
	w.writeUE(0) // pic_parameter_set_id = 0
	w.writeBits(0, 4) // frame_num = 0 (IDR)
	w.writeUE(idrPicId & 0xffff) // idr_pic_id
	w.writeBit(0) // no_output_of_prior_pics_flag = 0
	w.writeBit(0) // long_term_reference_flag = 0
	w.writeSE(0) // slice_qp_delta = 0
	w.writeUE(1) // disable_deblocking_filter_idc = 1 (preserve crisp 16x16 pixel-art blocks)

	const reconY = new Uint8Array(GRID * GRID)
	const reconCb = new Uint8Array(GRID * GRID)
	const reconCr = new Uint8Array(GRID * GRID)

	for (let my = 0; my < GRID; my++) {
		for (let mx = 0; mx < GRID; mx++) {
			const idx = my * GRID + mx
			let mbType: number
			let chromaMode: number
			let predY: number
			let predCb: number
			let predCr: number

			if (mx === 0 && my === 0) {
				// Top-left MB: DC prediction (128)
				mbType = 7 // I_16x16_2_1_0 (DC, cbp_chroma=1, cbp_luma=0)
				chromaMode = 0 // DC
				predY = 128
				predCb = 128
				predCr = 128
			} else if (mx > 0) {
				// Horizontal prediction from left neighbor
				mbType = 6 // I_16x16_1_1_0 (Horizontal, cbp_chroma=1, cbp_luma=0)
				chromaMode = 1 // Horizontal
				predY = reconY[idx - 1]
				predCb = reconCb[idx - 1]
				predCr = reconCr[idx - 1]
			} else {
				// First column (my > 0): Vertical prediction from top neighbor
				mbType = 5 // I_16x16_0_1_0 (Vertical, cbp_chroma=1, cbp_luma=0)
				chromaMode = 2 // Vertical
				predY = reconY[idx - GRID]
				predCb = reconCb[idx - GRID]
				predCr = reconCr[idx - GRID]
			}

			w.writeUE(mbType)
			w.writeUE(chromaMode)
			w.writeSE(0) // mb_qp_delta = 0

			const dY = grid.y[idx] - predY
			const dCb = grid.cb[idx] - predCb
			const dCr = grid.cr[idx] - predCr

			writeSingleDcCavlc(w, dY, false)
			writeSingleDcCavlc(w, dCb, true)
			writeSingleDcCavlc(w, dCr, true)

			reconY[idx] = Math.max(0, Math.min(255, predY + dY))
			reconCb[idx] = Math.max(0, Math.min(255, predCb + dCb))
			reconCr[idx] = Math.max(0, Math.min(255, predCr + dCr))
		}
	}

	w.rbspTrailingBits()
	return w.toNalUnit(0x65) // nal_ref_idc=3, nal_unit_type=5 (IDR slice)
}

function encodePSkipSlice(frameNum: number): Uint8Array {
	const w = createBitWriter(16)
	w.writeUE(0) // first_mb_in_slice = 0
	w.writeUE(5) // slice_type = 5 (P, all slices in pic are P)
	w.writeUE(0) // pic_parameter_set_id = 0
	w.writeBits(frameNum & 0x0f, 4) // frame_num (4-bit modulo 16)
	w.writeBit(0) // num_ref_idx_active_override_flag = 0
	w.writeBit(0) // ref_pic_list_modification_flag_l0 = 0
	w.writeBit(0) // adaptive_ref_pic_marking_mode_flag = 0 (sliding window)
	w.writeSE(0) // slice_qp_delta = 0
	w.writeUE(1) // disable_deblocking_filter_idc = 1
	w.writeUE(GRID * GRID) // mb_skip_run = 4096 (skip all macroblocks)
	w.rbspTrailingBits()
	return w.toNalUnit(0x41) // nal_ref_idc=2 (ref picture), nal_unit_type=1 (non-IDR slice)
}

function lengthPrefixedNal(nal: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + nal.byteLength)
	const dv = new DataView(out.buffer)
	dv.setUint32(0, nal.byteLength)
	out.set(nal, 4)
	return out
}

// ---------------------------------------------------------------------------
// MP3 frame parser with ID3v2/ID3v1/APEv2 trimming, resync & coverage check
// ---------------------------------------------------------------------------

// Bitrate tables (kbps) for Layer III
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]

// Sample rate tables by MPEG version id (0=2.5, 2=2, 3=1)
const SAMPLE_RATES: Record<number, readonly [number, number, number]> = {
	3: [44100, 48000, 32000],
	2: [22050, 24000, 16000],
	0: [11025, 12000, 8000],
}

interface ParsedMp3Header {
	mpegVersion: number
	sampleRate: number
	channels: number
	samplesPerFrame: number
	frameSize: number
	bitrate: number
	sideInfoSize: number
}

function parseMp3FrameHeader(data: Uint8Array, offset: number): ParsedMp3Header | null {
	if (offset + 4 > data.byteLength) return null
	const b0 = data[offset]
	const b1 = data[offset + 1]
	const b2 = data[offset + 2]
	const b3 = data[offset + 3]

	if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null
	const mpegVersion = (b1 >>> 3) & 0x03
	if (mpegVersion === 1) return null // reserved
	const layer = (b1 >>> 1) & 0x03
	if (layer !== 1) return null // only Layer III (MP3)

	const bitrateIdx = (b2 >>> 4) & 0x0f
	if (bitrateIdx === 0 || bitrateIdx === 15) return null // free-format or bad
	const srIdx = (b2 >>> 2) & 0x03
	if (srIdx === 3) return null // reserved
	const padding = (b2 >>> 1) & 0x01
	const channelMode = (b3 >>> 6) & 0x03
	const channels = channelMode === 3 ? 1 : 2

	const rates = SAMPLE_RATES[mpegVersion]
	if (!rates) return null
	const sampleRate = rates[srIdx]
	const bitrateKbps = mpegVersion === 3 ? BITRATES_V1_L3[bitrateIdx] : BITRATES_V2_L3[bitrateIdx]
	if (!bitrateKbps) return null
	const bitrate = bitrateKbps * 1000
	const samplesPerFrame = mpegVersion === 3 ? 1152 : 576
	const frameSize = Math.floor(((mpegVersion === 3 ? 144 : 72) * bitrate) / sampleRate) + padding
	if (frameSize < 24) return null

	const sideInfoSize = mpegVersion === 3 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17)
	return { mpegVersion, sampleRate, channels, samplesPerFrame, frameSize, bitrate, sideInfoSize }
}

function skipLeadingId3v2(data: Uint8Array): number {
	let pos = 0
	while (
		pos + 10 <= data.byteLength &&
		data[pos] === 0x49 &&
		data[pos + 1] === 0x44 &&
		data[pos + 2] === 0x33
	) {
		const flags = data[pos + 5]
		const size =
			((data[pos + 6] & 0x7f) << 21) |
			((data[pos + 7] & 0x7f) << 14) |
			((data[pos + 8] & 0x7f) << 7) |
			(data[pos + 9] & 0x7f)
		const footer = (flags & 0x10) !== 0 ? 10 : 0
		const next = pos + 10 + size + footer
		if (next > data.byteLength) fail('MP3 has truncated ID3v2 tag')
		pos = next
	}
	return pos
}

function trimTrailingTags(data: Uint8Array, start: number): number {
	let end = data.byteLength
	// Trailing ID3v1 tag (128 bytes starting with "TAG")
	if (end - start >= 128 && data[end - 128] === 0x54 && data[end - 127] === 0x41 && data[end - 126] === 0x47) {
		end -= 128
	}
	// Trailing APEv2 tag footer (32 bytes starting with "APETAGEX")
	if (
		end - start >= 32 &&
		data[end - 32] === 0x41 &&
		data[end - 31] === 0x50 &&
		data[end - 30] === 0x45 &&
		data[end - 29] === 0x54 &&
		data[end - 28] === 0x41 &&
		data[end - 27] === 0x47 &&
		data[end - 26] === 0x45 &&
		data[end - 25] === 0x58
	) {
		const dv = new DataView(data.buffer, data.byteOffset + end - 32, 32)
		const tagSize = dv.getUint32(12, true) // includes footer, excludes optional 32-byte header
		const flags = dv.getUint32(20, true)
		const hasHeader = (flags & 0x80000000) !== 0 ? 32 : 0
		const totalApe = tagSize + hasHeader
		if (totalApe >= 32 && end - totalApe >= start) {
			end -= totalApe
		}
	}
	return end
}

function isVbrMetadataFrame(data: Uint8Array, offset: number, hdr: ParsedMp3Header): boolean {
	const xingOff = offset + 4 + hdr.sideInfoSize
	if (xingOff + 4 <= offset + hdr.frameSize) {
		const m0 = data[xingOff]
		const m1 = data[xingOff + 1]
		const m2 = data[xingOff + 2]
		const m3 = data[xingOff + 3]
		if (
			(m0 === 0x58 && m1 === 0x69 && m2 === 0x6e && m3 === 0x67) || // "Xing"
			(m0 === 0x49 && m1 === 0x6e && m2 === 0x66 && m3 === 0x6f) // "Info"
		) {
			return true
		}
	}
	const vbriOff = offset + 4 + 32
	if (vbriOff + 4 <= offset + hdr.frameSize) {
		if (
			data[vbriOff] === 0x56 &&
			data[vbriOff + 1] === 0x42 &&
			data[vbriOff + 2] === 0x52 &&
			data[vbriOff + 3] === 0x49 // "VBRI"
		) {
			return true
		}
	}
	return false
}

export interface ParsedMp3 {
	mpegVersion: number
	sampleRate: number
	channels: number
	samplesPerFrame: number
	offsets: number[]
	sizes: number[]
	totalAudioBytes: number
	totalSamples: number
	durationMs: number
	avgBitrate: number
	maxBitrate: number
	coverage: number
}

export function parseMp3Frames(data: Uint8Array): ParsedMp3 {
	if (data.byteLength < 64) fail('MP3 audio is too short')
	const audioStart = skipLeadingId3v2(data)
	const audioEnd = trimTrailingTags(data, audioStart)
	if (audioEnd <= audioStart) fail('MP3 contains no audio payload')

	// Find first valid sync frame (requiring consecutive match if stream continues)
	let pos = -1
	let firstHdr: ParsedMp3Header | null = null
	const initialScanLimit = Math.min(audioEnd - 4, audioStart + MP3_RESYNC_LIMIT)
	for (let i = audioStart; i <= initialScanLimit; i++) {
		const h = parseMp3FrameHeader(data, i)
		if (!h || i + h.frameSize > audioEnd) continue
		const nextPos = i + h.frameSize
		if (nextPos === audioEnd) {
			pos = i
			firstHdr = h
			break
		}
		const h2 = parseMp3FrameHeader(data, nextPos)
		if (h2 && h2.mpegVersion === h.mpegVersion && h2.sampleRate === h.sampleRate && nextPos + h2.frameSize <= audioEnd) {
			pos = i
			firstHdr = h
			break
		}
	}

	if (pos < 0 || !firstHdr) fail('No valid MP3 Layer III frames found')

	// Skip layout-specific Xing/Info/VBRI header frame if present at the start
	let payloadBaselineStart = pos
	if (isVbrMetadataFrame(data, pos, firstHdr)) {
		pos += firstHdr.frameSize
		payloadBaselineStart = pos
		const next = parseMp3FrameHeader(data, pos)
		if (!next || pos + next.frameSize > audioEnd) {
			fail('MP3 contains only a VBR metadata frame')
		}
		firstHdr = next
	}

	const { mpegVersion, sampleRate, channels, samplesPerFrame } = firstHdr
	const offsets: number[] = []
	const sizes: number[] = []
	let totalAudioBytes = 0
	let maxBitrate = 0

	while (pos + 4 <= audioEnd) {
		const hdr = parseMp3FrameHeader(data, pos)
		if (
			hdr &&
			hdr.mpegVersion === mpegVersion &&
			hdr.sampleRate === sampleRate &&
			hdr.channels === channels &&
			pos + hdr.frameSize <= audioEnd
		) {
			offsets.push(pos)
			sizes.push(hdr.frameSize)
			totalAudioBytes += hdr.frameSize
			if (hdr.bitrate > maxBitrate) maxBitrate = hdr.bitrate
			pos += hdr.frameSize
			continue
		}

		// Resync forward within bounded window instead of truncating silently
		let resynced = -1
		const limit = Math.min(audioEnd - 4, pos + MP3_RESYNC_LIMIT)
		for (let s = pos + 1; s <= limit; s++) {
			const cand = parseMp3FrameHeader(data, s)
			if (
				!cand ||
				cand.mpegVersion !== mpegVersion ||
				cand.sampleRate !== sampleRate ||
				cand.channels !== channels ||
				s + cand.frameSize > audioEnd
			) {
				continue
			}
			const after = s + cand.frameSize
			if (after === audioEnd) {
				resynced = s
				break
			}
			const next = parseMp3FrameHeader(data, after)
			if (
				next &&
				next.mpegVersion === mpegVersion &&
				next.sampleRate === sampleRate &&
				next.channels === channels &&
				after + next.frameSize <= audioEnd
			) {
				resynced = s
				break
			}
		}

		if (resynced < 0) break
		pos = resynced
	}

	if (offsets.length === 0) fail('No valid MP3 audio frames found')

	const payloadSpan = Math.max(1, audioEnd - payloadBaselineStart)
	const coverage = totalAudioBytes / payloadSpan
	if (coverage < MP3_MIN_COVERAGE) {
		fail(`MP3 stream integrity below threshold (${(coverage * 100).toFixed(1)}% valid audio frames)`)
	}

	const totalSamples = offsets.length * samplesPerFrame
	const durationMs = Math.max(1, Math.round((totalSamples * 1000) / sampleRate))
	if (durationMs < 100) fail('MP3 audio is shorter than 100 ms')
	const avgBitrate = Math.round((totalAudioBytes * 8 * sampleRate) / totalSamples)

	return {
		mpegVersion,
		sampleRate,
		channels,
		samplesPerFrame,
		offsets,
		sizes,
		totalAudioBytes,
		totalSamples,
		durationMs,
		avgBitrate,
		maxBitrate,
		coverage,
	}
}

// ---------------------------------------------------------------------------
// ISO BMFF / MP4 box builders
// ---------------------------------------------------------------------------

function concatBytes(parts: Uint8Array[]): Uint8Array {
	let total = 0
	for (const p of parts) total += p.byteLength
	const out = new Uint8Array(total)
	let pos = 0
	for (const p of parts) {
		out.set(p, pos)
		pos += p.byteLength
	}
	return out
}

function u32(val: number): Uint8Array {
	const b = new Uint8Array(4)
	new DataView(b.buffer).setUint32(0, val >>> 0)
	return b
}

function ascii(str: string): Uint8Array {
	const b = new Uint8Array(str.length)
	for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i)
	return b
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
	let size = 8
	for (const p of payloads) size += p.byteLength
	const out = new Uint8Array(size)
	new DataView(out.buffer).setUint32(0, size)
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
	let pos = 8
	for (const p of payloads) {
		out.set(p, pos)
		pos += p.byteLength
	}
	return out
}

function fullBox(type: string, version: number, flags: number, ...payloads: Uint8Array[]): Uint8Array {
	const vf = new Uint8Array(4)
	vf[0] = version & 0xff
	vf[1] = (flags >>> 16) & 0xff
	vf[2] = (flags >>> 8) & 0xff
	vf[3] = flags & 0xff
	return box(type, vf, ...payloads)
}

function buildFtyp(): Uint8Array {
	return box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'))
}

function buildMvhd(durationMs: number): Uint8Array {
	const p = new Uint8Array(96)
	const dv = new DataView(p.buffer)
	dv.setUint32(8, 1000) // timescale = 1000 (ms)
	dv.setUint32(12, durationMs)
	dv.setUint32(16, 0x00010000) // rate = 1.0
	dv.setUint16(20, 0x0100) // volume = 1.0
	// Identity matrix
	dv.setUint32(32, 0x00010000)
	dv.setUint32(48, 0x00010000)
	dv.setUint32(64, 0x40000000)
	dv.setUint32(92, 3) // next_track_ID = 3
	return fullBox('mvhd', 0, 0, p)
}

function buildTkhd(trackId: number, durationMs: number, isAudio: boolean, width: number, height: number): Uint8Array {
	const p = new Uint8Array(80)
	const dv = new DataView(p.buffer)
	dv.setUint32(8, trackId)
	dv.setUint32(16, durationMs)
	if (isAudio) dv.setUint16(32, 0x0100) // volume = 1.0
	// Identity matrix
	dv.setUint32(36, 0x00010000)
	dv.setUint32(52, 0x00010000)
	dv.setUint32(68, 0x40000000)
	if (!isAudio) {
		dv.setUint32(72, width << 16)
		dv.setUint32(76, height << 16)
	}
	return fullBox('tkhd', 0, 0x000003, p) // track_enabled | track_in_movie
}

function buildMdhd(timescale: number, duration: number): Uint8Array {
	const p = new Uint8Array(20)
	const dv = new DataView(p.buffer)
	dv.setUint32(8, timescale)
	dv.setUint32(12, duration)
	dv.setUint16(16, 0x55c4) // language = 'und'
	return fullBox('mdhd', 0, 0, p)
}

function buildHdlr(handlerType: 'vide' | 'soun', name: string): Uint8Array {
	return fullBox('hdlr', 0, 0, new Uint8Array(4), ascii(handlerType), new Uint8Array(12), ascii(name + '\0'))
}

function buildDinf(): Uint8Array {
	const urlBox = fullBox('url ', 0, 0x000001)
	const dref = fullBox('dref', 0, 0, u32(1), urlBox)
	return box('dinf', dref)
}

function buildAvc1SampleEntry(sps: Uint8Array, pps: Uint8Array): Uint8Array {
	const header = new Uint8Array(78)
	const dv = new DataView(header.buffer)
	dv.setUint16(6, 1) // data_reference_index = 1
	dv.setUint16(24, VIDEO_WIDTH)
	dv.setUint16(26, VIDEO_HEIGHT)
	dv.setUint32(28, 0x00480000) // horizresolution = 72 dpi
	dv.setUint32(32, 0x00480000) // vertresolution = 72 dpi
	dv.setUint16(40, 1) // frame_count = 1
	dv.setUint16(74, 0x0018) // depth = 24
	dv.setInt16(76, -1) // pre_defined = -1

	const avcC = new Uint8Array(11 + sps.byteLength + pps.byteLength)
	const cdv = new DataView(avcC.buffer)
	avcC[0] = 1 // configurationVersion
	avcC[1] = sps[1] // AVCProfileIndication (66)
	avcC[2] = sps[2] // profile_compatibility (0xC0)
	avcC[3] = sps[3] // AVCLevelIndication (40)
	avcC[4] = 0xff // 6 reserved '1' + lengthSizeMinusOne=3 (4-byte NAL length)
	avcC[5] = 0xe1 // 3 reserved '1' + numOfSequenceParameterSets=1
	cdv.setUint16(6, sps.byteLength)
	avcC.set(sps, 8)
	const ppsOff = 8 + sps.byteLength
	avcC[ppsOff] = 1 // numOfPictureParameterSets=1
	cdv.setUint16(ppsOff + 1, pps.byteLength)
	avcC.set(pps, ppsOff + 3)

	return box('avc1', header, box('avcC', avcC))
}

/**
 * `.mp3` (`0x2e6d7033`) AudioSampleEntry — plays natively on Apple iOS/macOS AVFoundation,
 * Chrome/Electron, Firefox (`mp4parse-rust`), Android Media3/ExoPlayer, and FFmpeg.
 */
function buildDotMp3SampleEntry(mp3: ParsedMp3): Uint8Array {
	const header = new Uint8Array(28)
	const dv = new DataView(header.buffer)
	dv.setUint16(6, 1) // data_reference_index = 1
	dv.setUint16(16, mp3.channels) // channelcount
	dv.setUint16(18, 16) // samplesize = 16
	dv.setUint32(24, (mp3.sampleRate << 16) >>> 0) // 16.16 fixed-point sample rate
	return box('.mp3', header)
}

function buildStts(entries: Array<[count: number, delta: number]>): Uint8Array {
	const buf = new Uint8Array(4 + entries.length * 8)
	const dv = new DataView(buf.buffer)
	dv.setUint32(0, entries.length)
	for (let i = 0; i < entries.length; i++) {
		dv.setUint32(4 + i * 8, entries[i][0])
		dv.setUint32(8 + i * 8, entries[i][1])
	}
	return fullBox('stts', 0, 0, buf)
}

function buildStss(syncSampleNumbers: number[]): Uint8Array {
	const buf = new Uint8Array(4 + syncSampleNumbers.length * 4)
	const dv = new DataView(buf.buffer)
	dv.setUint32(0, syncSampleNumbers.length)
	for (let i = 0; i < syncSampleNumbers.length; i++) {
		dv.setUint32(4 + i * 4, syncSampleNumbers[i])
	}
	return fullBox('stss', 0, 0, buf)
}

function buildStsc(entries: Array<[firstChunk: number, samplesPerChunk: number]>): Uint8Array {
	const buf = new Uint8Array(4 + entries.length * 12)
	const dv = new DataView(buf.buffer)
	dv.setUint32(0, entries.length)
	for (let i = 0; i < entries.length; i++) {
		dv.setUint32(4 + i * 12, entries[i][0])
		dv.setUint32(8 + i * 12, entries[i][1])
		dv.setUint32(12 + i * 12, 1) // sample_description_index = 1
	}
	return fullBox('stsc', 0, 0, buf)
}

function buildStsz(sizes: number[]): Uint8Array {
	const buf = new Uint8Array(8 + sizes.length * 4)
	const dv = new DataView(buf.buffer)
	dv.setUint32(0, 0) // sample_size = 0 (variable)
	dv.setUint32(4, sizes.length)
	for (let i = 0; i < sizes.length; i++) {
		dv.setUint32(8 + i * 4, sizes[i])
	}
	return fullBox('stsz', 0, 0, buf)
}

function buildStco(chunkOffsets: number[]): Uint8Array {
	const buf = new Uint8Array(4 + chunkOffsets.length * 4)
	const dv = new DataView(buf.buffer)
	dv.setUint32(0, chunkOffsets.length)
	for (let i = 0; i < chunkOffsets.length; i++) {
		dv.setUint32(4 + i * 4, chunkOffsets[i] >>> 0)
	}
	return fullBox('stco', 0, 0, buf)
}

/** Run-length encode per-chunk sample counts into compact `stsc` entries (1-based chunk indices). */
function compressStsc(chunkCounts: number[]): Array<[number, number]> {
	const out: Array<[number, number]> = []
	let prev = -1
	for (let i = 0; i < chunkCounts.length; i++) {
		if (chunkCounts[i] !== prev) {
			out.push([i + 1, chunkCounts[i]])
			prev = chunkCounts[i]
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Public mux entrypoint
// ---------------------------------------------------------------------------

export interface MuxedMp4Result {
	mp4: Uint8Array
	durationMs: number
	videoFrames: number
	audioFrames: number
	sampleRate: number
	channels: number
	maxInterleaveGapBytes: number
}

export function muxCoverAndMp3ToMp4(pngBytes: Uint8Array, mp3Bytes: Uint8Array): MuxedMp4Result {
	if (mp3Bytes.byteLength > VIDEO_MAX_MP3_BYTES) {
		fail(`MP3 audio exceeds ${VIDEO_MAX_MP3_BYTES} byte limit`)
	}
	const mp3 = parseMp3Frames(mp3Bytes)
	const grid = pngToYuvGrid64(pngBytes)

	const sps = encodeSps()
	const pps = encodePps()
	const idrBase = encodeIdrSlice(grid, 0)
	const idrSample = lengthPrefixedNal(idrBase)

	// Pre-encode the P-skip slices for frame_num 1..GOP_SECONDS-1 (modulo 16)
	const pSkipByFrameNum = new Map<number, Uint8Array>()
	for (let fn = 0; fn < 16; fn++) {
		pSkipByFrameNum.set(fn, lengthPrefixedNal(encodePSkipSlice(fn)))
	}

	const durationMs = mp3.durationMs
	const wholeSeconds = Math.floor(durationMs / 1000)
	const remainderMs = durationMs - wholeSeconds * 1000

	// Build 1 fps video samples; last frame absorbs any <250ms remainder (or gets its own frame if >=250ms)
	const videoSamples: Uint8Array[] = []
	const videoDurations: number[] = []
	const syncSamples: number[] = []
	const frameCount = wholeSeconds === 0 ? 1 : remainderMs >= 250 ? wholeSeconds + 1 : wholeSeconds

	for (let i = 0; i < frameCount; i++) {
		const posInGop = i % GOP_SECONDS
		if (posInGop === 0) {
			const gopIndex = Math.floor(i / GOP_SECONDS)
			const sample = gopIndex === 0 ? idrSample : lengthPrefixedNal(encodeIdrSlice(grid, gopIndex))
			videoSamples.push(sample)
			syncSamples.push(i + 1) // 1-based sample number
		} else {
			videoSamples.push(pSkipByFrameNum.get(posInGop & 0x0f)!)
		}

		if (wholeSeconds === 0) {
			videoDurations.push(durationMs)
		} else if (i === frameCount - 1) {
			videoDurations.push(remainderMs >= 250 ? remainderMs : 1000 + remainderMs)
		} else {
			videoDurations.push(1000)
		}
	}

	// Build video stts entries (merge consecutive identical durations)
	const videoStts: Array<[number, number]> = []
	for (const d of videoDurations) {
		if (videoStts.length > 0 && videoStts[videoStts.length - 1][1] === d) {
			videoStts[videoStts.length - 1][0]++
		} else {
			videoStts.push([1, d])
		}
	}

	// Bucket audio frames into 1-second chunks matching each video frame for tight progressive interleaving
	const audioBuckets: number[][] = Array.from({ length: frameCount }, () => [])
	for (let i = 0; i < mp3.offsets.length; i++) {
		const startMs = (i * mp3.samplesPerFrame * 1000) / mp3.sampleRate
		const bucketIdx = Math.min(frameCount - 1, Math.floor(startMs / 1000))
		audioBuckets[bucketIdx].push(i)
	}

	// Plan interleaved mdat layout: [video[0], audioBucket[0], video[1], audioBucket[1], ...]
	const videoRelOffsets: number[] = new Array(frameCount)
	const audioRelOffsets: number[] = []
	const audioChunkCounts: number[] = []
	let mdatPayloadBytes = 0
	let maxInterleaveGapBytes = 0

	for (let s = 0; s < frameCount; s++) {
		const vOff = mdatPayloadBytes
		videoRelOffsets[s] = vOff
		mdatPayloadBytes += videoSamples[s].byteLength

		const bucket = audioBuckets[s]
		if (bucket.length > 0) {
			const aOff = mdatPayloadBytes
			const gap = aOff - vOff
			if (gap > maxInterleaveGapBytes) maxInterleaveGapBytes = gap
			audioRelOffsets.push(aOff)
			audioChunkCounts.push(bucket.length)
			for (const frameIdx of bucket) {
				mdatPayloadBytes += mp3.sizes[frameIdx]
			}
		}
	}

	const videoSampleSizes = videoSamples.map((s) => s.byteLength)
	const videoStsc = buildStsc([[1, 1]])
	const audioStsc = buildStsc(compressStsc(audioChunkCounts))
	const videoStsz = buildStsz(videoSampleSizes)
	const audioStsz = buildStsz(mp3.sizes)
	const videoSttsBox = buildStts(videoStts)
	const audioSttsBox = buildStts([[mp3.offsets.length, mp3.samplesPerFrame]])
	const videoStssBox = buildStss(syncSamples)
	const videoStsdBox = fullBox('stsd', 0, 0, u32(1), buildAvc1SampleEntry(sps, pps))
	const audioStsdBox = fullBox('stsd', 0, 0, u32(1), buildDotMp3SampleEntry(mp3))

	const vmhd = fullBox('vmhd', 0, 0x000001, new Uint8Array(8))
	const smhd = fullBox('smhd', 0, 0, new Uint8Array(4))
	const dinf = buildDinf()
	const mvhd = buildMvhd(durationMs)
	const videoTkhd = buildTkhd(1, durationMs, false, VIDEO_WIDTH, VIDEO_HEIGHT)
	const audioTkhd = buildTkhd(2, durationMs, true, 0, 0)
	const videoMdhd = buildMdhd(1000, durationMs)
	const audioMdhd = buildMdhd(mp3.sampleRate, mp3.totalSamples)
	const videoHdlr = buildHdlr('vide', 'SMOL Video')
	const audioHdlr = buildHdlr('soun', 'SMOL Audio')

	function buildMoov(mdatDataStart: number): Uint8Array {
		const videoStco = buildStco(videoRelOffsets.map((o) => mdatDataStart + o))
		const audioStco = buildStco(audioRelOffsets.map((o) => mdatDataStart + o))
		const videoStbl = box('stbl', videoStsdBox, videoSttsBox, videoStssBox, videoStsc, videoStsz, videoStco)
		const audioStbl = box('stbl', audioStsdBox, audioSttsBox, audioStsc, audioStsz, audioStco)
		const videoTrak = box('trak', videoTkhd, box('mdia', videoMdhd, videoHdlr, box('minf', vmhd, dinf, videoStbl)))
		const audioTrak = box('trak', audioTkhd, box('mdia', audioMdhd, audioHdlr, box('minf', smhd, dinf, audioStbl)))
		return box('moov', mvhd, videoTrak, audioTrak)
	}

	const ftyp = buildFtyp()
	const moovMeasure = buildMoov(0)
	const mdatDataStart = ftyp.byteLength + moovMeasure.byteLength + 8
	const moov = buildMoov(mdatDataStart)

	const mdatSize = 8 + mdatPayloadBytes
	const totalSize = ftyp.byteLength + moov.byteLength + mdatSize
	const out = new Uint8Array(totalSize)
	let pos = 0
	out.set(ftyp, pos)
	pos += ftyp.byteLength
	out.set(moov, pos)
	pos += moov.byteLength

	new DataView(out.buffer).setUint32(pos, mdatSize)
	out[pos + 4] = 0x6d // 'm'
	out[pos + 5] = 0x64 // 'd'
	out[pos + 6] = 0x61 // 'a'
	out[pos + 7] = 0x74 // 't'
	pos += 8

	for (let s = 0; s < frameCount; s++) {
		const v = videoSamples[s]
		out.set(v, pos)
		pos += v.byteLength
		for (const frameIdx of audioBuckets[s]) {
			const off = mp3.offsets[frameIdx]
			const sz = mp3.sizes[frameIdx]
			out.set(mp3Bytes.subarray(off, off + sz), pos)
			pos += sz
		}
	}

	return {
		mp4: out,
		durationMs,
		videoFrames: frameCount,
		audioFrames: mp3.offsets.length,
		sampleRate: mp3.sampleRate,
		channels: mp3.channels,
		maxInterleaveGapBytes,
	}
}

export { concatBytes }
