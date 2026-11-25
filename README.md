# Smol Workflow

Backend API and Cloudflare Workflows orchestration engine for [SMOL](https://smol.xyz) (`api.smol.xyz`). Transforms text prompts into complete musical compositions with AI-generated pixel art, descriptions, lyrics, audio tracks, semantic search indexing, and Stellar token minting.

## Architecture

```
smol-fe (smol.xyz)                  ──┐
smol-native-api (SONG_GENERATOR)    ──┼──► smol-workflow (Hono + Workflows + DO)
                                           ├─► Pixellab (64x64 pixel art)
                                           ├─► Cloudflare Workers AI (moondream3.1, deepseek-v4.1-flash, glm-5.3, clef, bge-m3)
                                           ├─► aisonggenerator-worker (HTTP Service Binding: lyrics + AISG v6 2-track music)
                                           ├─► Cloudflare AI Gateway BYOK (`smol`, ElevenLabs-only, 60 req/day) -> ElevenLabs Music v2.5
                                           ├─► kale-worker (RPC Service Binding: Stellar relay submitTransaction + mainnet chain reads)
                                           ├─► UserQuotaDO (generation quota + play-beacon gate shards)
                                           └─► D1 (smol-d1) · KV (SMOL_KV) · R2 (smol-r2) · Vectorize · Queues
```

### Music Providers & Track Shapes
- **AISG v6 (`aisonggenerator`, default)**: 2 tracks per generation. Uses split `POST /api/tasks` + read-only `GET /api/tasks/:id` discovery, bounded deterministic polling, 2-track audio swap fingerprinting, and explicit post-swap R2 persistence.
- **ElevenLabs Music v2.5 (`elevenlabs`)**: 1 track per generation (`model_id: "music_v2_5"`). Routed through Cloudflare AI Gateway BYOK (`.../elevenlabs/v1/music`, `cf-aig-no-wholesale: true`, no `xi-api-key` in Worker), streaming MP3 directly into `SMOL_BUCKET` (`el-<smolId>.mp3`) with canonical `https://api.smol.xyz/song/el-<smolId>.mp3` audio URL. Skips AISG polling and swap detection completely.
- **Automatic Fallback (`aisonggenerator` → `elevenlabs`)**: Triggered once on confirmed AISG submit rejection (e.g., outage, credits exhausted, auth failure) or terminal non-policy poll failure. Never triggered on content-policy rejection, invalid prompt, or ambiguous submission outcomes. Preserves original creator visibility and records `requested_provider`, `actual_provider`, `fallback_from`, and `fallback_reason`.

## Project Structure

```
src/
├── index.ts                 # Hono entrypoint, CORS (exposing Range/ETag headers), Queue & Cron handlers
├── passkey.ts               # WebAuthn registration/auth verification (approved smol.xyz RP IDs)
├── workflow.ts              # Main Smol generation Workflow (replay-safe, 1- & 2-track)
├── tx-workflow.ts           # Stellar minting Workflow (sign -> submit -> confirm -> persist, D1 phase records)
├── do.ts                    # Durable Objects: SmolDurableObject (v1) & SmolState (v2, retained)
├── quota-do.ts              # UserQuotaDO (SQLite): daily/burst generation quota + play-beacon admission
├── middleware/auth.ts       # parseAuth / optionalAuth / requireAdmin
├── utils.ts                 # RFC 9110 byte-range parser
├── ai/
│   ├── pixellab.ts          # Pixel art generation (pixflux, bounded body, fixed error copy)
│   ├── cf.ts                # Image description (@cf/moondream/moondream3.1-9B-A2B)
│   ├── song-intent.ts       # Prompt intent extraction (@cf/deepseek-ai/deepseek-v4.1-flash-1017 + det fallback)
│   ├── nsfw.ts              # Fail-closed NSFW classification (@cf/cloudflare/clef 27B + cover PNG)
│   ├── aisonggenerator.ts   # AISG v6 HTTP Service Binding client (lyrics, split tasks, songs)
│   ├── elevenlabs.ts        # ElevenLabs Music v2.5 via Cloudflare AI Gateway BYOK -> R2
│   └── mixtape-dedupe.ts    # Tier 2 clef-flash mixtape uniqueness tie-breaker (fail-open)
├── api/
│   ├── auth.ts              # POST /login, POST /logout
│   ├── smols.ts             # CRUD, provider create/retry, guarded 1-/2-track swap, bulk delete
│   ├── media.ts             # RFC 9110 Range/206, HEAD, ETag/If-Range, edge cache, play counting
│   ├── mint.ts              # Deduped single & batch Stellar mint submission + mint status
│   ├── chain.ts             # Authenticated mainnet chain snapshot (SAC/pool/balance/quotes)
│   ├── quota.ts             # Authenticated quota snapshot
│   ├── plays.ts             # Play beacon (no-op in `server` mode, counted in `beacon` mode)
│   ├── likes.ts             # Likes endpoints
│   ├── mixtapes.ts          # Mixtape lifecycle: public reads + owner CRUD, restore, merge
│   ├── playlists.ts         # Playlist reads
│   ├── artists.ts           # Artist public Smols
│   └── search.ts            # Semantic search, similar tracks, admin backfill/reconcile
└── utils/
    ├── songs.ts             # Provider strategy, retry reuse, fallback, bounded polling, R2 commit
    ├── bounded-read.ts      # Size-capped upstream body reader (cancels past the cap)
    ├── quota.ts             # Quota reserve / fallback transition / commit / refund helpers
    ├── chain.ts             # Mainnet ledger-entry reads + Comet quotes via KALE_WORKER
    ├── chain-target.ts      # Mint status target resolution
    ├── mixtape-visibility.ts# Tier 1 derived mixtape visibility rubric
    ├── audio-fingerprint.ts # Stream-capped 32KB audio swap fingerprinting (2-track AISG only)
    ├── search.ts            # Vectorize v2 indexing, queue consumer, DLQ recovery, cron backfill
    ├── cache.ts             # Cloudflare cache tag invalidation
    └── pagination.ts        # Cursor-based pagination
migrations/
├── 0001_smol_music_providers.sql        # Nullable Song_2 + Requested_Provider / Actual_Provider
├── 0002_mixtapes_lifecycle.sql          # Mixtape soft delete, merge, derived visibility
├── 0003_storage_query_optimization.sql  # Smols.Tags + minted/playlist indexes
└── 0004_users_address_unique.sql        # Unique Users.Address
```

## API Endpoints

### Auth
- `POST /login` — Passkey registration (`create`) or authentication (`connect`) across `smol.xyz` and `noot.smol.xyz` (plus local dev hosts when `ALLOW_LOCALHOST_ORIGINS=true`)
- `POST /logout` — Clear `smol_token` cookie

### Smols
- `GET /` — List public Smols (cursor-paginated)
- `GET /created` — List authenticated user's Smols
- `GET /liked` — List authenticated user's liked Smols
- `GET /:id` — Fetch completed or in-progress Smol (`d1.Song_2` normalized to `null` for 1-track Smols; `kv_do` exposes `payload.provider`, `actual_provider`, `generation_meta`)
- `POST /` — Create Smol (`{ prompt, public?, instrumental?, playlist?, provider?: 'aisonggenerator' | 'elevenlabs' }`) → `200 text/plain` instance ID
- `POST /retry/:id` — Retry failed Smol (caller-independent, deduplicated, preserves original creator & provider) → `200 text/plain` instance ID. An optional `{ override_provider }` / `{ provider }` body requires the creator's session (`401` / `403` otherwise)
- `PUT /:id` — Toggle public/private visibility (blocked when NSFW is unsafe or unclassified)
- `PUT /:smol_id/:song_id` — Swap `Song_1`/`Song_2` on 2-track Smols (guarded against `NULL`/empty `Song_2` on 1-track Smols)
- `DELETE /:id` — Delete owned, unminted Smol (`409` when minted or a mint is unresolved) in one guarded D1 batch with its `Likes`/`Playlists`; best-effort KV/cover/unreferenced-MP3 cleanup, purge caches
- `DELETE /admin/bulk` — Admin bulk delete (gated behind dedicated `ADMIN_SECRET` via `x-admin-secret` or `Authorization: Bearer`; fails closed with 404 when unset; skips minted, minting and by default public rows)

### Media, Likes, Playlists, Mixtapes, Artists, Search, Minting
- `GET` / `HEAD /song/:id.mp3` (MP3 only) — RFC 9110 Range/206, suffix & EOF-clamped ranges, `416` with `Content-Range`, `If-None-Match` (`304`), `If-Range`, edge caching without partial-body poisoning, play counting (in `server` mode) excluding `HEAD` and `bytes=0-1` probes
- `GET` / `HEAD /image/:id.png[?scale=1..32]` (PNG only) — Pixel art serving with nearest-neighbor scaling and per-scale edge caching
- `GET /likes`, `PUT /likes/:id` — User likes
- `GET /playlist/:title` — Public playlist feed
- `GET /mixtapes`, `GET /mixtapes/:id` — Public mixtapes (derived visibility)
- `GET /mixtapes/mine`, `POST /mixtapes/check-uniqueness`, `POST /mixtapes`, `PUT`/`PATCH`/`DELETE /mixtapes/:id`, `POST /mixtapes/:id/restore`, `POST /mixtapes/:id/merge` — Owner mixtape management (soft delete, restore, merge)
- `GET /artists/:address/smols` — Public artist feed
- `GET /search`, `GET /search/:id/similar`, `POST /search/admin/{reindex/:id,backfill,reconcile}`, `GET /search/admin/backfill/status`, `GET /search/admin/dlq`, `POST /search/admin/dlq/replay` — Semantic search, indexing ops and DLQ record replay
- `POST /mint/:id`, `POST /mint` — Deduplicated single & batch Stellar minting (`202`)
- `POST /mint/status` — Authenticated per-batch mint progress and track `Mint_Token` / `Mint_Amm`
- `POST /chain/snapshot` — Authenticated mainnet ledger snapshot (SAC, pool, reserves, balance, optional Comet quote)
- `GET /chain/balance` — Authenticated smart-wallet KALE balance (archive-aware; `503` when unreadable, never a fabricated `0`)

### Quota & Plays
- `GET /quota` — Authenticated per-provider daily quota snapshot (`no-store`)
- `POST /plays/:musicId` — Play beacon. `202 { counted: false }` while `PLAY_COUNT_MODE=server`; deduped, rate-limited `Plays` increment in `beacon` mode

## Bindings, Vars & Secrets

### Secrets (`wrangler secret put`)
- `SECRET` — User JWT signing secret (never valid for admin routes)
- `ADMIN_SECRET` — Dedicated optional admin token (`x-admin-secret` or `Authorization: Bearer`) for `DELETE /admin/bulk` and `/search/admin/*`; admin routes fail closed with `404` when unset
- `SK` — Stellar secret key for mint auth-entry signing
- `PIXELLAB_KEY` — Pixellab API key
- `CF_API_TOKEN` / `CF_ZONE_ID` — Cloudflare zone cache tag purge credentials
- `CF_AIG_TOKEN` — Cloudflare AI Gateway Run token for ElevenLabs BYOK (fail-closed if missing)
- `USER_QUOTA_OVERRIDES` — Optional JSON object keyed by Stellar address. Each entry can set `classic`, `elevenlabs`, or `burstPerMinute` to a non-negative integer.

### Variables (`wrangler.jsonc` `vars`)
- `CF_AI_GATEWAY_ID` — AI Gateway ID configured with ElevenLabs BYOK stored key (`smol`, `byok_only: true`, `60 req / 86400 s` sliding). Dedicated to ElevenLabs only — never route Workers AI through `smol`.
- `CF_AIG_BYOK_ALIAS` — BYOK key alias (default: `default`)
- `ELEVENLABS_MUSIC_LENGTH_MS` — Optional track duration override in ms (`3000..600000`); omitted on instrumentals by default so ElevenLabs chooses length naturally
- `ELEVENLABS_OUTPUT_FORMAT` — Audio format (default: `mp3_44100_128`)
- `ELEVENLABS_FALLBACK_ENABLED` — Enable automatic AISG → ElevenLabs fallback (`true` / `false`)
- `DAILY_LIMIT_CLASSIC` (10), `DAILY_LIMIT_ELEVENLABS` (5), `BURST_LIMIT_PER_MINUTE` (5) — Default per-user generation quotas
- `GLOBAL_DAILY_LIMIT_CLASSIC` (100), `GLOBAL_DAILY_LIMIT_ELEVENLABS` (50) — Global generation ceilings per UTC day. The ElevenLabs cap bounds worst-case spend at ~$75/day while the global quota Durable Object responds; the dedicated ElevenLabs `SMOL` key (`100k` credits/refresh, Auto Top Up off) and `smol` gateway (`60 req/day`) enforce hard outer caps.
- `PLAY_COUNT_MODE` — `beacon` (current live mode: count via `POST /plays/:musicId`) or `server` (count on media GET); optional `PLAY_BEACON_COOLDOWN_SECONDS` (30), `PLAY_BEACON_RATE_LIMIT_PER_MINUTE` (30)
- `MIXTAPE_DEDUPE_AI_ENABLED` — Tier 2 clef-flash mixtape tie-breaker (enabled unless exactly `false`)
- `RPC_URL`, `NETWORK_PASSPHRASE`, `SMOL_CONTRACT_ID` — Stellar mainnet RPC & contract config
- `SEARCH_BACKFILL_CRON_*` — Search backfill cron controls (`ENABLED`, `PAGE_LIMIT`, `STALL_RUNS`, `MAX_WAVES`)

### Bindings
- **Workflows**: `WORKFLOW` (`Workflow`), `TX_WORKFLOW` (`TxWorkflow`)
- **Durable Objects**: `DURABLE_OBJECT` (`SmolDurableObject`, v1), `DO_STATE` (`SmolState`, v2 — retained; live namespace contains stored data), and `USER_QUOTA` (`UserQuotaDO`, SQLite, v3 — quota + `play-gate:NN` beacon shards)
- **Storage**: `SMOL_D1` (`smol-d1`), `SMOL_KV`, `SMOL_BUCKET` (`smol-r2`), `SMOL_SEARCH_INDEX` (`smol-search-index`), `SEARCH_QUEUE` (`smol-search-queue` + `smol-search-queue-dlq`)
- **Services & AI**: `AI`, `AISONGGENERATOR` (`aisonggenerator-worker`), `KALE_WORKER` (`kale-worker`: relay + chain reads)
- **Cron**: `0 * * * *` (search backfill; a no-op once a full pass completes — see `docs/search-index-setup.md`)

## Development & Verification

```sh
# Type check
pnpm run typecheck

# Run full test suite (zero paid calls)
pnpm test

# Dry-run Wrangler bundle verification (no credentials, no local .dev.vars)
EMPTY_ENV=$(mktemp) && CLOUDFLARE_API_TOKEN='' npx wrangler deploy --dry-run --env-file "$EMPTY_ENV"; rm -f "$EMPTY_ENV"

# Exact-bundle workerd smoke (Miniflare; local bindings only, outbound network blocked)
pnpm exec wrangler deploy --dry-run --outdir /tmp/wf1-lean-dry && pnpm exec tsx scripts/wf1-bundle-smoke.ts /tmp/wf1-lean-dry

# Whitespace check
git diff --check

# Local dev
pnpm start
```

See [docs/workflows-and-media.md](./docs/workflows-and-media.md) (providers, quota, migrations, media, plays, mixtapes, chain, minting), [docs/music-provider-economics.md](./docs/music-provider-economics.md), [docs/search-index-setup.md](./docs/search-index-setup.md), and [docs/up-next.md](./docs/up-next.md) for details and backlog. The production cutover runbook is `smol/orchestration/CUTOVER_CHECKLIST.md`.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
