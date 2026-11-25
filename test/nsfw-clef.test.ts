import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CLEF_NSFW_TEST_CODES, clefNsfwPayload, FAKE_PNG_B64 } from './helpers/harness'
import {
	CLEF_NSFW_MAX_IMAGE_BYTES,
	CLEF_NSFW_MAX_TEXT_CHARS,
	CLEF_NSFW_QUESTIONS,
	CLEF_NSFW_THRESHOLDS,
	checkNSFW,
	decideClefNsfw,
	isNsfwBlocked,
	normalizeClefPngBase64,
	normalizeNsfwResult,
} from '../src/ai/nsfw'
import { decodePng } from '../src/utils/png-scale'

const SAFE = { safe: true, categories: [] }
const UNKNOWN = { safe: false, categories: [], unknown: true }
const withScores = (scores: Record<string, number>) => clefNsfwPayload(scores)
const pngOf = (bytes: number) => {
	const buf = Buffer.alloc(bytes)
	Buffer.from(FAKE_PNG_B64, 'base64').copy(buf)
	return buf.toString('base64')
}

function mockEnv(run: (model: string, input: any) => unknown, provider?: string) {
	const calls: Array<{ model: string; input: any }> = []
	const env = {
		...(provider !== undefined ? { NSFW_PROVIDER: provider } : {}),
		AI: { run: async (model: string, input: any) => { calls.push({ model, input }); return await run(model, input) } },
	} as unknown as Env
	return { env, calls }
}

test('Clef rubric and thresholds are the frozen evaluated artifacts', () => {
	const evaluated = JSON.parse(readFileSync(new URL('./fixtures/nsfw-clef-questions.json', import.meta.url), 'utf8'))
	assert.deepEqual(CLEF_NSFW_QUESTIONS, evaluated)
	assert.deepEqual(Object.keys(CLEF_NSFW_QUESTIONS), [...CLEF_NSFW_TEST_CODES])
	for (const code of CLEF_NSFW_TEST_CODES) {
		const { review, block } = CLEF_NSFW_THRESHOLDS[code]
		assert.equal(review, code === 'S8' ? 0.45 : code === 'S12' ? 0.4 : 0.5, code)
		assert.equal(block, Math.round((review + 0.05) * 100) / 100, code)
		// Every emitted code survives the public sanitizer (src/api/smols.ts NSFW_CODE)
		assert.match(code, /^S(?:[1-9]|1[0-4])$/)
	}
})

