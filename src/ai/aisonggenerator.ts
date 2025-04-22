// Generate lyrics from a prompt
export async function generateLyrics(env: Env, prompt: string, description: string): Promise<AiSongGeneratorLyrics> {
    return env.AISONGGENERATOR.fetch(`http://aisonggenerator-worker/api/lyrics`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            prompt: `
                Write a song based off the following initial prompt and image description:

                # Prompt
                ${prompt}

                # Description
                ${description}
            `
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
export async function generateSongs(env: Env, lyrics: AiSongGeneratorLyrics): Promise<number[] | string[]> {
    return env.AISONGGENERATOR.fetch('http://aisonggenerator-worker/api/songs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(lyrics)
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