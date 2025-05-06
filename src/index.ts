import { HTTPException } from "hono/http-exception";
import { SmolDurableObject, SmolState } from "./do";
import { Workflow } from "./workflow";
import { TxWorkflow } from "./tx-workflow";
import { Context, Hono, Next } from 'hono'
import { cors } from 'hono/cors'
import { Jimp, ResizeStrategy } from 'jimp';
import { cache } from "hono/cache";
import { env } from "cloudflare:workers";
import { verifyAuthentication, verifyRegistration } from "./passkey";
import { sign, verify } from 'hono/jwt'
import { getCookie, setCookie } from "hono/cookie";

export const app = new Hono<{ Bindings: Env }>()

// TODO 
// LT token turnstile guard
// Analytics track plays
// Place safety caps on prompts
// Use cookies for auth and start protecting endpoints
// Implement blockchain
// clear cache in the right places

function conditionalCache(options: Parameters<typeof cache>[0]) {
	const caching = cache(options)

	return async (c: Context, next: Next) => {
		const range = c.req.header('range')

		if (range) {
			// Skip cache middleware for range requests
			return await next()
		}

		// Apply cache middleware
		return await caching(c, next)
	}
}

async function parseAuth(c: Context, next: Next) {
	const authHeader = c.req.header('Authorization')

	if (authHeader) {
		const token = authHeader.split(' ')[1]

		if (token) {
			c.set('jwtPayload', await verify(token, c.env.SECRET))
		}
	} else {
		const token = getCookie(c, 'smol_token')

		if (token) {
			c.set('jwtPayload', await verify(token, c.env.SECRET))
		}
	}

	return next()
}

app.use('*', cors({
	origin: (origin) => origin ?? '*',
	credentials: true,
}))

app.post('/login', async (c) => {
	const { env, req } = c;
	const body = await req.json();
	const host = req.header('origin') ?? req.header('referer');
	const { type, response, keyId, contractId } = body;

	if (!host) {
		throw new HTTPException(400, { message: 'Missing origin and referer' });
	}

	switch (type) {
		case 'create':
			await verifyRegistration(host, response)
			break;
		case 'connect':
			await verifyAuthentication(host, keyId, contractId, response)
			break;
		default:
			throw new HTTPException(400, { message: 'Invalid type' });
	}

	const payload = {
		sub: contractId,
		key: keyId,
		exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30, // Token expires in 30 days
	}
	const token = await sign(payload, env.SECRET)

	await setCookie(c, 'smol_token', token, {
		path: '/',
		secure: true,
		httpOnly: true,
		sameSite: 'None',
		maxAge: 60 * 60 * 24 * 30,
	});

	return c.text(token)
});

app.get(
	'/likes', 
	parseAuth,
	async (c) => {
		const { env } = c;
		const payload = c.get('jwtPayload')

		const { results } = await env.SMOL_D1.prepare(`
			SELECT Id FROM Likes
			WHERE "Address" = ?1
		`)
			.bind(payload.sub)
			.all();

		const likes = results.map((like: any) => like.Id);

		return c.json(likes)
	}
)

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
	'/created',
	parseAuth,
	// cache({
	// 	cacheName: 'smol-workflow',
	// 	cacheControl: 'public, max-age=30',
	// }),
	async (c) => {
		const { env } = c
		const payload = c.get('jwtPayload')

		const { results } = await env.SMOL_D1.prepare(`
			SELECT Id, Title, Song_1 
			FROM Smols 
			WHERE Address = ?1
			ORDER BY Created_At DESC 
			LIMIT 1000
		`)
			.bind(payload.sub)
			.all();

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

app.put(
	'/like/:id', 
	parseAuth,
	async (c) => {
		const { env, req } = c;
		const id = req.param('id');
		const body = await req.json();
		const payload = c.get('jwtPayload')

		const deleteResult = await env.SMOL_D1
			.prepare(`DELETE FROM Likes WHERE Id = ?1 AND "Address" = ?2`)
			.bind(id, payload.sub)
			.run();

		if (deleteResult.meta.changes === 0) {
			await env.SMOL_D1
				.prepare(`INSERT INTO Likes (Id, "Address") VALUES (?1, ?2)`)
				.bind(id, payload.sub)
				.run();

			// buy token
			await env.TX_WORKFLOW.create({
				params: {
					type: 'buy',
					owner: payload.sub,
					entropy: id,
				}
			});
		} else {
			// sell token
			await env.TX_WORKFLOW.create({
				params: {
					type: 'sell',
					xdr: body.xdr,
					// owner: contractId,
					// entropy: id,
				}
			});
		}

		return c.body(null, 204);
	}
)

app.put(
	'/:smol_id/:song_id', 
	parseAuth,
	async (c) => {
		const { env, req } = c;
		const smol_id = req.param('smol_id');
		const song_id = req.param('song_id');
		const payload = c.get('jwtPayload')

		const result = await env.SMOL_D1.prepare(`
			UPDATE Smols SET 
				Song_1 = Song_2,
				Song_2 = (SELECT s.Song_1 FROM Smols s WHERE s.Id = Smols.Id)
			WHERE Id = ?1
			AND Song_2 = ?2
			AND Address = ?3
		`)
			.bind(smol_id, song_id, payload.sub)
			.run();

		if (result.meta.changes === 0) {
			throw new HTTPException(404, { message: 'No record found or no update needed' });
		}

		return c.body(null, 204);
	}
);

app.get(
	'/song/:id{.+\\.mp3}',
	conditionalCache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=31536000, immutable', // 1 year in seconds
	}),
	async ({ env, req, ...c }) => {
		const id = req.param('id');
		const rangeHeader = req.header('range')
		const headers = new Headers({
			'Content-Type': 'audio/mpeg',
			'Content-Disposition': 'inline',
		})

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
	TxWorkflow,
	SmolDurableObject,
	SmolState,
	handler as default,
};