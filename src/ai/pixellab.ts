import { NonRetryableError } from 'cloudflare:workflows';
import { BoundedReadError, readBoundedStream } from '../utils/bounded-read';

const PIXELLAB_TIMEOUT_MS = 45_000;
/** A 64x64 pixflux image is a few KiB of base64 JSON; anything near this cap is hostile or broken. */
export const PIXELLAB_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** 4xx is final except timeout/rate-limit statuses, which may succeed on a workflow retry. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

export async function pixellab(env: Env, description: string, model: 'pixflux' = 'pixflux'): Promise<string> {
	if (!model || !description) {
		throw new NonRetryableError('Missing Pixellab parameters');
	}

	if (!env.PIXELLAB_KEY) {
		throw new NonRetryableError('Missing Pixellab API key');
	}

	if (model !== 'pixflux') {
		throw new NonRetryableError(`Unsupported Pixellab model: ${model}`);
	}

	const res = await pixflux(env, description);
	if (!res?.image?.base64 || typeof res.image.base64 !== 'string') {
		throw new Error('Pixellab response did not contain image base64');
	}
	return res.image.base64;
}

async function pixflux(env: Env, description: string): Promise<{ image?: { base64?: string } }> {
	const width = 64;

	const response = await fetch('https://api.pixellab.ai/v1/generate-image-pixflux', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${env.PIXELLAB_KEY}`,
		},
		body: JSON.stringify({
			description,
			negative_description: 'blurry. dithering. photorealism.',
			text_guidance_scale: 8, // max 20
			image_size: {
				width,
				height: width,
			},
			outline: 'selective outline',
			shading: 'basic shading',
			detail: 'medium detail',
			view: 'low top-down',
			direction: 'south',
			no_background: false,
		}),
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
