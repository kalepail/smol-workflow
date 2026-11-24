import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { installCloudflareStubs, type CloudflareStubHandle } from './helpers/harness'

let stubs: CloudflareStubHandle
let el: typeof import('../src/ai/elevenlabs')
let songsModule: typeof import('../src/utils/songs')

before(async () => {
	stubs = installCloudflareStubs()
	el = await import('../src/ai/elevenlabs')
	songsModule = await import('../src/utils/songs')
})

after(() => {
	stubs.cleanup()
})

const isHeading = (line: string) => /^\s*\[[^\]]+\]\s*$/.test(line)
const sungLinesOf = (chunks: string[]) => chunks.flatMap((c) => c.split('\n')).filter((l) => l.trim() && !isHeading(l))
const assertChunkLimits = (chunks: string[], maxChunks = el.MAX_ELEVENLABS_CHUNKS) => {
	assert.ok(chunks.length <= maxChunks, `${chunks.length} chunks > ${maxChunks}`)
	for (const chunk of chunks) {
		assert.ok(chunk.split('\n').length <= el.MAX_ELEVENLABS_CHUNK_LINES, `chunk has ${chunk.split('\n').length} lines`)
		for (const line of chunk.split('\n')) assert.ok(Array.from(line).length <= el.MAX_ELEVENLABS_LINE_CHARS)
	}
}

function sectionedLyrics(sections: number, linesPerSection: number): { text: string; sung: string[] } {
	const sung: string[] = []
	const blocks: string[] = []
	for (let s = 0; s < sections; s++) {
		const lines = Array.from({ length: linesPerSection }, (_, i) => `section ${s + 1} sung line ${i + 1}`)
		sung.push(...lines)
		blocks.push(`[Part ${s + 1}]\n${lines.join('\n')}`)
	}
	return { text: blocks.join('\n\n'), sung }
}

test('P1: lyric coalescer packs 31 sections x 15 lines into <=30 chunks preserving ALL 465 sung lines in order', () => {
	const { text, sung } = sectionedLyrics(31, 15)
	const chunks = el.splitElevenLabsLyricSections(text)
	assertChunkLimits(chunks)
	assert.equal(sungLinesOf(chunks).length, 465)
	assert.deepEqual(sungLinesOf(chunks), sung, 'every sung line preserved verbatim and in order')

	// Composition chunks (planner/baseline path) carry the same lossless text.
	const comp = el.buildElevenLabsCompositionChunks(text, ['pop'])
	assert.deepEqual(sungLinesOf(comp.map((c) => c.text)), sung)
	assert.ok(comp.every((c) => c.duration_ms >= el.MIN_ELEVENLABS_CHUNK_MS && c.duration_ms <= el.MAX_ELEVENLABS_CHUNK_MS))

	// Explicit ELEVENLABS_MUSIC_LENGTH_MS override path (fewer chunks allowed) is lossless too.
	const overridden = el.buildElevenLabsCompositionChunks(text, ['pop'], 60_000) // floor(60000/3000) = 20 chunks
	assertChunkLimits(overridden.map((c) => c.text), 20)
	assert.deepEqual(sungLinesOf(overridden.map((c) => c.text)), sung)
})

test('P1: lyric packing fills the exact 900-line ceiling and rejects >900 sung lines before any paid dispatch', () => {
	// Exactly 30 x 30 = 900 sung lines across 60 headed sections -> representable (headings dropped).
	const full = sectionedLyrics(60, 15)
	const fullChunks = el.splitElevenLabsLyricSections(full.text)
	assertChunkLimits(fullChunks)
	assert.deepEqual(sungLinesOf(fullChunks), full.sung)

	// 901 sung lines (headed and unheaded) cannot fit -> non-retryable rejection, never truncation.
	const over = sectionedLyrics(53, 17) // 901 lines
	assert.equal(over.sung.length, 901)
	const unheaded = Array.from({ length: 1000 }, (_, i) => `unheaded line ${i + 1}`).join('\n')
	for (const lyrics of [over.text, unheaded]) {
		assert.throws(
			() => el.splitElevenLabsLyricSections(lyrics),
			(err: unknown) => err instanceof el.ElevenLabsProviderError
				&& err.code === 'invalid_composition_plan'
				&& err.outcome === 'rejected'
				&& err.retryable === false
				&& /refusing to drop lyrics/.test(err.message)
		)
		// The request body (built before any network call) rejects too, so the paid step refunds and
		// rethrows it as NonRetryableError instead of dispatching truncated lyrics.
		assert.throws(() => el.buildElevenLabsRequestBody({ prompt: 'p', lyrics: { title: 't', style: ['pop'], lyrics }, isInstrumental: false }))
		const nonRetryable = el.toNonRetryableElevenLabsError(new el.ElevenLabsProviderError({ message: 'x', code: 'invalid_composition_plan', retryable: false, outcome: 'rejected' }))
		assert.equal((nonRetryable as Error).name, 'NonRetryableError')
	}

	// Explicit override with a tiny total (1 chunk = 30 lines) rejects 31 lines instead of truncating.
	assert.throws(
		() => el.buildElevenLabsCompositionChunks(sectionedLyrics(2, 16).text, ['pop'], 3_000),
		(err: unknown) => err instanceof el.ElevenLabsProviderError && err.code === 'invalid_composition_plan'
	)
})

