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
// Use cookies for auth and start protecting endpoints
// Implement blockchain
// clear cache in the right places

app.use('*', cors())

app.get(
	'/',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=30',
	}),
	async ({ env, req, ...c }) => {
		const { results } = await env.SMOL_D1.prepare(`
			SELECT Id, Title, Song_1 
			FROM Smols 
			WHERE Public = 1 
			ORDER BY Created_At DESC 
			LIMIT 1000
		`).all();

		return c.json(results)
	}
);

app.get(
	'/:id',
	async ({ env, req, ...c }) => {
		const id = req.param('id');
		const smol_d1 = await env.SMOL_D1.prepare(`SELECT * FROM Smols WHERE Id = ?1`).bind(id).first();

		if (smol_d1) {
			const smol_kv = await env.SMOL_KV.get(id, { type: 'json', cacheTtl: 2419200 });

			return c.json({
				kv_do: smol_kv,
				d1: smol_d1,
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
				kv_do: await stub.getSteps(),
				wf: instance && await instance.status(),
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
			public: body.public ?? true,
			instrumental: body.instrumental ?? false,
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

app.put('/:smol_id/:song_id', async ({ env, executionCtx, req, ...c }) => {
	const smol_id = req.param('smol_id');
	const song_id = req.param('song_id');

	// TODO enforce authorship

	await env.SMOL_D1.prepare(`
		UPDATE Smols SET 
			Song_1 = Song_2,
			Song_2 = (SELECT s.Song_1 FROM Smols s WHERE s.Id = Smols.Id)
		WHERE Id = ?1
		AND Song_2 = ?2
	`)
		.bind(smol_id, song_id)
		.run();

	return c.body(null, 204);
});

app.get(
	'/song/:id{.+\\.mp3}',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=31536000, immutable', // 1 year in seconds
	}),
	async ({ env, req, ...c }) => {
		const id = req.param('id');
		const rangeHeader = req.header('range')
		const headers = new Headers()

		let offset: number | undefined
		let length: number | undefined
		let status = 200

		if (rangeHeader && rangeHeader.startsWith('bytes=')) {
			const bytesRange = rangeHeader.replace(/bytes=/, '').split('-')
			const start = parseInt(bytesRange[0], 10)
			const end = bytesRange[1] ? parseInt(bytesRange[1], 10) : undefined

			if (!isNaN(start) && (end === undefined || !isNaN(end))) {
				offset = start

				if (end !== undefined) {
					length = end - start + 1
				}
			}
		}

		const object = await env.SMOL_BUCKET.get(id, {
			range: offset !== undefined ? { offset, length } : undefined,
		})

		if (!object || !object.body) {
			throw new HTTPException(404, { message: 'Song not found' });
		}

		object.writeHttpMetadata(headers)
		headers.set('etag', object.httpEtag)

		if (offset !== undefined) {
			const end = offset + (length ?? object.size - offset) - 1
			headers.set('content-range', `bytes ${offset}-${end}/${object.size}`)
			status = 206
		}

		return new Response(object.body, { status, headers })
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
		} catch { }

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