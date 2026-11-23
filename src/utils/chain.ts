import { Address, Asset, hash, Networks, StrKey, xdr } from '@stellar/stellar-sdk/minimal'

export const KALE_SAC = 'CB23WRDQWGSP6YPMY4UV5C4OW5CBTXKYN3XEATG7KJEZCXMJBYEHOUOV'
const SMOL_FACTORY = 'CBRNUVLGFM5OYWAGZVGU7CTMP2UJLKZCLFY2ANUCK5UGKND6BBAA5PLA'
const SMOL_ISSUER = 'GBVJZCVQIKK7SL2K6NL4BO6ZYNXAGNVBTAQDDNOIJ5VPP3IXCSE2SMOL'
const COMET_HASH = '61e1fc5401a7b22418c2bd3bc5bd2c07241e4dae098c587c89f3f666aca12e37'
const I128_MAX = (1n << 127n) - 1n
const U32_MAX = 0xffff_ffff
const STROOP = 10n ** 7n
const SCALAR = 10n ** 11n
const BONE = 10n ** 18n
export const LEDGER_KEY_LIMIT = 200

type LedgerEntryWire = {
	key: string
	xdr: string
	lastModifiedLedgerSeq: number
	liveUntilLedgerSeq?: number
}

export type LedgerPage = {
	latestLedger: number
	archiveAware: boolean
	entries: LedgerEntryWire[]
}

export interface MainnetChainReads {
	readEntries(request: { keys: string[]; minLedger?: number; deadlineMs?: number }): Promise<LedgerPage>
	getTip(): Promise<{ sequence: number; closeTime: string }>
	getTx(hash: string): Promise<{
		status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'
		latestLedger: number
		ledger?: number
		returnValueXdr?: string
	}>
}

export type LedgerLife = 'live' | 'archived'

export type LedgerValue =
	| { state: 'present'; value: xdr.ScVal; life?: LedgerLife }
	| { state: 'absent' }
	| { state: 'unknown' }

export type Balance =
	| { state: 'known'; amount: string; life: LedgerLife | 'absent' }
	| { state: 'unknown'; reason: string }

export function isLedgerSequence(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= U32_MAX
}

export function deriveMintPair(id: string): { sac: string; pool: string } | null {
	if (!/^[0-9a-f]{64}$/.test(id)) return null

	const sac = new Asset(id.slice(0, 12), SMOL_ISSUER).contractId(Networks.PUBLIC)
	const from = new xdr.ContractIdPreimageFromAddress({
		address: new Address(SMOL_FACTORY).toScAddress(),
		salt: Buffer.from(id, 'hex'),
	})
	const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
		networkId: hash(Buffer.from(Networks.PUBLIC)),
		contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(from),
	}))
	return { sac, pool: StrKey.encodeContract(hash(preimage.toXDR())) }
}

export function contractDataKey(contract: string, key: xdr.ScVal): xdr.LedgerKey {
	return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
		contract: new Address(contract).toScAddress(),
		key,
		durability: xdr.ContractDataDurability.persistent(),
	}))
}

export function storageKey(name: string, ...args: xdr.ScVal[]): xdr.ScVal {
	return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), ...args])
}

export function instanceKey(contract: string): xdr.LedgerKey {
	return contractDataKey(contract, xdr.ScVal.scvLedgerKeyContractInstance())
}

export function balanceKey(contract: string, holder: string): xdr.LedgerKey {
	return contractDataKey(contract, storageKey('Balance', new Address(holder).toScVal()))
}

export function poolRecordsKey(contract: string): xdr.LedgerKey {
	return contractDataKey(contract, storageKey('AllRecordData'))
}

export function decodeLedgerPage(page: LedgerPage, keys: readonly string[], minLedger?: number) {
	if (!page || !isLedgerSequence(page.latestLedger) || page.latestLedger < (minLedger ?? 0)
		|| typeof page.archiveAware !== 'boolean' || !Array.isArray(page.entries) || page.entries.length > keys.length) {
		throw new Error('Invalid ledger page')
	}
	const requested = new Set(keys)
	const values = new Map<string, LedgerValue>()
	for (const entry of page.entries) {
		if (!entry || !requested.has(entry.key) || values.has(entry.key)) throw new Error('Unexpected ledger key')
		values.set(entry.key, decodeLedgerValue(entry, page.latestLedger))
	}
	for (const key of keys) {
		if (!values.has(key)) values.set(key, { state: page.archiveAware ? 'absent' : 'unknown' })
	}
	return { ledger: page.latestLedger, values }
}

