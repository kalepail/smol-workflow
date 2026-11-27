import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
	analyzePromptWithModel,
	canBypassSongwriterWithIntent,
	finalizeSongText,
	mergeSongIntent,
	parseSongIntent,
	promptLines,
	resolveQuickTitle,
	resolveSongIntent,
	resolveStylesSource,
	sanitizeLyrics,
	SONG_INTENT_MODEL,
} from '../src/ai/song-intent'
import { generateLyrics, replayAisgTaskSubmit, submitAisgTask } from '../src/ai/aisonggenerator'

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
		await resolveSongIntent(rateLimited as never, 'secret prompt words', false, 'smol-trace-1')
	} finally {
		console.log = log
	}
	assert.equal(logs.length, 2)
	const event = JSON.parse(logs[0])
	assert.deepEqual(Object.keys(event).sort(), ['event', 'mode', 'ms', 'source'])
	assert.deepEqual([event.event, event.source, event.mode], ['song_intent', 'det', 'write'])
	const tracedEvent = JSON.parse(logs[1])
	assert.deepEqual(Object.keys(tracedEvent).sort(), ['event', 'mode', 'ms', 'smol_id', 'source'])
	assert.equal(tracedEvent.smol_id, 'smol-trace-1')
	assert.ok(!logs[0].includes('secret') && !logs[1].includes('secret'))
})

