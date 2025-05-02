import { Server } from "@stellar/stellar-sdk/minimal/rpc";
import { env } from "cloudflare:workers";
import { Client } from 'fp-sdk';

export const rpc = new Server(env.RPC_URL)

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}