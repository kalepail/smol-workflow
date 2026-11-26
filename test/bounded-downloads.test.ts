import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createMockR2Bucket, installCloudflareStubs, type CloudflareStubHandle } from './helpers/harness'

let stubs: CloudflareStubHandle
let songsModule: typeof import('../src/utils/songs')
let pixellabModule: typeof import('../src/ai/pixellab')
let fingerprintModule: typeof import('../src/utils/audio-fingerprint')
let safeFetchModule: typeof import('../src/utils/safe-fetch')

const MIB = 1024 * 1024
const originalFetch = globalThis.fetch

before(async () => {
	stubs = installCloudflareStubs()
	songsModule = await import('../src/utils/songs')
	pixellabModule = await import('../src/ai/pixellab')
	fingerprintModule = await import('../src/utils/audio-fingerprint')
	safeFetchModule = await import('../src/utils/safe-fetch')
})

after(() => {
	globalThis.fetch = originalFetch
	stubs.cleanup()
})

/** Endless upstream body that counts how much was pulled and whether the reader cancelled it. */
function endlessBody(chunkBytes = MIB) {
	const state = { pulledBytes: 0, cancelled: false }
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			state.pulledBytes += chunkBytes
			controller.enqueue(new Uint8Array(chunkBytes))
		},
		cancel() {
			state.cancelled = true
		},
	})
	return { stream, state }
}

function stubFetch(handler: (url: string) => Response) {
	const calls: string[] = []
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		calls.push(url)
		return handler(url)
	}) as typeof fetch
	return calls
}

const song = (audio: string) => ({ music_id: 'bounded-1', status: 4, audio, service: 'aisonggenerator' }) as any

test('A5: AISG audio commit refuses non-https URLs before any fetch', async () => {
	const r2 = createMockR2Bucket()
	const calls = stubFetch(() => new Response(new Uint8Array([1])))
	for (const bad of ['http://cdn.aisg.test/a.mp3', 'file:///etc/passwd', 'https://user:pw@cdn.aisg.test/a.mp3', 'not a url']) {
		await assert.rejects(
			() => songsModule.commitSongsAudioToR2({ env: { SMOL_BUCKET: r2.bucket } as unknown as Env, smolId: 's', songs: [song(bad)], provider: 'aisonggenerator' }),
			(err: Error) => err.name === 'NonRetryableError' && /non-https audio URL/.test(err.message),
			bad
		)
	}
	assert.equal(calls.length, 0)
	assert.equal(r2.stats.putCalls, 0)
})

test('A5: AISG audio download stops at the 25 MiB cap without buffering the whole body', async () => {
	const r2 = createMockR2Bucket()
	const { stream, state } = endlessBody()
	stubFetch(() => new Response(stream, { status: 200 }))
	await assert.rejects(
		() => songsModule.commitSongsAudioToR2({ env: { SMOL_BUCKET: r2.bucket } as unknown as Env, smolId: 's', songs: [song('https://cdn.aisg.test/big.mp3')], provider: 'aisonggenerator' }),
		(err: Error) => err.name === 'NonRetryableError' && /exceeded 26214400 bytes/.test(err.message)
	)
	assert.equal(state.cancelled, true, 'oversized upstream stream is cancelled')
	assert.ok(state.pulledBytes <= 27 * MIB, `pulled ${state.pulledBytes} bytes; must stop near the cap`)
	assert.equal(r2.stats.putCalls, 0)

	// Normal sized audio still commits.
	const audio = new Uint8Array([1, 2, 3, 4])
	stubFetch(() => new Response(audio, { status: 200 }))
	const committed = await songsModule.commitSongsAudioToR2({ env: { SMOL_BUCKET: r2.bucket } as unknown as Env, smolId: 's', songs: [song('https://cdn.aisg.test/ok.mp3')], provider: 'aisonggenerator' })
	assert.equal(committed.length, 1)
	assert.deepEqual([...r2.store.get('bounded-1.mp3')!.bytes], [...audio])
})

