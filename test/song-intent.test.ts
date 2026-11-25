import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
	analyzePromptWithModel,
	finalizeSongText,
	mergeSongIntent,
	parseSongIntent,
	promptLines,
	resolveSongIntent,
	sanitizeLyrics,
	SONG_INTENT_MODEL,
} from '../src/ai/song-intent'
import { generateLyrics, generateSongs, replayAisgTaskSubmit, submitAisgTask } from '../src/ai/aisonggenerator'

// Real prompts + the recorded DeepSeek v4.1 flash text for each (no live calls in tests).
type Fixture = { prompt: string; instrumental: boolean; deepseek: string; songwriter?: AiSongGeneratorLyrics }
const { fixtures } = JSON.parse(readFileSync(join(__dirname, 'fixtures/song-intent.json'), 'utf8')) as { fixtures: Record<string, Fixture> }
const NOOT = ['fb24e5', '626681', '34d372', 'cb8900']
const SONGWRITER: AiSongGeneratorLyrics = {
	title: 'Songwriter Title',
	style: ['indie pop', 'male vocals', 'dreamy', 'warm'],
	lyrics: '[Verse]\nfirst written line\nsecond written line\n(No lyrics)\n(guitar solo)\nthird written line\nfourth written line',
}

const modelOf = (id: string) => parseSongIntent(fixtures[id].deepseek, promptLines(fixtures[id].prompt).length)
const finalize = (id: string, model: ReturnType<typeof modelOf>, generated = fixtures[id].songwriter ?? SONGWRITER, instrumental = fixtures[id].instrumental) =>
	finalizeSongText(generated, mergeSongIntent(model, fixtures[id].prompt, instrumental), fixtures[id].prompt, instrumental)
const firstThree = (style: string[]) => style.slice(0, 3).join(' | ')

test('Noot-4: the user lyrics are sung verbatim, female lead first, male vocals negated first; a null model never slices', () => {
	for (const id of NOOT) {
		const model = modelOf(id)
		assert.ok(model && model.mode === 'user_lyrics' && model.lyrics_lines, id)
		const out = finalize(id, model)
		const [a, b] = model.lyrics_lines!
		assert.equal(out.lyrics, sanitizeLyrics(promptLines(fixtures[id].prompt).slice(a - 1, b).join('\n')), id)
		assert.equal(out.vocalGender, 'f', id)
		assert.match(out.negativeTags!, /^male vocals(, |$)/, id)
		assert.ok(out.negativeTags!.length <= 200 && !/,\s*$/.test(out.negativeTags!), id)
		assert.match(firstThree(out.style), /female/i, id)
		assert.ok(out.style.length >= 4 && out.style.length <= 8 && out.style.every((s) => /^[\x20-\x7e]+$/.test(s)), id)
		assert.ok(out.title.length > 0 && Array.from(out.title).length <= 80, id)
		assert.equal(out.intent_v, 1)

		const fallback = finalize(id, null)
		assert.equal(fallback.lyrics, sanitizeLyrics(SONGWRITER.lyrics), `${id}: deterministic never slices`)
		assert.equal(fallback.vocalGender, 'f', `${id}: deterministic gender cue`)
	}
})

test('Vietnamese outro: a range that ends one line early extends to the final quoted lyric', () => {
	const model = modelOf('b67a8a')!
	assert.deepEqual(model.lyrics_lines, [5, 94], 'recorded model range drops line 95')
	const out = finalize('b67a8a', model)
	const lines = promptLines(fixtures.b67a8a.prompt)
	assert.equal(out.lyrics.split('\n').at(-1), lines[94].trim())
	assert.equal(out.title, 'BÉ KHOAI ĐẬP TRỨNG (EDM REMIX)')
})

test('production briefs (6eb82c, 4b20ba) and short lists (8f2189) never become the sung track', () => {
	for (const id of ['6eb82c', '4b20ba']) {
		for (const model of [modelOf(id), null]) {
			const merged = mergeSongIntent(model, fixtures[id].prompt, false)
			assert.equal(merged.mode, 'write', id)
			assert.equal(finalize(id, model).lyrics, sanitizeLyrics(SONGWRITER.lyrics), id)
		}
	}
	const short = modelOf('8f2189')!
	assert.deepEqual([short.mode, short.lyrics_lines], ['user_lyrics', [1, 4]])
	assert.equal(mergeSongIntent(short, fixtures['8f2189'].prompt, false).mode, 'write', 'fewer than 8 lines -> songwriter')
	const out = finalize('8f2189', short)
	assert.equal(out.vocalGender, undefined)
	assert.ok(!out.style.some((s) => /\b(fe)?male vocals\b/i.test(s)), 'genderless prompt drops single-gender tags')
})

