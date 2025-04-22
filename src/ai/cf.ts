// Take an image and describe it
export async function imageDescribe(env: Env, base64: string) {
    const blob = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const input: AiImageToTextInput = {
        image: [...blob],
        // prompt: `Imagine a theme song from this scene in one sentence including the style using genres and vibes`,
        // prompt: `Imagine this scene creatively in one sentence as a collection of musical genres and artistic vibes`,
        // prompt: `# Title\n${title}\n## Story\n${story}\nImagine a creative theme song from this image in a few sentences including specific musical genres and vibes`,
        prompt: `Describe this image in a few sentences. Be creative but specific focusing on story, emotion and environment.`,
        // temperature: 0.7,
        // top_p: 0.9,
        // top_k: 40,
        // repetition_penalty: 1.1,
        // frequency_penalty: 0.6,
        // presence_penalty: 0.3,
        // max_tokens: 512,
        // TODO put in the original prompt here. Likely in the `messages` field (not sure what the `raw` field is)
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

