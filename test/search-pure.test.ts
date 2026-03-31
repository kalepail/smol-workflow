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
	normalizeExtractedSearchMetadata,
	parseSearchHints,
	fuseMatches,
	sortCandidates,
	blendCandidateMaps,
} from '../src/utils/search'

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

test('normalizeText collapses internal whitespace and trims', () => {
	assert.equal(normalizeText('  hello   world  '), 'hello world')
})

test('normalizeText handles tabs and newlines', () => {
	assert.equal(normalizeText('line\n\ttwo'), 'line two')
})

test('normalizeText returns empty string for null/undefined', () => {
	assert.equal(normalizeText(null), '')
	assert.equal(normalizeText(undefined), '')
})

test('normalizeText passes through a clean string unchanged', () => {
	assert.equal(normalizeText('already clean'), 'already clean')
})

test('truncateText returns input unchanged when within limit', () => {
	assert.equal(truncateText('short', 100), 'short')
})

test('truncateText cuts at maxChars and appends ellipsis', () => {
	const result = truncateText('abcdefghij', 5)
	assert.equal(result, 'abcde\u2026')
})

test('truncateText trims trailing whitespace before ellipsis', () => {
	const result = truncateText('abc   defghij', 6)
	assert.equal(result, 'abc\u2026')
})

test('uniqueStrings deduplicates and normalizes', () => {
	const result = uniqueStrings(['  pop ', 'pop', 'rock', null, undefined, ''])
	assert.deepEqual(result, ['pop', 'rock'])
})

test('uniqueStrings returns empty array for all-empty inputs', () => {
	assert.deepEqual(uniqueStrings([null, undefined, '', '  ']), [])
})

test('clampSearchLimit defaults to 10 for undefined/zero/NaN', () => {
	assert.equal(clampSearchLimit(undefined), 10)
	assert.equal(clampSearchLimit(0), 10)
	assert.equal(clampSearchLimit(NaN), 10)
	assert.equal(clampSearchLimit(-5), 10)
})

test('clampSearchLimit caps at SEARCH_MAX_LIMIT (20)', () => {
	assert.equal(clampSearchLimit(50), 20)
	assert.equal(clampSearchLimit(20), 20)
})

test('clampSearchLimit passes through valid values under the cap', () => {
	assert.equal(clampSearchLimit(5), 5)
	assert.equal(clampSearchLimit(1), 1)
})

// ---------------------------------------------------------------------------
// Metadata heuristic functions
// ---------------------------------------------------------------------------

test('guessEnergy returns high for upbeat keywords', () => {
	assert.equal(guessEnergy('An Upbeat dance track'), 'high')
	assert.equal(guessEnergy('PUNK anthem'), 'high')
	assert.equal(guessEnergy('hyper pop club banger'), 'high')
})

test('guessEnergy returns low for calm keywords', () => {
	assert.equal(guessEnergy('slow ambient drone'), 'low')
	assert.equal(guessEnergy('mellow acoustic set'), 'low')
	assert.equal(guessEnergy('soft gentle lullaby'), 'low')
	assert.equal(guessEnergy('chill vibes'), 'low')
})

test('guessEnergy defaults to mid when no keywords match', () => {
	assert.equal(guessEnergy('a song about rain'), 'mid')
	assert.equal(guessEnergy(''), 'mid')
})

test('guessBrightness returns bright for warm/happy keywords', () => {
	assert.equal(guessBrightness('bright sunny day'), 'bright')
	assert.equal(guessBrightness('WARM and joyful'), 'bright')
	assert.equal(guessBrightness('hopeful glow'), 'bright')
	assert.equal(guessBrightness('colorful celebration'), 'bright')
})

test('guessBrightness returns dark for gloomy/cold keywords', () => {
	assert.equal(guessBrightness('dark and moody'), 'dark')
	assert.equal(guessBrightness('lonely night'), 'dark')
	assert.equal(guessBrightness('cold shadow'), 'dark')
	assert.equal(guessBrightness('the gloom sets in'), 'dark')
})

test('guessBrightness defaults to neutral', () => {
	assert.equal(guessBrightness('a normal song'), 'neutral')
	assert.equal(guessBrightness(''), 'neutral')
})

