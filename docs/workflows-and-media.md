# Workflows, Providers, Quota, Media & Chain

## 1. Music Provider Routing & Replay Safety

### Paid-Submit Replay Rules
- Paid upstream submissions (`submit aisonggenerator task`, `reconcile aisonggenerator attempt`, `generate song (elevenlabs)`, `generate song (elevenlabs fallback)`, and `TxWorkflow` `submit transaction`) run with **`retries: { limit: 0 }`**.
- Before dispatching a paid generation POST, `SmolDurableObject.claimPaidAttempt(provider)` atomically records an in-flight claim in DO storage. Claimed, submitted and ambiguous attempts carry across the whole retry chain for both providers.
- For **AISG v6**:
  1. `POST /api/tasks` (with an `Idempotency-Key` equal to the attempt ID) returns `{ task_id, workspace_id? }` right after acceptance. The client still falls back to the legacy `POST /api/songs` on HTTP `404`; that staged-rollout shim is dead (the worker has served `/api/tasks` since rollout) and is scheduled for removal (audit 47a A3).
  2. Read-only `GET /api/tasks/:id` discovery runs in bounded steps until 2 distinct `music_ids` arrive.
  3. Bounded `poll songs #N` steps + `step.sleep` replace polling-by-throwing exponential backoff.
  4. 2-track swap fingerprinting runs **only** for 2-track AISG jobs with stream reads capped at 32 KB.
  5. Final MP3 persistence (`persist song audio`) runs in a dedicated workflow step **after** swap resolution completes. Each source URL must be a plain `https:` URL (no credentials) before any fetch, and the body is read with `readBoundedStream` (`src/utils/bounded-read.ts`), which cancels the upstream as soon as it passes 25 MiB.
  6. **Reconciling an ambiguous attempt:** when a retry carries a claimed or ambiguous AISG attempt with no task ID, `reconcile aisonggenerator attempt` replays `POST /api/tasks` with the **same** `Idempotency-Key` and the same payload. aisonggenerator-worker answers from its stored receipt (accepted/completed → the original `task_id`, no new upstream submit). An `in_flight`/`ambiguous` receipt returns `504 aisg_dispatch_unknown`, and a payload mismatch returns `409`; both end in `NonRetryableError` ("requires reconciliation before authorizing another charge") instead of a second paid submit.
- For **ElevenLabs Music v2.5**:
  1. Resolves `env.AI.gateway(env.CF_AI_GATEWAY_ID).getUrl('elevenlabs')` and posts to `/v1/music?output_format=mp3_44100_128` with `model_id: "music_v2_5"`, BYOK headers (`cf-aig-authorization`, `cf-aig-byok-alias`, `cf-aig-no-wholesale: true`, `cf-aig-skip-cache: true`, `cf-aig-collect-log-payload: false`), and no `xi-api-key`.
  2. Instrumentals send `{ model_id, prompt, force_instrumental: true }`. `music_length_ms` is omitted unless `ELEVENLABS_MUSIC_LENGTH_MS` is set, so `music_v2_5` picks the length itself (3–600 s; see `docs/music-provider-economics.md` for the cost ceiling). Vocals send `{ model_id, composition_plan: { chunks: [...] } }` with no top-level `prompt`, `force_instrumental`, or `music_length_ms`; per-chunk `duration_ms` is planned in a dedicated pre-submit step via `@cf/zai-org/glm-5.3` anchored on live-measured SMOL empirical durations (falling back cleanly to the empirical baseline on any AI error), with automatic chunk splitting for ElevenLabs' `<= 30` lines/chunk and `<= 200` chars/line limits.
  3. Streams known-length responses straight into `SMOL_BUCKET` via `FixedLengthStream` (and bounds unknown-length streams at 25 MiB), rejecting truncated/overflow/empty responses before committing.
  4. Always populates `songs[0].audio = "https://api.smol.xyz/song/el-<smolId>.mp3"` and `status: 4` so existing clients never stall.
- **PixelLab** success bodies are read through the same bounded reader (`PIXELLAB_MAX_RESPONSE_BYTES`, 10 MiB). Errors use the fixed message `Pixellab request failed (<status>)` with no upstream body: 4xx (except 408/429) is a `NonRetryableError`, everything else is retryable.

