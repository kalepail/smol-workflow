/**
 * Byte comparisons over plain `Uint8Array` views.
 *
 * `Buffer#equals` and `Buffer.compare` throw in workerd when one operand is a stellar-sdk
 * (`buffer` polyfill) Buffer and the other a `node:buffer` Buffer, because each realm rejects the
 * other's instances. Both are `Uint8Array`s, so comparing indices works for either.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false
	}
	return true
}

/** Unsigned lexicographic order (a shorter prefix sorts first), identical to `Buffer.compare`. */
export function compareBytes(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
	const length = Math.min(a.length, b.length)
	for (let i = 0; i < length; i += 1) {
		if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
	}
	if (a.length === b.length) return 0
	return a.length < b.length ? -1 : 1
}
