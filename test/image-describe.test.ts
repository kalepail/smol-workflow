import assert from 'node:assert/strict'
import test from 'node:test'
import { extractImageDescription, imageDescribe, IMAGE_DESCRIBE_MODEL } from '../src/ai/cf'

test('extractImageDescription reads the result-wrapped answer returned by the live binding', () => {
	assert.equal(extractImageDescription({
		result: {
			answer: '  A parrot perched in a neon jungle.  ',
			caption: null,
			finish_reason: 'stop',
		},
		usage: { prompt_tokens: 740, completion_tokens: 25, total_tokens: 765 },
	}), 'A parrot perched in a neon jungle.')
})

test('extractImageDescription accepts the top-level shape from the docs schema and caption output', () => {
	assert.equal(extractImageDescription({ answer: 'Top-level answer', finish_reason: 'stop' }), 'Top-level answer')
	assert.equal(extractImageDescription({ result: { answer: null, caption: 'A caption', finish_reason: 'stop' } }), 'A caption')
})

test('extractImageDescription throws on empty or streamed output so the workflow step retries', () => {
	assert.throws(() => extractImageDescription({ result: { answer: '   ', finish_reason: 'length' } }), /no text \(finish_reason: length\)/)
	assert.throws(() => extractImageDescription({}), /no text/)
	assert.throws(() => extractImageDescription(new ReadableStream()), /no text/)
	assert.throws(() => extractImageDescription(null), /no text/)
})

test('imageDescribe sends a data URI with streaming disabled to the moondream model', async () => {
	const calls: Array<{ model: string; input: Record<string, unknown> }> = []
	const env = {
		AI: {
			run: async (model: string, input: Record<string, unknown>) => {
				calls.push({ model, input })
				return { result: { answer: 'A pixel parrot.', finish_reason: 'stop' } }
			},
		},
	} as unknown as Env

	assert.equal(await imageDescribe(env, 'iVBORw0KGgo=', 'a parrot'), 'A pixel parrot.')
	assert.equal(await imageDescribe(env, 'data:image/png;base64,iVBORw0KGgo=', 'a parrot'), 'A pixel parrot.')

	assert.equal(calls.length, 2)
	assert.equal(calls[0]?.model, IMAGE_DESCRIBE_MODEL)
	assert.equal(IMAGE_DESCRIBE_MODEL, '@cf/moondream/moondream3.1-9B-A2B')
	assert.equal(calls[0]?.input.task, 'query')
	assert.equal(calls[0]?.input.stream, false)
	assert.equal(calls[0]?.input.image, 'data:image/png;base64,iVBORw0KGgo=')
	assert.equal(calls[1]?.input.image, 'data:image/png;base64,iVBORw0KGgo=')
	assert.match(String(calls[0]?.input.question), /Do not mention pixels, pixel art/)
	assert.match(String(calls[0]?.input.question), /Original prompt for context: a parrot/)
})
