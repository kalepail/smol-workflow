import { HTTPException } from "hono/http-exception";
import { SmolDurableObject, SmolState } from "./do";
import { Workflow } from "./workflow";
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Jimp, ResizeStrategy } from 'jimp';
import { cache } from "hono/cache";
import { env } from "cloudflare:workers";

export const app = new Hono<{ Bindings: Env }>()

// TODO 
// LT token turnstile guard
// Analytics track plays
// Place safety caps on prompts

app.use('*', cors())

app.get(
	'/', 
	cache({ 
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=30',
	}),
	async ({ env, req, ...c }) => {
		// const cursor = req.query('cursor');
		// const { keys, ...rest } = await env.SMOL_KV.list({ limit: 1000, cursor });

		// return c.json({
		// 	results: keys.map(({ name }) => name),
		// 	// @ts-ignore
		// 	cursor: rest.cursor,
		// })

		const { results } = await env.SMOL_D1.prepare('SELECT Id FROM Smols WHERE Public = 1 ORDER BY Created_At DESC LIMIT 1000').all();
		return c.json(results)
	}
);

app.get(
	'/:id',
	cache({ cacheName: 'smol-workflow' }),
	async ({ env, req, ...c }) => {
		const id = req.param('id');
		const smol = await env.SMOL_KV.get(id, 'json');

		if (smol) {
			return c.json({
				do: smol,
				steps: null,
			}, {
				headers: {
					'Cache-Control': 'public, max-age=2419200, immutable', // 4 weeks in seconds
				}
			})
		} else {
			const doid = env.DURABLE_OBJECT.idFromString(id);
			const stub = env.DURABLE_OBJECT.get(doid);
			const instance = await new Promise<WorkflowInstance | null>(async (resolve) => {
				try {
					resolve(await env.WORKFLOW.get(id))
				} catch {
					resolve(null)
				}
			});

			return c.json({
				do: await stub.getSteps(),
				steps: instance && await instance.status(),
			}, {
				headers: {
					'Cache-Control': 'public, max-age=5', // 5 seconds
				}
			});
		}
	}
);

app.post('/', async ({ env, req, ...c }) => {
	const body: { 
		address: string
		prompt: string
		public?: boolean
		instrumental?: boolean
	} = await req.json();

	if (!body.address) {
		throw new HTTPException(400, { message: 'Missing address' });
	}

	if (!body.prompt) {
		throw new HTTPException(400, { message: 'Missing prompt' });
	}

	const instanceId = env.DURABLE_OBJECT.newUniqueId().toString();
	const instance = await env.WORKFLOW.create({
		id: instanceId,
		params: {
			address: body.address,
			prompt: body.prompt,
			public: body.public || true,
			instrumental: body.instrumental || false,
		}
	});

	console.log('Workflow started', instanceId, await instance.status());

	return c.text(instanceId);
});

app.post('/retry/:id', async ({ env, req, ...c }) => {
	// TODO Disable retry if there's no need

	const body: { 
		address: string
	} = await req.json();

	if (!body.address) {
		throw new HTTPException(400, { message: 'Missing address' });
	}

	const id = req.param('id');
	const instanceId = env.DURABLE_OBJECT.newUniqueId().toString();
	const instance = await env.WORKFLOW.create({
		id: instanceId,
		params: {
			retry_id: id,
			address: body.address,
		}
	});

	console.log('Workflow restarted', instanceId, await instance.status());

	return c.text(instanceId);
});

app.get(
	'/song/:id{.+\\.mp3}', 
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=31536000, immutable', // 1 year in seconds
	}),
	async ({ env, req, ...c }) => {
		const id = req.param('id');
		const song = await env.SMOL_BUCKET.get(id);

		if (!song) {
			throw new HTTPException(404, { message: 'Song not found' });
		}

		return c.body(song.body, {
			headers: {
				'Content-Type': 'audio/mpeg'
			}
		});
	}
);

app.get(
	'/image/:id{.+\\.png}',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=31536000, immutable', // 1 year in seconds
	}),
	async ({ env, req, ...c }) => {
		const id = req.param('id');
		const scale = req.query('scale');
		const image = await env.SMOL_BUCKET.get(id);

		if (!image) {
			throw new HTTPException(404, { message: 'Image not found' });
		}

		let scaled_image: Buffer | null = null;

		if (scale) {
			const jimp_image = await Jimp.fromBuffer(await image.arrayBuffer());

			jimp_image.resize({
				w: jimp_image.width * parseInt(scale),
				h: jimp_image.height * parseInt(scale),
				mode: ResizeStrategy.NEAREST_NEIGHBOR,
			});

			scaled_image = await jimp_image.getBuffer('image/png')
		}

		return c.body(scaled_image || image.body, {
			headers: {
				'Content-Type': 'image/png'
			}
		});
	}
);

// TODO this should be a protected route
if (env.MODE === 'dev') {
	app.delete('/:id', async ({ env, req, ...c }) => {
		const id = req.param('id');
		const smol: any = await env.SMOL_KV.get(id, 'json');

		try {
			const doid = env.DURABLE_OBJECT.idFromString(id);
			const stub = env.DURABLE_OBJECT.get(doid);
			await stub.setToFlush();
		} catch {}

		await env.SMOL_KV.delete(id);
		await env.SMOL_D1.prepare(`DELETE FROM Smols WHERE Id = ?1`).bind(id).run()
		await env.SMOL_BUCKET.delete(`${id}.png`);

		if (smol) {
			for (let song of smol.songs) {
				await env.SMOL_BUCKET.delete(`${song.music_id}.mp3`);
			}
		}

		return c.body(null, 204);
	});
}

app.notFound((c) => {
	return c.body(null, 404)
});

const handler = {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;

export {
	Workflow,
	SmolDurableObject,
	SmolState,
	handler as default,
};