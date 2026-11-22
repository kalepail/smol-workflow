// Workers AI model typings missing from the generated worker-configuration.d.ts
// (generated with workerd@1.20260114.0, which predates these models).
//
// Shapes were verified against the live Workers AI binding on 2026-11-21, not
// just the docs schemas. Notable runtime differences from the published docs:
// - moondream3.1 streams SSE unless `stream: false` is passed explicitly, even
//   though the docs list `stream` as defaulting to false.
// - With `stream: false`, moondream3.1 wraps its output in `{ result, usage }`
//   rather than returning `answer`/`caption` at the top level.
// - gemma-4 returns an OpenAI-style chat completion (`choices[].message.content`),
//   not the legacy `{ response }` text-generation shape.

interface Ai_Cf_Moondream_Moondream3_1_9B_A2B_Input {
	task?: 'query' | 'caption' | 'point' | 'detect'
	/** Public HTTPS URL or base64 data URI (e.g. `data:image/png;base64,...`). */
	image?: string
	question?: string
	caption_length?: 'short' | 'normal' | 'long'
	target?: string
	reasoning?: boolean
	temperature?: number
	top_p?: number
	max_tokens?: number
	max_objects?: number
	stream?: boolean
}

interface Ai_Cf_Moondream_Moondream3_1_9B_A2B_Result {
	finish_reason?: string
	metrics?: {
		input_tokens: number
		output_tokens: number
		prefill_time_ms: number
		decode_time_ms: number
		ttft_ms: number
	}
	answer?: string | null
	caption?: string | null
	points?: Array<{ x: number; y: number }> | null
	objects?: Array<{ x_min: number; y_min: number; x_max: number; y_max: number }> | null
	reasoning?: { text: string; grounding?: object[] } | null
}

type Ai_Cf_Moondream_Moondream3_1_9B_A2B_Output = Ai_Cf_Moondream_Moondream3_1_9B_A2B_Result & {
	result?: Ai_Cf_Moondream_Moondream3_1_9B_A2B_Result
	usage?: AiWorkersAiUsage
}

interface Base_Ai_Cf_Moondream_Moondream3_1_9B_A2B {
	inputs: Ai_Cf_Moondream_Moondream3_1_9B_A2B_Input
	postProcessedOutputs: Ai_Cf_Moondream_Moondream3_1_9B_A2B_Output
}

interface AiWorkersAiUsage {
	prompt_tokens?: number
	completion_tokens?: number
	total_tokens?: number
}

interface Ai_Cf_Chat_Completion_Message {
	role: 'system' | 'user' | 'assistant'
	content: string
}

interface Ai_Cf_Google_Gemma_4_26B_A4B_It_Input {
	messages: Ai_Cf_Chat_Completion_Message[]
	response_format?:
		| { type: 'text' }
		| { type: 'json_object' }
		| { type: 'json_schema'; json_schema: { name: string; description?: string; schema?: object; strict?: boolean | null } }
	max_completion_tokens?: number
	temperature?: number
	top_p?: number
	seed?: number
	chat_template_kwargs?: {
		/** Defaults to true. When enabled, reasoning tokens count against max_completion_tokens. */
		enable_thinking?: boolean
		clear_thinking?: boolean
	}
}

interface Ai_Cf_Google_Gemma_4_26B_A4B_It_Output {
	id?: string
	object?: string
	model?: string
	choices?: Array<{
		index?: number
		message?: {
			role?: 'assistant'
			content?: string | null
			reasoning_content?: string | null
		}
		finish_reason?: string | null
	}>
	usage?: AiWorkersAiUsage
}

interface Base_Ai_Cf_Google_Gemma_4_26B_A4B_It {
	inputs: Ai_Cf_Google_Gemma_4_26B_A4B_It_Input
	postProcessedOutputs: Ai_Cf_Google_Gemma_4_26B_A4B_It_Output
}

interface AiModels {
	'@cf/moondream/moondream3.1-9B-A2B': Base_Ai_Cf_Moondream_Moondream3_1_9B_A2B
	'@cf/google/gemma-4-26b-a4b-it': Base_Ai_Cf_Google_Gemma_4_26B_A4B_It
}
