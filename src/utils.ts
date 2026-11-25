export type ParsedByteRange =
	| {
		kind: 'range'
		offset: number
		end: number
		length: number
		isSuffix: boolean
		isOpenEnded: boolean
	}
	| {
		kind: 'unsatisfiable'
	}
	| {
		kind: 'ignore'
	}

/**
 * RFC 9110 §14.1.2 single byte-range parser.
 *
 * Returns:
 * - `{ kind: 'range', offset, end, length, ... }` for a satisfiable single range
 *   (clamping end to `size - 1`, and clamping suffix ranges longer than `size` to full `[0, size - 1]`).
 * - `{ kind: 'unsatisfiable' }` when syntactically valid but unsatisfiable
 *   (`start >= size`, zero-length suffix `bytes=-0`, or any valid range against an empty `size === 0` object).
 * - `{ kind: 'ignore' }` when malformed, non-byte range unit, or multipart range (`bytes=0-1, 2-3`),
 *   signaling callers to serve the full 200 representation rather than silently dropping extra ranges.
 */
export function parseByteRange(header: string, size: number): ParsedByteRange {
	if (!header || typeof header !== 'string' || !Number.isInteger(size) || size < 0) {
		return { kind: 'ignore' };
	}

	const trimmed = header.trim();
	const prefixMatch = /^bytes=(.+)$/i.exec(trimmed);
	if (!prefixMatch) {
		return { kind: 'ignore' };
	}

	const rangeSpec = prefixMatch[1].trim();
	if (!rangeSpec || rangeSpec.includes(',')) {
		// Multipart ranges (e.g. bytes=0-1, 2-3) fall back to full 200 per RFC 9110.
		return { kind: 'ignore' };
	}

	const specMatch = /^(\d*)-(\d*)$/.exec(rangeSpec);
	if (!specMatch) {
		return { kind: 'ignore' };
	}

	const [, startStr, endStr] = specMatch;
	if (!startStr && !endStr) {
		return { kind: 'ignore' };
	}

	// Suffix byte-range: bytes=-N
	if (!startStr && endStr) {
		const suffixLength = Number(endStr);
		if (!Number.isSafeInteger(suffixLength)) {
			return { kind: 'ignore' };
		}
		if (suffixLength === 0 || size === 0) {
			return { kind: 'unsatisfiable' };
		}
		const offset = Math.max(0, size - suffixLength);
		const end = size - 1;
		return {
			kind: 'range',
			offset,
			end,
			length: end - offset + 1,
			isSuffix: true,
			isOpenEnded: false,
		};
	}

	const start = Number(startStr);
	if (!Number.isSafeInteger(start)) {
		return { kind: 'ignore' };
	}

	// Open-ended byte-range: bytes=start-
	if (!endStr) {
		if (size === 0 || start >= size) {
			return { kind: 'unsatisfiable' };
		}
		const end = size - 1;
		return {
			kind: 'range',
			offset: start,
			end,
			length: end - start + 1,
			isSuffix: false,
			isOpenEnded: true,
		};
	}

	// Bounded byte-range: bytes=start-end
	const rawEnd = Number(endStr);
	if (!Number.isSafeInteger(rawEnd) || rawEnd < start) {
		return { kind: 'ignore' };
	}

	if (size === 0 || start >= size) {
		return { kind: 'unsatisfiable' };
	}

	const end = Math.min(rawEnd, size - 1);
	return {
		kind: 'range',
		offset: start,
		end,
		length: end - start + 1,
		isSuffix: false,
		isOpenEnded: false,
	};
}