test('guessModality detects minor key', () => {
	assert.equal(guessModality('a song in minor key'), 'minor')
	assert.equal(guessModality('Minor scale melody'), 'minor')
})

test('guessModality detects major key', () => {
	assert.equal(guessModality('a major key anthem'), 'major')
})

test('guessModality does not match partial words', () => {
	assert.equal(guessModality('a minority opinion'), 'unknown')
	assert.equal(guessModality('the majority rules'), 'unknown')
})

test('guessModality defaults to unknown', () => {
	assert.equal(guessModality('something else'), 'unknown')
	assert.equal(guessModality(''), 'unknown')
})

test('guessMood returns melancholic for sad keywords', () => {
	assert.equal(guessMood('a lonely heartbreak song'), 'melancholic')
	assert.equal(guessMood('grief and sorrow'), 'melancholic')
	assert.equal(guessMood('feeling SAD today'), 'melancholic')
})

test('guessMood returns uplifting for happy keywords', () => {
	assert.equal(guessMood('pure joy and fun'), 'uplifting')
	assert.equal(guessMood('happy euphoric celebration'), 'uplifting')
})

test('guessMood returns defiant for angry keywords', () => {
	assert.equal(guessMood('RAGE against the machine'), 'defiant')
	assert.equal(guessMood('angry rebellious protest'), 'defiant')
})

test('guessMood returns dreamy for calm/dream keywords', () => {
	assert.equal(guessMood('a peaceful dream'), 'dreamy')
	assert.equal(guessMood('calm floating sensation'), 'dreamy')
})

test('guessMood defaults to cinematic', () => {
	assert.equal(guessMood('an orchestral piece'), 'cinematic')
	assert.equal(guessMood(''), 'cinematic')
})

test('guessTheme returns love for romantic keywords', () => {
	assert.equal(guessTheme('a love song from the heart'), 'love')
	assert.equal(guessTheme('a sweet romance and a kiss'), 'love')
})

test('guessTheme returns loneliness for isolation keywords', () => {
	assert.equal(guessTheme('lonely and alone'), 'loneliness')
	assert.equal(guessTheme('isolation and emptiness'), 'loneliness')
})

test('guessTheme returns nightlife for urban keywords', () => {
	assert.equal(guessTheme('the neon city street'), 'nightlife')
	assert.equal(guessTheme('a night out in the city'), 'nightlife')
})

test('guessTheme returns nostalgia for memory keywords', () => {
	assert.equal(guessTheme('a dream of yesterday'), 'nostalgia')
	assert.equal(guessTheme('memory and nostalgia'), 'nostalgia')
})

test('guessTheme returns resilience for power keywords', () => {
	assert.equal(guessTheme('rise and fight to survive'), 'resilience')
	assert.equal(guessTheme('raw POWER'), 'resilience')
})

test('guessTheme defaults to storytelling', () => {
	assert.equal(guessTheme('a regular song about rain'), 'storytelling')
	assert.equal(guessTheme(''), 'storytelling')
})

// ---------------------------------------------------------------------------
// buildFallbackMetadata
// ---------------------------------------------------------------------------

test('buildFallbackMetadata builds correct metadata for a vocal song with style tags', () => {
	const source = {
		id: 'smol-1',
		title: 'Heartbreak Hotel',
		public: true,
		instrumental: false,
		description: 'A sad lonely ballad',
		lyrics: {
			title: 'Heartbreak Hotel',
			style: ['dream pop', 'shoegaze'],
			lyrics: 'I am so lonely tonight',
		},
	}

	const result = buildFallbackMetadata(source)

	assert.equal(result.style_primary, 'dream pop')
	assert.equal(result.mood_primary, 'melancholic')
	// "heart" in the title matches the love theme before loneliness
	assert.equal(result.theme_primary, 'love')
	assert.equal(result.lyric_presence, 'sparse')
	assert.equal(result.brightness_level, 'dark')
	assert.equal(result.energy_level, 'mid')
	assert.equal(result.modality_guess, 'unknown')
	assert.deepEqual(result.style_tags, ['dream pop', 'shoegaze'])
	assert.equal(result.title, 'Heartbreak Hotel')
})