function decodeLedgerValue(entry: LedgerEntryWire, ledger: number): LedgerValue {
	try {
		const ttl = entry.liveUntilLedgerSeq
		if (!isLedgerSequence(entry.lastModifiedLedgerSeq) || entry.lastModifiedLedgerSeq > ledger
			|| (ttl !== undefined && ttl !== 0 && !isLedgerSequence(ttl))) {
			return { state: 'unknown' }
		}
		const data = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64').contractData()
		const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
			contract: data.contract(),
			key: data.key(),
			durability: data.durability(),
		}))
		if (key.toXDR('base64') !== entry.key) return { state: 'unknown' }
		const life = ttl === undefined ? undefined : ttl < ledger ? 'archived' : 'live'
		return { state: 'present', value: data.val(), life }
	} catch {
		return { state: 'unknown' }
	}
}

export async function readChainSnapshot(binding: MainnetChainReads, keys: string[], minLedger?: number) {
	const uniqueKeys = [...new Set(keys)]
	const chunks: string[][] = []
	for (let i = 0; i < uniqueKeys.length; i += LEDGER_KEY_LIMIT) {
		chunks.push(uniqueKeys.slice(i, i + LEDGER_KEY_LIMIT))
	}
	const read = async (chunk: string[], floor?: number) => {
		try {
			const page = await binding.readEntries({ keys: chunk, minLedger: floor })
			return decodeLedgerPage(page, chunk, floor)
		} catch {
			return null
		}
	}
	let pages = await Promise.all(chunks.map((chunk) => read(chunk, minLedger)))
	const latest = Math.max(0, ...pages.map((page) => page?.ledger ?? 0))
	if (latest > 0 && pages.some((page) => page && page.ledger < latest)) {
		pages = await Promise.all(pages.map((page, i) =>
			page?.ledger === latest ? page : read(chunks[i], latest).then((fresh) => fresh ?? page),
		))
	}
	const ledgers = pages.flatMap((page) => page ? [page.ledger] : [])
	const latestLedger = Math.max(0, ...ledgers)
	const oldestObservationLedger = ledgers.length ? Math.min(...ledgers) : 0
	const coherent = pages.length > 0 && pages.length === ledgers.length && latestLedger === oldestObservationLedger
	const values = new Map(pages.flatMap((page) => page ? [...page.values] : []))
	return { values, latestLedger, oldestObservationLedger, coherent }
}

export function parseUnits(value: unknown): bigint | null {
	if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(value)) return null
	const amount = BigInt(value)
	return amount <= I128_MAX ? amount : null
}

function unsignedI128(value?: xdr.ScVal): bigint | null {
	if (value?.switch().name !== 'scvI128') return null
	const parts = value.i128()
	const hi = parts.hi().toBigInt()
	return hi < 0n ? null : (hi << 64n) | parts.lo().toBigInt()
}

function contractAddress(value: xdr.ScVal): string | null {
	if (value.switch().name !== 'scvAddress' || value.address().switch().name !== 'scAddressTypeContract') return null
	return Address.fromScVal(value).toString()
}

function mapValues(entries: xdr.ScMapEntry[] | null | undefined, keyType: 'symbol' | 'address' | 'storage') {
	if (!entries) return null
	const fields = new Map<string, xdr.ScVal>()
	for (const entry of entries) {
		const key = entry.key()
		const type = key.switch().name
		const name = keyType === 'symbol' && type === 'scvSymbol' ? key.sym().toString()
			: keyType === 'address' ? contractAddress(key)
			: keyType === 'storage' ? key.toXDR('base64') : null
		if (name === null || fields.has(name)) return null
		fields.set(name, entry.val())
	}
	return fields
}

function symbolMap(value?: xdr.ScVal) {
	return value?.switch().name === 'scvMap' ? mapValues(value.map(), 'symbol') : null
}

export function readSacBalance(entry?: LedgerValue): Balance {
	if (entry?.state === 'absent') return { state: 'known', amount: '0', life: 'absent' }
	if (entry?.state !== 'present') return { state: 'unknown', reason: 'unavailable' }
	const amount = unsignedI128(symbolMap(entry.value)?.get('amount'))
	if (amount === null || !entry.life) return { state: 'unknown', reason: 'invalidEntry' }
	return { state: 'known', amount: amount.toString(), life: entry.life }
}

export function isSacInstance(entry?: LedgerValue): boolean {
	return entry?.state === 'present'
		&& entry.value.switch().name === 'scvContractInstance'
		&& entry.value.instance().executable().switch().name === 'contractExecutableStellarAsset'
}

export function cometInstance(entry?: LedgerValue) {
	if (entry?.state !== 'present' || entry.value.switch().name !== 'scvContractInstance') return null
	const instance = entry.value.instance()
	const executable = instance.executable()
	return executable.switch().name === 'contractExecutableWasm'
		&& Buffer.from(executable.wasmHash()).toString('hex') === COMET_HASH
		? instance : null
}

export type Reserve = { token: string; balance: bigint; weight: bigint; scalar: bigint }

