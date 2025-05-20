import { HTTPException } from "hono/http-exception";
import { SmolDurableObject, SmolState } from "./do";
import { Workflow } from "./workflow";
import { TxWorkflow } from "./tx-workflow";
import { Context, Hono, Next } from 'hono'
import { cors } from 'hono/cors'
import { Jimp, ResizeStrategy } from 'jimp';
import { cache } from "hono/cache";
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

// TODO ensure if verify breaks the request fails 

async function parseAuth(c: Context, next: Next) {
	const authHeader = c.req.header('Authorization')

	if (authHeader) {
		const token = authHeader.split(' ')[1]

		if (token === c.env.SECRET) {

		} else if (token) {
			c.set('jwtPayload', await verify(token, c.env.SECRET))
		} else {
			throw new HTTPException(401, { message: 'Invalid "Authorization" header' });
		}
	} else {
		const token = getCookie(c, 'smol_token')

		if (token) {
			c.set('jwtPayload', await verify(token, c.env.SECRET))
		} else {
			throw new HTTPException(401, { message: 'Invalid "Cookie" token' });
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

	let { username } = body;

	if (!host) {
		throw new HTTPException(400, { message: 'Missing origin and referer' });
	}

	switch (type) {
		case 'create':
			await verifyRegistration(host, response)
			await env.SMOL_D1.prepare(`INSERT INTO Users ("Address", Username) VALUES (?1, ?2)`).bind(contractId, username).run();
			break;
		case 'connect':
			await verifyAuthentication(host, keyId, contractId, response)
			const user = await env.SMOL_D1.prepare(`SELECT Username FROM Users WHERE "Address" = ?1`).bind(contractId).first();
			username = user?.Username ?? 'Smol';
			break;
		default:
			throw new HTTPException(400, { message: 'Invalid type' });
	}

	const payload = {
		sub: contractId,
		key: keyId,
		usr: username,
		exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30, // Token expires in 30 days
	}
	const token = await sign(payload, env.SECRET)

	setCookie(c, 'smol_token', token, {
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
	'/liked',
	parseAuth,
	// cache({
	// 	cacheName: 'smol-workflow',
	// 	cacheControl: 'public, max-age=30',
	// }),
	async (c) => {
		const { env } = c
		const payload = c.get('jwtPayload')

		const { results } = await env.SMOL_D1.prepare(`
			SELECT s.Id, s.Title, s.Song_1 
			FROM Smols s
			INNER JOIN Likes l ON s.Id = l.Id
			WHERE l."Address" = ?1
			ORDER BY s.Created_At DESC 
			LIMIT 1000
		`)
			.bind(payload.sub)
			.all();

		return c.json(results)
	}
);

app.get(
	'/playlist/:title',
	cache({
		cacheName: 'smol-workflow',
		cacheControl: 'public, max-age=30',
	}),
	async (c) => {
		const { env } = c;
		const playlistTitle = c.req.param('title');

		interface User {
			Username: string;
			Address: string;
		}

		interface Smol {
			Id: string;
			Title: string;
			Song_1: string;
			Address: string; // Address is part of the initial fetch but removed later
			Plays: number;
		}

		const smolsD1Result = await env.SMOL_D1.prepare(`
			SELECT s.Id, s.Title, s.Song_1, s.Address, s.Plays, s.Views
			FROM Smols s
			INNER JOIN Playlists p ON s.Id = p.Id
			WHERE p.Title = ?1 AND s.Public = 1
			ORDER BY s.Created_At DESC 
			LIMIT 1000
		`)
			.bind(playlistTitle)
			.all<Smol>();

		const smolsFromDb = smolsD1Result.results || [];
		let users: User[] = [];

		if (smolsFromDb.length > 0) {
			const creatorAddresses = [...new Set(smolsFromDb.map((smol) => smol.Address!))].filter(Boolean); // Ensure no undefined/null addresses

			if (creatorAddresses.length > 0) {
				const placeholders = creatorAddresses.map(() => '?').join(',');
				const usersD1Result = await env.SMOL_D1.prepare(`
					SELECT Username, Address FROM Users WHERE Address IN (${placeholders})
				`).bind(...creatorAddresses).all<User>();
				users = usersD1Result.results || [];
			}
		}

		return c.json({
			smols: smolsFromDb,
			users: users
		});
	}
);

app.get(
	'/:id',
	async (c) => {
		const { env, req, executionCtx } = c;
		const id = req.param('id');
		const smol_d1 = await env.SMOL_D1.prepare(`SELECT * FROM Smols WHERE Id = ?1`).bind(id).first();

		if (smol_d1) {
			const smol_kv = await env.SMOL_KV.get(id, 'json');

			// Increment views non-blockingly
			executionCtx.waitUntil(
				env.SMOL_D1.prepare(
					"UPDATE Smols SET Views = Views + 1 WHERE Id = ?"
				).bind(id).run()
			);

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
		playlist?: string
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
			playlist: body.playlist,
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

// Toggle public vs private
app.put(
	'/:id',
	parseAuth,
	async (c) => {
		const { env, req } = c;
		const id = req.param('id'); // Changed from smol_id to id to match route param
		const payload = c.get('jwtPayload')

		const smol_kv: any = await env.SMOL_KV.get(id, 'json');

		if (!smol_kv) {
			throw new HTTPException(404, { message: 'Smol not found' });
		}

		if (typeof smol_kv.nsfw !== 'string' && smol_kv.nsfw?.safe === false) {
			throw new HTTPException(400, { message: 'Cannot change visibility of a NSFW smol' });
		}

		await env.SMOL_D1.prepare(`
			UPDATE Smols SET 
				Public = CASE WHEN Public = 1 THEN 0 ELSE 1 END
			WHERE Id = ?1 AND "Address" = ?2
		`)
			.bind(id, payload.sub)
			.run();

		return c.body(null, 204);
	}
);

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
                Song_2 = Song_1
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
	async (c) => {
		const { env, req, executionCtx } = c;
		const idWithSuffix = req.param('id');
		const id = idWithSuffix.replace(/\.mp3$/, ''); // Remove .mp3 suffix
		const rangeHeader = req.header('range')
		const headers = new Headers({
			// Explicitly set Content-Type, R2 might not always infer it correctly for .mp3
			'Content-Type': 'audio/mpeg',
			'Content-Disposition': 'inline',
		})

		// Fetch only the object metadata first using head()
		const metadata = await env.SMOL_BUCKET.head(idWithSuffix);

		if (!metadata) {
			throw new HTTPException(404, { message: 'Song not found' });
		}

		// Set ETag and Last-Modified from the metadata for comparison and for all responses
		headers.set('ETag', metadata.httpEtag);
		if (metadata.uploaded) {
			headers.set('Last-Modified', metadata.uploaded.toUTCString());
		}
		// Allow R2 to set other relevant HTTP metadata from the HEAD request (e.g., custom metadata, cache-control from R2)
		metadata.writeHttpMetadata(headers);

		const ifNoneMatch = req.header('if-none-match');
		if (ifNoneMatch && ifNoneMatch.split(',').map(etag => etag.trim()).includes(metadata.httpEtag)) {
			// Client has a fresh version, clear unnecessary headers for 304
			// ETag and Last-Modified should remain. Cache-Control from R2 (via writeHttpMetadata) also good.
			headers.delete('Content-Type');
			headers.delete('Content-Disposition');
			headers.delete('Content-Length');
			if (rangeHeader) headers.delete('Content-Range');
			return new Response(null, { status: 304, headers });
		}

		let offset: number | undefined;
		let length: number | undefined;
		let status = 200;

		if (rangeHeader && rangeHeader.startsWith('bytes=')) {
			const bytesRange = rangeHeader.replace(/bytes=/, '').split('-');
			const start = parseInt(bytesRange[0], 10);
			let end = bytesRange[1] ? parseInt(bytesRange[1], 10) : undefined;

			if (isNaN(start) || start < 0) {
				throw new HTTPException(416, { message: 'Invalid range start' });
			}

			if (start >= metadata.size) {
				throw new HTTPException(416, { message: 'Range Not Satisfiable: start past end of file' });
			}

			if (end !== undefined) {
				if (isNaN(end) || end < start) {
					throw new HTTPException(416, { message: 'Invalid range end' });
				}
				end = Math.min(end, metadata.size - 1);
				length = end - start + 1;
			} else {
				// If no end is specified, serve till the end of the file
				length = metadata.size - start;
			}
			offset = start;
			status = 206;
		}

		// Prepare options for the R2 get call
		const r2GetOptions: R2GetOptions = {};
		if (status === 206 && offset !== undefined) {
			r2GetOptions.range = { offset, length }; // length will also be defined here
		}

		// Fetch the actual object (or range) from R2
		const object = await env.SMOL_BUCKET.get(idWithSuffix, r2GetOptions);

		if (!object || !object.body) {
			// This might happen if the object was deleted between HEAD and GET, or R2 error
			throw new HTTPException(500, { message: 'Failed to retrieve song data after metadata check' });
		}

		// Clear potentially stale headers from the HEAD request before applying headers from the GET response object
		// except for ETag and Last-Modified which are stable and already set from metadata.
		const etagFromMeta = headers.get('ETag');
		const lastModifiedFromMeta = headers.get('Last-Modified');

		// Create a new Headers object for the final response to avoid modifying the one used for 304 checks
		const responseHeaders = new Headers();

		// Apply headers from the R2 object (this will set Content-Length, potentially Content-Type, etc.)
		object.writeHttpMetadata(responseHeaders);

		// Ensure our critical headers are set with desired values
		if (etagFromMeta) responseHeaders.set('ETag', etagFromMeta);
		if (lastModifiedFromMeta) responseHeaders.set('Last-Modified', lastModifiedFromMeta);
		responseHeaders.set('Content-Type', 'audio/mpeg'); // Ensure our desired Content-Type
		responseHeaders.set('Content-Disposition', 'inline'); // Ensure our desired Content-Disposition

		// Add Accept-Ranges header to indicate server support for range requests
		responseHeaders.set('Accept-Ranges', 'bytes');

		if (status === 206 && offset !== undefined) {
			// object.size for a ranged GET is the size of the partial content.
			responseHeaders.set('Content-Range', `bytes ${offset}-${offset + object.size - 1}/${metadata.size}`);
			// Content-Length for 206 is set by object.writeHttpMetadata correctly from object.size (partial size)
		} else if (status === 200) {
			// Content-Length for 200 should be the full size.
			// object.writeHttpMetadata (if on a full object) should set this from object.size (full size)
			// If for some reason it's different from metadata.size (e.g. R2 compression not reflected in HEAD size?), metadata.size is the source of truth for the full file.
			if (responseHeaders.get('Content-Length') !== metadata.size.toString()) {
				responseHeaders.set('Content-Length', metadata.size.toString());
			}
		}

		// Increment plays non-blockingly
		executionCtx.waitUntil(
			env.SMOL_D1.prepare(
				"UPDATE Smols SET Plays = Plays + 1 WHERE Song_1 = ?1 OR Song_2 = ?1"
			).bind(id).run()
		);

		return new Response(object.body, { status, headers: responseHeaders });
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

app.delete(
	'/:id',
	parseAuth,
	async ({ env, req, ...c }) => {
		const id = req.param('id');
		const smol: any = await env.SMOL_KV.get(id, 'json');

		try {
			const doid = env.DURABLE_OBJECT.idFromString(id);
			const stub = env.DURABLE_OBJECT.get(doid);
			await stub.setToFlush();
		} catch { }

		await env.SMOL_KV.delete(id);
		await env.SMOL_D1.prepare(`
			DELETE FROM Smols 
			WHERE Id = ?1
		`)
			.bind(id)
			.run()
		await env.SMOL_BUCKET.delete(`${id}.png`);

		if (smol) {
			for (let song of smol.songs) {
				await env.SMOL_BUCKET.delete(`${song.music_id}.mp3`);
			}
		}

		return c.body(null, 204);
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
	TxWorkflow,
	SmolDurableObject,
	SmolState,
	handler as default,
};