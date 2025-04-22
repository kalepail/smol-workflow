import { HTTPException } from "hono/http-exception";
import { SmolDurableObject, SmolState } from "./do";
import { Workflow } from "./workflow";
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Jimp, ResizeStrategy } from 'jimp';
import { cache } from "hono/cache";

export const app = new Hono<{ Bindings: Env }>()

app.use('*', cors())

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
		}
	});

	console.log('Workflow started', instanceId, await instance.status());

	return c.text(instanceId);
});

app.post('/retry/:id', async ({ env, req, ...c }) => {
	const id = req.param('id');
	const instanceId = env.DURABLE_OBJECT.newUniqueId().toString();
	const instance = await env.WORKFLOW.create({
		id: instanceId,
		params: {
			retry_id: id,
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
)

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