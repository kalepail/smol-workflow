# Workflows, Providers, Quota, Media & Chain

## 1. Music Provider Routing & Replay Safety

### Paid-Submit Replay Rules
- Paid upstream submissions (`submit aisonggenerator task`, `reconcile aisonggenerator attempt`, `generate song (elevenlabs)`, `generate song (elevenlabs fallback)`, and `TxWorkflow` `submit transaction`) run with **`retries: { limit: 0 }`**.
- Before dispatching a paid generation POST, `SmolDurableObject.claimPaidAttempt(provider)` (called directly over RPC) atomically records an in-flight claim in DO storage. Claimed, submitted and ambiguous attempts carry across the whole retry chain for both providers.
- For **AISG v6**:
  1. `POST /api/tasks` (with an `Idempotency-Key` equal to the attempt ID) returns `{ task_id, workspace_id? }` right after acceptance. There is no fallback to the legacy `POST /api/songs`; a `404` is classified like any other submit error.
  2. Read-only `GET /api/tasks/:id` discovery runs in bounded steps until 2 distinct `music_ids` arrive.
  3. Bounded `poll songs #N` steps + `step.sleep` replace polling-by-throwing exponential backoff.
  4. 2-track swap fingerprinting runs **only** for 2-track AISG jobs with stream reads capped at 32 KB.
  5. Final MP3 persistence (`persist song audio`) runs in a dedicated workflow step **after** swap resolution completes. Each source URL must be a plain `https:` URL (no credentials) before any fetch, and the body is read with `readBoundedStream` (`src/utils/bounded-read.ts`), which cancels the upstream as soon as it passes 25 MiB.
  6. **Reconciling an ambiguous attempt:** when a retry carries a claimed or ambiguous AISG attempt with no task ID, `reconcile aisonggenerator attempt` replays `POST /api/tasks` with the **same** `Idempotency-Key` and the same payload. aisonggenerator-worker answers from its stored receipt (accepted/completed → the original `task_id`, no new upstream submit). An `in_flight`/`ambiguous` receipt returns `504 aisg_dispatch_unknown`, and a payload mismatch returns `409`; both end in `NonRetryableError` ("requires reconciliation before authorizing another charge") instead of a second paid submit.
