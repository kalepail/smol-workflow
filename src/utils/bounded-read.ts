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

export type BoundedJsonResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; reason: 'too_large' | 'invalid_json' };

/**
 * Reads a request body as a JSON object without ever buffering more than `maxBytes`:
 * a declared Content-Length over the cap is refused before reading, and the stream is cut off
 * as soon as it passes the cap. Malformed, empty, non-UTF-8 or non-object bodies are `invalid_json`.
 */
export async function readBoundedJsonObject(request: Request, maxBytes: number): Promise<BoundedJsonResult> {
	const header = request.headers.get('content-length');
	let declaredLength: number | null = null;
	if (header !== null) {
		if (!/^[0-9]{1,15}$/.test(header.trim())) return { ok: false, reason: 'invalid_json' };
		declaredLength = Number(header.trim());
		if (declaredLength > maxBytes) {
			await request.body?.cancel('Body exceeds maximum allowed size').catch(() => {});
			return { ok: false, reason: 'too_large' };
		}
	}

	let bytes: Uint8Array;
	try {
		bytes = await readBoundedStream(request.body, maxBytes, declaredLength);
	} catch (error) {
		if (error instanceof BoundedReadError) {
			return { ok: false, reason: error.reason === 'too_large' ? 'too_large' : 'invalid_json' };
		}
		return { ok: false, reason: 'invalid_json' };
	}

	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		return { ok: false, reason: 'invalid_json' };
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid_json' };
	return { ok: true, value: value as Record<string, unknown> };
}