test('1-liner, duet, Nepali-in-English and the instrumental flag', () => {
	// cd8d4: sung backing vocals survive; only instrument cues become headings.
	const romance = finalize('cd8d41', modelOf('cd8d41'))
	assert.match(romance.lyrics, /^\[Intro\]\n\(Your smile pulls me in\)\n\(Pulls me in, pulls me in\)/)
	assert.equal(romance.vocalGender, 'f')
	assert.equal(romance.negativeTags, 'male vocals')

	const duet = finalize('1f0e3a', modelOf('1f0e3a'))
	assert.ok(duet.style.includes('male and female duet'))
	assert.equal(duet.vocalGender, undefined)
	assert.equal(duet.negativeTags, undefined)

	const nepali = modelOf('1b23a3')!
	assert.ok(nepali.styles.includes('male vocals') && nepali.vocal_gender === null)
	const nepaliOut = finalize('1b23a3', nepali)
	assert.ok(!nepaliOut.style.includes('male vocals') && nepaliOut.style.includes('Nepali pop'))

	// 1f65e2: the model says instrumental but the flag is off -> write, never empty lyrics.
	const info = modelOf('1f65e2')!
	assert.equal(info.mode, 'instrumental')
	const vocal = finalize('1f65e2', info)
	assert.ok(vocal.lyrics.trim().length > 0)
	const instrumental = finalize('1f65e2', info, undefined, true)
	assert.equal(instrumental.lyrics, '')
	assert.equal(instrumental.vocalGender, undefined)
})

test('CRLF prompts with blank lines index the same lines the model saw; [STYLE] overlap and <4 sung lines fall back', () => {
	const prompt = 'Title: Night Bus\r\n[STYLE: lo-fi hip hop, female vocals, no drums]\r\n\r\n[Verse]\r\nWindow fogged\r\nthe city hums\r\n\r\nneon puddles\r\nslow bus turns\r\n[Chorus]\r\nRide on\r\nride on\r\n"one more stop"\r\nnotes: keep it mellow'
	const model = { mode: 'user_lyrics' as const, lyrics_lines: [4, 12] as [number, number], title: null, vocal_gender: null, styles: [], exclusions: ['drums'] }
	const out = finalizeSongText(SONGWRITER, mergeSongIntent(model, prompt, false), prompt, false)
	assert.equal(out.lyrics, '[Verse]\nWindow fogged\nthe city hums\n\nneon puddles\nslow bus turns\n[Chorus]\nRide on\nride on\n"one more stop"')
	assert.equal(out.title, 'Night Bus', 'deterministic explicit title')
	assert.equal(out.vocalGender, 'f', 'deterministic [STYLE] gender cue')
	assert.deepEqual(out.style.slice(0, 2), ['lo-fi hip hop', 'female vocals'], 'det [STYLE] clauses lead when model styles are missing')
	assert.equal(out.negativeTags, 'male vocals, drums')

	const overlap = mergeSongIntent({ ...model, lyrics_lines: [2, 12] }, prompt, false)
	assert.equal(overlap.mode, 'write')
	const headingsOnly = '[Intro]\n[Verse]\n[Chorus]\n[Bridge]\n[Outro]\n[Solo]\n[Break]\n[End]\nla\nla'
	const guard = finalizeSongText(SONGWRITER, mergeSongIntent({ ...model, lyrics_lines: [1, 10] }, headingsOnly, false), headingsOnly, false)
	assert.equal(guard.lyrics, sanitizeLyrics(SONGWRITER.lyrics), 'vocal guard')
})

test('sanitizeLyrics is idempotent: placeholders dropped, keyword cues to [headings], sung parentheticals kept', () => {
	const raw = '[Verse]\n(No lyrics)\n(Instrumental break)\n(guitar solo)\n(Your smile pulls me in)\n(ooh)\nline\n\n\n\n(fade out)'
	const once = sanitizeLyrics(raw)
	assert.equal(once, '[Verse]\n[guitar solo]\n(Your smile pulls me in)\n(ooh)\nline\n\n[fade out]')
	assert.equal(sanitizeLyrics(once), once)
	const long = finalizeSongText({ title: 'x'.repeat(120), style: ['pop', 'rock'], lyrics: 'a\nb\nc\nd' }, mergeSongIntent(null, 'song', false), 'song', false)
	assert.equal(long.title.length, 80)
})

