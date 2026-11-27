import assert from 'node:assert/strict'
import test from 'node:test'
import {
	normalizeText,
	truncateText,
	uniqueStrings,
	clampSearchLimit,
	guessEnergy,
	guessBrightness,
	guessModality,
	guessMood,
	guessTheme,
	buildFallbackMetadata,
	normalizeMetadataPhrase,
	normalizeMetadataEnum,
	tryParseJsonObject,
	extractTextGenerationContent,
	normalizeExtractedSearchMetadata,
	parseSearchHints,
	fuseMatches,
	sortCandidates,
	blendCandidateMaps,
} from '../src/utils/search'

type Modality = 'style' | 'title' | 'lyrics' | 'description'

function assertTable<T>(fn: (input: string) => T, cases: Array<[string, T]>): void {
	for (const [input, expected] of cases) {
		assert.equal(fn(input), expected, `${fn.name}(${JSON.stringify(input)})`)
	}
}

test('text helpers normalize whitespace, truncate with an ellipsis, dedupe, and clamp limits', () => {
	assert.equal(normalizeText('  hello \n\t  world  '), 'hello world')
	assert.equal(normalizeText(null), '')
	assert.equal(truncateText('short', 100), 'short')
	assert.equal(truncateText('abcdefghij', 5), 'abcde…')
	assert.equal(truncateText('abc   defghij', 6), 'abc…')
	assert.deepEqual(uniqueStrings(['  pop ', 'pop', 'rock', null, undefined, '', '  ']), ['pop', 'rock'])
	for (const [input, expected] of [[undefined, 10], [0, 10], [NaN, 10], [-5, 10], [5, 5], [20, 20], [50, 20]] as const) {
		assert.equal(clampSearchLimit(input), expected)
	}
})

test('heuristic guesses map keywords to energy, brightness, modality, mood, and theme with stable defaults', () => {
	assertTable(guessEnergy, [['An Upbeat dance track', 'high'], ['hyper pop club banger', 'high'], ['mellow acoustic set', 'low'], ['chill vibes', 'low'], ['a song about rain', 'mid'], ['', 'mid']])
	assertTable(guessBrightness, [['WARM and joyful', 'bright'], ['colorful celebration', 'bright'], ['lonely night', 'dark'], ['the gloom sets in', 'dark'], ['a normal song', 'neutral']])
	assertTable(guessModality, [['Minor scale melody', 'minor'], ['a major key anthem', 'major'], ['a minority opinion', 'unknown'], ['the majority rules', 'unknown']])
	assertTable(guessMood, [['grief and sorrow', 'melancholic'], ['happy euphoric celebration', 'uplifting'], ['RAGE against the machine', 'defiant'], ['calm floating sensation', 'dreamy'], ['an orchestral piece', 'cinematic']])
	assertTable(guessTheme, [['a sweet romance and a kiss', 'love'], ['isolation and emptiness', 'loneliness'], ['the neon city street', 'nightlife'], ['memory and nostalgia', 'nostalgia'], ['raw POWER', 'resilience'], ['a regular song about rain', 'storytelling']])
})

test('buildFallbackMetadata derives metadata from style tags, instrumental flag, and lyric length', () => {
	const vocal = buildFallbackMetadata({
		id: 'smol-1',
		title: 'Heartbreak Hotel',
		public: true,
		instrumental: false,
		description: 'A sad lonely ballad',
		lyrics: { title: 'Heartbreak Hotel', style: ['dream pop', 'shoegaze'], lyrics: 'I am so lonely tonight' },
	})
	// "heart" in the title matches the love theme before loneliness
	assert.deepEqual(vocal, {
		style_primary: 'dream pop',
		mood_primary: 'melancholic',
		theme_primary: 'love',
		lyric_presence: 'sparse',
		brightness_level: 'dark',
		energy_level: 'mid',
		modality_guess: 'unknown',
		style_tags: ['dream pop', 'shoegaze'],
		title: 'Heartbreak Hotel',
	})

	const instrumental = buildFallbackMetadata({ id: 'smol-2', title: 'Dawn Theme', public: true, instrumental: true, description: 'A bright warm sunrise' })
	assert.deepEqual([instrumental.lyric_presence, instrumental.style_primary, instrumental.brightness_level], ['instrumental', 'instrumental', 'bright'])

	const heavy = buildFallbackMetadata({ id: 'smol-3', title: 'Epic', public: true, instrumental: false, lyrics: { title: 'Epic', style: ['rock'], lyrics: 'word '.repeat(200) } })
	assert.equal(heavy.lyric_presence, 'lyric-heavy')
	const untagged = buildFallbackMetadata({ id: 'smol-4', title: 'Song', public: true, instrumental: false, lyrics: { title: 'Song', style: [], lyrics: 'hello' } })
	assert.equal(untagged.style_primary, 'vocal')
})

