import { DurableObject } from 'cloudflare:workers';

export class SmolState extends DurableObject<Env> {
    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }
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

            case 'image_base64':
                await this.env.SMOL_BUCKET.put(`${this.id}.png`, Buffer.from(data, 'base64'));
            break;

            case 'description':
            break;
            case 'lyrics':
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

    async getSteps() {
        return Object.fromEntries((await this.ctx.storage.list()).entries());
    }

    async setToFlush() {
        await this.ctx.storage.setAlarm(Date.now() + (1000 * 60))
    }

    private async flush() {
        await this.ctx.storage.deleteAll();
    }

    async alarm() {
        await this.flush();
    }
}