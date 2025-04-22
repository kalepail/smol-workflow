import { DurableObject, WorkflowEvent } from 'cloudflare:workers';

export class SmolState extends DurableObject<Env> {
    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    setLatestTweet(tweetId: string) {
        return this.ctx.storage.put('latestTweet', tweetId);
    }
    getLatestTweet() {
        return this.ctx.storage.get<string>('latestTweet');
    }
    
    // async getCount() {
    //     const count = await this.ctx.storage.get<number>('count') || 0
    //     return Math.max(count, 0);
    // }
    // async setCount(n: number) {
    //     const count = await this.getCount();
    //     return this.ctx.storage.put('count', Math.max(count + n, 0));
    // }
}

export class SmolDurableObject extends DurableObject<Env> {
    public id: string;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        this.id = state.id.toString();
    }

    async saveStep(step: string, data: any) {
        await this.ctx.storage.put(step, data);

        switch (step) {
            case 'payload':
            break;
            case 'send_tweet_id':
            break;

            case 'image_base64':
                await this.env.SMOL_BUCKET.put(`${this.id}.png`, Buffer.from(data, 'base64'));
            break;

            case 'description':
            break;

            case 'lyrics':
                await this.env.SMOL_KV.put(this.id, JSON.stringify(data));
            break;

            case 'nsfw':
            break;
            case 'song_ids':
            break;

            case 'songs':
                for (let song of data) {
                    // lookup in R2 before replacing
                    if (song.audio && song.status >= 4) {
                        if (!await this.env.SMOL_BUCKET.head(`${song.music_id}.mp3`)) {
                            await fetch(song.audio)
                                .then(async (res) => {
                                    if (res.ok) {
                                        return this.env.SMOL_BUCKET.put(`${song.music_id}.mp3`, await res.arrayBuffer());
                                    }

                                    throw new Error(`Failed to fetch song audio: ${song.audio}`);
                                });
                        }
                    }
                }
            break;
        }
    }

    // TODO consider adding a timestamp
    async getSteps() {
        // TODO backfill image, audio and lyrics from their respective storage
        return Object.fromEntries((await this.ctx.storage.list()).entries());
    }

    async flush() {
        await this.ctx.storage.deleteAll();
    }
}