test('model output parsing: JSON objects only, chat-completion or legacy shapes, enums fall back field by field', () => {
	assert.deepEqual(tryParseJsonObject('{"key": "value"}'), { key: 'value' })
	assert.deepEqual(tryParseJsonObject({ foo: 'bar' }), { foo: 'bar' })
	for (const bad of ['[1, 2, 3]', 'not json', undefined, '"just a string"']) {
		assert.equal(tryParseJsonObject(bad), null)
	}

	const content = '{"style_primary":"synthwave"}'
	assert.equal(extractTextGenerationContent({
		object: 'chat.completion',
		choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
	}), content)
	assert.deepEqual(extractTextGenerationContent({ response: { style_primary: 'folk' } }), { style_primary: 'folk' })
	assert.equal(extractTextGenerationContent({ response: '{"a":1}' }), '{"a":1}')
	assert.equal(extractTextGenerationContent({
		choices: [{ message: { role: 'assistant', content: '', reasoning_content: '...' }, finish_reason: 'length' }],
	}), undefined)
	assert.equal(extractTextGenerationContent('not an object'), undefined)

	assert.equal(normalizeMetadataPhrase('  Dream Pop ', 'fallback'), 'dream pop')
	for (const bad of [42, null, undefined, '', '   ']) {
		assert.equal(normalizeMetadataPhrase(bad, 'fallback'), 'fallback')
	}
	assert.equal(normalizeMetadataEnum('  HIGH  ', ['low', 'mid', 'high'] as const, 'mid'), 'high')
	assert.equal(normalizeMetadataEnum('invalid', ['dark', 'neutral', 'bright'] as const, 'neutral'), 'neutral')
	assert.equal(normalizeMetadataEnum(123, ['low', 'mid', 'high'] as const, 'mid'), 'mid')

	const fallback: SearchStoredMetadata = {
		style_primary: 'pop', mood_primary: 'uplifting', theme_primary: 'love', lyric_presence: 'sparse',
		brightness_level: 'bright', energy_level: 'mid', modality_guess: 'major', style_tags: ['pop'], title: 'Test',
	}
	assert.equal(normalizeExtractedSearchMetadata(null, fallback), null)
	const valid = normalizeExtractedSearchMetadata({
		style_primary: '  Indie Rock ', mood_primary: 'Melancholic', theme_primary: 'Heartbreak',
		lyric_presence: 'lyric-heavy', brightness_level: 'DARK', energy_level: 'low', modality_guess: 'minor',
	}, fallback)
	assert.deepEqual(
		[valid?.style_primary, valid?.mood_primary, valid?.theme_primary, valid?.lyric_presence, valid?.brightness_level, valid?.energy_level, valid?.modality_guess],
		['indie rock', 'melancholic', 'heartbreak', 'lyric-heavy', 'dark', 'low', 'minor']
	)
	const invalid = normalizeExtractedSearchMetadata({
		style_primary: 'rock', mood_primary: 'aggressive', theme_primary: 'war',
		lyric_presence: 'bogus-value', brightness_level: 'not-real', energy_level: 'extreme', modality_guess: 'pentatonic',
	}, fallback)
	assert.deepEqual(
		[invalid?.style_primary, invalid?.mood_primary, invalid?.lyric_presence, invalid?.brightness_level, invalid?.energy_level, invalid?.modality_guess],
		['rock', 'aggressive', 'sparse', 'bright', 'mid', 'major']
	)
})