test('buildFallbackMetadata marks instrumental songs correctly', () => {
	const source = {
		id: 'smol-2',
		title: 'Dawn Theme',
		public: true,
		instrumental: true,
		description: 'A bright warm sunrise',
	}

	const result = buildFallbackMetadata(source)

	assert.equal(result.lyric_presence, 'instrumental')
	assert.equal(result.style_primary, 'instrumental')
	assert.equal(result.brightness_level, 'bright')
})

test('buildFallbackMetadata assigns lyric-heavy when lyrics exceed 800 chars', () => {
	const longLyrics = 'word '.repeat(200)
	const source = {
		id: 'smol-3',
		title: 'Epic Song',
		public: true,
		instrumental: false,
		lyrics: {
			title: 'Epic Song',
			style: ['rock'],
			lyrics: longLyrics,
		},
	}

	const result = buildFallbackMetadata(source)
	assert.equal(result.lyric_presence, 'lyric-heavy')
})

test('buildFallbackMetadata falls back to vocal when no style tags and not instrumental', () => {
	const source = {
		id: 'smol-4',
		title: 'Song',
		public: true,
		instrumental: false,
		lyrics: {
			title: 'Song',
			style: [],
			lyrics: 'hello',
		},
	}

	const result = buildFallbackMetadata(source)
	assert.equal(result.style_primary, 'vocal')
})

// ---------------------------------------------------------------------------
// normalizeMetadataPhrase / normalizeMetadataEnum
// ---------------------------------------------------------------------------

test('normalizeMetadataPhrase returns lowercased trimmed value for valid string', () => {
	assert.equal(normalizeMetadataPhrase('  Dream Pop ', 'fallback'), 'dream pop')
})

test('normalizeMetadataPhrase returns fallback for non-string', () => {
	assert.equal(normalizeMetadataPhrase(42, 'fallback'), 'fallback')
	assert.equal(normalizeMetadataPhrase(null, 'fallback'), 'fallback')
	assert.equal(normalizeMetadataPhrase(undefined, 'fallback'), 'fallback')
})

test('normalizeMetadataPhrase returns fallback for empty string', () => {
	assert.equal(normalizeMetadataPhrase('', 'fallback'), 'fallback')
	assert.equal(normalizeMetadataPhrase('   ', 'fallback'), 'fallback')
})

test('normalizeMetadataEnum returns matched value when valid', () => {
	assert.equal(normalizeMetadataEnum('dark', ['dark', 'neutral', 'bright'] as const, 'neutral'), 'dark')
	assert.equal(normalizeMetadataEnum('  HIGH  ', ['low', 'mid', 'high'] as const, 'mid'), 'high')
})

test('normalizeMetadataEnum returns fallback for invalid enum value', () => {
	assert.equal(normalizeMetadataEnum('invalid', ['dark', 'neutral', 'bright'] as const, 'neutral'), 'neutral')
})

test('normalizeMetadataEnum returns fallback for non-string', () => {
	assert.equal(normalizeMetadataEnum(123, ['low', 'mid', 'high'] as const, 'mid'), 'mid')
})

// ---------------------------------------------------------------------------
// tryParseJsonObject
// ---------------------------------------------------------------------------

test('tryParseJsonObject parses valid JSON string to object', () => {
	const result = tryParseJsonObject('{"key": "value"}')
	assert.deepEqual(result, { key: 'value' })
})

test('tryParseJsonObject returns null for JSON array string', () => {
	assert.equal(tryParseJsonObject('[1, 2, 3]'), null)
})

test('tryParseJsonObject returns null for invalid JSON', () => {
	assert.equal(tryParseJsonObject('not json'), null)
})

test('tryParseJsonObject returns null for undefined', () => {
	assert.equal(tryParseJsonObject(undefined), null)
})

test('tryParseJsonObject passes through an object directly', () => {
	const obj = { foo: 'bar' }
	assert.deepEqual(tryParseJsonObject(obj), obj)
})

test('tryParseJsonObject returns null for JSON primitive string', () => {
	assert.equal(tryParseJsonObject('"just a string"'), null)
})

// ---------------------------------------------------------------------------
// normalizeExtractedSearchMetadata
// ---------------------------------------------------------------------------

