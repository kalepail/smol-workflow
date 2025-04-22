// import { checkNSFW } from "./ai/nsfw";
import { SmolDurableObject, SmolState } from "./do";
// import { queue } from "./queue";
import { processTwitterMentions } from "./twitter";
import { Workflow } from "./workflow";

// TODO switch to use itty-router
// specifically for cors and preflight
// TODO add caching

// TODO support retries in case of failure
// Save images to R2
// Save relevant info to KV or SQL

const headers = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': '*',
	'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
} 

const handler = {
	async fetch(req: Request, env: Env) {
		let url = new URL(req.url);
		let id = url.searchParams.get('id');
		let retry = url.searchParams.get('retry');

		if (req.method === 'OPTIONS') {
			return new Response(null, {
				headers
			});
		}

		if (url.pathname.startsWith('/favicon')) {
			return new Response('Not Found', { 
				status: 404,
				headers
			});
		}

		// if (url.pathname.includes('nsfw')) {
		// 	let prompt = url.searchParams.get('prompt');
		// 	let description = url.searchParams.get('description');
		// 	let lyrics = url.searchParams.get('lyrics');
		// 	return Response.json(await checkNSFW(env, prompt!, description!, lyrics!));
		// }

		// if (url.pathname.includes('smol')) {
		// 	const doid = env.DO_STATE.idFromName('SMOL ; March 2025');
		// 	const stub = env.DO_STATE.get(doid);

		// 	if (req.method === 'POST') {
		// 		let count = url.searchParams.get('count') || 0;
		// 		await stub.setCount(Number(count))
		// 	}

		// 	return new Response((await stub.getCount()).toLocaleString());
		// }

		if (req.method === 'GET' && id) {
			const doid = env.DURABLE_OBJECT.idFromString(id);
			const stub = env.DURABLE_OBJECT.get(doid);
			const instance = await new Promise<WorkflowInstance | null>(async (resolve) => {
				try {
					resolve(await env.WORKFLOW.get(id))
				} catch {
					resolve(null)
				}
			});

			// TODO if the instance is done we should save the results to KV and toss the DO and the Workflow
			// TODO toss old instances (.terminate?) not actually sure it's possible to trash old workflows atm
			// TODO if we have everything but the songs (for whatever reason) we should make a manual call to backfill

			return Response.json({
				do: await stub.getSteps(),
				steps: instance ? await instance.status() : [],
			}, {
				headers
			});
		}

		if (req.method !== 'POST') {
			return new Response('Method Not Allowed', { 
				status: 405,
				headers
			});
		}

		if (id && retry) {
			let instanceId = env.DURABLE_OBJECT.newUniqueId().toString();

			const instance = await env.WORKFLOW.create({
				id: instanceId,
				params: {
					retry_id: id,
				}
			});

			console.log('Workflow restarted', instanceId, await instance.status());

			return new Response(instanceId, {
				headers
			});
		}

		const body: { prompt: string } = await req.json();

		if (!body.prompt) {
			return new Response('Bad Request', { 
				status: 400,
				headers
			});
		}

		let instanceId = env.DURABLE_OBJECT.newUniqueId().toString();

		// await env.QUEUE.send({
		// 	id: instanceId,
		// 	prompt: body.prompt			
		// });

		const instance = await env.WORKFLOW.create({
			id: instanceId,
			params: {
				prompt: body.prompt,
			}
		});

		console.log('Workflow started', instanceId, await instance.status());

		return new Response(instanceId, {
			headers
		});
	},

	async scheduled(ctrl, env, ctx) {
		await processTwitterMentions(env, ctx);
	},

	// TODO I've observed queued items getting stuck, consider implementing a cron trigger to pull queue items and process them
	// https://developers.cloudflare.com/queues/configuration/configure-queues/#pull-based

	// async queue(
	// 	batch: MessageBatch<QueueParams>,
	// 	env: Env,
	// 	ctx: ExecutionContext
	// ) {
	// 	await queue(batch, env, ctx)
	// },
} satisfies ExportedHandler<Env>;

export {
	Workflow,
	SmolDurableObject,
	SmolState,
	handler as default,
};