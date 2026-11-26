/**
 * Song intent: what the user's prompt asks the music model for (their own lyrics, a vocalist,
 * styles, exclusions, a title), resolved inside the checkpointed `generate lyrics` step.
 *
 * - One Workers AI call (DeepSeek, `env.AI.run` with NO gateway option, 6 s, 1 attempt). Any error,
 *   429, timeout or invalid JSON gives `null`; generation never depends on it.
 * - A small deterministic fallback (gender cues, exclusions, [STYLE:] clauses, explicit title). It
 *   never slices lyrics: `user_lyrics` comes only from a validated model range.
 * - `finalizeSongText` stores AISG-ready camelCase fields (`vocalGender`, `negativeTags`) plus the
 *   `intent_v` marker on the lyrics object, so the existing `...lyrics` spreads forward them unchanged.
 */

export const SONG_INTENT_MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017' as const;
export const SONG_INTENT_TIMEOUT_MS = 6_000;
export const MAX_TITLE_CHARS = 80;
export const MAX_STYLES = 8;
export const MAX_NEGATIVE_TAGS_CHARS = 200;

export type IntentMode = 'write' | 'user_lyrics' | 'instrumental';
export type VocalGender = 'f' | 'm';

export interface SongIntent {
	mode: IntentMode;
	lyrics_lines: [number, number] | null;
	title: string | null;
	vocal_gender: VocalGender | null;
	styles: string[];
	exclusions: string[];
}

// Ported verbatim from the R4 bench (bench/system-prompt.txt).
export const SONG_INTENT_SYSTEM = `You extract the intent of a song request for a music generator. The user message gives an instrumental flag and the request with every line prefixed "N| " (its line number). Reply with one JSON object only:
{"mode":"write"|"user_lyrics"|"instrumental","lyrics_lines":[first,last]|null,"title":string|null,"vocal_gender":"f"|"m"|null,"styles":[...],"exclusions":[...]}
- mode: "instrumental" if the flag is true or the user wants the whole song without vocals; "user_lyrics" if the request contains lyrics the user wrote to be sung (several lyric lines, often under [Verse]/[Chorus]-style headings); otherwise "write". A story, description or one-line idea is "write".
- lyrics_lines: for user_lyrics only, the first and last line numbers of the lyric block, including section headings and cues inside it; exclude style text, titles and notes before or after it. Else null.
- title: only a title the user explicitly gave (e.g. "Title: X", "titled X", a heading above their lyrics). Else null.
- vocal_gender: "f" or "m" only when the lead vocal is clearly one gender ("female voice", "two female vocalists", "giọng nam"; "no male vocals" means "f"). Mixed, duet of both genders, or unstated: null. Story characters do not set it.
- styles: 4-8 short ENGLISH music style tags, ordered: genre/subgenre first, then vocalist (e.g. "female vocals", "dual female vocals", "male and female duet"), then key instruments, then tempo/BPM if stated, then at most 2 moods. Translate non-English cues. Never artist, band, brand or song names; describe the sound instead. Never include anything excluded.
- exclusions: short ENGLISH terms the user explicitly asked to avoid for the whole song ("no synths" -> "synths", "exclude folk" -> "folk", "not heavy metal" -> "heavy metal"). Not section-only cues like "[Bridge - no singing]", not words inside the lyrics, not descriptions. [] if none.
Example 1 input:
instrumental: false
1| sad indie folk song with female voice, no drums
Example 1 output: {"mode":"write","lyrics_lines":null,"title":null,"vocal_gender":"f","styles":["indie folk","female vocals","acoustic guitar","slow tempo","melancholic"],"exclusions":["drums"]}
Example 2 input:
instrumental: false
1| Title: Night Bus
2| Lo-fi hip hop, 80 BPM
3| [Verse]
4| Window fogged, the city hums
5| [Chorus]
6| Ride on, ride on
Example 2 output: {"mode":"user_lyrics","lyrics_lines":[3,6],"title":"Night Bus","vocal_gender":null,"styles":["lo-fi hip hop","mellow vocals","dusty drums","Rhodes piano","80 BPM","nostalgic"],"exclusions":[]}`;

/** The exact line split the model sees (CR dropped, blank lines kept), so ranges index the same lines. */
export function promptLines(prompt: string): string[] {
	return String(prompt ?? '').replace(/\r/g, '').split('\n');
}

