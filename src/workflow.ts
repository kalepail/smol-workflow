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

// TODO store a version for each smol to make it easier to debug in the future 

const config: WorkflowStepConfig = {
	retries: {
		limit: 5,
		delay: '10 second',
		backoff: 'exponential',
	},
	timeout: '5 minutes',
}

export class Workflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		let retry_steps: WorkflowSteps | undefined;
		let payload = event.payload;

		const { retry_id, playlist } = payload;

		if (retry_id) {
			await step.do(
				'retry workflow',
				config,
				async () => {
					try {
						const retry_doid = this.env.DURABLE_OBJECT.idFromString(retry_id);
						const retry_stub = this.env.DURABLE_OBJECT.get(retry_doid);

						retry_steps = await retry_stub.getSteps() as WorkflowSteps;
						payload = {
							...payload, // original payload
							...retry_steps?.payload // previous payload (notably we keep the original address)
						};

						// if for some reason the above fails (legacy gens)
					} catch (err) {
						retry_steps = await this.env.SMOL_KV.get(retry_id, 'json') as WorkflowSteps;
						payload = {
							...payload, // original payload
							...retry_steps?.payload // previous payload (notably we keep the original address)
						};
					}
				}
			);
		}

		const { address, prompt, public: is_public = true, instrumental: is_instrumental = false } = payload;

		if (!address) {
			throw new NonRetryableError("event.payload missing address");
		}

		if (!prompt) {
			throw new NonRetryableError("event.payload missing prompt");
		}

		const doid = this.env.DURABLE_OBJECT.idFromString(event.instanceId);
		const stub = this.env.DURABLE_OBJECT.get(doid);

		await step.do('save payload', config, async () => stub.saveStep('payload', payload));

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
			let description = await imageDescribe(this.env, image_base64, prompt);
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

		// if retrying and all songs gens were successful, use the existing song ids
		let song_ids = retry_steps?.song_ids && retry_steps?.songs?.every((song) => song.status === 4)
			? retry_steps.song_ids
			: await step.do('generate songs', config, async () => {
				let song_ids = await generateSongs(this.env, prompt, description, lyrics, is_public, is_instrumental);
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

				if (is_streaming) {
					await stub.saveStep('songs', songs)
					throw new Error('Songs still streaming')
				}

				return songs;
			}
		);

		await step.do('save songs', config, () => stub.saveStep('songs', songs));

		// mint smol on Stellar
		await step.do('mint smol', config, async () => {
			// TODO this probably should just be done inline here vs sent to another workflow
			await this.env.TX_WORKFLOW.create({
				params: {
					type: 'mint',
					owner: address,
					entropy: event.instanceId,
					name: lyrics.title,
				}
			});
		})

		await step.do('complete workflow', config, async () => {
			await stub.setToFlush();
			await this.env.SMOL_D1.prepare(`
                INSERT INTO Smols (Id, Title, Song_1, Song_2, Address, Public, Instrumental)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
				ON CONFLICT (Id) DO NOTHING
            `)
				.bind(
					event.instanceId,
					lyrics.title,
					songs[0].music_id,
					songs[1].music_id,
					address,
					typeof nsfw !== 'string' && nsfw?.safe === false ? false : is_public, // if nsfw has been marked unsafe force smol to be private
					is_instrumental,
				)
				.run()
			await this.env.SMOL_KV.put(event.instanceId, JSON.stringify({
				payload,
				image_base64,
				description,
				lyrics,
				nsfw,
				song_ids,
				songs,
			}));

			if (retry_id) {
				try {
					const retry_doid = this.env.DURABLE_OBJECT.idFromString(retry_id);
					const retry_stub = this.env.DURABLE_OBJECT.get(retry_doid);
					await retry_stub.setToFlush();
				} catch { }

				await this.env.SMOL_D1.prepare(`DELETE FROM Smols WHERE Id = ?1`).bind(retry_id).run();
				await this.env.SMOL_KV.delete(retry_id);
			}

			if (playlist) {
				await this.env.SMOL_D1.prepare(`INSERT INTO Playlists (Id, Title) VALUES (?1, ?2)`).bind(event.instanceId, playlist).run()
			}
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