test('tryParseJsonObject extracts wrapped JSON objects from model output', () => {
	const parsed = tryParseJsonObject(`Here is the JSON you requested:

\`\`\`json
{
  "style_primary": "dream pop",
  "mood_primary": "dreamy"
}
\`\`\`

Use it directly.`)

	assert.deepEqual(parsed, {
		style_primary: 'dream pop',
		mood_primary: 'dreamy',
	})
})

test('normalizeExtractedSearchMetadata maps common enum aliases to the schema contract', () => {
	const normalized = normalizeExtractedSearchMetadata({
		style_primary: 'Progressive Metal',
		mood_primary: 'Hard-Hitting',
		theme_primary: 'Cosmic',
		lyric_presence: 'full lyrics',
		brightness_level: 'balanced',
		energy_level: 'energetic',
		modality_guess: 'ambiguous',
	}, {
		style_primary: 'fallback style',
		mood_primary: 'fallback mood',
		theme_primary: 'fallback theme',
		lyric_presence: 'sparse',
		brightness_level: 'neutral',
		energy_level: 'mid',
		modality_guess: 'unknown',
		style_tags: [],
		title: 'Fallback',
	})

	assert.deepEqual(normalized, {
		style_primary: 'progressive metal',
		mood_primary: 'hard-hitting',
		theme_primary: 'cosmic',
		lyric_presence: 'lyric-heavy',
		brightness_level: 'neutral',
		energy_level: 'high',
		modality_guess: 'mixed',
	})
})

test('parseSearchHints reads lyric presence, brightness, energy, and key (including exclusions) from the query', () => {
	for (const empty of ['', null, undefined]) assert.deepEqual(parseSearchHints(empty), {})
	for (const q of ['instrumental jazz', 'something with no lyrics', 'a track without lyrics']) {
		assert.equal(parseSearchHints(q).instrumental, true, q)
	}
	assert.deepEqual(parseSearchHints('instrumental jazz').lyricPresence, ['instrumental'])
	for (const q of ['something with lyrics and a singer', 'lyrical ballad', 'with vocals', 'a singing voice']) {
		assert.equal(parseSearchHints(q).instrumental, false, q)
	}
	assert.deepEqual(parseSearchHints('with lyrics').lyricPresence, ['sparse', 'lyric-heavy'])

	for (const q of ['bright pop song', 'warm acoustic', 'sunny vibe', 'brighter feel', 'colourful mix']) assert.equal(parseSearchHints(q).brightness, 'bright', q)
	for (const q of ['dark ambient', 'darker tone', 'cold synth', 'shadowy atmosphere', 'moody electronica']) assert.equal(parseSearchHints(q).brightness, 'dark', q)
	for (const q of ['upbeat dance track', 'high energy workout music', 'energetic and faster', 'dancey remix']) assert.equal(parseSearchHints(q).energy, 'high', q)
	for (const q of ['calm ambient music', 'slow mellow jazz', 'low energy background', 'gentle lullaby']) assert.equal(parseSearchHints(q).energy, 'low', q)

	const key = (q: string) => [parseSearchHints(q).modality, parseSearchHints(q).excludeModality]
	assert.deepEqual(key('something in minor'), ['minor', undefined])
	assert.deepEqual(key('a song in major'), ['major', undefined])
	assert.deepEqual(key('not in a minor key'), [undefined, 'minor'])
	assert.deepEqual(key('not in a major key'), [undefined, 'major'])
	assert.deepEqual(key('no minor songs'), [undefined, 'minor'])

	const combined = parseSearchHints('bright high energy instrumental in minor')
	assert.deepEqual([combined.brightness, combined.energy, combined.instrumental, combined.modality], ['bright', 'high', true, 'minor'])
})