export function readReserves(entry: LedgerValue | undefined, sac: string): [Reserve, Reserve] | null {
	if (entry?.state !== 'present' || entry.value.switch().name !== 'scvMap') return null
	const map = mapValues(entry.value.map(), 'address')
	if (map?.size !== 2) return null

	const read = (token: string): Reserve | null => {
		const record = symbolMap(map.get(token))
		const balance = unsignedI128(record?.get('balance'))
		const weight = unsignedI128(record?.get('weight'))
		const scalar = unsignedI128(record?.get('scalar'))
		if (balance === null || !weight || !scalar || record?.get('index')?.switch().name !== 'scvU32') return null
		return { token, balance, weight, scalar }
	}
	const kale = read(KALE_SAC)
	const track = read(sac)
	return kale && track ? [kale, track] : null
}

export type QuoteIssue = 'unsupported' | 'unavailable' | 'invalidInput' | 'frozen'
export type QuoteRequest = { direction: 'kaleIn' | 'trackIn'; amountIn: bigint }

export function quoteComet(
	instance: xdr.ScContractInstance,
	reserves: [Reserve, Reserve],
	request: QuoteRequest,
	ledger: number,
	requiresRestore: boolean,
) {
	const { direction, amountIn } = request
	const [input, output] = direction === 'kaleIn' ? reserves : [reserves[1], reserves[0]]
	const issue = (quoteIssue: QuoteIssue) => ({ quoteIssue })
	if (reserves.some(({ weight, scalar }) => weight !== STROOP / 2n || scalar !== SCALAR)) return issue('unsupported')
	const storage = mapValues(instance.storage(), 'storage')
	if (!storage) return issue('unavailable')
	const freeze = storage.get(storageKey('Freeze').toXDR('base64'))
	if (freeze && freeze.switch().name !== 'scvBool') return issue('unavailable')
	if (freeze?.b()) return issue('frozen')

	const config = symbolMap(storage.get(storageKey('SwapFeeConfig').toXDR('base64')))
	const trackedAddress = config?.get('tracked_token')
	const trackedToken = trackedAddress ? contractAddress(trackedAddress) : null
	const tracked = reserves.find((reserve) => reserve.token === trackedToken)
	const min = unsignedI128(config?.get('min_fee'))
	const max = unsignedI128(config?.get('max_fee'))
	const low = unsignedI128(config?.get('low_util_balance'))
	const high = unsignedI128(config?.get('high_util_balance'))
	if (!tracked || min === null || max === null || low === null || high === null
		|| min >= STROOP || max >= STROOP || !input.balance || !output.balance) return issue('unavailable')

	let fee = max
	if (max > min && high > low) {
		if (high * tracked.scalar > I128_MAX || tracked.balance * tracked.scalar > I128_MAX) return issue('unavailable')
		const clamped = tracked.balance < low ? low : tracked.balance > high ? high : tracked.balance
		const utilization = (clamped - low) * STROOP / (high - low)
		fee -= (max - min) * utilization / STROOP
	}

	const maxIn = input.balance * (STROOP / 3n + 1n) / STROOP
	const nextInput = input.balance + amountIn
	if (amountIn <= 0n || amountIn > maxIn || nextInput > I128_MAX) return issue('invalidInput')

	const x = input.balance * input.scalar
	const y = output.balance * output.scalar
	const adjusted = amountIn * input.scalar * (STROOP - fee) / STROOP
	const base = x * BONE / (x + adjusted)
	const expectedOut = (y * (BONE - base) / BONE) / output.scalar
	if (expectedOut <= 0n || expectedOut >= output.balance) return issue('invalidInput')

	// Comet floors both spot prices in seven-decimal units.
	const spot = (balanceIn: bigint, balanceOut: bigint) => {
		const num = balanceIn * STROOP / input.weight
		const den = balanceOut * STROOP / output.weight
		const ratio = num * STROOP / den
		const price = ratio * STROOP / (STROOP - fee)
		return num <= I128_MAX && den <= I128_MAX && ratio <= I128_MAX && price <= I128_MAX ? price : null
	}
	const before = spot(input.balance, output.balance)
	const after = spot(nextInput, output.balance - expectedOut)
	const effective = amountIn * STROOP / expectedOut
	if (before === null || after === null || after < before || effective < before || effective > I128_MAX) {
		return issue('invalidInput')
	}

	// Difference from the fee-adjusted marginal output, rounded to 0.01 basis points.
	const marginal = amountIn * (STROOP - fee) * output.balance
	const shortfall = marginal - expectedOut * STROOP * input.balance
	const curveImpactBps = shortfall > 0n ? Number(shortfall * 1_000_000n / marginal) / 100 : 0
	return { quote: {
		amountIn: amountIn.toString(),
		expectedOut: expectedOut.toString(),
		swapFee7: fee.toString(),
		maxIn: maxIn.toString(),
		curveImpactBps,
		ledger,
		requiresRestore,
	} }
}