test('A5: PixelLab errors use fixed copy (no upstream body) and success bodies are size-bounded', async () => {
	const env = { PIXELLAB_KEY: 'pk' } as unknown as Env
	const leaky = 'SECRET-UPSTREAM-DETAIL '.repeat(50)

	stubFetch(() => new Response(leaky, { status: 500 }))
	await assert.rejects(() => pixellabModule.pixellab(env, 'a frog'), (err: Error) => {
		assert.equal(err.message, 'Pixellab request failed (500)')
		assert.notEqual(err.name, 'NonRetryableError')
		return true
	})

	stubFetch(() => new Response(leaky, { status: 401 }))
	await assert.rejects(() => pixellabModule.pixellab(env, 'a frog'), (err: Error) => {
		assert.equal(err.message, 'Pixellab request failed (401)')
		assert.equal(err.name, 'NonRetryableError')
		return true
	})

	const { stream, state } = endlessBody(256 * 1024)
	stubFetch(() => new Response(stream, { status: 200 }))
	await assert.rejects(
		() => pixellabModule.pixellab(env, 'a frog'),
		(err: Error) => err.name === 'NonRetryableError' && /exceeded maximum allowed size/.test(err.message)
	)
	assert.equal(state.cancelled, true)
	assert.ok(state.pulledBytes <= pixellabModule.PIXELLAB_MAX_RESPONSE_BYTES + 2 * 256 * 1024, `pulled ${state.pulledBytes} bytes`)

	stubFetch(() => Response.json({ image: { base64: 'iVBORw0KGgo=' } }))
	assert.equal(await pixellabModule.pixellab(env, 'a frog'), 'iVBORw0KGgo=')

	// Data-URI PNG prefix and unpadded/URL-safe PNG base64 normalize to canonical raw base64.
	stubFetch(() => Response.json({ image: { base64: 'data:image/png;base64,iVBORw0KGgo=' } }))
	assert.equal(await pixellabModule.pixellab(env, 'a frog'), 'iVBORw0KGgo=')
	stubFetch(() => Response.json({ image: { base64: 'iVBORw0KGgo' } }))
	assert.equal(await pixellabModule.pixellab(env, 'a frog'), 'iVBORw0KGgo=')

	// Non-PNG bytes ("hello"), non-PNG data URI, and unexpected HTTP 202 fail explicitly.
	stubFetch(() => Response.json({ image: { base64: Buffer.from('hello').toString('base64') } }))
	await assert.rejects(() => pixellabModule.pixellab(env, 'a frog'), /not a valid PNG/)

	stubFetch(() => Response.json({ image: { base64: 'data:image/svg+xml;base64,PHN2Zz4=' } }))
	await assert.rejects(() => pixellabModule.pixellab(env, 'a frog'), /unsupported image data URI/)

	stubFetch(() => Response.json({ background_job_id: 'job-1' }, { status: 202 }))
	await assert.rejects(
		() => pixellabModule.pixellab(env, 'a frog'),
		(err: Error) => err.name === 'NonRetryableError' && /unexpected status \(202\)/.test(err.message)
	)

	// Oversized extracted base64 is rejected as non-retryable before exceeding Workflow's 1 MiB step cap.
	const hugeB64 = 'iVBORw0KGgoA' + 'A'.repeat(pixellabModule.PIXELLAB_MAX_IMAGE_BASE64_CHARS)
	stubFetch(() => Response.json({ image: { base64: hugeB64 } }))
	await assert.rejects(
		() => pixellabModule.pixellab(env, 'a frog'),
		(err: Error) => err.name === 'NonRetryableError' && /exceeded maximum allowed base64 length/.test(err.message)
	)
})

/** Records url + redirect mode for every fetch and lets the handler answer per URL. */
function stubFetchWithInit(handler: (url: string) => Response) {
	const calls: Array<{ url: string; redirect?: RequestRedirect }> = []
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		calls.push({ url, redirect: init?.redirect })
		return handler(url)
	}) as typeof fetch
	return calls
}

const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { location } })

