// Custom types for the project
// Note: The Bindings type in src/types.ts references the auto-generated Env type
// from worker-configuration.d.ts, so wrangler types must be run to keep types in sync

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
	playlist?: string
}

type WorkflowTxParams = {
	type: 'mint' | 'batch-mint'
	entropy: string
	xdr: string
	ids?: string[]
}