test('Clef envelopes: direct and ≤2 healthy envelopes accepted; anything unhealthy, deeper or malformed is unknown', () => {
	const p = clefNsfwPayload()
	assert.deepEqual(decideClefNsfw(p), SAFE)
	assert.deepEqual(decideClefNsfw({ ...p, model: '@cf/cloudflare/clef' }), SAFE)
	assert.deepEqual(decideClefNsfw({ success: true, errors: [], result: p }), SAFE)
	assert.deepEqual(decideClefNsfw({ success: true, errors: [], result: { state: 'Completed', result: p } }), SAFE)

	const bad: unknown[] = [
		null, undefined, 'safe', [], {}, 42,
		{ success: false, result: p },
		{ success: 'true', result: p },
		{ result: { errors: [{}], result: p } },
		{ errors: 'none', result: p },
		{ result: { result: { result: p } } },
		{ ...p, state: 'Running' },
		{ ...p, success: false },
		{ ...p, model: 'clef-flash' },
		{ ...p, model: undefined },
		{ ...p, usage: {} },
		{ ...p, usage: undefined },
		{ ...p, usage: { input_tokens: -1, output_tokens: 0 } },
		{ ...p, usage: { input_tokens: 1.5, output_tokens: 0 } },
		{ ...p, usage: { input_tokens: 10, output_tokens: '0' } },
		{ ...p, answers: {} },
		{ ...p, answers: [] },
	]
	for (const raw of bad) assert.deepEqual(decideClefNsfw(raw), UNKNOWN, JSON.stringify(raw))

	const { S7: _missing, ...missing } = p.answers
	assert.deepEqual(decideClefNsfw({ ...p, answers: missing }), UNKNOWN)
	assert.deepEqual(decideClefNsfw({ ...p, answers: { ...missing, S6: { type: 'noul', noul: 0.1 } } }), UNKNOWN)
	assert.deepEqual(decideClefNsfw({ ...p, answers: { ...p.answers, S14: { type: 'noul', noul: 0.1 } } }), UNKNOWN)

	for (const noul of [true, '0.1', -1, 1.01, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
		const answers = { ...p.answers, S12: { type: 'noul', noul } }
		assert.deepEqual(decideClefNsfw({ ...p, answers }), UNKNOWN, String(noul))
	}
	assert.deepEqual(decideClefNsfw({ ...p, answers: { ...p.answers, S1: { type: 'choice', noul: 0.1 } } }), UNKNOWN)
	assert.deepEqual(decideClefNsfw(withScores({ S1: 0, S12: 0 })), SAFE)
})

test('Clef thresholds: inclusive review and +.05 definite boundaries per code', () => {
	const cases: Array<[string, number, object]> = [
		['S12', 0.3999, SAFE], ['S12', 0.4, UNKNOWN], ['S12', 0.4499, UNKNOWN], ['S12', 0.45, { safe: false, categories: ['S12'] }],
		['S8', 0.4499, SAFE], ['S8', 0.45, UNKNOWN], ['S8', 0.4999, UNKNOWN], ['S8', 0.5, { safe: false, categories: ['S8'] }],
	]
	for (const code of CLEF_NSFW_TEST_CODES.filter((c) => c !== 'S8' && c !== 'S12')) {
		cases.push([code, 0.4999, SAFE], [code, 0.5, UNKNOWN], [code, 0.5499, UNKNOWN], [code, 0.55, { safe: false, categories: [code] }])
	}
	for (const [code, score, want] of cases) {
		assert.deepEqual(decideClefNsfw(withScores({ [code]: score })), want, `${code}=${score}`)
	}
	assert.deepEqual(decideClefNsfw(withScores({ S12: 1 })), { safe: false, categories: ['S12'] })
})

test('Clef decision: highest definite code wins, exact ties drop the code, review-only crossings never display', () => {
	assert.deepEqual(decideClefNsfw(withScores({ S1: 0.9, S8: 0.7 })), { safe: false, categories: ['S1'] })
	assert.deepEqual(decideClefNsfw(withScores({ S1: 0.9, S8: 0.9 })), { safe: false, categories: [] })
	// An adult pinup must not also be labelled S4 just because S4 crossed
	assert.deepEqual(decideClefNsfw(withScores({ S4: 0.6, S12: 0.95 })), { safe: false, categories: ['S12'] })
	// A definite block outranks a higher-scoring review-only crossing elsewhere
	assert.deepEqual(decideClefNsfw(withScores({ S12: 0.46, S1: 0.54 })), { safe: false, categories: ['S12'] })

	// Every Clef verdict round-trips through stored-KV normalization unchanged
	for (const verdict of [SAFE, UNKNOWN, { safe: false, categories: ['S12'] }, { safe: false, categories: [] }]) {
		assert.deepEqual(normalizeNsfwResult(JSON.parse(JSON.stringify(verdict))), verdict)
		assert.equal(isNsfwBlocked(verdict), !verdict.safe)
	}
	// Legacy stored shapes are untouched
	assert.deepEqual(normalizeNsfwResult('unsafe S12'), { safe: false, categories: ['S12'] })
	assert.deepEqual(normalizeNsfwResult('safe'), SAFE)
})

test('Clef cover PNG: raw or data URL, strict base64, PNG signature and 4 MiB decoded cap', () => {
	const fixture = decodePng(Buffer.from(FAKE_PNG_B64, 'base64'))
	assert.equal(fixture.width, 1)
	assert.equal(fixture.height, 1)
	assert.equal(normalizeClefPngBase64(FAKE_PNG_B64), FAKE_PNG_B64)
	assert.equal(normalizeClefPngBase64(`data:image/png;base64,${FAKE_PNG_B64}`), FAKE_PNG_B64)
	assert.equal(normalizeClefPngBase64(` DATA:image/PNG;base64,${FAKE_PNG_B64}\n`), FAKE_PNG_B64)
	assert.equal(normalizeClefPngBase64(pngOf(CLEF_NSFW_MAX_IMAGE_BYTES))?.length, Math.ceil(CLEF_NSFW_MAX_IMAGE_BYTES / 3) * 4)

	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64')
	for (const bad of [
		undefined, null, 42, '', '   ', 'data:image/png;base64,',
		jpeg, `data:image/jpeg;base64,${FAKE_PNG_B64}`, `data:image/png;base64,${jpeg}`,
		FAKE_PNG_B64.slice(0, -1), `${FAKE_PNG_B64.slice(0, 8)}\n${FAKE_PNG_B64.slice(8)}`, FAKE_PNG_B64.replace(/^./, '-'),
		pngOf(CLEF_NSFW_MAX_IMAGE_BYTES + 1),
	]) {
		assert.equal(normalizeClefPngBase64(bad), null, String(bad).slice(0, 40))
	}
})

test('checkNSFW (clef default): exact evaluated payload, data URL stripped, raw lyrics passed through', async () => {
	for (const provider of [undefined, 'clef', 'unexpected']) {
		const { env, calls } = mockEnv(() => clefNsfwPayload(), provider)
		const lyrics = '[Verse]\n"Hold my hand"'
		assert.deepEqual(await checkNSFW(env, 'p', 'd', lyrics, `data:image/png;base64,${FAKE_PNG_B64}`), SAFE)
		assert.equal(calls.length, 1)
		assert.equal(calls[0].model, '@cf/cloudflare/clef')
		assert.deepEqual(calls[0].input, {
			model: 'clef',
			state: { prompt: 'p', description: 'd', lyrics },
			questions: CLEF_NSFW_QUESTIONS,
			images: [{ content_type: 'image/png', base64: FAKE_PNG_B64 }],
		})
	}
	const { env } = mockEnv(() => ({ success: true, errors: [], result: withScores({ S8: 0.5 }) }))
	assert.deepEqual(await checkNSFW(env, 'p', 'd', '', FAKE_PNG_B64), { safe: false, categories: ['S8'] })
})

test('checkNSFW (clef) fails closed to unknown, never throws, on bad inputs, timeouts, throws and bad responses', async () => {
	for (const image of [undefined, '', 'not-base64!', Buffer.from('GIF89a-cover').toString('base64'), pngOf(CLEF_NSFW_MAX_IMAGE_BYTES + 1)]) {
		const { env, calls } = mockEnv(() => clefNsfwPayload())
		assert.deepEqual(await checkNSFW(env, 'p', 'd', 'l', image), UNKNOWN)
		assert.equal(calls.length, 0, 'invalid cover must not reach the model')
	}

	const half = CLEF_NSFW_MAX_TEXT_CHARS / 2
	const atCap = mockEnv(() => clefNsfwPayload())
	assert.deepEqual(await checkNSFW(atCap.env, 'p'.repeat(half), '', 'l'.repeat(half), FAKE_PNG_B64), SAFE)
	assert.equal(atCap.calls.length, 1)
	const overCap = mockEnv(() => clefNsfwPayload())
	assert.deepEqual(await checkNSFW(overCap.env, 'p'.repeat(half), 'd', 'l'.repeat(half), FAKE_PNG_B64), UNKNOWN)
	assert.equal(overCap.calls.length, 0, 'oversized text must fail closed, not be truncated')
	const nonString = mockEnv(() => clefNsfwPayload())
	assert.deepEqual(await checkNSFW(nonString.env, 'p', 'd', undefined as unknown as string, FAKE_PNG_B64), UNKNOWN)
	assert.equal(nonString.calls.length, 0)

	const hung = mockEnv(() => new Promise(() => {}))
	const started = Date.now()
	assert.deepEqual(await checkNSFW(hung.env, 'p', 'd', 'l', FAKE_PNG_B64, 20), UNKNOWN)
	assert.ok(Date.now() - started < 1_000)

	const thrown = mockEnv(() => { throw new Error('5000: capacity') })
	assert.deepEqual(await checkNSFW(thrown.env, 'p', 'd', 'l', FAKE_PNG_B64), UNKNOWN)
	const rejected = mockEnv(() => Promise.reject(new Error('network')))
	assert.deepEqual(await checkNSFW(rejected.env, 'p', 'd', 'l', FAKE_PNG_B64), UNKNOWN)
	const malformed = mockEnv(() => ({ ...clefNsfwPayload(), model: 'clef-flash' }))
	assert.deepEqual(await checkNSFW(malformed.env, 'p', 'd', 'l', FAKE_PNG_B64), UNKNOWN)
	const review = mockEnv(() => withScores({ S12: 0.42 }))
	assert.deepEqual(await checkNSFW(review.env, 'p', 'd', 'l', FAKE_PNG_B64), UNKNOWN)
})

test('checkNSFW rollback: NSFW_PROVIDER="llama-guard" runs the legacy Guard call with JSON-stringified lyrics and no cover', async () => {
	const { env, calls } = mockEnv(() => ({ response: 'unsafe\nS12' }), 'llama-guard')
	const lyrics = 'line one\nline "two"'
	assert.deepEqual(await checkNSFW(env, 'p', 'd', lyrics), { safe: false, categories: ['S12'] })
	assert.equal(calls.length, 1)
	assert.equal(calls[0].model, '@cf/meta/llama-guard-3-8b')
	assert.ok(calls[0].input.messages[0].content.includes(JSON.stringify(lyrics)))
	assert.equal('images' in calls[0].input, false)

	const failing = mockEnv(() => { throw new Error('guard down') }, 'llama-guard')
	await assert.rejects(() => checkNSFW(failing.env, 'p', 'd', 'l'), /guard down/, 'legacy path keeps step.do retry semantics')
})