test('normalizeExtractedSearchMetadata returns null for null input', () => {
	const fallback: SearchStoredMetadata = {
		style_primary: 'pop',
		mood_primary: 'uplifting',
		theme_primary: 'love',
		lyric_presence: 'sparse',
		brightness_level: 'bright',
		energy_level: 'mid',
		modality_guess: 'major',
		style_tags: ['pop'],
		title: 'Test',
	}

	assert.equal(normalizeExtractedSearchMetadata(null, fallback), null)
})

test('normalizeExtractedSearchMetadata normalizes valid AI output', () => {
	const fallback: SearchStoredMetadata = {
		style_primary: 'pop',
		mood_primary: 'uplifting',
		theme_primary: 'love',
		lyric_presence: 'sparse',
		brightness_level: 'bright',
		energy_level: 'mid',
		modality_guess: 'major',
		style_tags: ['pop'],
		title: 'Test',
	}

	const input = {
		style_primary: '  Indie Rock ',
		mood_primary: 'Melancholic',
		theme_primary: 'Heartbreak',
		lyric_presence: 'lyric-heavy',
		brightness_level: 'DARK',
		energy_level: 'low',
		modality_guess: 'minor',
	}

	const result = normalizeExtractedSearchMetadata(input, fallback)

	assert.ok(result)
	assert.equal(result.style_primary, 'indie rock')
	assert.equal(result.mood_primary, 'melancholic')
	assert.equal(result.theme_primary, 'heartbreak')
	assert.equal(result.lyric_presence, 'lyric-heavy')
	assert.equal(result.brightness_level, 'dark')
	assert.equal(result.energy_level, 'low')
	assert.equal(result.modality_guess, 'minor')
})

test('normalizeExtractedSearchMetadata falls back for invalid enum values', () => {
	const fallback: SearchStoredMetadata = {
		style_primary: 'pop',
		mood_primary: 'uplifting',
		theme_primary: 'love',
		lyric_presence: 'sparse',
		brightness_level: 'bright',
		energy_level: 'mid',
		modality_guess: 'major',
		style_tags: ['pop'],
		title: 'Test',
	}

	const input = {
		style_primary: 'rock',
		mood_primary: 'aggressive',
		theme_primary: 'war',
		lyric_presence: 'bogus-value',
		brightness_level: 'not-real',
		energy_level: 'extreme',
		modality_guess: 'pentatonic',
	}

	const result = normalizeExtractedSearchMetadata(input, fallback)

	assert.ok(result)
	assert.equal(result.lyric_presence, 'sparse')
	assert.equal(result.brightness_level, 'bright')
	assert.equal(result.energy_level, 'mid')
	assert.equal(result.modality_guess, 'major')
	// Free-form phrases should still pass through normalized
	assert.equal(result.style_primary, 'rock')
	assert.equal(result.mood_primary, 'aggressive')
	assert.equal(result.theme_primary, 'war')
})

// ---------------------------------------------------------------------------
// Query hint parsing
// ---------------------------------------------------------------------------

test('parseSearchHints returns empty object for empty/null/undefined input', () => {
	assert.deepEqual(parseSearchHints(''), {})
	assert.deepEqual(parseSearchHints(null), {})
	assert.deepEqual(parseSearchHints(undefined), {})
})

test('parseSearchHints detects instrumental', () => {
	const hints = parseSearchHints('instrumental jazz')
	assert.equal(hints.instrumental, true)
	assert.deepEqual(hints.lyricPresence, ['instrumental'])
})

test('parseSearchHints detects no lyrics', () => {
	const hints = parseSearchHints('something with no lyrics')
	assert.equal(hints.instrumental, true)
	assert.deepEqual(hints.lyricPresence, ['instrumental'])
})

test('parseSearchHints detects without lyrics', () => {
	const hints = parseSearchHints('a track without lyrics')
	assert.equal(hints.instrumental, true)
})

test('parseSearchHints detects with lyrics / vocal requests', () => {
	const hints = parseSearchHints('something with lyrics and a singer')
	assert.equal(hints.instrumental, false)
	assert.deepEqual(hints.lyricPresence, ['sparse', 'lyric-heavy'])
})

test('parseSearchHints detects singing/vocals variants', () => {
	assert.equal(parseSearchHints('lyrical ballad').instrumental, false)
	assert.equal(parseSearchHints('with vocals').instrumental, false)
	assert.equal(parseSearchHints('a singing voice').instrumental, false)
})

