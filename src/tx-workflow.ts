import { Address, hash, Keypair, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk/minimal";
import { basicNodeSigner } from "@stellar/stellar-sdk/minimal/contract";
import { env, WorkflowEntrypoint, WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { Client as SmolClient } from "smol-sdk";

// const keypair = Keypair.fromRawEd25519Seed(hash(Buffer.from('kalepail')));
// const publicKey = keypair.publicKey();

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

export class TxWorkflow extends WorkflowEntrypoint<Env, WorkflowTxParams> {
    async run(event: WorkflowEvent<WorkflowTxParams>, step: WorkflowStep) {
        const body = new FormData();

        const res = await step.do(
            'submit transaction',
            config,
            async (): Promise<any> => {
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

                body.append('xdr', xdrEnvelope);

                return this.env.LAUNCHTUBE.fetch('http://launchtube/', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.env.LAUNCHTUBE_TOKEN}`,
                    },
                    body,
                })
                .then(async (res) => {
                    if (!res.ok) {
                        throw await res.text()
                    }

                    // Response contains mint metadata we persist in a follow-up step

                    return res.json()
                })
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
            });
        } else if (event.payload.type === 'batch-mint') {
            await step.do('persist batch mint metadata', config, async () => {
                const results = scValToNative(xdr.ScVal.fromXDR(res.returnValue, 'base64')) as [string, string][];

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