export function buildIntentUserMessage(prompt: string, instrumental: boolean): string {
	return `instrumental: ${!!instrumental}\n${promptLines(prompt).map((line, i) => `${i + 1}| ${line}`).join('\n')}`;
}

export function extractIntentText(response: unknown): string | null {
	const outer = response as { result?: unknown } | null | undefined;
	const r = (outer && typeof outer === 'object' && outer.result && typeof outer.result === 'object' ? outer.result : outer) as {
		response?: unknown;
		choices?: Array<{ message?: { content?: unknown } }>;
	} | null | undefined;
	if (!r || typeof r !== 'object') return null;
	if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
	if (typeof r.response === 'string') return r.response;
	const content = r.choices?.[0]?.message?.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) return content.map((part: { text?: string }) => part?.text ?? '').join('');
	return null;
}

/** The bench validator (`parseIntent`): any schema error rejects the whole response. */
export function parseSongIntent(text: string | null | undefined, lineCount: number): SongIntent | null {
	if (!text) return null;
	const s = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
	const a = s.indexOf('{');
	const b = s.lastIndexOf('}');
	if (a < 0 || b < a) return null;
	let o: Record<string, unknown>;
	try {
		o = JSON.parse(s.slice(a, b + 1));
	} catch {
		return null;
	}
	if (!o || typeof o !== 'object') return null;
	const mode = o.mode;
	if (mode !== 'write' && mode !== 'user_lyrics' && mode !== 'instrumental') return null;
	const L = o.lyrics_lines;
	const validRange = Array.isArray(L) && L.length === 2 && L.every(Number.isInteger)
		&& L[0] >= 1 && L[0] <= L[1] && L[1] <= lineCount;
	if (!(L === null || L === undefined || validRange)) return null;
	if (mode === 'user_lyrics' && !validRange) return null;
	if (!(o.title == null || typeof o.title === 'string')) return null;
	if (!(o.vocal_gender == null || o.vocal_gender === 'f' || o.vocal_gender === 'm')) return null;
	const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string');
	if (!isStrings(o.styles) || !isStrings(o.exclusions)) return null;
	return {
		mode,
		lyrics_lines: validRange ? [L[0] as number, L[1] as number] : null,
		title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : null,
		vocal_gender: (o.vocal_gender as VocalGender | null | undefined) ?? null,
		styles: o.styles,
		exclusions: o.exclusions,
	};
}

/**
 * One DeepSeek call via the AI binding (never the `smol` gateway, which caps ElevenLabs at 25/day).
 * Returns null on any error, 429, timeout (Promise.race) or invalid output.
 */