test('parseSearchHints detects bright', () => {
	assert.equal(parseSearchHints('bright pop song').brightness, 'bright')
	assert.equal(parseSearchHints('warm acoustic').brightness, 'bright')
	assert.equal(parseSearchHints('sunny vibe').brightness, 'bright')
	assert.equal(parseSearchHints('brighter feel').brightness, 'bright')
	assert.equal(parseSearchHints('colourful mix').brightness, 'bright')
})

test('parseSearchHints detects dark', () => {
	assert.equal(parseSearchHints('dark ambient').brightness, 'dark')
	assert.equal(parseSearchHints('darker tone').brightness, 'dark')
	assert.equal(parseSearchHints('cold synth').brightness, 'dark')
	assert.equal(parseSearchHints('shadowy atmosphere').brightness, 'dark')
	assert.equal(parseSearchHints('moody electronica').brightness, 'dark')
})

test('parseSearchHints detects high energy', () => {
	assert.equal(parseSearchHints('upbeat dance track').energy, 'high')
	assert.equal(parseSearchHints('high energy workout music').energy, 'high')
	assert.equal(parseSearchHints('energetic and faster').energy, 'high')
	assert.equal(parseSearchHints('dancey remix').energy, 'high')
})

test('parseSearchHints detects low energy', () => {
	assert.equal(parseSearchHints('calm ambient music').energy, 'low')
	assert.equal(parseSearchHints('slow mellow jazz').energy, 'low')
	assert.equal(parseSearchHints('low energy background').energy, 'low')
	assert.equal(parseSearchHints('gentle lullaby').energy, 'low')
})

test('parseSearchHints detects minor key', () => {
	const hints = parseSearchHints('something in minor')
	assert.equal(hints.modality, 'minor')
	assert.equal(hints.excludeModality, undefined)
})

test('parseSearchHints detects major key', () => {
	const hints = parseSearchHints('a song in major')
	assert.equal(hints.modality, 'major')
	assert.equal(hints.excludeModality, undefined)
})

test('parseSearchHints detects not minor (exclude)', () => {
	const hints = parseSearchHints('not in a minor key')
	assert.equal(hints.excludeModality, 'minor')
	assert.equal(hints.modality, undefined)
})

test('parseSearchHints detects not major (exclude)', () => {
	const hints = parseSearchHints('not in a major key')
	assert.equal(hints.excludeModality, 'major')
	assert.equal(hints.modality, undefined)
})

test('parseSearchHints no minor shorthand', () => {
	const hints = parseSearchHints('no minor songs')
	assert.equal(hints.excludeModality, 'minor')
	assert.equal(hints.modality, undefined)
})

test('parseSearchHints does not set modality when exclude is present', () => {
	// "not minor" should exclude minor but not set modality to major
	const hints = parseSearchHints('not minor stuff')
	assert.equal(hints.excludeModality, 'minor')
	assert.equal(hints.modality, undefined)
})

test('parseSearchHints combines multiple hints', () => {
	const hints = parseSearchHints('bright high energy instrumental in minor')
	assert.equal(hints.brightness, 'bright')
	assert.equal(hints.energy, 'high')
	assert.equal(hints.instrumental, true)
	assert.equal(hints.modality, 'minor')
})

// ---------------------------------------------------------------------------
// RRF ranking: fuseMatches
// ---------------------------------------------------------------------------

function makeMatch(smolId: string, _score: number): VectorizeMatch {
	return {
		id: `${smolId}:style`,
		score: _score,
		metadata: { smol_id: smolId },
	} as unknown as VectorizeMatch
}

function makeMatchesByModality(config: Record<string, Array<{ smolId: string; score: number }>>): Record<'style' | 'title' | 'lyrics' | 'description', VectorizeMatches> {
	const empty: VectorizeMatches = { matches: [], count: 0 }
	const result = {
		style: empty,
		title: empty,
		lyrics: empty,
		description: empty,
	}

	for (const [modality, entries] of Object.entries(config)) {
		result[modality as keyof typeof result] = {
			matches: entries.map((e) => makeMatch(e.smolId, e.score)),
			count: entries.length,
		}
	}

	return result
}

