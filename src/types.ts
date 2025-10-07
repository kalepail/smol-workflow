import { SmolDurableObject } from './do'

// Use the generated Env type from wrangler types
// This ensures all bindings are properly typed
export type Bindings = Env

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