### Completion & Retry Guarantees
- `POST /retry/:id` deduplicates concurrent retries via `SmolDurableObject.claimRetrySuccessor`, protects already-healthy/minted published rows, preserves original creator & provider by default, and seeds the new DO before `WORKFLOW.create(...)`. The plain empty-body retry needs no auth (legacy `smol.xyz` callers send none); an `override_provider` / `provider` body requires the creator's session (`401` without one, `403` for anyone else) because it can buy a paid call on the creator's quota.
- Completion runs as **four** checkpointed steps, in this order:
  1. `publish smol` — durable detail KV first (preserving any newer search revision on replay), then one D1 batch: `Smols` row + conflict-safe `INSERT OR IGNORE INTO Playlists`.
  2. `enqueue search indexing` — only for search-public smols; throws (and retries) if the KV record is not visible yet, so it never silently skips.
  3. `cleanup retry state` — only when this run is a retry. Retires the source's KV, PNG and DO **only** if the source has no D1 row and its workflow is `errored`/`terminated`/missing. Fails closed on D1 or Workflow lookup errors and never touches shared/active MP3s.
  4. `finalize workflow` — one batched cache-tag purge (`user:<address>:created`, plus `public-smols`, the artist tag and `playlist:<title>` when relevant), then the DO flush alarm **last**.

## 2. Generation Quota (`src/utils/quota.ts`, `src/quota-do.ts`)

- Per-user, per-provider daily quotas live in the SQLite Durable Object `UserQuotaDO` (binding `USER_QUOTA`, migration tag `v3`). Days are UTC (`getUtcDayKey`).
- Limits (`wrangler.jsonc` vars): `DAILY_LIMIT_CLASSIC` (10), `DAILY_LIMIT_ELEVENLABS` (3), `BURST_LIMIT_PER_MINUTE` (5), and global per-day ceilings `GLOBAL_DAILY_LIMIT_CLASSIC` (500) and `GLOBAL_DAILY_LIMIT_ELEVENLABS` (20).
- Lifecycle: `POST /` and any retry that will make a fresh paid call **reserve** a slot on the creator's quota before `WORKFLOW.create` (a retry that resumes a carried attempt reuses its reservation). The workflow **refunds** it on a pre-music failure (`refund quota on pre-music failure`), **moves** it from classic to ElevenLabs on an automatic fallback (`transitionFallbackQuota`, which can itself hit the ElevenLabs cap), marks it **ambiguous** when a paid outcome is unknown, and **commits** it once songs are saved.
- Over-limit requests get `429` with a `quota_exceeded` payload (`provider`, `limit`, `used`, `resetAt`, `scope: user|global`, `window: day|minute`).
- `GET /quota` (authenticated, `Cache-Control: no-store`) returns the caller's snapshot for both providers.

## 3. D1 Schema Migrations (`migrations/`)

| File | What it does |
|---|---|
| `0001_smol_music_providers.sql` | Rebuilds `Smols` via `Smols_v3` copying all 12 columns **by name**, normalizes `NULLIF(Song_2, '')`, adds nullable `Requested_Provider` / `Actual_Provider` with `CHECK` constraints (no backfill), and recreates the 5 explicit indexes. |
| `0002_mixtapes_lifecycle.sql` | Additive mixtape lifecycle columns (soft delete, merge target, derived visibility). Applied before the worker that reads them. |
| `0003_storage_query_optimization.sql` | Adds `Smols.Tags` and partial/covering indexes for minted listings and playlists. |
| `0004_users_address_unique.sql` | Unique index on `Users.Address`. |

- Workflow writes stay compatible with pre- and post-`0001` schemas: post-migration writes store SQL `NULL` in `Song_2` and populate provider columns; pre-migration environments fall back to `Song_2 = ''` and the 7-column insert, while `GET /:id` normalizes `Song_2 || null`.
- The live `d1_migrations` ledger is now seeded (`wrangler d1 migrations list smol-d1 --remote` reports nothing to apply). The "never run `migrations apply`" warnings in the `0003`/`0004` headers predate that and are stale (audit 47a D7).

## 4. Media Streaming & Caching Contract (`src/api/media.ts`)

- Implements RFC 9110 §14 single byte-range handling (`parseByteRange` in `src/utils.ts`): bounded, open-ended, suffix (`bytes=-N`), EOF clamping, `416` with `Content-Range: bytes */N`, `If-None-Match` (`304`), `If-Range` validator fallback, and full `200` fallback on malformed/unsupported/multipart ranges.
- `HEAD /song/:id.mp3` returns `Content-Length` and `ETag` from cache or `SMOL_BUCKET.head()` without reading R2 bodies or incrementing `Plays`.
- Edge caching stores only complete origin-neutral `200` responses under canonical full-GET keys; partial `206` and error responses are never cached under the full key, and CORS headers (`Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length, ETag`) are applied per-origin after cache lookup.