test('fuseMatches returns empty map for empty input', () => {
	const result = fuseMatches(makeMatchesByModality({}))
	assert.equal(result.size, 0)
})

test('fuseMatches aggregates scores across modalities using RRF', () => {
	// smol-A appears at rank 0 in style (weight 1.0) and rank 0 in title (weight 0.7)
	// smol-B appears at rank 1 in style only
	const matchesByModality = makeMatchesByModality({
		style: [
			{ smolId: 'smol-A', score: 0.95 },
			{ smolId: 'smol-B', score: 0.85 },
		],
		title: [
			{ smolId: 'smol-A', score: 0.90 },
		],
	})

	const fused = fuseMatches(matchesByModality)

	assert.equal(fused.size, 2)

	const candidateA = fused.get('smol-A')!
	const candidateB = fused.get('smol-B')!

	assert.ok(candidateA)
	assert.ok(candidateB)

	// smol-A: style contribution = 1.0 * 1/(60+0+1) = 1/61
	//         title contribution = 0.7 * 1/(60+0+1) = 0.7/61
	const expectedA = (1.0 / 61) + (0.7 / 61)
	assert.ok(Math.abs(candidateA.score - expectedA) < 1e-10, `Expected ~${expectedA}, got ${candidateA.score}`)

	// smol-B: style contribution = 1.0 * 1/(60+1+1) = 1/62
	const expectedB = 1.0 / 62
	assert.ok(Math.abs(candidateB.score - expectedB) < 1e-10, `Expected ~${expectedB}, got ${candidateB.score}`)

	// A should have higher score than B
	assert.ok(candidateA.score > candidateB.score)
})

test('fuseMatches tracks modalityScores per candidate', () => {
	const matchesByModality = makeMatchesByModality({
		style: [{ smolId: 'smol-X', score: 0.9 }],
		lyrics: [{ smolId: 'smol-X', score: 0.8 }],
	})

	const fused = fuseMatches(matchesByModality)
	const candidate = fused.get('smol-X')!

	assert.ok(candidate.modalityScores.style! > 0)
	assert.ok(candidate.modalityScores.lyrics! > 0)
	assert.equal(candidate.modalityScores.title, undefined)
	assert.equal(candidate.modalityScores.description, undefined)
})

test('fuseMatches applies modality weights correctly (style > title > lyrics > description)', () => {
	// Each smol appears at rank 0 in exactly one modality
	const matchesByModality = makeMatchesByModality({
		style: [{ smolId: 'smol-style', score: 0.9 }],
		title: [{ smolId: 'smol-title', score: 0.9 }],
		lyrics: [{ smolId: 'smol-lyrics', score: 0.9 }],
		description: [{ smolId: 'smol-desc', score: 0.9 }],
	})

	const fused = fuseMatches(matchesByModality)

	const styleScore = fused.get('smol-style')!.score
	const titleScore = fused.get('smol-title')!.score
	const lyricsScore = fused.get('smol-lyrics')!.score
	const descScore = fused.get('smol-desc')!.score

	assert.ok(styleScore > titleScore, 'style weight should produce higher score than title')
	assert.ok(titleScore > lyricsScore, 'title weight should produce higher score than lyrics')
	assert.ok(lyricsScore > descScore, 'lyrics weight should produce higher score than description')
})

// ---------------------------------------------------------------------------
// sortCandidates
// ---------------------------------------------------------------------------

test('sortCandidates orders by score descending', () => {
	const candidates = [
		{ smolId: 'a', score: 0.1, modalityScores: {} },
		{ smolId: 'b', score: 0.5, modalityScores: {} },
		{ smolId: 'c', score: 0.3, modalityScores: {} },
	]

	const sorted = sortCandidates(candidates)
	assert.deepEqual(sorted.map((c) => c.smolId), ['b', 'c', 'a'])
})

test('sortCandidates uses smolId as tiebreaker (alphabetical ascending)', () => {
	const candidates = [
		{ smolId: 'zebra', score: 0.5, modalityScores: {} },
		{ smolId: 'alpha', score: 0.5, modalityScores: {} },
		{ smolId: 'mike', score: 0.5, modalityScores: {} },
	]

	const sorted = sortCandidates(candidates)
	assert.deepEqual(sorted.map((c) => c.smolId), ['alpha', 'mike', 'zebra'])
})

