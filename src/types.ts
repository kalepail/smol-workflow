import { SmolDurableObject } from './do'

// Use the generated Env type which is augmented in types/env.d.ts
// The augmentation adds secrets not in wrangler.jsonc
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
