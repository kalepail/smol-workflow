/**
 * Normalize legacy and current NSFW classifier responses into a strict object.
 * Requires an unambiguous safe result to mark `safe: true`.
 * Fails closed (`safe: false, unknown: true`) on contradictory, unparseable, or missing output
 * so unclassified items remain unlisted pending classification.
 */
export function normalizeNsfwResult(raw: unknown): NormalizedNsfwResult {
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		const candidate = raw as { safe?: unknown; categories?: unknown; unknown?: unknown };
		const categories = Array.isArray(candidate.categories)
			? candidate.categories
				.map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
				.filter(Boolean)
			: [];

		// Never treat an object flagged `unknown: true` as safe
		if (candidate.unknown === true) {
			return { safe: false, categories, unknown: true };
		}

		if (typeof candidate.safe === 'boolean') {
			return {
				safe: candidate.safe,
				categories,
			};
		}

		return { safe: false, categories, unknown: true };
	}

	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) {
			return { safe: false, categories: [], unknown: true };
		}

		// Try JSON string format first (e.g. '{"safe":false,"categories":["S12"]}')
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				return normalizeNsfwResult(parsed);
			} catch {
				// Fall through to Llama Guard plain-text parsing
			}
		}

		// Llama Guard plain text format:
		// - Exactly one line "safe" (no trailing contradictory lines or categories) -> safe
		// - First line "unsafe" (optionally followed by category codes) -> unsafe
		const lines = trimmed
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const firstLine = (lines[0] ?? '').toLowerCase();

		if (firstLine === 'safe' && lines.length === 1) {
			return { safe: true, categories: [] };
		}

		if (firstLine === 'unsafe' || firstLine.startsWith('unsafe ')) {
			const restText = [
				firstLine.startsWith('unsafe ') ? lines[0].slice('unsafe'.length).trim() : '',
				...lines.slice(1),
			]
				.filter(Boolean)
				.join(',');
			const categories = restText
				.split(/[\s,]+/)
				.map((part) => part.trim())
				.filter(Boolean);
			return { safe: false, categories };
		}

		return { safe: false, categories: [], unknown: true };
	}

	return { safe: false, categories: [], unknown: true };
}

/**
 * Returns true if the NSFW result blocks public listing (explicitly unsafe OR unknown/unclassified).
 */
export function isNsfwBlocked(raw: unknown): boolean {
	return !normalizeNsfwResult(raw).safe;
}

export async function checkNSFW(env: Env, prompt: string, description: string, lyrics: string): Promise<NormalizedNsfwResult> {
	const response = await env.AI.run("@cf/meta/llama-guard-3-8b", {
		response_format: { type: 'json_object' },
		messages: [
			{ role: "user", content: `
				<BEGIN UNSAFE CONTENT CATEGORIES>
				S1: Violent Crimes. 
				S2: Non-Violent Crimes. 
				S3: Sex Crimes. 
				S4: Child Exploitation. 
				S5: Defamation. 
				S7: Privacy. 
				S8: Intellectual Property. 
				S9: Indiscriminate Weapons. 
				S10: Hate. 
				S11: Self-Harm. 
				S12: Sexual Content. 
					Reject all content containing sexual, explicit, suggestive, erotic, romantic, or NSFW themes in any form. Only permit content that is entirely G-rated, suitable for viewing by all ages—including young children. Specifically: 
						- No sexual language, innuendo, euphemisms, or slang. 
						- No romantic or suggestive scenarios, relationships, or interactions. 
						- No references to nudity, partial nudity, clothing that accentuates sexual characteristics, or anatomical descriptions of sexual characteristics. 
						- No discussions or depictions of reproduction, pregnancy, childbirth, or related anatomical processes. 
						- No adult products, dating, romantic gestures, or flirting. 
						- No suggestive descriptions of appearance, clothing, or body movements. 
					Allow ONLY neutral, non-romantic, non-sexual, strictly safe-for-children (G-rated) prompts and outputs. 
				S13: Elections. 
				<END UNSAFE CONTENT CATEGORIES>
				<BEGIN CONVERSATION>
				User: 
				# Prompt 
				${prompt} 
				# Description 
				${description} 
				# Lyrics 
				${lyrics} 
				<END CONVERSATION>
			` },
		]
	});

	return normalizeNsfwResult(response?.response);
}