test('AISG wire: old lyrics give byte-identical submit/replay bodies; new lyrics add vocalGender + string negativeTags and an empty instrumental caption', async () => {
	const bodies: Record<string, string> = {}
	const headersByPath: Record<string, Headers> = {}
	const env = {
		AISONGGENERATOR: {
			fetch: async (url: string, init: RequestInit) => {
				const path = new URL(url).pathname
				bodies[path] = String(init.body)
				headersByPath[path] = new Headers(init.headers)
				if (path === '/api/lyrics') return Response.json({ title: 't', style: ['a', 'b'], lyrics: 'l', service: 'aisonggenerator.io', model: 'openrouter/auto' })
				return Response.json({ task_id: 'task-1' })
			},
		},
	} as unknown as Env
	const send = async (lyrics: AiSongGeneratorLyrics, instrumental: boolean) => {
		await submitAisgTask(env, 'raw prompt', 'pixel caption', lyrics, true, instrumental, 'key-1', 'smol-wire-1')
		const submit = bodies['/api/tasks']
		assert.equal(headersByPath['/api/tasks'].get('x-smol-id'), 'smol-wire-1')
		await replayAisgTaskSubmit(env, 'raw prompt', 'pixel caption', lyrics, true, instrumental, 'key-1', 'smol-wire-1')
		assert.equal(bodies['/api/tasks'], submit, 'replay body === submit body')
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

	// Short vocal prompt with description omits # Description (cover captions stay for UI/search/NSFW, not lyrics) and sends X-Smol-Id.
	await generateLyrics(env, 'soft romantic rock song with female voice', {
		description: 'Warm lantern light over a misty pier.',
		instrumental: false,
		smolId: 'smol-short-1',
	})
	const shortVocalBody = JSON.parse(bodies['/api/lyrics'])
	assert.equal(shortVocalBody.user_prompt, 'soft romantic rock song with female voice')
	assert.ok(!shortVocalBody.prompt.includes('# Description'))
	assert.ok(!shortVocalBody.prompt.includes('Warm lantern light'))
	assert.equal(headersByPath['/api/lyrics'].get('x-smol-id'), 'smol-short-1')

	// Short instrumental prompt and long (> 160 chars) vocal prompt omit # Description.
	await generateLyrics(env, 'soft piano', {
		description: 'Warm lantern light over a misty pier.',
		instrumental: true,
	})
	assert.ok(!JSON.parse(bodies['/api/lyrics']).prompt.includes('# Description'))

	const longPrompt = 'a'.repeat(161)
	await generateLyrics(env, longPrompt, {
		description: 'Warm lantern light over a misty pier.',
		instrumental: false,
	})
	assert.ok(!JSON.parse(bodies['/api/lyrics']).prompt.includes('# Description'))

	// Calling without description still omits # Description.
	await generateLyrics(env, 'soft romantic rock song with female voice')
	assert.ok(!JSON.parse(bodies['/api/lyrics']).prompt.includes('# Description'))
})

test('pass-1 #2: styles never fail a complete song (refill from songwriter, then neutral defaults)', () => {
	const sw = (style: string[]): AiSongGeneratorLyrics => ({ title: 'Night Bus', style, lyrics: SONGWRITER.lyrics })
	const run = (prompt: string, model: Parameters<typeof mergeSongIntent>[0], style: string[], instrumental = false) =>
		finalizeSongText(sw(style), mergeSongIntent(model, prompt, instrumental), prompt, instrumental).style

	const nightBus = run('Sad indie folk about a night bus', null, ['indie folk', 'female vocals'])
	assert.deepEqual(nightBus, ['indie folk', 'female vocals'], 'null model: refill restores the songwriter tag')
	assert.ok(run('a song', null, ['female vocals', 'male vocals']).length >= 2, 'two single-gender tags')
	assert.deepEqual(run('a song', null, ['female vocals']), ['female vocals', 'original song'])
	assert.deepEqual(run('soft piano', null, [], true), ['instrumental', 'full arrangement'])

	const folk = { mode: 'write' as const, lyrics_lines: null, title: null, vocal_gender: null, styles: ['folk', 'Folk', 'FOLK', 'fOlK'], exclusions: [] }
	const variants = run('folk song', folk, ['Folk', 'acoustic guitar', 'warm'])
	assert.deepEqual(variants, ['folk', 'acoustic guitar', 'warm'], 'case variants collapse, then refill')
	assert.deepEqual(run('folk song', folk, []), ['folk', 'original song'])

	// Exclusions still apply to the refill.
	assert.ok(!run('folk song, no drums', { ...folk, exclusions: ['drums'] }, ['drums', 'banjo']).includes('drums'))
	// Zero ASCII tags: unchanged behaviour (the unfiltered songwriter tags).
	assert.deepEqual(run('गीत', null, ['नेपाली गीत', 'भावपूर्ण']), ['नेपाली गीत', 'भावपूर्ण'])
})

test('pass-1 #3: range extension needs a quoted line; plain instructions after the lyric are never appended', () => {
	const lyric = '[Verse]\nWindow fogged\nCity asleep\nNeon puddles\n[Chorus]\nRide on\nOne more stop\nOver the hill'
	const model = { mode: 'user_lyrics' as const, lyrics_lines: [1, 8] as [number, number], title: null, vocal_gender: null, styles: [], exclusions: [] }
	const notes = `${lyric}\nPlease mix the drums louder.\nDo not sing these instructions.`
	const merged = mergeSongIntent(model, notes, false)
	assert.deepEqual(merged.lyrics_lines, [1, 8])
	assert.equal(finalizeSongText(SONGWRITER, merged, notes, false).lyrics, lyric)

	const quoted = `${lyric}\n“One more stop,” she said\nPlease mix the drums louder.`
	assert.deepEqual(mergeSongIntent(model, quoted, false).lyrics_lines, [1, 9])
})

test('pass-1 #4: sanitizeLyrics unwraps markdown cues and drops chord-chart lines (corpus 328a45, 4c46a7)', () => {
	const raw = [
		'[Verse 6]', '**[Outro – Screaming slide guitar]**', 'Roll him up!', '__[Bridge]__', '*[Fade]*',
		'**Verse 1**', '**Chorus:**', '**Really loud and proud**',
		'Dm........A#...........C..........Dm.......', 'G | D/F# | Em7 | Cmaj7', 'F#m7 - Bbmaj7 - G/B', 'C',
		'A day in May', 'Am I the one', 'Bad dreams again',
	].join('\n')
	const once = sanitizeLyrics(raw)
	assert.equal(once, [
		'[Verse 6]', '[Outro – Screaming slide guitar]', 'Roll him up!', '[Bridge]', '[Fade]',
		'[Verse 1]', '[Chorus]', '**Really loud and proud**',
		'C', 'A day in May', 'Am I the one', 'Bad dreams again',
	].join('\n'))
	assert.equal(sanitizeLyrics(once), once, 'idempotent')
})

test('pass-1 #5: vocal lyrics are never empty (1f65e2 with songwriter "(No lyrics)")', () => {
	const noLyrics = { ...fixtures['1f65e2'].songwriter!, lyrics: '(No lyrics)' }
	const out = finalize('1f65e2', modelOf('1f65e2'), noLyrics, false)
	assert.ok(out.lyrics.trim().length > 0)
	assert.ok(out.title && out.style.length >= 2)
	const chordsOnly = { ...noLyrics, lyrics: '(No lyrics)\nDm....C....G\nAm..F' }
	assert.equal(finalize('1f65e2', modelOf('1f65e2'), chordsOnly, false).lyrics, 'Dm....C....G\nAm..F', 'raw minus placeholders')
	assert.equal(finalize('1f65e2', modelOf('1f65e2'), noLyrics, true).lyrics, '', 'instrumental stays empty')
})

test('LYR-3 smart style merge: prefers upgraded CF songwriter styles on write-mode without [STYLE:], while honoring gender/exclusions/clauses', () => {
	const richSongwriter: AiSongGeneratorLyrics = {
		title: 'Passenger Side',
		lyrics: '[Verse 1]\nLine one\nLine two\nLine three\nLine four',
		style: [
			'warm 90s indie soft rock',
			'smoky female alto, intimate phrasing',
			'clean chiming telecaster, brushed snare',
			'slow 74 BPM swaying groove',
			'dry close-mic warmth, wide chorus lift',
		],
	}

	// Open-ended write prompt -> songwriter styles win when preferSongwriterStyles is true
	const romIntent = mergeSongIntent(modelOf('cd8d41'), fixtures.cd8d41.prompt, false)
	assert.equal(resolveStylesSource(richSongwriter, romIntent, false, { preferSongwriterStyles: true }), 'songwriter')
	const romOut = finalizeSongText(richSongwriter, romIntent, fixtures.cd8d41.prompt, false, { preferSongwriterStyles: true })
	assert.equal(romOut.style[0], 'warm 90s indie soft rock')
	assert.match(firstThree(romOut.style), /female/i)
	assert.equal(romOut.vocalGender, 'f')
	assert.equal(romOut.negativeTags, 'male vocals')

	// Exclusions still filter songwriter tags, and genderless prompts still strip unrequested single-gender tags
	// (while preserving instruments like "alto sax" / "baritone guitar")
	const exIntent = mergeSongIntent(
		{ mode: 'write', lyrics_lines: null, title: null, vocal_gender: null, styles: ['indie rock', 'guitar', 'bass', 'warm'], exclusions: ['snare'] },
		'indie rock song, no snare',
		false,
	)
	const exOut = finalizeSongText(
		{ ...richSongwriter, style: [...richSongwriter.style, 'alto sax', 'baritone guitar'] },
		exIntent,
		'indie rock song, no snare',
		false,
		{ preferSongwriterStyles: true },
	)
	assert.ok(!exOut.style.some((s) => /snare/i.test(s)), 'exclusion stripped from songwriter styles')
	assert.ok(!exOut.style.some((s) => /female/i.test(s)), 'unstated gender drops single-gender songwriter tag')
	assert.ok(exOut.style.some((s) => /alto sax/i.test(s)), 'instrument "alto sax" is preserved')
	assert.ok(exOut.style.some((s) => /baritone guitar/i.test(s)), 'instrument "baritone guitar" is preserved')

	// AISG fallback (preferSongwriterStyles: false) still lets intent.styles win over AISG tag soup
	assert.equal(resolveStylesSource(richSongwriter, romIntent, false, { preferSongwriterStyles: false }), 'model')
	const aisgOut = finalizeSongText(richSongwriter, romIntent, fixtures.cd8d41.prompt, false, { preferSongwriterStyles: false })
	assert.equal(aisgOut.style[0], 'soft rock')

	// Explicit [STYLE: ...] clause or user_lyrics or instrumental keeps intent.styles / clauses authoritative
	const nootIntent = mergeSongIntent(modelOf('34d372'), fixtures['34d372'].prompt, false)
	assert.equal(resolveStylesSource(richSongwriter, nootIntent, false, { preferSongwriterStyles: true }), 'model')
	const instIntent = mergeSongIntent(modelOf('1f65e2'), fixtures['1f65e2'].prompt, true)
	assert.equal(resolveStylesSource(richSongwriter, instIntent, true, { preferSongwriterStyles: true }), 'model')
})

test('LYR-2 intent-first bypass: user_lyrics and instrumental skip full songwriter; resolveQuickTitle handles untitled prompts cleanly', async () => {
	// Noot-4 user_lyrics with explicit title + styles -> eligible to bypass full songwriter
	const nootIntent = mergeSongIntent(modelOf('34d372'), fixtures['34d372'].prompt, false)
	assert.equal(canBypassSongwriterWithIntent(nootIntent, fixtures['34d372'].prompt, false), true)
	// Instrumental with styles -> eligible to bypass full songwriter
	const instIntent = mergeSongIntent(modelOf('1f65e2'), fixtures['1f65e2'].prompt, true)
	assert.equal(canBypassSongwriterWithIntent(instIntent, fixtures['1f65e2'].prompt, true), true)
	// Standard write prompt -> NEVER bypasses songwriter
	const writeIntent = mergeSongIntent(modelOf('cd8d41'), fixtures.cd8d41.prompt, false)
	assert.equal(canBypassSongwriterWithIntent(writeIntent, fixtures.cd8d41.prompt, false), false)

	// resolveQuickTitle parses valid JSON and returns null safely on errors
	const titleOk = await resolveQuickTitle(
		{ AI: { run: async () => ({ response: '{"title":"Rain on Tin"}' }) } } as never,
		'chill lo-fi rain on a tin roof',
		true,
	)
	assert.equal(titleOk, 'Rain on Tin')
	const titleFail = await resolveQuickTitle(
		{ AI: { run: async () => { throw new Error('429') } } } as never,
		'chill lo-fi rain on a tin roof',
		true,
	)
	assert.equal(titleFail, null)
})
