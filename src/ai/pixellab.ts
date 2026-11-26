import { NonRetryableError } from 'cloudflare:workflows';
import { BoundedReadError, readBoundedStream } from '../utils/bounded-read';

const PIXELLAB_TIMEOUT_MS = 45_000;
/** A 64x64 pixflux image is a few KiB of base64 JSON; anything near this cap is hostile or broken. */
export const PIXELLAB_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** Cap extracted base64 well below Cloudflare Workflows' 1 MiB step-result limit. */
export const PIXELLAB_MAX_IMAGE_BASE64_CHARS = 512 * 1024;
/** 4xx is final except timeout/rate-limit statuses, which may succeed on a workflow retry. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

const PNG_DATA_URI_PREFIX = /^data:image\/png;base64,/i;
const ANY_DATA_URI_PREFIX = /^data:/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PixellabOptions {
	/** Optional 31-bit non-negative integer seed for reproducible generations across retries. */
	seed?: number;
	/**
	 * When true, sends the exact legacy PixFlux payload (including deprecated negative_description,
	 * view: 'low top-down', and direction: 'south'). Used only when COVER_PROMPT_MODE === 'raw'.
	 */
	legacy?: boolean;
}

/**
 * Normalize PixelLab's `image.base64` string into canonical padded standard raw base64 and verify
 * the decoded bytes begin with the 8-byte PNG signature.
 * PixelLab's OpenAPI schemas document data-URI prefixes (`data:image/png;base64,...`), while
 * `SmolDurableObject.saveStep` decodes the string directly with `Buffer.from(data, 'base64')`.
 */
export function normalizePixellabBase64(raw: unknown): string {
	if (typeof raw !== 'string') {
		throw new Error('Pixellab response did not contain image base64');
	}

	let value = raw.trim();
	if (!value) {
		throw new Error('Pixellab response did not contain image base64');
	}

	if (PNG_DATA_URI_PREFIX.test(value)) {
		value = value.replace(PNG_DATA_URI_PREFIX, '').trim();
	} else if (ANY_DATA_URI_PREFIX.test(value)) {
		throw new Error('Pixellab response contained an unsupported image data URI');
	}

	// Normalize whitespace, URL-safe base64 alphabet (-/_), and missing '=' padding
	value = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
	const mod = value.length % 4;
	if (mod === 1) {
		throw new Error('Pixellab response contained invalid image base64');
	}
	if (mod > 0) {
		value += '='.repeat(4 - mod);
	}

	if (!value || !BASE64_PATTERN.test(value)) {
		throw new Error('Pixellab response contained invalid image base64');
	}

	if (value.length > PIXELLAB_MAX_IMAGE_BASE64_CHARS) {
		throw new NonRetryableError(
			`Pixellab image exceeded maximum allowed base64 length (${PIXELLAB_MAX_IMAGE_BASE64_CHARS} chars)`
		);
	}

	// Verify the decoded header starts with the 8-byte PNG signature so arbitrary non-PNG bytes
	// (e.g. base64("hello")) never checkpoint or reach R2 as image/png.
	const headBytes = Buffer.from(value.slice(0, 12), 'base64');
	if (headBytes.length < PNG_MAGIC.length || !PNG_MAGIC.every((b, i) => headBytes[i] === b)) {
		throw new Error('Pixellab response image was not a valid PNG');
	}

	return value;
}

export async function pixellab(
	env: Env,
	description: string,
	model: 'pixflux' = 'pixflux',
	options: PixellabOptions = {}
): Promise<string> {
	if (!model || !description) {
		throw new NonRetryableError('Missing Pixellab parameters');
	}

	if (!env.PIXELLAB_KEY) {
		throw new NonRetryableError('Missing Pixellab API key');
	}

	if (model !== 'pixflux') {
		throw new NonRetryableError(`Unsupported Pixellab model: ${model}`);
	}

	const res = await pixflux(env, description, options);
	return normalizePixellabBase64(res?.image?.base64);
}

async function pixflux(
	env: Env,
	description: string,
	options: PixellabOptions
): Promise<{ image?: { base64?: string } }> {
	const width = 64;

	const seed = typeof options.seed === 'number' && Number.isInteger(options.seed) && options.seed >= 0
		? options.seed & 0x7fffffff
		: undefined;

	const body: Record<string, unknown> = options.legacy
		? {
			description,
			negative_description: 'blurry. dithering. photorealism.',
			text_guidance_scale: 8, // max 20
			image_size: { width, height: width },
			outline: 'selective outline',
			shading: 'basic shading',
			detail: 'medium detail',
			view: 'low top-down',
			direction: 'south',
			no_background: false,
		}
		: {
			description,
			text_guidance_scale: 8, // max 20
			image_size: { width, height: width },
			outline: 'selective outline',
			shading: 'basic shading',
			detail: 'medium detail',
			no_background: false,
			...(seed !== undefined ? { seed } : {}),
		};

	const response = await fetch('https://api.pixellab.ai/v1/generate-image-pixflux', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.PIXELLAB_KEY}`,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(PIXELLAB_TIMEOUT_MS),
	});

	if (!response.ok) {
		// Fixed copy only: upstream error bodies can echo prompts or account details.
		await response.body?.cancel().catch(() => {});
		const message = `Pixellab request failed (${response.status})`;
		if (response.status >= 400 && response.status < 500 && !RETRYABLE_CLIENT_STATUSES.has(response.status)) {
			throw new NonRetryableError(message);
		}
		throw new Error(message);
	}

	// Never retry an unexpected 202 Accepted (an async job would be re-submitted on every retry).
	if (response.status !== 200) {
		await response.body?.cancel().catch(() => {});
		throw new NonRetryableError(`Pixellab returned unexpected status (${response.status})`);
	}

	let bytes: Uint8Array;
	try {
		bytes = await readBoundedStream(response.body, PIXELLAB_MAX_RESPONSE_BYTES);
	} catch (err) {
		if (err instanceof BoundedReadError) {
			if (err.reason === 'too_large') {
				throw new NonRetryableError(`Pixellab response exceeded maximum allowed size (${PIXELLAB_MAX_RESPONSE_BYTES} bytes)`);
			}
			throw new Error('Pixellab returned an empty response');
		}
		throw err;
	}

	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as { image?: { base64?: string } };
	} catch {
		throw new Error('Pixellab response was not valid JSON');
	}
}
