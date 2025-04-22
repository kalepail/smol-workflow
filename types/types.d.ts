// type QueueParams = {
// 	prompt: string;
// 	id: string;
// }

interface AiSongGeneratorLyrics {
    title: string
    style: string[]
    lyrics: string
}

interface AiSongGeneratorSong {
    music_id: string,
    status: number
    audio: string
}

interface WorkflowSteps {
	payload: WorkflowParams;
	send_tweet_id: string | undefined;
	image_base64: string | undefined;
	description: string | undefined;
	lyrics: AiSongGeneratorLyrics | undefined;
	nsfw: string | {
		safe?: boolean;
		categories?: string[];
	} | undefined;
	song_ids: number[] | undefined;
	songs: AiSongGeneratorSong[] | undefined;
}

type WorkflowParams = {
	retry_id?: string;
	tweet_id?: string;
	tweet_author?: string;
	prompt?: string;
}