## 5. Play Counting (`PLAY_COUNT_MODE`, `src/api/plays.ts`)

- **`server` (current live mode):** `GET /song/:id.mp3` increments `Plays` on real play starts, including warm cache hits. It skips `HEAD`, `bytes=0-1` / `bytes=0-0` probes, mid-file seeks, suffix ranges, `304`, `416`, and empty objects. `POST /plays/:musicId` answers `202 { counted: false, mode: "server" }` with no D1 or DO calls, so new frontends can send beacons before the flip without double counting.
- **`beacon`:** media GETs stop counting. `POST /plays/:musicId` (optional auth, optional `playId`, body ≤ 1 KiB) is admitted by one of 64 `play-gate:NN` shards of `USER_QUOTA`, which serializes a per-caller 30 s song cooldown (`PLAY_BEACON_COOLDOWN_SECONDS`), a 300 s `playId` dedupe, and a per-minute rate limit (`PLAY_BEACON_RATE_LIMIT_PER_MINUTE`, default 30) **before** the single `UPDATE Smols SET Plays = Plays + 1`. Duplicates return `200 { deduped: true }`; over-limit callers get `429` with `Retry-After`.
- Caller identity is the JWT `sub`, else the edge-set `cf-connecting-ip`; client-supplied `x-forwarded-for` is ignored so callers cannot mint fresh dedupe identities.
- The flip to `beacon` is a cutover step; follow `smol/orchestration/CUTOVER_CHECKLIST.md` §3.

## 6. Mixtapes (`src/api/mixtapes.ts`, `src/ai/mixtape-dedupe.ts`)

- Public: `GET /mixtapes` (non-deleted, Tier-1-public only, re-derived from live `Smols.Public` on each cache miss) and `GET /mixtapes/:id`.
- Owner (authenticated, never shared-cached): `GET /mixtapes/mine` (all of the caller's non-deleted mixtapes, including hidden, with coaching), `POST /mixtapes/check-uniqueness` (Tier 1 preview only: no inference, writes or purges), `POST /mixtapes`, `PUT`/`PATCH /mixtapes/:id`, `DELETE /mixtapes/:id` (soft delete; songs and tokens untouched), `POST /mixtapes/:id/restore` (undo a soft delete; merged sources cannot be restored), and `POST /mixtapes/:id/merge` (owner of both; appends missing songs to the target, then soft-deletes the source as `merged`).
- Visibility is derived: a deterministic Tier 1 rubric, plus a write-time-only Tier 2 tie-breaker on `@cf/cloudflare/clef-flash` for the top borderline same-owner pair. Tier 2 is gated by `MIXTAPE_DEDUPE_AI_ENABLED`, has a 1.5 s timeout, and fails open to Tier 1.

## 7. Chain Reads & Mint Status (`src/api/chain.ts`, `src/api/mint.ts`, `src/utils/chain.ts`)

- `POST /chain/snapshot` (authenticated, `no-store`) returns mainnet ledger entries for the requested tracks (SAC instance, pool instance, reserves, optional holder balance) and optional Comet quotes. Reads go through the `KALE_WORKER` binding's chain-read RPCs (`readChainSnapshot`), and unavailable balances come back as `{ state: "unknown" }` rather than failing the call.
- `POST /mint/status` (authenticated, `no-store`) takes a `target`, track `ids` and/or `workflowIds` and returns per-batch progress (`phase`, including `uncertain` when a workflow lookup is indeterminate) plus each track's `Mint_Token` / `Mint_Amm`.

## 8. Transaction Mint Workflow (`src/tx-workflow.ts`)

- Durable steps: `sign transaction` → `submit transaction` (`retries: 0`, checkpoints the relay `hash`) → `confirm transaction` (bounded read-only Stellar RPC polling; terminal `FAILED` throws `NonRetryableError`) → idempotent `persist mint metadata` / `persist batch mint metadata` (batched via `SMOL_D1.batch()`, verifying existing `(Mint_Token, Mint_Amm)` on replay). When the request tracks status, `record mint submit intent` / `record submitted mint` / `record confirmed mint` / `record persisted mint` checkpoint each phase in D1 for `POST /mint/status`.
- A relay result that carries an `error` **and** a valid 64-hex hash (e.g. `WAIT_TIMEOUT`, `ONCHAIN_FAILED`) is checkpointed and confirmed on-chain instead of being dropped, so a mint that lands after a relay timeout is still recorded. An error with no valid hash ends in `NonRetryableError`.
- `POST /mint/:id` and `POST /mint` derive deterministic workflow IDs to deduplicate repeated identical requests while preserving existing `202` response formats.
