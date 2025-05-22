// Generate lyrics from a prompt
export async function generateLyrics(env: Env, prompt: string, description: string): Promise<AiSongGeneratorLyrics> {
    let finalPrompt: string;

    const promptWithDescription = `
        # Prompt
        ${prompt}

        # Description
        ${description}

        # NOTES
        Focus on creativity, story and lyrical variety over strict adherence to the prompt and description.
    `;
    const promptWithoutDescription = `
        # Prompt
        ${prompt}

        # NOTES
        Focus on creativity, story and lyrical variety over strict adherence to the prompt.
    `;

    if (prompt.length > 500) {
        finalPrompt = promptWithoutDescription;
    } else {
        finalPrompt = promptWithDescription;
    }

    return env.AISONGGENERATOR.fetch(`http://aisonggenerator-worker/api/lyrics`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            prompt: finalPrompt
        })
    })
        .then(async (res) => {
            if (res.ok)
                return res.json()
            else
                throw await res.text()
        })
}

// Generate a song from lyrics
export async function generateSongs(env: Env, prompt: string, description: string, lyrics: AiSongGeneratorLyrics, is_public = true, is_instrumental = false): Promise<number[] | string[]> {
    return env.AISONGGENERATOR.fetch('http://aisonggenerator-worker/api/songs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            ...lyrics,
            prompt,
            description,
            public: is_public,
            instrumental: is_instrumental
        })
    })
        .then(async (res) => {
            if (res.ok)
                return res.json()
            else
                throw await res.text()
        })
}

export async function getSongs(env: Env, ids: number[] | string[]): Promise<AiSongGeneratorSong[]> {
    return env.AISONGGENERATOR.fetch(`http://aisonggenerator-worker/api/songs?ids=${ids.join(',')}`)
        .then(async (res) => {
            if (res.ok)
                return res.json()
            else
                throw await res.text()
        })
}