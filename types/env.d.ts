interface AiSongGeneratorLyrics {
    title: string
    style: string[]
    lyrics: string
}

interface AiSongGeneratorSong {
    music_id: string
    status: number
    audio: string
}

interface WorkflowSteps {
	payload: WorkflowParams
	image_base64: string | undefined
	description: string | undefined
	lyrics: AiSongGeneratorLyrics | undefined
	nsfw: string | {
		safe?: boolean
		categories?: string[]
	} | undefined
	song_ids: number[] | undefined
	songs: AiSongGeneratorSong[] | undefined
}

type WorkflowParams = {
	address?: string
	prompt?: string
	retry_id?: string
	public?: boolean
	instrumental?: boolean
}

type WorkflowTxParams = {
	type: 'mint' | 'buy' | 'sell'
	owner: string
	entropy: string
	name?: string
}