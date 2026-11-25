// Replaces @cf/llava-hf/llava-1.5-7b-hf, which Workers AI deprecated on 2026-11-20 (error 5028).
export const IMAGE_DESCRIBE_MODEL = '@cf/moondream/moondream3.1-9B-A2B'

// Take an image and describe it
export async function imageDescribe(env: Env, base64: string, prompt: string) {
    const image = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`

    const response = await env.AI.run(IMAGE_DESCRIBE_MODEL, {
        task: 'query',
        image,
        question: [
            'Describe the scene, subject, lighting, colors, and emotional atmosphere in 2-3 vivid, grounded sentences as if it were a real place or moment.',
            'Do not mention pixels, pixel art, pixelated graphics, 8-bit, sprites, digital art, or that this is an image.',
            `Original prompt for context: ${prompt}`,
        ].join(' '),
        // The binding streams SSE unless stream is explicitly false.
        stream: false,
        reasoning: false,
        temperature: 0.7,
        max_tokens: 512,
    });

    return extractImageDescription(response)
}

// The live binding wraps moondream output in `result`; the docs schema lists the
// fields at the top level, so accept both.
export function extractImageDescription(response: unknown) {
    const output = response && typeof response === 'object'
        ? response as Ai_Cf_Moondream_Moondream3_1_9B_A2B_Output & { result?: Ai_Cf_Moondream_Moondream3_1_9B_A2B_Output }
        : undefined
    const result = output?.result ?? output
    const description = (result?.answer ?? result?.caption ?? '').trim()

    if (!description) {
        throw new Error(`Image description model returned no text (finish_reason: ${result?.finish_reason ?? 'unknown'})`)
    }

    return description
}
