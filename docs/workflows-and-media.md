# Workflows, Providers, Migration & Media Streaming

## 1. Music Provider Routing & Replay Safety

### Paid-Submit Replay Rules
- Paid upstream submissions (`submit aisonggenerator task`, `generate song (elevenlabs)`, `generate song (elevenlabs fallback)`, and `TxWorkflow` `submit transaction`) run with **`retries: { limit: 0 }`**.
- Before dispatching a paid generation POST, `SmolDurableObject.claimPaidAttempt(provider)` atomically records an in-flight claim in DO storage.
- For **AISG v6**:
  1. `POST /api/tasks` returns `{ task_id, workspace_id? }` immediately after acceptance (falling back to `POST /api/songs` only on HTTP `404` during staged rollout).
  2. Read-only `GET /api/tasks/:id` discovery runs in bounded steps until 2 distinct `music_ids` arrive.
  3. Bounded `poll songs #N` steps + `step.sleep` replace polling-by-throwing exponential backoff.
  4. 2-track swap fingerprinting runs **only** for 2-track AISG jobs with stream reads capped at 32 KB.
  5. Final MP3 persistence (`persist song audio`) runs in a dedicated workflow step **after** swap resolution completes.
- For **ElevenLabs Music v2.5**:
  1. Resolves `env.AI.gateway(env.CF_AI_GATEWAY_ID).getUrl('elevenlabs')` and posts to `/v1/music?output_format=mp3_44100_128` with `model_id: "music_v2_5"`, BYOK headers (`cf-aig-authorization`, `cf-aig-byok-alias`, `cf-aig-no-wholesale: true`, `cf-aig-skip-cache: true`, `cf-aig-collect-log-payload: false`), and no `xi-api-key`.
  2. Instrumentals send `{ model_id, prompt, force_instrumental: true }` (omitting `music_length_ms` unless `ELEVENLABS_MUSIC_LENGTH_MS` is explicitly configured so `music_v2_5` chooses length naturally). Vocals send `{ model_id, composition_plan: { chunks: [...] } }` with no top-level `prompt`, `force_instrumental`, or `music_length_ms`; per-chunk `duration_ms` is planned in a dedicated pre-submit step via `@cf/zai-org/glm-5.3` anchored on live-measured SMOL empirical durations (falling back cleanly to the empirical baseline on any AI error), with automatic chunk splitting for ElevenLabs' `<= 30` lines/chunk and `<= 200` chars/line limits.
  3. Streams known-length responses straight into `SMOL_BUCKET` via `FixedLengthStream` (and bounds unknown-length streams at 25 MiB), rejecting truncated/overflow/empty responses before committing.
  4. Always populates `songs[0].audio = "https://api.smol.xyz/song/el-<smolId>.mp3"` and `status: 4` so existing clients never stall.

### Completion & Retry Guarantees
- `POST /retry/:id` deduplicates concurrent retries via `SmolDurableObject.claimRetrySuccessor`, protects already-healthy/minted published rows, preserves original creator & provider by default (with optional `override_provider`), and seeds the new DO before `WORKFLOW.create(...)`.
- `complete workflow` executes in safe replay order: durable KV → batched D1 `Smols` + `INSERT OR IGNORE INTO Playlists` → search queue → unminted retry cleanup (never deleting active or shared MP3s) → single batched cache purge → DO flush alarms **last**.

## 2. D1 Schema Migration (`migrations/0001_smol_music_providers.sql`)

- Rebuilds `Smols` via `Smols_v3` copying all 12 columns **by name** (live column order around `Instrumental` differs from `schema.sql`), normalizes `NULLIF(Song_2, '')`, adds nullable `Requested_Provider` and `Actual_Provider` columns with `CHECK` constraints (no historical backfill), and recreates all 5 explicit indexes.
- Workflow writes are compatible with **both** pre- and post-migration schemas: post-migration writes store SQL `NULL` in `Song_2` and populate provider columns; pre-migration environments automatically fall back to `Song_2 = ''` and the 7-column insert, while `GET /:id` normalizes `Song_2 || null`.

## 3. Media Streaming & Caching Contract (`src/api/media.ts`)

- Implements RFC 9110 §14 single byte-range handling (`parseByteRange` in `src/utils.ts`): bounded, open-ended, suffix (`bytes=-N`), EOF clamping, `416` with `Content-Range: bytes */N`, `If-None-Match` (`304`), `If-Range` validator fallback, and full `200` fallback on malformed/unsupported/multipart ranges.
- `HEAD /song/:id.mp3` returns `Content-Length` and `ETag` from cache or `SMOL_BUCKET.head()` without reading R2 bodies or incrementing `Plays`.
- Play counting excludes `HEAD`, `bytes=0-1` / `bytes=0-0` probes, mid-file seeks, suffix ranges, `304`, `416`, and empty objects, while still counting real play starts on warm cache hits.
- Edge caching stores only complete origin-neutral `200` responses under canonical full-GET keys; partial `206` and error responses are never cached under the full key, and CORS headers (`Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length, ETag`) are applied per-origin after cache lookup.

## 4. Transaction Mint Workflow (`src/tx-workflow.ts`)

- Splits minting into four durable steps: `sign transaction` → `submit transaction` (`retries: 0`, checkpoints relay `hash`) → `confirm transaction` (bounded read-only Stellar RPC polling; terminal `FAILED` throws `NonRetryableError`) → idempotent `persist mint metadata` / `persist batch mint metadata` (batched via `SMOL_D1.batch()`, verifying existing `(Mint_Token, Mint_Amm)` on replay).
- `POST /mint/:id` and `POST /mint` derive deterministic workflow IDs to deduplicate repeated identical requests while preserving existing `202` response formats.