test('sortCandidates handles empty input', () => {
	assert.deepEqual(sortCandidates([]), [])
})

// ---------------------------------------------------------------------------
// blendCandidateMaps
// ---------------------------------------------------------------------------

test('blendCandidateMaps blends scores from two maps with given weights', () => {
	const base = new Map([
		['smol-1', { smolId: 'smol-1', score: 1.0, modalityScores: { style: 0.8, title: 0.2 } }],
		['smol-2', { smolId: 'smol-2', score: 0.5, modalityScores: { style: 0.5 } }],
	])

	const refine = new Map([
		['smol-1', { smolId: 'smol-1', score: 0.6, modalityScores: { style: 0.3, lyrics: 0.3 } }],
		['smol-3', { smolId: 'smol-3', score: 0.9, modalityScores: { description: 0.9 } }],
	])

	const blended = blendCandidateMaps(base, refine, 0.7, 0.3)

	assert.equal(blended.size, 3)

	// smol-1 appears in both
	const s1 = blended.get('smol-1')!
	assert.ok(Math.abs(s1.score - (1.0 * 0.7 + 0.6 * 0.3)) < 1e-10)

	// smol-2 only in base
	const s2 = blended.get('smol-2')!
	assert.ok(Math.abs(s2.score - (0.5 * 0.7)) < 1e-10)

	// smol-3 only in refine
	const s3 = blended.get('smol-3')!
	assert.ok(Math.abs(s3.score - (0.9 * 0.3)) < 1e-10)
})

test('blendCandidateMaps blends modality scores per-field', () => {
	const base = new Map([
		['smol-1', { smolId: 'smol-1', score: 1.0, modalityScores: { style: 1.0 } as Partial<Record<'style' | 'title' | 'lyrics' | 'description', number>> }],
	])

	const refine = new Map([
		['smol-1', { smolId: 'smol-1', score: 0.5, modalityScores: { style: 0.4, lyrics: 0.6 } as Partial<Record<'style' | 'title' | 'lyrics' | 'description', number>> }],
	])

	const blended = blendCandidateMaps(base, refine, 0.7, 0.3)
	const s1 = blended.get('smol-1')!

	assert.ok(Math.abs(s1.modalityScores.style! - (1.0 * 0.7 + 0.4 * 0.3)) < 1e-10)
	assert.ok(Math.abs(s1.modalityScores.lyrics! - (0.6 * 0.3)) < 1e-10)
	assert.equal(s1.modalityScores.title, undefined)
	assert.equal(s1.modalityScores.description, undefined)
})

test('blendCandidateMaps returns empty map for empty inputs', () => {
	const blended = blendCandidateMaps(new Map(), new Map(), 0.5, 0.5)
	assert.equal(blended.size, 0)
})

// ---------------------------------------------------------------------------
// End-to-end RRF: fuseMatches + sortCandidates produce correct ordering
// ---------------------------------------------------------------------------

test('fuseMatches + sortCandidates produces correct ranking for multi-modality matches', () => {
	// smol-A: rank 0 in style + rank 0 in title (strong match)
	// smol-B: rank 0 in lyrics only (single weak modality)
	// smol-C: rank 1 in style + rank 0 in description
	const matchesByModality = makeMatchesByModality({
		style: [
			{ smolId: 'smol-A', score: 0.95 },
			{ smolId: 'smol-C', score: 0.80 },
		],
		title: [
			{ smolId: 'smol-A', score: 0.90 },
		],
		lyrics: [
			{ smolId: 'smol-B', score: 0.88 },
		],
		description: [
			{ smolId: 'smol-C', score: 0.75 },
		],
	})

	const fused = fuseMatches(matchesByModality)
	const ranked = sortCandidates(fused.values())

	// smol-A: style(1.0/61) + title(0.7/61) = 1.7/61 ~ 0.02787
	// smol-C: style(1.0/62) + desc(0.3/61) ~ 0.01613 + 0.00492 = 0.02105
	// smol-B: lyrics(0.5/61) ~ 0.00820
	assert.equal(ranked[0]?.smolId, 'smol-A')
	assert.equal(ranked[1]?.smolId, 'smol-C')
	assert.equal(ranked[2]?.smolId, 'smol-B')
})
