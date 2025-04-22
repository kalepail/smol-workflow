export async function checkNSFW(env: Env, prompt: string, description: string, lyrics: string) {
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

	return response.response;
}
