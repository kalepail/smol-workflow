// Take an image and describe it
export async function imageDescribe(env: Env, base64: string, prompt: string) {
    const blob = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const input: AiImageToTextInput = {
        image: [...blob],
        prompt: `
            Describe this image in a few sentences. Be creative but specific. Focus on story, emotion and environment.
            Keep in mind this was the original prompt to generate the image: ${prompt}
        `,
        // temperature: 0.7,
        // top_p: 0.9,
        // top_k: 40,
        // repetition_penalty: 1.1,
        // frequency_penalty: 0.6,
        // presence_penalty: 0.3,
        // max_tokens: 512,
    };

    const response = await env.AI.run(
        "@cf/llava-hf/llava-1.5-7b-hf",
        // "@cf/unum/uform-gen2-qwen-500m",
        input
    );

    return response.description
        .trim()
        // .replace(/^"[^"]+"\s*-\s*/, '')
        // .replace(/[^\w\s,:-;]/g, '')
        // .replace(/\s+/g, ' ')
}

// Generate a title and story based on a prompt and image description
export async function promptExpand() {

}