test('A5: AISG audio commit follows redirects manually and refuses an https -> http hop before requesting it', async () => {
	const r2 = createMockR2Bucket()
	const env = { SMOL_BUCKET: r2.bucket } as unknown as Env

	// https -> http downgrade: only the https URL is requested, the http target never is.
	let calls = stubFetchWithInit((url) => url.startsWith('https://cdn.aisg.test/start')
		? redirectTo('http://evil.test/a.mp3')
		: new Response(new Uint8Array([9])))
	await assert.rejects(
		() => songsModule.commitSongsAudioToR2({ env, smolId: 's', songs: [song('https://cdn.aisg.test/start.mp3')], provider: 'aisonggenerator' }),
		(err: Error) => err.name === 'NonRetryableError' && /non-https audio URL/.test(err.message)
	)
	assert.deepEqual(calls.map((c) => c.url), ['https://cdn.aisg.test/start.mp3'])
	assert.equal(calls[0].redirect, 'manual', 'redirects are never followed automatically')
	assert.equal(r2.stats.putCalls, 0)

	// Credentialed redirect target is refused too.
	calls = stubFetchWithInit(() => redirectTo('https://user:pw@cdn.aisg.test/b.mp3', 307))
	await assert.rejects(
		() => songsModule.commitSongsAudioToR2({ env, smolId: 's', songs: [song('https://cdn.aisg.test/c.mp3')], provider: 'aisonggenerator' }),
		(err: Error) => err.name === 'NonRetryableError'
	)
	assert.equal(calls.length, 1)

	// Redirect loop is bounded (initial request + MAX_SAFE_FETCH_REDIRECTS hops).
	calls = stubFetchWithInit((url) => redirectTo(`${url}x`))
	await assert.rejects(
		() => songsModule.commitSongsAudioToR2({ env, smolId: 's', songs: [song('https://cdn.aisg.test/loop')], provider: 'aisonggenerator' }),
		(err: Error) => err.name === 'NonRetryableError' && /Too many redirects/.test(err.message)
	)
	assert.equal(calls.length, safeFetchModule.MAX_SAFE_FETCH_REDIRECTS + 1)

	// Safe relative https -> https redirect is followed and committed.
	const audio = new Uint8Array([5, 6, 7])
	calls = stubFetchWithInit((url) => url.endsWith('/hop.mp3') ? redirectTo('/final.mp3', 301) : new Response(audio, { status: 200 }))
	const committed = await songsModule.commitSongsAudioToR2({ env, smolId: 's', songs: [song('https://cdn.aisg.test/hop.mp3')], provider: 'aisonggenerator' })
	assert.equal(committed.length, 1)
	assert.deepEqual(calls.map((c) => c.url), ['https://cdn.aisg.test/hop.mp3', 'https://cdn.aisg.test/final.mp3'])
	assert.ok(calls.every((c) => c.redirect === 'manual'))
	assert.deepEqual([...r2.store.get('bounded-1.mp3')!.bytes], [...audio])
})

test('A5: fingerprint polling never requests an http/credentialed provider URL or an https -> http redirect target', async () => {
	for (const bad of ['http://cdn.aisg.test/stream.mp3', 'https://user:pw@cdn.aisg.test/stream.mp3', 'ftp://cdn.aisg.test/x']) {
		const calls = stubFetchWithInit(() => new Response(new Uint8Array(40_000)))
		await assert.rejects(
			() => fingerprintModule.extractFingerprint(bad),
			(err: Error) => err.name === 'UnsafeFetchUrlError',
			bad
		)
		assert.equal(calls.length, 0, `no request for ${bad}`)
	}

	const calls = stubFetchWithInit((url) => url.startsWith('https://')
		? redirectTo('http://cdn.aisg.test/plain.mp3')
		: new Response(new Uint8Array(40_000)))
	await assert.rejects(
		() => fingerprintModule.extractFingerprint('https://cdn.aisg.test/stream.mp3'),
		(err: Error) => err.name === 'UnsafeFetchUrlError'
	)
	assert.deepEqual(calls.map((c) => c.url), ['https://cdn.aisg.test/stream.mp3'], 'http redirect target is never requested')
	assert.equal(calls[0].redirect, 'manual')

	// Safe https -> https redirect still fingerprints.
	const ok = stubFetchWithInit((url) => url.endsWith('/a.mp3') ? redirectTo('https://cdn2.aisg.test/b.mp3', 308) : new Response(new Uint8Array(40_000).fill(3)))
	const fp = await fingerprintModule.extractFingerprint('https://cdn.aisg.test/a.mp3')
	assert.ok(fp?.hash)
	assert.equal(ok.length, 2)
})