- **Prompt → Song Intent → Lyrics (`src/ai/song-intent.ts`, `src/workflow.ts`):**
  - Step 4 (`generate lyrics`) extracts structured intent via `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (`json_object` + local validator, 6 s timeout, off AI Gateway, deterministic fallback) and checkpoints `intent_v: 1`, `vocalGender`, `negativeTags`, concrete English `style[]` (≤ 8 tags), and verbatim user lyrics (when a validated ≥ 8-line / ≥ 4-sung-line block is present) on `lyrics`.
  - AISG submit and replay both derive their payload from that checkpointed `lyrics` object, keeping idempotency hashes stable across retries and legacy in-flight attempts. Cover captions are excluded from lyric prompts and new-song instrumental prompts.
- For **ElevenLabs Music v2.5**:
  1. Resolves `env.AI.gateway(env.CF_AI_GATEWAY_ID).getUrl('elevenlabs')` (`smol` gateway, ElevenLabs-only, `60 req / 86400 s` sliding, dedicated 100k-credit-capped `SMOL` BYOK key) and posts to `/v1/music?output_format=mp3_44100_128` with `model_id: "music_v2_5"`, BYOK headers (`cf-aig-authorization`, `cf-aig-byok-alias`, `cf-aig-no-wholesale: true`, `cf-aig-skip-cache: true`, `cf-aig-collect-log-payload: false`), a `cf-aig-metadata` JSON header (`{ source: "explicit" | "fallback", smol_id }`) for gateway log attribution, and no `xi-api-key`.
  2. Instrumentals send `{ model_id, prompt, force_instrumental: true }`. `music_length_ms` is omitted unless `ELEVENLABS_MUSIC_LENGTH_MS` is set, so `music_v2_5` picks the length itself (3–600 s; see `docs/music-provider-economics.md` for the cost ceiling). Vocals send `{ model_id, composition_plan: { chunks: [...] } }` with no top-level `prompt`, `force_instrumental`, or `music_length_ms`: chunk 0 leads with the extracted vocalist/genre styles, every chunk carries `negative_styles` (including opposite-gender exclusion when single-gender and `"vocals"` on heading-only chunks), `(No lyrics)` / prose cues / chord charts are stripped, and per-chunk `duration_ms` is planned in a dedicated pre-submit step via `@cf/zai-org/glm-5.3` anchored on live-measured SMOL empirical durations (falling back cleanly to the empirical baseline on any AI error), with automatic chunk splitting for ElevenLabs' `<= 30` lines/chunk and `<= 200` chars/line limits.
  3. Streams known-length responses straight into `SMOL_BUCKET` via `FixedLengthStream` (and bounds unknown-length streams at 25 MiB), rejecting truncated/overflow/empty responses before committing.
  4. Always populates `songs[0].audio = "https://api.smol.xyz/song/el-<smolId>.mp3"` and `status: 4` so existing clients never stall.
- **Cover-art distillation & PixelLab (`src/ai/cover-prompt.ts`, `src/ai/pixellab.ts`, `src/workflow.ts`):**
  - Inside Step 2 (`generate image`), unless `COVER_PROMPT_MODE === "raw"` (instant byte-identical rollback), `resolveCoverPrompt` distills the raw song prompt into a <= 280-char English visual brief via `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (`json_object`, 8 s timeout, 1 attempt, off AI Gateway, never throws). Strict schema + lexical leak guards strip unrequested musical instruments, performers, stages, audio gear, genre terms, and portrait cues; an explicit visual-instrument carve-out requires both model evidence and an affirmative non-negated syntactic depiction match outside cue/style blocks. Any model error, timeout, refusal, or unrepairable leak falls back deterministically: a short clean visual subject from the prompt (e.g. "A volcano erupting") gets lighting and framing, anything else gets a neutral motif scene (`NEUTRAL_MOTIFS`) keyed by `smolId`. There are no keyword-matched scene templates.
  - PixelLab (`POST /v1/generate-image-pixflux`, 64×64) omits the deprecated `negative_description` and sprite-biasing `view`/`direction` fields, passes a deterministic 31-bit `seed` derived from `smolId`, normalizes any `data:image/png;base64,` prefix or unpadded/URL-safe base64 into canonical raw base64 verified against the 8-byte PNG signature, and bounds both HTTP response size (`PIXELLAB_MAX_RESPONSE_BYTES`, 10 MiB) and extracted base64 length (`PIXELLAB_MAX_IMAGE_BASE64_CHARS`, 512 KiB). Errors use the fixed message `Pixellab request failed (<status>)` with no upstream body: 4xx (except 408/429) and unexpected HTTP `202` are `NonRetryableError`, everything else is retryable. Step 2 checkpoints `{ image_base64, cover_prompt, cover_meta }` (with backward-compatible reading of legacy string checkpoints) so replay preserves cover provenance and passes the distilled brief to Step 3 (`describe image`), while Step 5 (`checkNSFW`) always moderates the original raw prompt alongside the actual cover and lyrics.

### Completion & Retry Guarantees
- `POST /retry/:id` deduplicates concurrent retries via `SmolDurableObject.claimRetrySuccessor`, protects already-healthy/minted published rows, preserves original creator & provider by default, and seeds the new DO before `WORKFLOW.create(...)`. The plain empty-body retry needs no auth (legacy `smol.xyz` callers send none); an `override_provider` / `provider` body requires the creator's session (`401` without one, `403` for anyone else) because it can buy a paid call on the creator's quota.
- Completion runs as **four** checkpointed steps, in this order:
  1. `publish smol` — durable detail KV first (preserving any newer search revision on replay), then one D1 batch: `Smols` row + conflict-safe `INSERT OR IGNORE INTO Playlists`.
  2. `enqueue search indexing` — only for search-public smols; throws (and retries) if the KV record is not visible yet, so it never silently skips.
  3. `cleanup retry state` — only when this run is a retry. Retires the source's KV, PNG and DO **only** if the source has no D1 row and its workflow is `errored`/`terminated`/missing. Fails closed on D1 or Workflow lookup errors and never touches shared/active MP3s.
  4. `finalize workflow` — one batched cache-tag purge when anything public changed (`public-smols`, the artist tag, `playlist:<title>`), then the DO flush alarm **last**.
- The published KV detail stores `image: true`, not the cover bytes; the PNG lives in R2 as `<id>.png`. A retry restored from KV (its DO already flushed) reads the predecessor's `<id>.png` from R2. If that PNG is missing or too large for a step result, the cover is regenerated and its description and NSFW verdict are recomputed.

## 2. Generation Quota (`src/utils/quota.ts`, `src/quota-do.ts`)