test('P2: line wrapping and section names count Unicode code points, never split a surrogate pair, and keep the closing bracket', () => {
	const cps = (text: string) => Array.from(text).length
	const noLoneSurrogate = (piece: string) =>
		!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(piece)

	// 199 ASCII + emoji + 50 ASCII = 250 code points -> cut at exactly 200 code points (emoji kept whole).
	const emoji = '\u{1F3B5}'
	const line = `${'a'.repeat(199)}${emoji}${'b'.repeat(50)}`
	const wrapped = el.wrapLineToMaxChars(line)
	assert.equal(wrapped.join(''), line, 'no characters lost')
	assert.deepEqual(wrapped, [`${'a'.repeat(199)}${emoji}`, 'b'.repeat(50)])
	for (const piece of wrapped) {
		assert.ok(cps(piece) <= el.MAX_ELEVENLABS_LINE_CHARS)
		assert.ok(noLoneSurrogate(piece), `lone surrogate in ${JSON.stringify(piece.slice(-3))}`)
	}
	// 150 emoji = 300 UTF-16 units but only 150 characters -> stays one line.
	assert.deepEqual(el.wrapLineToMaxChars(emoji.repeat(150)), [emoji.repeat(150)])
	const allEmoji = emoji.repeat(250) // 250 code points, no spaces
	const emojiPieces = el.wrapLineToMaxChars(allEmoji)
	assert.equal(emojiPieces.join(''), allEmoji)
	assert.deepEqual(emojiPieces.map(cps), [200, 50])
	assert.ok(emojiPieces.every((p) => noLoneSurrogate(p) && Array.from(p).every((cp) => cp === emoji)))

	// Long [Section] names: interior <= 100 code points, closing ']' kept, no half emoji.
	const longName = `${'Bridge '.repeat(30)}`
	const chunks = el.splitElevenLabsLyricSections(`[${longName}]\nsing it\n[${'x'.repeat(99)}${emoji}tail]\nmore`)
	const headings = chunks.map((c) => c.split('\n')[0])
	for (const heading of headings) {
		assert.match(heading, /^\[[^\]]+\]$/)
		assert.ok(cps(heading) - 2 <= el.MAX_ELEVENLABS_SECTION_NAME_CHARS, `interior ${cps(heading) - 2}`)
		assert.ok(noLoneSurrogate(heading))
	}
	assert.equal(headings[1], `[${'x'.repeat(99)}${emoji}]`, 'the 100th code point is kept whole; the rest is dropped')
	assert.equal(el.normalizeSectionHeading('[Chorus]'), '[Chorus]')
})

test('P2 Astra probe: an 80-code-point astral heading stays intact (not cut to 50 by UTF-16 length)', () => {
	const astral = '\u{20000}' // CJK Ext-B, 2 UTF-16 units
	const name = astral.repeat(80)
	assert.equal(name.length, 160)
	assert.equal(el.normalizeSectionHeading(`[${name}]`), `[${name}]`)
	const chunks = el.splitElevenLabsLyricSections(`[${name}]\nsing it`)
	assert.deepEqual(chunks, [`[${name}]\nsing it`])
	const comp = el.buildElevenLabsCompositionChunks(`[${name}]\nsing it`, ['pop'], 3_000)
	assert.equal(comp[0].text.split('\n')[0], `[${name}]`)
})

