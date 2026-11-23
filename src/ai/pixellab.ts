import { NonRetryableError } from 'cloudflare:workflows';

const PIXELLAB_TIMEOUT_MS = 45_000;
const NON_RETRYABLE_STATUSES = new Set([400, 401, 402, 403, 422]);

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
		const errorText = (await response.text().catch(() => '')).slice(0, 300);
		const message = `Pixellab request failed (${response.status}): ${errorText || response.statusText}`;
		if (NON_RETRYABLE_STATUSES.has(response.status)) {
			throw new NonRetryableError(message);
		}
		throw new Error(message);
	}

	return await response.json() as { image?: { base64?: string } };
}
