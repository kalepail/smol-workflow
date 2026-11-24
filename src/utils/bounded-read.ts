export type BoundedReadFailure = 'too_large' | 'empty' | 'truncated';

export class BoundedReadError extends Error {
	readonly reason: BoundedReadFailure;
	readonly maxBytes: number;
	readonly receivedBytes: number;
	readonly declaredLength: number | null;

	constructor(reason: BoundedReadFailure, details: { maxBytes: number; receivedBytes: number; declaredLength: number | null }) {
		super(`Bounded read failed: ${reason}`);
		this.name = 'BoundedReadError';
		this.reason = reason;
		this.maxBytes = details.maxBytes;
		this.receivedBytes = details.receivedBytes;
		this.declaredLength = details.declaredLength;
	}
}

/**
 * Reads an upstream body chunk by chunk and stops (cancelling the stream) as soon as it passes
 * `maxBytes`, so an oversized or hostile upstream can never be buffered in full.
 * When `declaredLength` is given, the byte count must match it exactly.
 */
export async function readBoundedStream(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	declaredLength: number | null = null
): Promise<Uint8Array> {
	if (declaredLength !== null && declaredLength > maxBytes) {
		await body?.cancel('Body exceeds maximum allowed size').catch(() => {});
		throw new BoundedReadError('too_large', { maxBytes, receivedBytes: 0, declaredLength });
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	if (body) {
		const reader = body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (!value || value.byteLength === 0) {
					continue;
				}
				totalBytes += value.byteLength;
				if (totalBytes > maxBytes) {
					await reader.cancel('Body exceeds maximum allowed size').catch(() => {});
					throw new BoundedReadError('too_large', { maxBytes, receivedBytes: totalBytes, declaredLength });
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
	}

	if (totalBytes <= 0) {
		throw new BoundedReadError('empty', { maxBytes, receivedBytes: 0, declaredLength });
	}

	if (declaredLength !== null && totalBytes !== declaredLength) {
		throw new BoundedReadError('truncated', { maxBytes, receivedBytes: totalBytes, declaredLength });
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}
