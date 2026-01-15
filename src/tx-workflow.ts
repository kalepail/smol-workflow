import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk/minimal";
import { rpc } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/minimal/contract";
import { env, WorkflowEntrypoint, WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { Client as SmolClient } from "smol-sdk";
import { purgeCacheByTags } from "./utils/cache";

const KP = Keypair.fromSecret(env.SK)
const PK = KP.publicKey()

const config: WorkflowStepConfig = {
    retries: {
        limit: 5,
        delay: '10 second',
        backoff: 'exponential',
    },
    timeout: '5 minutes',
}

/**
 * Poll Stellar RPC for transaction result and extract returnValue.
 * Waits for the transaction to be confirmed on-chain.
 */
async function getTransactionResult(hash: string, rpcUrl: string): Promise<string> {
    const rpcServer = new rpc.Server(rpcUrl);
    const timeout = 30000;
    const pollInterval = 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        const result = await rpcServer.getTransaction(hash);

        if (result.status === 'SUCCESS') {
            if (!result.returnValue) {
                throw new Error(`Transaction ${hash} succeeded but has no returnValue`);
            }
            return result.returnValue.toXDR('base64');
        } else if (result.status === 'FAILED') {
            throw new Error(`Transaction ${hash} failed on-chain`);
        }

        // NOT_FOUND - transaction not yet in ledger, keep polling
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Timeout waiting for transaction ${hash} confirmation`);
}

export class TxWorkflow extends WorkflowEntrypoint<Env, WorkflowTxParams> {
    async run(event: WorkflowEvent<WorkflowTxParams>, step: WorkflowStep) {
        const res = await step.do(
            'submit transaction',
            config,
            async (): Promise<{ hash: string; returnValue: string }> => {
                let xdrEnvelope: string

                switch (event.payload.type) {
                    case 'mint':
                        xdrEnvelope = await this.signTransaction(event.payload.xdr!)
                        break;
                    case 'batch-mint':
                        xdrEnvelope = await this.signTransaction(event.payload.xdr!)
                        break;
                    default:
                        throw new Error('Invalid transaction type');
                }

                // Submit via kale-worker service binding (bypasses Turnstile auth)
                const result = await this.env.KALE_WORKER.submitTransaction({ xdr: xdrEnvelope });

                if (result.error) {
                    throw new Error(`Transaction failed: ${result.error} (${result.errorCode})`);
                }

                if (!result.hash) {
                    throw new Error('Transaction submitted but no hash returned');
                }

                // Fetch the returnValue from Stellar RPC using the transaction hash
                const returnValue = await getTransactionResult(result.hash, this.env.RPC_URL);

                return { hash: result.hash, returnValue };
            }
        );

        if (event.payload.type === 'mint') {
            // TODO if this fails we're kinda eff'ed. Either need a way to retry just this step or we should consider saving this step first
            // as contract addresses are deterministic and we could get the values from the simulation
            await step.do('persist mint metadata', config, async () => {
                const [tokenSACAddress, cometAMMAddress] = scValToNative(xdr.ScVal.fromXDR(res.returnValue, 'base64'));

                await this.env.SMOL_D1.prepare(`
                    UPDATE Smols
                    SET Mint_Token = ?1, Mint_Amm = ?2
                    WHERE Id = ?3
                `)
                    .bind(tokenSACAddress, cometAMMAddress, event.payload.entropy)
                    .run();

                // Purge user's individual smol page
                await purgeCacheByTags([`user:${event.payload.sub}:smol:${event.payload.entropy}`]);
            });
        } else if (event.payload.type === 'batch-mint') {
            await step.do('persist batch mint metadata', config, async () => {
                const results = scValToNative(xdr.ScVal.fromXDR(res.returnValue, 'base64')) as [string, string][];

                // Collect smol IDs for cache purging
                const smolCacheTags: string[] = [];

                for (let i = 0; i < results.length; i++) {
                    const [tokenSACAddress, cometAMMAddress] = results[i];
                    const id = event.payload.ids![i];

                    await this.env.SMOL_D1.prepare(`
                        UPDATE Smols
                        SET Mint_Token = ?1, Mint_Amm = ?2
                        WHERE Id = ?3
                    `)
                        .bind(tokenSACAddress, cometAMMAddress, id)
                        .run();

                    // Collect cache tags for user's individual smol pages
                    smolCacheTags.push(`user:${event.payload.sub}:smol:${id}`);
                }

                // Purge user's individual smol pages
                if (smolCacheTags.length > 0) {
                    await purgeCacheByTags(smolCacheTags);
                }
            });
        }

        return res;
    }

    async signTransaction(xdr: string) {
        const contract = new SmolClient({
            contractId: this.env.SMOL_CONTRACT_ID,
            rpcUrl: this.env.RPC_URL,
            networkPassphrase: this.env.NETWORK_PASSPHRASE,
        });

        const at = contract.txFromXDR(xdr);

        await at.signAuthEntries({
            address: PK,
            signAuthEntry: basicNodeSigner(KP, this.env.NETWORK_PASSPHRASE).signAuthEntry
        });

        return at.built!.toXDR();
    }
}