export async function analyzePromptWithModel(
	env: Pick<Env, 'AI'>,
	prompt: string,
	instrumental: boolean,
	timeoutMs = SONG_INTENT_TIMEOUT_MS
): Promise<SongIntent | null> {
	if (typeof env.AI?.run !== 'function') return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const call = (env.AI.run as (model: string, input: unknown) => Promise<unknown>)(SONG_INTENT_MODEL, {
			messages: [
				{ role: 'system', content: SONG_INTENT_SYSTEM },
				{ role: 'user', content: buildIntentUserMessage(prompt, instrumental) },
			],
			temperature: 0.1,
			reasoning_effort: 'none',
			chat_template_kwargs: { enable_thinking: false },
			max_completion_tokens: 700,
			response_format: { type: 'json_object' },
		});
		const timeout = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), timeoutMs);
		});
		const response = await Promise.race([call, timeout]);
		if (response === 'timeout') {
			call.catch(() => {});
			return null;
		}
		return parseSongIntent(extractIntentText(response), promptLines(prompt).length);
	} catch {
		return null;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// --- Deterministic fallback (gender, exclusions, [STYLE] clauses, explicit title only) -----------

const F_CUE = /\b(female|feminine|girl group|all-female|soprano|mezzo|songstress|diva)\b|\b(?:woman|women|girls?|lady|ladies)\W+(?:\w+\W+)?(?:vocals?|voices?|vocalists?|singers?|sings|rappers?|lead|idols?|duo)\b|giọng nữ|여성|여자|suara (?:perempuan|wanita)/i;
const M_CUE = /\b(male|masculine|baritone|boy band|man's voice|men's (?:choir|vocals?)|tenor)\b|giọng nam|남성|남자|suara (?:laki|pria)/i;
const NO_STOP = /^(longer|more|matter|one|doubt|need|way|sleep|time|end|limit|stopping|turning back|second)\b/i;

function deterministicExclusions(text: string): string[] {
	const out: string[] = [];
	const add = (chunk: string) => {
		for (let t of chunk.split(/,|;|\/|\bor\b|\band\b|\bnor\b|\bno\b/i)) {
			t = t.replace(/^\s*(any|the|a|use of|such as|words such as|using)\s+/i, '').replace(/[."'!)\]]+$/g, '').trim().toLowerCase();
			if (t && t.split(/\s+/).length <= 4 && t.length <= 40 && !NO_STOP.test(t)) out.push(t);
		}
	};
	const re = /\b(?:no|without|exclude|excluding|avoid|not|never use|do not use|don't use|do not want|don't want)\b[:\s]+([^.:;\]\n(]+)/gi;
	for (const m of text.matchAll(re)) {
		const kw = m[0].slice(0, m[0].length - m[1].length).trim().toLowerCase();
		if (kw === 'not' && !/\bbut\s*$/i.test(text.slice(0, m.index))) continue; // only "but not X"
		if (kw === 'not' || kw === 'without') {
			add(m[1].split(',')[0]);
			continue;
		}
		if (/^(longer|more|matter|one|need)\b/i.test(m[1])) continue;
		add(m[1]);
	}
	return [...new Set(out)];
}

function deterministicGender(text: string, exclusions: string[]): VocalGender | null {
	const t = text.replace(/\b(?:no|without|exclude|avoid)\b[^.\]\n]*/gi, ' ');
	const f = F_CUE.test(t);
	const m = M_CUE.test(t);
	const exM = exclusions.some((e) => /\bmale\b/.test(e) && !/female/.test(e));
	const exF = exclusions.some((e) => /female/.test(e));
	if ((f || exM) && !(m || exF)) return 'f';
	if ((m || exF) && !(f || exM)) return 'm';
	return null;
}

/** `[STYLE: a, b. c]` / `Style: a, b` clauses: at most 4 clauses of 60 chars, in prompt order. */
export function styleClauses(prompt: string): string[] {
	const blocks = [...prompt.matchAll(/\[\s*style\s*:([^\]]+)\]|^[*\s]*style\s*:\s*(.+)$/gim)].map((m) => m[1] ?? m[2] ?? '');
	const out: string[] = [];
	for (const block of blocks) {
		for (const raw of block.split(/[,.;\n]/)) {
			const clause = raw.replace(/\s+/g, ' ').trim();
			if (clause && clause.length <= 60) out.push(clause);
			if (out.length >= 4) return out;
		}
	}
	return out;
}

export function deterministicIntent(prompt: string): Pick<SongIntent, 'title' | 'vocal_gender' | 'exclusions'> & { clauses: string[] } {
	const text = String(prompt ?? '');
	const exclusions = deterministicExclusions(text);
	const tm = text.match(/^\s*[*#]*\s*(?:title|song)\s*:\s*\**\s*["“]?([^"”\n*]+?)["”]?\s*\**\s*$/im)
		|| text.match(/\btitled\s+["“]([^"”]+)["”]/i);
	return {
		title: tm ? tm[1].trim() : null,
		vocal_gender: deterministicGender(text, exclusions),
		exclusions,
		clauses: styleClauses(text),
	};
}

// --- Lyrics sanitizer (shared by finalize, the EL pacing planner and the EL chunk builder) --------

const PLACEHOLDER_LINES = new Set(['(no lyrics)', '(instrumental)', '(instrumental break)', '(no vocals)']);
const DIRECTION_KEYWORDS = /\b(solos?|instrumental|break(?:down)?s?|riffs?|fade(?:s|d|\s?out|\s?in)?|intro|outro|guitars?|piano|drums?|bass|synths?|strings|violins?|beat drop|build(?:-?up)?s?)\b/i;
const HEADING_LINE = /^\s*\[[^\]]+\]\s*$/;
const EMPHASIZED_CUE = /^(\*\*|__|\*|_)\s*(\[[^\]]+\])\s*\1$/; // **[Outro – x]** -> [Outro – x]
const BOLD_SECTION = /^(\*\*|__)\s*([^*_\n]{1,40}?)\s*:?\s*\1$/; // **Verse 1** -> [Verse 1]
const SECTION_WORD = /^(?:verse|chorus|pre-?chorus|post-?chorus|bridge|intro|outro|hook|refrain|interlude|breakdown|instrumental|solo|drop|coda|final chorus)\b[\w\s#.\-–]*$/i;
const CHORD = /^[A-G](?:#|b)?(?:maj|min|m|dim|aug|sus|add)?\d*(?:\/[A-G](?:#|b)?)?$/;

/** A chord-chart line ("Dm........A#....C", "G | D/F# | Em7"): only chord tokens between dots/spaces/dashes/pipes. */
function isChordLine(trimmed: string): boolean {
	const tokens = trimmed.split(/[\s.\-|]+/).filter(Boolean);
	if (!tokens.length || !tokens.every((t) => CHORD.test(t))) return false;
	return tokens.length >= 2 || /[.|]/.test(trimmed);
}

/**
 * Idempotent: drops exact placeholder lines and chord-chart lines, unwraps markdown-emphasized
 * cues (`**[Outro]**`, `**Verse 1**` -> `[Verse 1]`), and turns a full-line `( … )` into a `[ … ]`
 * heading only when it names an instrument/arrangement cue. Everything else (sung backing vocals
 * such as "(Your smile pulls me in)") is kept verbatim.
 */
export function sanitizeLyrics(text: string): string {
	const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (PLACEHOLDER_LINES.has(trimmed.toLowerCase()) || isChordLine(trimmed)) continue;
		const cue = EMPHASIZED_CUE.exec(trimmed);
		if (cue) {
			out.push(cue[2]);
			continue;
		}
		const bold = BOLD_SECTION.exec(trimmed);
		if (bold && SECTION_WORD.test(bold[2])) {
			out.push(`[${bold[2]}]`);
			continue;
		}
		const paren = /^\(([^()]+)\)$/.exec(trimmed);
		out.push(paren && DIRECTION_KEYWORDS.test(paren[1]) ? `[${paren[1].trim()}]` : line);
	}
	return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function countSungLines(text: string): number {
	return String(text ?? '').split('\n').filter((line) => line.trim() && !HEADING_LINE.test(line)).length;
}

// --- Styles ------------------------------------------------------------------------------------

const FEMALE_WORD = /\b(female|women|woman|girls?|feminine|soprano|mezzo)\b/i;
const MALE_WORD = /\b(male|men|man|boys?|masculine|baritone|tenor)\b/i;
const VOCAL_WORD = /\b(vocals?|vocalists?|voices?|singers?|singing|rap|rapper|duo|choir|idols?|screams?)\b/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The vocalist a tag names ("dual female vocals" -> f). Genre tags like "k-pop girl group" name none. */
function genderOfTag(tag: string): VocalGender | 'both' | null {
	if (!VOCAL_WORD.test(tag)) return null;
	const f = FEMALE_WORD.test(tag);
	const m = MALE_WORD.test(tag);
	if (f && m) return 'both';
	return f ? 'f' : m ? 'm' : null;
}

/** Guarantee a tag naming the requested vocalist sits in the first 3 (EL weighs chunk-0 order). */
export function ensureVocalistInFirstThree(styles: string[], gender: VocalGender | null | undefined): string[] {
	if (gender !== 'f' && gender !== 'm') return styles;
	const out = [...styles];
	const idx = out.findIndex((tag) => genderOfTag(tag) === gender);
	if (idx >= 0 && idx < 3) return out;
	const tag = idx >= 0 ? out.splice(idx, 1)[0] : gender === 'f' ? 'female vocals' : 'male vocals';
	out.splice(Math.min(1, out.length), 0, tag);
	return out;
}

const toAscii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'));

const isAscii = (tag: string) => /^[\x20-\x7e]+$/.test(tag);

function finalizeStyles(
	candidates: string[],
	songwriterTags: string[],
	exclusions: string[],
	gender: VocalGender | null,
	isInstrumental: boolean
): string[] {
	const excluded = exclusions.map((e) => new RegExp(`\\b${escapeRe(e)}\\b`, 'i'));
	const seen = new Set<string>();
	const cleaned: string[] = [];
	const add = (raw: unknown, refill: boolean) => {
		const tag = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
		if (!tag || excluded.some((re) => re.test(tag))) return;
		const g = genderOfTag(tag);
		if (!refill && gender === null && (g === 'f' || g === 'm')) return; // unstated gender: no single-gender tag
		if (gender && g && g !== 'both' && g !== gender) return;
		const key = toAscii(tag).toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		cleaned.push(tag);
	};
	for (const raw of candidates) add(raw, false);
	const asciiCount = () => cleaned.filter((tag) => isAscii(toAscii(tag))).length;
	// Styles never fail a complete song: refill from the songwriter, then neutral English defaults.
	if (asciiCount() < 3) for (const raw of songwriterTags) add(raw, true);
	const ascii = cleaned.map(toAscii).filter(isAscii);
	// Zero ASCII tags (non-English songwriter): keep the unfiltered tags, as before.
	const base = ascii.length ? ascii : cleaned;
	const defaults = isInstrumental ? ['instrumental', 'full arrangement'] : ['original song', 'full arrangement'];
	for (const tag of defaults) {
		if (base.length >= 2) break;
		if (!base.some((t) => t.toLowerCase() === tag)) base.push(tag);
	}
	return ensureVocalistInFirstThree(base, gender).slice(0, MAX_STYLES);
}

/** Opposite gender first (so the 200-char cut never drops it), then exclusions, cut at a term boundary. */
export function buildNegativeTags(gender: VocalGender | null, exclusions: string[]): string | undefined {
	const terms: string[] = [];
	const seen = new Set<string>();
	const push = (term: string) => {
		const t = toAscii(term).replace(/[,\s]+/g, ' ').trim();
		if (!t || !/^[\x20-\x7e]+$/.test(t) || seen.has(t.toLowerCase())) return;
		seen.add(t.toLowerCase());
		terms.push(t);
	};
	if (gender) push(gender === 'f' ? 'male vocals' : 'female vocals');
	for (const e of exclusions) push(e);
	let out = '';
	for (const term of terms) {
		const next = out ? `${out}, ${term}` : term;
		if (next.length > MAX_NEGATIVE_TAGS_CHARS) break;
		out = next;
	}
	return out || undefined;
}

// --- user_lyrics range validation ---------------------------------------------------------------

function styleBlockLines(lines: string[]): Set<number> {
	const out = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		if (/^[*\s]*style\s*:/i.test(lines[i])) out.add(i);
		if (!/\[\s*style\s*:/i.test(lines[i])) continue;
		for (let j = i; j < lines.length; j++) {
			out.add(j);
			const from = j === i ? lines[j].search(/\[\s*style\s*:/i) : 0;
			if (lines[j].indexOf(']', from) >= 0) {
				i = j;
				break;
			}
		}
	}
	return out;
}

const isQuoted = (line: string) => /^\s*["“”'‘]/.test(line);

/**
 * The model's lyric range, if it passes every check; otherwise null (the songwriter writes).
 * >= 8 non-empty lines, >= 4 sung lines, a [heading] or a clear lyric shape, no [STYLE] overlap;
 * extends by up to 2 lines only onto quoted lines (positive evidence of a continued lyric).
 */
export function validatedLyricRange(prompt: string, range: [number, number] | null): [number, number] | null {
	const lines = promptLines(prompt);
	if (!range) return null;
	let [a, b] = range;
	if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && a <= b && b <= lines.length)) return null;
	const style = styleBlockLines(lines);
	for (let i = a - 1; i < b; i++) if (style.has(i)) return null;

	const block = lines.slice(a - 1, b);
	const nonEmpty = block.filter((line) => line.trim());
	const sung = nonEmpty.filter((line) => !HEADING_LINE.test(line));
	if (nonEmpty.length < 8 || sung.length < 4) return null;
	const hasHeading = nonEmpty.some((line) => HEADING_LINE.test(line));
	const shortLines = sung.filter((line) => line.trim().length <= 80).length;
	if (!hasHeading && (shortLines / sung.length < 0.75 || sung.some((line) => line.trim().length > 160))) return null;

	for (let step = 0; step < 2 && b < lines.length; step++) {
		if (style.has(b) || !isQuoted(lines[b])) break;
		b += 1;
	}
	return [a, b];
}

// --- Merge + finalize --------------------------------------------------------------------------

export interface MergedIntent {
	mode: IntentMode;
	lyrics_lines: [number, number] | null;
	title: string | null;
	vocal_gender: VocalGender | null;
	styles: string[] | null; // model styles (>= 4) or null: use det clauses + songwriter tags
	exclusions: string[];
	clauses: string[];
}

export function mergeSongIntent(model: SongIntent | null, prompt: string, isInstrumental: boolean): MergedIntent {
	const det = deterministicIntent(prompt);
	let mode: IntentMode = isInstrumental ? 'instrumental' : model?.mode === 'user_lyrics' ? 'user_lyrics' : 'write';
	const lyrics_lines = mode === 'user_lyrics' ? validatedLyricRange(prompt, model?.lyrics_lines ?? null) : null;
	if (mode === 'user_lyrics' && !lyrics_lines) mode = 'write';
	const rawExclusions = model ? model.exclusions : det.exclusions;
	// "in the style of X" / "like X" names an artist, not something to avoid.
	const exclusions = rawExclusions
		.map((e) => e.trim())
		.filter((e) => e && !new RegExp(`\\b(?:style of|like)\\s+${escapeRe(e)}\\b`, 'i').test(prompt));
	return {
		mode,
		lyrics_lines,
		title: model?.title ?? det.title,
		vocal_gender: isInstrumental ? null : model?.vocal_gender ?? det.vocal_gender,
		styles: model && model.styles.length >= 4 ? model.styles : null,
		exclusions,
		clauses: det.clauses,
	};
}

export function finalizeSongText(
	generated: AiSongGeneratorLyrics,
	intent: MergedIntent,
	prompt: string,
	isInstrumental: boolean
): AiSongGeneratorLyrics {
	const songwriterLyrics = sanitizeLyrics(generated.lyrics ?? '');
	let lyrics: string;
	if (isInstrumental) {
		lyrics = '';
	} else if (intent.mode === 'user_lyrics' && intent.lyrics_lines) {
		const [a, b] = intent.lyrics_lines;
		lyrics = sanitizeLyrics(promptLines(prompt).slice(a - 1, b).join('\n'));
	} else {
		lyrics = songwriterLyrics;
	}
	if (!isInstrumental && countSungLines(lyrics) < 4) lyrics = songwriterLyrics; // vocal guard
	if (!isInstrumental && !lyrics) {
		// Never empty vocal lyrics: the songwriter's raw text minus placeholders, else as-is.
		const raw = String(generated.lyrics ?? '').replace(/\r\n?/g, '\n');
		const kept = raw.split('\n').filter((line) => !PLACEHOLDER_LINES.has(line.trim().toLowerCase())).join('\n').trim();
		lyrics = kept || raw.trim();
	}

	const title = Array.from((intent.title ?? generated.title ?? '').trim()).slice(0, MAX_TITLE_CHARS).join('').trim();
	const songwriterTags = Array.isArray(generated.style) ? generated.style : [];
	const candidates = intent.styles
		?? (intent.clauses.length ? [...intent.clauses, ...songwriterTags.slice(0, 2)] : songwriterTags);
	const style = finalizeStyles(candidates, songwriterTags, intent.exclusions, intent.vocal_gender, isInstrumental);
	const negativeTags = buildNegativeTags(intent.vocal_gender, intent.exclusions);

	return {
		title,
		style,
		lyrics,
		...(intent.vocal_gender ? { vocalGender: intent.vocal_gender } : {}),
		...(negativeTags ? { negativeTags } : {}),
		intent_v: 1,
	};
}

export interface SongIntentResolution {
	merged: MergedIntent;
	source: 'model' | 'det';
	ms: number;
	rawStyles?: string[];
}

/** The model call with its timing and one log line (no prompt text). Never throws. */
export async function resolveSongIntentWithMeta(
	env: Pick<Env, 'AI'>,
	prompt: string,
	isInstrumental: boolean,
	smolId?: string
): Promise<SongIntentResolution> {
	const t0 = Date.now();
	const model = await analyzePromptWithModel(env, prompt, isInstrumental);
	const merged = mergeSongIntent(model, prompt, isInstrumental);
	const ms = Date.now() - t0;
	const source = model ? 'model' : 'det';
	console.log(JSON.stringify({
		event: 'song_intent',
		...(smolId ? { smol_id: smolId } : {}),
		source,
		mode: merged.mode,
		ms,
	}));
	return {
		merged,
		source,
		ms,
		...(model?.styles?.length ? { rawStyles: model.styles } : {}),
	};
}

export async function resolveSongIntent(
	env: Pick<Env, 'AI'>,
	prompt: string,
	isInstrumental: boolean,
	smolId?: string
): Promise<MergedIntent> {
	return (await resolveSongIntentWithMeta(env, prompt, isInstrumental, smolId)).merged;
}
