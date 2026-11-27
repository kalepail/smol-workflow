import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { StrKey } from '@stellar/stellar-sdk/base'
import {
	createAuthToken,
	createMockExecutionContext,
	createMockUserQuotaNamespace,
	installCloudflareStubs,
	type CloudflareStubHandle,
} from './helpers/harness'

let stubs: CloudflareStubHandle
let appModule: typeof import('../src/index')
let quotaUtils: typeof import('../src/utils/quota')

const SECRET = 'test-jwt-secret-32-chars-minimum!'
const ADMIN_SECRET = 'test-admin-secret-also-32-chars!!'
const USER = StrKey.encodeContract(Buffer.alloc(32, 7))
const LEGACY_USER = StrKey.encodeContract(Buffer.alloc(32, 9))
const NOW = Date.parse('2026-11-27T12:00:00.000Z')

before(async () => {
	stubs = installCloudflareStubs()
	appModule = await import('../src/index')
	quotaUtils = await import('../src/utils/quota')
})

after(() => stubs.cleanup())

function harness(vars: Record<string, string | undefined> = {}) {
	const quotaNs = createMockUserQuotaNamespace(appModule.UserQuotaDO)
	const env = {
		SECRET,
		ADMIN_SECRET,
		DAILY_LIMIT_CLASSIC: '10',
		DAILY_LIMIT_ELEVENLABS: '5',
		BURST_LIMIT_PER_MINUTE: '0',
		GLOBAL_DAILY_LIMIT_CLASSIC: '100',
		GLOBAL_DAILY_LIMIT_ELEVENLABS: '50',
		USER_QUOTA: quotaNs.namespace,
		DURABLE_OBJECT: { newUniqueId: () => ({ toString: () => 'f'.repeat(64) }) },
		...vars,
	} as unknown as Env
	const send = async (path: string, init: RequestInit = {}) => {
		const ctx = createMockExecutionContext()
		const res = await appModule.app.fetch(new Request(`https://api.smol.xyz${path}`, init), env, ctx.ctx)
		await ctx.flush()
		return res
	}
	const override = async (body: Record<string, unknown>, secret: string | null = ADMIN_SECRET) => {
		const res = await send('/admin/quota-override', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-admin-secret': secret } : {}) },
			body: JSON.stringify(body),
		})
		return { res, json: res.status === 200 ? await res.json() as import('../src/utils/quota').QuotaOverrideView : null }
	}
	const quotaOf = async (address: string) => {
		const res = await send('/quota', { headers: { Authorization: `Bearer ${await createAuthToken(address, SECRET)}` } })
		return { status: res.status, body: res.status === 200 ? await res.json() as import('../src/quota-do').QuotaSnapshot : null }
	}
	const reserve = (reservationId: string, provider: 'aisonggenerator' | 'elevenlabs', address = USER, nowMs = NOW) =>
		quotaUtils.reserveGenerationQuota(env, { address, reservationId, provider, nowMs })
	return { env, quotaNs, send, override, quotaOf, reserve }
}

test('quota override: default 10/5, a 20/10 grant, partial and zero fields, clear, enforced by GET /quota, reserve and fallback', async () => {
	const h = harness()
	const inspect = await h.override({ address: USER })
	assert.equal(inspect.res.status, 200)
	assert.equal(inspect.res.headers.get('Cache-Control'), 'private, no-store')
	assert.deepEqual(inspect.json, { override: null, limits: { classic: 10, elevenlabs: 5 }, source: 'default' })
	assert.deepEqual([(await h.quotaOf(USER)).body?.classic.limit, (await h.quotaOf(USER)).body?.elevenlabs.limit], [10, 5])

	const granted = await h.override({ address: USER, action: 'set', classic: 20, elevenlabs: 10 })
	assert.deepEqual(granted.json?.limits, { classic: 20, elevenlabs: 10 })
	assert.equal(granted.json?.source, 'durable_object')
	assert.deepEqual(
		[granted.json?.override?.classic, granted.json?.override?.elevenlabs, granted.json?.override?.burstPerMinute],
		[20, 10, null]
	)
	const snapshot = (await h.quotaOf(USER)).body!
	assert.deepEqual([snapshot.classic.limit, snapshot.elevenlabs.limit], [20, 10])
	const admitted = await h.reserve('grant-1', 'elevenlabs')
	assert.ok(admitted.ok)
	assert.equal(admitted.quota.elevenlabs.limit, 10)

	// `set` replaces the row: omitted fields fall back to defaults, 0 blocks a provider.
	const partial = await h.override({ address: USER, action: 'set', elevenlabs: 0 })
	assert.deepEqual(partial.json?.limits, { classic: 10, elevenlabs: 0 })
	const blocked = await h.reserve('zero-el', 'elevenlabs')
	assert.ok(!blocked.ok && blocked.code === 'quota_exceeded')
	assert.deepEqual([blocked.payload.scope, blocked.payload.limit], ['user', 0])
	assert.ok((await h.reserve('classic-ok', 'aisonggenerator')).ok)
	const fallback = await quotaUtils.transitionFallbackQuota(h.env, {
		address: USER, reservationId: 'classic-ok', fromProvider: 'aisonggenerator', toProvider: 'elevenlabs', nowMs: NOW,
	})
	assert.ok(!fallback.ok && fallback.code === 'quota_exceeded' && fallback.payload.limit === 0, 'fallback honours the override')

	const burst = await h.override({ address: USER, action: 'set', burstPerMinute: 1 })
	assert.deepEqual(burst.json?.limits, { classic: 10, elevenlabs: 5, burstPerMinute: 1 })
	const burstDenied = await h.reserve('burst-2', 'aisonggenerator', USER, NOW + 1000)
	assert.ok(!burstDenied.ok && burstDenied.code === 'quota_exceeded' && burstDenied.payload.window === 'minute')

	const cleared = await h.override({ address: USER, action: 'clear' })
	assert.deepEqual(cleared.json, { override: null, limits: { classic: 10, elevenlabs: 5 }, source: 'default' })
	assert.equal((await h.quotaOf(USER)).body?.elevenlabs.limit, 5)
})

