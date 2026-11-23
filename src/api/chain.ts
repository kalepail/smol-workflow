import { StrKey } from '@stellar/stellar-sdk/minimal'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { optionalAuth } from '../middleware/auth'
import type { HonoEnv } from '../types'
import {
	balanceKey, cometInstance, deriveMintPair, instanceKey, isLedgerSequence, isSacInstance,
	KALE_SAC, parseUnits, poolRecordsKey, quoteComet, readChainSnapshot, readReserves, readSacBalance,
	type Balance, type LedgerLife, type QuoteRequest,
} from '../utils/chain'
import { parseTrackTarget, readChainTarget } from '../utils/chain-target'
import { privateNoStore, readJsonBody } from './mixtapes'

const chain = new Hono<HonoEnv>()

function parseQuote(value: unknown): QuoteRequest | undefined {
	if (value === undefined) return undefined
	if (value && typeof value === 'object' && 'direction' in value && 'amountIn' in value) {
		const { direction } = value
		const amountIn = parseUnits(value.amountIn)
		if ((direction === 'kaleIn' || direction === 'trackIn') && amountIn) return { direction, amountIn }
	}
	throw new HTTPException(400, { message: 'Invalid quote' })
}

function trackKeys(pair: ReturnType<typeof deriveMintPair>, holder?: string) {
	return pair ? {
		sac: instanceKey(pair.sac).toXDR('base64'),
		pool: instanceKey(pair.pool).toXDR('base64'),
		reserves: poolRecordsKey(pair.pool).toXDR('base64'),
		...(holder ? { balance: balanceKey(pair.sac, holder).toXDR('base64') } : {}),
	} : null
}

const UNKNOWN_BALANCE = { state: 'unknown', reason: 'unavailable' } satisfies Balance

chain.post('/snapshot', privateNoStore, optionalAuth, async (c) => {
	const body = await readJsonBody(c)
	const target = parseTrackTarget(body.target)
	const quote = parseQuote(body.quote)
	const { includeWallet, minLedger } = body
	if (includeWallet !== undefined && typeof includeWallet !== 'boolean') {
		throw new HTTPException(400, { message: 'Invalid includeWallet' })
	}
	if (minLedger !== undefined && !isLedgerSequence(minLedger)) {
		throw new HTTPException(400, { message: 'Invalid minLedger' })
	}
	const claim = c.get('jwtPayload')?.sub
	const sub = typeof claim === 'string' && claim ? claim : undefined
	if (includeWallet && !sub) {
		throw new HTTPException(401, { message: 'User session required' })
	}
	if (includeWallet && !StrKey.isValidContract(sub!)) {
		throw new HTTPException(400, { message: 'Wallet snapshots require a contract account' })
	}

	const membership = await readChainTarget(c.env, target, sub)
	const holder = includeWallet ? sub : undefined
	const kaleKey = holder ? balanceKey(KALE_SAC, holder).toXDR('base64') : undefined
	const candidates = membership.tracks.map((row) => ({ row, pair: deriveMintPair(row.Id) }))
	const assets = new Map<string, number>()
	for (const { pair } of candidates) {
		if (pair) assets.set(pair.sac, (assets.get(pair.sac) ?? 0) + 1)
	}
	// The asset code uses a prefix. Two salts can deploy distinct pools for the same SAC.
	const checks = candidates.map(({ row, pair }) => ({
		row, pair, keys: pair && assets.get(pair.sac) === 1 ? trackKeys(pair, holder) : null,
	}))
	const allKeys = checks.flatMap(({ keys }) => keys ? Object.values(keys) : [])
	if (kaleKey) allKeys.push(kaleKey)
	const { values, latestLedger, oldestObservationLedger, coherent } = await readChainSnapshot(c.env.KALE_WORKER, allKeys, minLedger)
	const kale = kaleKey ? (coherent ? readSacBalance(values.get(kaleKey)) : UNKNOWN_BALANCE) : undefined

	const tracks = checks.map(({ row, pair, keys }) => {
		const index = !row.Mint_Token && !row.Mint_Amm ? 'missing'
			: pair && pair.sac === row.Mint_Token && pair.pool === row.Mint_Amm ? 'matches' : 'conflict'
		const base = { id: row.Id, sac: pair?.sac ?? null, pool: pair?.pool ?? null, index }
		const unresolved = {
			...base,
			mint: 'unresolved' as const,
			...(holder ? { balance: UNKNOWN_BALANCE } : {}),
		}

		if (!pair || !keys || !coherent) return { ...unresolved, ...(quote ? { quoteIssue: 'unavailable' } : {}) }

		const sac = values.get(keys.sac)
		const pool = values.get(keys.pool)
		const records = values.get(keys.reserves)
		const balance = keys.balance ? values.get(keys.balance) : undefined
		const instance = cometInstance(pool)
		const reserves = readReserves(records, pair.sac)
		if (sac?.state === 'absent' && pool?.state === 'absent' && records?.state === 'absent'
			&& index === 'missing' && (!keys.balance || balance?.state === 'absent')) {
			return {
				...base,
				mint: 'unminted' as const,
				...(keys.balance ? { balance: readSacBalance(balance) } : {}),
				...(quote ? { quoteIssue: 'unavailable' } : {}),
			}
		}
		if (!isSacInstance(sac) || !instance || !reserves) {
			const unsupported = pool?.state === 'present' && pool.value.switch().name === 'scvContractInstance' && !instance
			return { ...unresolved, ...(quote ? { quoteIssue: unsupported ? 'unsupported' : 'unavailable' } : {}) }
		}

		const lifetimes = [sac, pool, records].map((entry) => entry?.state === 'present' ? entry.life : undefined)
		const life: LedgerLife | undefined = lifetimes.includes('archived') ? 'archived'
			: lifetimes.every((ttl) => ttl === 'live') ? 'live' : undefined
		const walletBalance = keys.balance ? readSacBalance(balance) : undefined
		const requiresRestore = life === 'archived'
			|| (walletBalance?.state === 'known' && walletBalance.life === 'archived')
			|| (kale?.state === 'known' && kale.life === 'archived')
		return {
			...base,
			mint: 'verified' as const,
			...(life ? { life } : {}),
			...(walletBalance ? { balance: walletBalance } : {}),
			reserves: reserves.map(({ token, balance, weight, scalar }) => ({
				token, balance: balance.toString(), weight: weight.toString(), scalar: scalar.toString(),
			})),
			...(quote ? (lifetimes.every(Boolean) ? quoteComet(instance, reserves, quote, latestLedger, requiresRestore)
				: { quoteIssue: 'unavailable' }) : {}),
		}
	})

	let ownership: 'owned' | 'notOwned' | 'unknown' | 'notRequested' = 'notRequested'
	if (holder) {
		ownership = 'unknown'
		if (!membership.incompleteMembership && coherent && tracks.length) {
			const knownBalance = (track: typeof tracks[number]) => track.balance?.state === 'known' ? track.balance.amount : null
			if (tracks.some((track) => track.mint === 'unminted' || (track.mint === 'verified' && knownBalance(track) === '0'))) {
				ownership = 'notOwned'
			} else if (tracks.every((track) => track.mint === 'verified' && knownBalance(track) !== null)) {
				ownership = 'owned'
			}
		}
	}

	return c.json({
		network: 'mainnet',
		revision: membership.revision,
		observedAt: new Date().toISOString(),
		latestLedger,
		oldestObservationLedger,
		coherent,
		kale,
		tracks,
		incompleteMembership: membership.incompleteMembership,
		ownership,
	})
})

export default chain
