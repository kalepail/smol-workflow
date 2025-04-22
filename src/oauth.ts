export async function getToken(env: Env) {
    const method = 'POST';
    const url = 'https://api.twitter.com/2/tweets';

    const oauthParams: Record<string, string> = {
      oauth_consumer_key: env.TWITTER_CONSUMER_KEY,
      oauth_nonce: cryptoRandomString(32),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: env.TWITTER_ACCESS_TOKEN,
      oauth_version: '1.0',
    };

    // Step 1: Build the base string (no POST body included)
    const paramString = Object.keys(oauthParams)
      .sort()
      .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(oauthParams[k])}`)
      .join('&');

    const baseString = [
      method,
      encodeRFC3986(url),
      encodeRFC3986(paramString),
    ].join('&');

    const signingKey = `${encodeRFC3986(env.TWITTER_CONSUMER_SECRET)}&${encodeRFC3986(env.TWITTER_ACCESS_SECRET)}`;
    const signature = await hmacSha1(signingKey, baseString);
    oauthParams.oauth_signature = signature;

    // Step 2: Build Authorization header
    const authHeader =
      'OAuth ' +
      Object.keys(oauthParams)
        .sort()
        .map((k) => `${encodeRFC3986(k)}="${encodeRFC3986(oauthParams[k])}"`)
        .join(', ');

    return authHeader;
};

function encodeRFC3986(str: string): string {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) =>
        `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

function cryptoRandomString(length: number): string {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

async function hmacSha1(key: string, text: string): Promise<string> {
    const enc = new TextEncoder();
    const keyData = enc.encode(key);
    const msgData = enc.encode(text);

    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
    );

    const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    const bytes = new Uint8Array(sig);

    // base64 encoding
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }

    return btoa(binary);
}