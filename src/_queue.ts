export async function queue(
    batch: MessageBatch<QueueParams>,
    env: Env,
    ctx: ExecutionContext
) {
    const delaySeconds = 60 * 5; // retry in 5 minutes
    const queueMax = 10; // max number of concurrent workflows

    const doid = env.DO_STATE.idFromName('SMOL ; March 2025');
    const stub = env.DO_STATE.get(doid);

    for (const message of batch.messages) {
        if (batch.queue === 'smol-queue-dlq') {
            console.log('DLQ', message.body);
            await stub.setCount(-1);
            return message.ack();
        }
        
        try {
            const instance = await env.WORKFLOW.get(message.body.id);
            const { status } = await instance.status();

            // status: "queued" // means that instance is waiting to be started (see concurrency limits)
            // | "running" | "paused" | "errored" | "terminated" // user terminated the instance while it was running
            // | "complete" | "waiting" // instance is hibernating and waiting for sleep or event to finish
            // | "waitingForPause" // instance is finishing the current work to pause
            // | "unknown";

            switch (status) {
                case 'errored':
                case 'terminated':
                case 'complete':
                case 'unknown':
                    await stub.setCount(-1);
                    return message.ack();
                default:
                    return message.retry({ delaySeconds });
            }
        } catch {
            const count = await stub.getCount()

            if (count < queueMax) {
                const instance = await env.WORKFLOW.create({
                    id: message.body.id,
                    params: {
                        prompt: message.body.prompt,
                    }
                });

                console.log('Workflow started', message.body.id, await instance.status());

                await stub.setCount(1);
            }

            return message.retry({ delaySeconds });
        }
    }
}