test('model call: no gateway option, json_object, null on 429 / junk / timeout, one log line without prompt text', async () => {
	const calls: unknown[][] = []
	const recorded = { response: fixtures.cd8d41.deepseek }
	const ok = await analyzePromptWithModel({ AI: { run: async (...args: unknown[]) => (calls.push(args), recorded) } } as never, fixtures.cd8d41.prompt, false)
	assert.equal(ok?.vocal_gender, 'f')
	assert.equal(calls.length, 1)
	assert.equal(calls[0].length, 2, 'env.AI.run(model, input) with no gateway options')
	assert.equal(calls[0][0], SONG_INTENT_MODEL)
	const input = calls[0][1] as Record<string, any>
	assert.deepEqual(
		[input.response_format, input.temperature, input.reasoning_effort, input.chat_template_kwargs, input.max_completion_tokens],
		[{ type: 'json_object' }, 0.1, 'none', { enable_thinking: false }, 700],
	)
	assert.equal(input.messages[1].content, `instrumental: false\n1| ${fixtures.cd8d41.prompt}`)

	const rateLimited = { AI: { run: async () => { throw new Error('AiError: rate limiting: inference (429)') } } }
	const junk = { AI: { run: async () => ({ response: '{"mode":"sing","styles":"x"}' }) } }
	const stalled = { AI: { run: () => new Promise(() => {}) } }
	assert.equal(await analyzePromptWithModel(rateLimited as never, 'song', false), null)
	assert.equal(await analyzePromptWithModel(junk as never, 'song', false), null)
	const t0 = Date.now()
	assert.equal(await analyzePromptWithModel(stalled as never, 'song', false, 50), null)
	assert.ok(Date.now() - t0 < 1_000)

	const logs: string[] = []
	const log = console.log
	console.log = (line: string) => logs.push(line)
	try {
		const merged = await resolveSongIntent(rateLimited as never, 'secret prompt words', false)
		assert.equal(merged.mode, 'write')
	} finally {
		console.log = log
	}
	assert.equal(logs.length, 1)
	const event = JSON.parse(logs[0])
	assert.deepEqual(Object.keys(event).sort(), ['event', 'mode', 'ms', 'source'])
	assert.deepEqual([event.event, event.source, event.mode], ['song_intent', 'det', 'write'])
	assert.ok(!logs[0].includes('secret'))
})

test('AISG wire: old lyrics give byte-identical submit/replay/legacy bodies; new lyrics add vocalGender + string negativeTags and an empty instrumental caption', async () => {
	const bodies: Record<string, string> = {}
	const env = {
		AISONGGENERATOR: {
			fetch: async (url: string, init: RequestInit) => {
				const path = new URL(url).pathname
				bodies[path] = String(init.body)
				if (path === '/api/lyrics') return Response.json({ title: 't', style: ['a', 'b'], lyrics: 'l' })
				return Response.json(path === '/api/songs' ? ['s1', 's2'] : { task_id: 'task-1' })
			},
		},
	} as unknown as Env
	const send = async (lyrics: AiSongGeneratorLyrics, instrumental: boolean) => {
		await submitAisgTask(env, 'raw prompt', 'pixel caption', lyrics, true, instrumental, 'key-1')
		const submit = bodies['/api/tasks']
		await replayAisgTaskSubmit(env, 'raw prompt', 'pixel caption', lyrics, true, instrumental, 'key-1')
		assert.equal(bodies['/api/tasks'], submit, 'replay body === submit body')
		await generateSongs(env, 'raw prompt', 'pixel caption', lyrics, true, instrumental, 'key-1')
		assert.equal(bodies['/api/songs'], submit, 'legacy body === submit body')
		return submit
	}

	// Exactly what the pre-intent workflow sent (hash-stable for receipts already stored).
	assert.equal(
		await send({ title: 'Old', style: ['ambient', 'calm'], lyrics: '' }, true),
		'{"title":"Old","style":["ambient","calm"],"lyrics":"","prompt":"raw prompt","description":"pixel caption","public":true,"instrumental":true,"attempt_id":"key-1"}',
	)
	assert.equal(
		await send({ title: 'Old', style: ['pop', 'rock'], lyrics: '[Verse]\nla' }, false),
		'{"title":"Old","style":["pop","rock"],"lyrics":"[Verse]\\nla","prompt":"raw prompt","description":"pixel caption","public":true,"instrumental":false,"attempt_id":"key-1"}',
	)

	const vocal = finalize('cd8d41', modelOf('cd8d41'))
	const vocalBody = JSON.parse(await send(vocal, false))
	assert.deepEqual([vocalBody.vocalGender, vocalBody.negativeTags, vocalBody.description], ['f', 'male vocals', 'pixel caption'])
	assert.equal(typeof vocalBody.negativeTags, 'string')
	const inst = finalize('1f65e2', modelOf('1f65e2'), undefined, true)
	const instBody = JSON.parse(await send(inst, true))
	assert.deepEqual([instBody.description, instBody.lyrics, instBody.intent_v, 'vocalGender' in instBody], ['', '', 1, false])

	// The lyric LLM gets the raw prompt alongside the wrapper, and no cover caption.
	await generateLyrics(env, 'soft romantic rock song with female voice')
	const lyricsBody = JSON.parse(bodies['/api/lyrics'])
	assert.equal(lyricsBody.user_prompt, 'soft romantic rock song with female voice')
	assert.match(lyricsBody.prompt, /^# Prompt\nsoft romantic rock song with female voice\n/)
	assert.ok(!lyricsBody.prompt.includes('# Description'))
})
