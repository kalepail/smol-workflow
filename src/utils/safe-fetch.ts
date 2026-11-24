/**
 * Shared guard for fetching provider-supplied (untrusted) audio URLs.
 * - Only well-formed `https:` URLs without embedded credentials are ever requested.
 * - Redirects are followed manually (bounded hop count) and EVERY `Location` target is re-validated
 *   with the same guard before it is requested, so an https URL can never bounce to http or to a
 *   credentialed URL.
 */

export const MAX_SAFE_FETCH_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class UnsafeFetchUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsafeFetchUrlError';
	}
}

/** Returns the parsed URL only for a well-formed https: URL without embedded credentials. */
export function parseHttpsUrl(raw: string | URL, base?: string | URL): URL | null {
	let url: URL;
	try {
		url = new URL(raw, base);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
		return null;
	}
	return url;
}

/**
 * fetch() an https URL with `redirect: 'manual'`, following at most `maxRedirects` validated hops.
 * Throws UnsafeFetchUrlError (before any request to the offending URL) for an unsafe initial URL,
 * an unsafe or missing redirect target, or too many redirects.
 */
export async function fetchHttpsFollowingSafeRedirects(
	rawUrl: string,
	init: RequestInit = {},
	maxRedirects = MAX_SAFE_FETCH_REDIRECTS
): Promise<Response> {
	let url = parseHttpsUrl(rawUrl);
	if (!url) {
		throw new UnsafeFetchUrlError('Refusing non-https or credentialed URL');
	}

	for (let hop = 0; ; hop++) {
		const response = await fetch(url.toString(), { ...init, redirect: 'manual' });
		if (!REDIRECT_STATUSES.has(response.status)) {
			return response;
		}

		await response.body?.cancel().catch(() => {});
		if (hop >= maxRedirects) {
			throw new UnsafeFetchUrlError(`Too many redirects (> ${maxRedirects})`);
		}
		const location = response.headers.get('location');
		if (!location) {
			throw new UnsafeFetchUrlError(`Redirect ${response.status} without a Location header`);
		}
		const next = parseHttpsUrl(location, url);
		if (!next) {
			throw new UnsafeFetchUrlError('Refusing redirect to a non-https or credentialed URL');
		}
		url = next;
	}
}
