import { Address, hash, Keypair, StrKey, xdr } from "@stellar/stellar-sdk/minimal";
import { basicNodeSigner } from "@stellar/stellar-sdk/minimal/contract";
import { env, WorkflowEntrypoint, WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { Client } from "fp-sdk";

const keypair = Keypair.fromRawEd25519Seed(hash(Buffer.from('kalepail')));
const publicKey = keypair.publicKey()

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
                let xdr: string

                switch (event.payload.type) {
                    case 'mint':
                        xdr = await this.mint(event.payload)
                        break;
                    case 'buy':
                        xdr = await this.buy(event.payload)
                        break;
                    case 'sell':
                        xdr = await this.sell(event.payload)
                        break;
                    default:
                        throw new Error('Invalid transaction type');
                }

                body.append('xdr', xdr);

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
                    return res.json()
                })
            }
        );

        return res;
    }

    async mint(payload: WorkflowTxParams) {
        const at = await Client.deploy({
            owner: PK,
            name: payload.name!
        }, {
            address: publicKey,
            wasmHash: this.env.FP_WASM_HASH,
            rpcUrl: this.env.RPC_URL,
            networkPassphrase: this.env.NETWORK_PASSPHRASE,
            salt: Buffer.from(payload.entropy, 'hex'),
            format: 'hex',
        });

        await at.signAuthEntries({
            address: publicKey,
            signAuthEntry: basicNodeSigner(keypair, this.env.NETWORK_PASSPHRASE).signAuthEntry
        });

        return at.built!.toXDR();
    }

    async buy(payload: WorkflowTxParams) {
        let contractId: string | undefined = StrKey.encodeContract(hash(xdr.HashIdPreimage.envelopeTypeContractId(
            new xdr.HashIdPreimageContractId({
                networkId: hash(Buffer.from(this.env.NETWORK_PASSPHRASE)),
                contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                    new xdr.ContractIdPreimageFromAddress({
                        address: Address.fromString(publicKey).toScAddress(),
                        salt: Buffer.from(payload.entropy, 'hex'),
                    })
                )
            })
        ).toXDR()));

        const contract = new Client({
            contractId,
            rpcUrl: this.env.RPC_URL,
            networkPassphrase: this.env.NETWORK_PASSPHRASE,
        });

        const at = await contract.mint({
            account: payload.owner,
            amount: 1n,
        });

        await at.signAuthEntries({
            address: PK,
            signAuthEntry: basicNodeSigner(KP, this.env.NETWORK_PASSPHRASE).signAuthEntry
        });
        
        return at.built!.toXDR();
    }

    async sell(payload: WorkflowTxParams) {
        return payload.xdr!;
    }
}