test('P2 Astra probe: 16 lines of 101 astral code points fit a one-chunk override as 16 lines (not 32)', () => {
	const astral = '\u{1F3B6}'
	const lines = Array.from({ length: 16 }, () => astral.repeat(101))
	assert.equal(lines[0].length, 202)
	const comp = el.buildElevenLabsCompositionChunks(lines.join('\n'), ['pop'], 3_000) // floor(3000/3000) = 1 chunk
	assert.equal(comp.length, 1)
	assertChunkLimits(comp.map((c) => c.text), 1)
	assert.deepEqual(sungLinesOf(comp.map((c) => c.text)), lines, 'every 101-character line kept whole')
	assert.equal(comp[0].duration_ms, 3_000)
})

test('P2 Astra probe: 40 one-line sections under a 6,000 ms override pack once into 2 chunks keeping all 40 sung lines', () => {
	const { text, sung } = sectionedLyrics(40, 1)
	const comp = el.buildElevenLabsCompositionChunks(text, ['pop'], 6_000) // floor(6000/3000) = 2 chunks
	const texts = comp.map((c) => c.text)
	assert.equal(comp.length, 2)
	assertChunkLimits(texts, 2)
	assert.deepEqual(sungLinesOf(texts), sung, 'all 40 sung lines preserved verbatim and in order')
	assert.equal(comp.reduce((acc, c) => acc + c.duration_ms, 0), 6_000)
	// Same budget through the public splitter.
	assert.deepEqual(sungLinesOf(el.splitElevenLabsLyricSections(text, 2)), sung)
	// The request body for the override path is lossless too.
	const body = el.buildElevenLabsRequestBody({
		prompt: 'p',
		lyrics: { title: 't', style: ['pop'], lyrics: text },
		isInstrumental: false,
		musicLengthMs: 6_000,
	})
	assert.deepEqual(sungLinesOf(body.composition_plan!.chunks.map((c) => c.text)), sung)
})

test('P2: vocal pacing planner requires finite JSON numbers (no coercion) and falls back to the empirical baseline', async () => {
	assert.equal(el.parsePlannedVocalDurationsMs({ durations_ms: [true, [45000]] }, 2), null)
	assert.equal(el.parsePlannedVocalDurationsMs({ durations_ms: ['3000', 45000] }, 2), null)
	assert.equal(el.parsePlannedVocalDurationsMs({ durations_ms: [null, 45000] }, 2), null)
	assert.equal(el.parsePlannedVocalDurationsMs('{"durations_ms":[true,[45000]]}', 2), null)
	assert.deepEqual(el.parsePlannedVocalDurationsMs({ durations_ms: [3000, 45000] }, 2), [3000, 45000])

	const lyrics = { title: 't', style: ['pop'], lyrics: '[Verse]\none\n[Chorus]\ntwo' }
	const env = {
		AI: { run: async () => ({ choices: [{ message: { content: JSON.stringify({ durations_ms: [true, [45000]] }) } }] }) },
	} as unknown as Env
	const planned = await el.planElevenLabsVocalDurations({ env, prompt: 'p', lyrics })
	assert.deepEqual(planned, el.estimateFallbackChunkDurationsMs(el.splitElevenLabsLyricSections(lyrics.lyrics)))
})

test('P2: pacing helper never throws (AI error, helper error, or unrepresentable lyrics)', async () => {
	const lyrics = { title: 't', style: ['pop'], lyrics: '[Verse]\none\n[Chorus]\ntwo' }
	const baseline = el.estimateFallbackChunkDurationsMs(el.splitElevenLabsLyricSections(lyrics.lyrics))
	const throwingAi = { AI: { run: async () => { throw new Error('Workers AI outage') } } } as unknown as Env
	assert.deepEqual(await songsModule.planElevenLabsVocalDurationsSafely(throwingAi, 'p', lyrics), baseline)

	const throwingGetter = { get AI(): never { throw new Error('binding blew up') } } as unknown as Env
	assert.deepEqual(await songsModule.planElevenLabsVocalDurationsSafely(throwingGetter, 'p', lyrics), baseline)

	const huge = { ...lyrics, lyrics: Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n') }
	assert.equal(await songsModule.planElevenLabsVocalDurationsSafely(throwingAi, 'p', huge), undefined)
})