test('quota override: a stored row wins over USER_QUOTA_OVERRIDES; without one the legacy secret still applies', async () => {
	const h = harness({ USER_QUOTA_OVERRIDES: JSON.stringify({ [LEGACY_USER]: { classic: 15, elevenlabs: 8 } }) })
	assert.deepEqual((await h.override({ address: LEGACY_USER })).json, {
		override: null, limits: { classic: 15, elevenlabs: 8 }, source: 'legacy_secret',
	})
	assert.equal((await h.quotaOf(LEGACY_USER)).body?.classic.limit, 15)

	// A row is applied over the configured defaults, not over the legacy entry.
	assert.deepEqual((await h.override({ address: LEGACY_USER, action: 'set', classic: 3 })).json?.limits, { classic: 3, elevenlabs: 5 })
	assert.deepEqual([(await h.quotaOf(LEGACY_USER)).body?.classic.limit, (await h.quotaOf(LEGACY_USER)).body?.elevenlabs.limit], [3, 5])

	assert.equal((await h.override({ address: LEGACY_USER, action: 'clear' })).json?.source, 'legacy_secret')
	assert.equal((await h.quotaOf(LEGACY_USER)).body?.classic.limit, 15)
})

test('quota override: the global daily cap is still enforced for a granted address', async () => {
	const h = harness({ GLOBAL_DAILY_LIMIT_CLASSIC: '1' })
	await h.override({ address: USER, action: 'set', classic: 20, elevenlabs: 10 })
	assert.ok((await h.reserve('global-1', 'aisonggenerator')).ok)
	const denied = await h.reserve('global-2', 'aisonggenerator')
	assert.ok(!denied.ok && denied.code === 'quota_exceeded')
	assert.deepEqual([denied.payload.scope, denied.payload.limit], ['global', 1])
})

test('quota override: a DO storage error fails closed (503) for GET /quota, POST /, reserve and the admin route', async (t) => {
	t.mock.method(console, 'error', () => {})
	const h = harness()
	await h.override({ address: USER, action: 'set', classic: 20 })
	const instance = h.quotaNs.getInstance(`user:${USER}`) as unknown as { sql: { exec: (query: string, ...args: unknown[]) => unknown } }
	const exec = instance.sql.exec.bind(instance.sql)
	instance.sql.exec = (query: string, ...args: unknown[]) => {
		if (query.includes('quota_overrides')) throw new Error('SQLITE_IOERR: disk I/O error')
		return exec(query, ...args)
	}

	assert.equal((await h.quotaOf(USER)).status, 503)
	await assert.rejects(() => h.reserve('storage-error', 'aisonggenerator'), /SQLITE_IOERR/)
	assert.equal((await h.override({ address: USER })).res.status, 503)
	const create = await h.send('/', {
		method: 'POST',
		headers: { Authorization: `Bearer ${await createAuthToken(USER, SECRET)}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ prompt: 'storage error song', provider: 'aisonggenerator' }),
	})
	assert.equal(create.status, 503)
})

test('quota override route: admin-only, validated body, and the address never reaches logs', async (t) => {
	const logged: string[] = []
	for (const method of ['log', 'warn', 'error'] as const) {
		t.mock.method(console, method, (...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
	}
	const h = harness()
	assert.equal((await h.override({ address: USER }, null)).res.status, 401)
	assert.equal((await h.override({ address: USER }, 'wrong-secret-wrong-secret-wrong!!')).res.status, 401)
	const unset = harness({ ADMIN_SECRET: undefined })
	assert.equal((await unset.override({ address: USER })).res.status, 404)

	for (const body of [
		{ address: 'not-an-address' },
		{},
		{ address: USER, action: 'delete' },
		{ address: USER, action: 'set' },
		{ address: USER, action: 'set', classic: -1 },
		{ address: USER, action: 'set', classic: 1.5 },
		{ address: USER, action: 'set', elevenlabs: '10' },
	]) {
		const { res } = await h.override(body)
		assert.equal(res.status, 400, JSON.stringify(body))
		assert.equal(res.headers.get('Cache-Control'), 'private, no-store')
	}
	assert.equal((await h.override({ address: USER, action: 'set', classic: 20, elevenlabs: null })).res.status, 200)
	assert.ok(logged.every((line) => !line.includes(USER)), 'addresses are never logged')
})