- Per-user, per-provider daily quotas live in the SQLite Durable Object `UserQuotaDO` (binding `USER_QUOTA`, migration tag `v3`). Days are UTC (`getUtcDayKey`).
- `wrangler.jsonc` sets default per-user limits with `DAILY_LIMIT_CLASSIC` (10), `DAILY_LIMIT_ELEVENLABS` (5), and `BURST_LIMIT_PER_MINUTE` (5). It sets global per-day ceilings with `GLOBAL_DAILY_LIMIT_CLASSIC` (100) and `GLOBAL_DAILY_LIMIT_ELEVENLABS` (50).
- The optional Worker secret `USER_QUOTA_OVERRIDES` maps Stellar addresses to JSON objects with `classic`, `elevenlabs`, or `burstPerMinute` fields. Each field accepts a non-negative integer. Missing or invalid values use the configured defaults. A burst override of `0` disables the burst guard for that address. Reservations still check the global daily ceilings.
- Reserve: the user DO admits the request (daily + burst limits, fail-closed), then the `global:<day>` DO is checked. An explicit global denial releases only this caller's claim (by claim ID, retrying once on a fresh stub) and returns `429`; a global RPC error fails open. Concurrent retries of one successor share a reservation (`claim_count`), so a losing caller never refunds the winner's slot. A reservation left unadmitted by a crash rolls forward to the next UTC day.
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

- Workflow writes assume `0001` and `0003`: 1-track Smols store SQL `NULL` in `Song_2`, and a replayed publish fills `Tags` only where it is still `NULL`. `GET /:id` still normalizes legacy `''` to `null`.
- The live `d1_migrations` ledger is seeded, so `wrangler d1 migrations apply smol-d1 --remote` is the normal path.

## 4. Media Streaming & Caching Contract (`src/api/media.ts`)

- Implements RFC 9110 §14 single byte-range handling (`parseByteRange` in `src/utils.ts`): bounded, open-ended, suffix (`bytes=-N`), EOF clamping, `416` with `Content-Range: bytes */N`, `If-None-Match` (`304`), `If-Range` validator fallback, and full `200` fallback on malformed/unsupported/multipart ranges.
- `HEAD /song/:id.mp3` returns `Content-Length` and `ETag` from cache or `SMOL_BUCKET.head()` without reading R2 bodies or incrementing `Plays`.
- Edge caching stores only complete origin-neutral `200` responses under canonical full-GET keys; partial `206` and error responses are never cached under the full key, and CORS headers (`Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length, ETag`) are applied per-origin after cache lookup.
- `Cache-Tag` (`smol:<id>:media`, `song:<id>:media`, list tags) is set on the copies stored with `cache.put` so tag purges (Free plan: 5 requests/min, 100 tags/request) evict them; a global middleware strips it from every client response, including `304`s. Per-user `user:*` tags are gone: liked, created and signed-in detail responses are private and never shared-cached.

## 5. Play Counting (`PLAY_COUNT_MODE`, `src/api/plays.ts`)

- **`beacon` (current live mode):** media GETs stop counting. `POST /plays/:musicId` (optional auth, optional `playId`, body ≤ 1 KiB) is admitted by one of 64 `play-gate:NN` shards of `USER_QUOTA`, which serializes a per-caller 30 s song cooldown (`PLAY_BEACON_COOLDOWN_SECONDS`), a 300 s `playId` dedupe, and a per-minute rate limit (`PLAY_BEACON_RATE_LIMIT_PER_MINUTE`, default 30) **before** the single `UPDATE Smols SET Plays = Plays + 1`. Duplicates return `200 { deduped: true }`; over-limit callers get `429` with `Retry-After`.
- **`server` (legacy rollback mode):** `GET /song/:id.mp3` increments `Plays` on real play starts, including warm cache hits. It skips `HEAD`, `bytes=0-1` / `bytes=0-0` probes, mid-file seeks, suffix ranges, `304`, `416`, and empty objects. `POST /plays/:musicId` answers `202 { counted: false, mode: "server" }` with no D1 or DO calls.
- Caller identity is the JWT `sub`, else the edge-set `cf-connecting-ip`; client-supplied `x-forwarded-for` is ignored so callers cannot mint fresh dedupe identities.

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
- `TX_WORKFLOW` retains finished instances for 30 days. The hourly cron deletes `persisted`/`failed` `MintBatchStatus` rows once their instance is definitively `instance.not_found` (oldest first, 25 per run); unresolved phases and mint prefix locks are never pruned.