function matchesByModality(config: Partial<Record<Modality, string[]>>): Record<Modality, VectorizeMatches> {
	const result = {} as Record<Modality, VectorizeMatches>
	for (const modality of ['style', 'title', 'lyrics', 'description'] as const) {
		const ids = config[modality] ?? []
		result[modality] = {
			matches: ids.map((smolId, rank) => ({ id: `${smolId}:${modality}`, score: 1 - rank / 10, metadata: { smol_id: smolId } }) as unknown as VectorizeMatch),
			count: ids.length,
		}
	}
	return result
}

test('reciprocal-rank fusion weights modalities style > title > lyrics > description and ranks deterministically', () => {
	assert.equal(fuseMatches(matchesByModality({})).size, 0)

	const fused = fuseMatches(matchesByModality({ style: ['smol-A', 'smol-B'], title: ['smol-A'] }))
	assert.ok(Math.abs(fused.get('smol-A')!.score - (1.0 / 61 + 0.7 / 61)) < 1e-10)
	assert.ok(Math.abs(fused.get('smol-B')!.score - 1.0 / 62) < 1e-10)
	assert.ok(fused.get('smol-A')!.modalityScores.title! > 0)
	assert.equal(fused.get('smol-B')!.modalityScores.title, undefined)

	const single = fuseMatches(matchesByModality({ style: ['s'], title: ['t'], lyrics: ['l'], description: ['d'] }))
	assert.deepEqual(sortCandidates(single.values()).map((c) => c.smolId), ['s', 't', 'l', 'd'])

	const ranked = sortCandidates(fuseMatches(matchesByModality({
		style: ['smol-A', 'smol-C'], title: ['smol-A'], lyrics: ['smol-B'], description: ['smol-C'],
	})).values())
	assert.deepEqual(ranked.map((c) => c.smolId), ['smol-A', 'smol-C', 'smol-B'])

	const ties = [0.1, 0.5, 0.5, 0.5].map((score, i) => ({ smolId: ['a', 'zebra', 'alpha', 'mike'][i], score, modalityScores: {} }))
	assert.deepEqual(sortCandidates(ties).map((c) => c.smolId), ['alpha', 'mike', 'zebra', 'a'])
	assert.deepEqual(sortCandidates([]), [])
})

test('blendCandidateMaps weights base and refine scores, including per-modality scores', () => {
	type Scores = Partial<Record<Modality, number>>
	const base = new Map([
		['smol-1', { smolId: 'smol-1', score: 1.0, modalityScores: { style: 1.0 } as Scores }],
		['smol-2', { smolId: 'smol-2', score: 0.5, modalityScores: { style: 0.5 } as Scores }],
	])
	const refine = new Map([
		['smol-1', { smolId: 'smol-1', score: 0.5, modalityScores: { style: 0.4, lyrics: 0.6 } as Scores }],
		['smol-3', { smolId: 'smol-3', score: 0.9, modalityScores: { description: 0.9 } as Scores }],
	])
	const blended = blendCandidateMaps(base, refine, 0.7, 0.3)
	const close = (actual: number | undefined, expected: number) => assert.ok(Math.abs((actual ?? NaN) - expected) < 1e-10, `${actual} != ${expected}`)
	assert.equal(blended.size, 3)
	close(blended.get('smol-1')!.score, 1.0 * 0.7 + 0.5 * 0.3)
	close(blended.get('smol-2')!.score, 0.5 * 0.7)
	close(blended.get('smol-3')!.score, 0.9 * 0.3)
	close(blended.get('smol-1')!.modalityScores.style, 1.0 * 0.7 + 0.4 * 0.3)
	close(blended.get('smol-1')!.modalityScores.lyrics, 0.6 * 0.3)
	assert.equal(blended.get('smol-1')!.modalityScores.title, undefined)
	assert.equal(blendCandidateMaps(new Map(), new Map(), 0.5, 0.5).size, 0)
})
