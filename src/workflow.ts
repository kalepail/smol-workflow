import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent, WorkflowStepConfig } from 'cloudflare:workers';
import { pixellab } from './ai/pixellab';
import { imageDescribe } from './ai/cf';
import { generateLyrics, generateSongs, getSongs } from './ai/aisonggenerator';
import { checkNSFW } from './ai/nsfw';
import { NonRetryableError } from 'cloudflare:workflows';

// ensure gen can be paid for
// [maybe pay to proxy?]
// gen (prompt)
// image (pixellab)
// meta (cf ai)
// title
// story
// describe image (cf ai)
// song (aisongenerator)
// gen lyrics
// gen song
// pay for gen
// [maybe refund if error]
// deliver results

export class Workflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		let retry_steps: WorkflowSteps | undefined;
		let payload = event.payload;
	
		const { retry_id } = payload;	

		if (retry_id) {
			const retry_doid = this.env.DURABLE_OBJECT.idFromString(retry_id);
			const retry_stub = this.env.DURABLE_OBJECT.get(retry_doid);

			retry_steps = await retry_stub.getSteps() as WorkflowSteps;
			payload = retry_steps.payload;
		}

		const { address, prompt } = payload;

		if (!address) {
			throw new NonRetryableError("event.payload missing address");
		}

		if (!prompt) {
			throw new NonRetryableError("event.payload missing prompt");
		}

		const config: WorkflowStepConfig = {
			retries: {
				limit: 5,
				delay: '10 second',
				backoff: 'exponential',
			},
			timeout: '5 minutes',
		}

		const doid = this.env.DURABLE_OBJECT.idFromString(event.instanceId);
		const stub = this.env.DURABLE_OBJECT.get(doid);

		await step.do('save payload', config, async () => stub.saveStep('payload', event.payload));

		let image_base64 = retry_steps?.image_base64 || await step.do(
			'generate image',
			{
				...config,
				retries: {
					...config.retries,
					limit: 10,
				},
			} as WorkflowStepConfig,
			async () => {
				let image_base64 = await pixellab(prompt, 'pixflux');
				return image_base64;
			}
		);

		await step.do('save generated image', config, () => stub.saveStep('image_base64', image_base64))

		let description = retry_steps?.description || await step.do('describe image', config, async () => {
			let description = await imageDescribe(this.env, image_base64);
			return description;
		});

		await step.do('save image description', config, () => stub.saveStep('description', description))

		let lyrics = retry_steps?.lyrics || await step.do('generate lyrics', config, async () => {
			let lyrics = await generateLyrics(this.env, prompt, description);

			if (
				!lyrics.title
				|| !lyrics.lyrics
				|| (lyrics.style?.length ?? 0) < 2
			) {
				throw JSON.stringify({
					message: 'Generated incomplete lyrics',
					lyrics
				}, null, 2);
			}

			return lyrics;
		});

		await step.do('save generated lyrics', config, () => stub.saveStep('lyrics', lyrics))

		let nsfw = retry_steps?.nsfw || await step.do('check nsfw', config, async () => {
			let nsfw = await checkNSFW(this.env, prompt, description, JSON.stringify(lyrics.lyrics));
			return nsfw;
		})

		await step.do('save nsfw check', config, () => stub.saveStep('nsfw', nsfw))

		let song_ids = retry_steps?.song_ids || await step.do('generate songs', config, async () => {
			let song_ids = await generateSongs(this.env, lyrics);
			return song_ids;
		})

		await step.do('save song ids', config, () => stub.saveStep('song_ids', song_ids));

		await step.sleep('wait for songs to generate', '30 seconds');

		let songs = await step.do(
			'get songs',
			{
				...config,
				retries: {
					...config.retries,
					limit: 10,
				},
			} as WorkflowStepConfig,
			async () => {
				let songs = await getSongs(this.env, song_ids);
				let has_audio = false;
				let is_streaming = false;

				// TODO if any song is ready we should save that so there's at least something to listen to
				// On the frontend then we'll just hide any songs that aren't ready (only save songs that are ready to DO)
				for (let song of songs) {
					if (song.audio) {
						has_audio = true;
					}

					if (song.status < 4) {
						is_streaming = true;
					}
				}

				if (!has_audio) {
					await stub.saveStep('songs', songs)
					throw new Error(`Songs missing audio`);
				}

				// TODO Might not need to keep saving and updating this
				// Definitely seeing some dead links 
				// Might should just save this once as it's own step
				if (is_streaming) {
					await stub.saveStep('songs', songs)
					throw new Error('Songs still streaming')
				}

				return songs;
			}
		);

		await step.do('save songs', config, () => stub.saveStep('songs', songs));

		await step.do('complete workflow', config, async () => {
			// save the whole job to sql
				// author id
				// job id
				// image ids
			// consider saving job data to KV so we can toss the DO
			await this.env.SMOL_KV.put(event.instanceId, JSON.stringify({
				payload,
				image_base64,
				description,
				lyrics,
				nsfw,
				song_ids,
				songs,
			}));
			await stub.setToFlush();
		});

		return [
			payload,
			image_base64,
			description,
			lyrics,
			nsfw,
			song_ids,
			songs,
		];
	}
}