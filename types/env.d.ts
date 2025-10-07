// Augment the Cloudflare.Env interface with secrets not in wrangler.jsonc
// This ensures the global `env` from cloudflare:workers has the right types
// These secrets are managed via `wrangler secret put` or `.dev.vars`
declare namespace Cloudflare {
	interface Env {
		SECRET: string
		LAUNCHTUBE_TOKEN: string
		SK: string
		CF_API_TOKEN: string
		CF_ZONE_ID: string
	}
}

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