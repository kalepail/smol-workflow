import { SmolDurableObject } from './do'

export type Bindings = {
	DURABLE_OBJECT: DurableObjectNamespace<SmolDurableObject>
	WORKFLOW: Workflow
	TX_WORKFLOW: Workflow
	SMOL_D1: D1Database
	SMOL_KV: KVNamespace
	SMOL_BUCKET: R2Bucket
	SECRET: string
	RPC_URL: string
}

export type Variables = {
	jwtPayload?: JWTPayload
}

export type JWTPayload = {
	sub: string
	key: string
	usr: string
	exp: number
}

export type HonoEnv = {
	Bindings: Bindings
	Variables: Variables
}
