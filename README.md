# Smol Workflow

Backend API and Cloudflare Workflows orchestration engine for [SMOL](https://smol.xyz) (`api.smol.xyz`). Transforms text prompts into complete musical compositions with AI-generated pixel art, descriptions, lyrics, audio tracks, semantic search indexing, and Stellar token minting.

## Architecture

```
smol-fe (smol.xyz / next.smol.xyz)  ──┐
smol-native-api (SONG_GENERATOR)    ──┼──► smol-workflow (Hono + Workflows + DO)
                                           ├─► Pixellab (64x64 pixel art)
                                           ├─► Cloudflare Workers AI (moondream3.1, llama-guard-3-8b, gemma-4, bge-m3)
                                           ├─► aisonggenerator-worker (HTTP Service Binding: lyrics + AISG v6 2-track music)
                                           ├─► Cloudflare AI Gateway BYOK -> ElevenLabs Music v2.5 (1-track direct MP3 to R2)
                                           ├─► kale-worker (RPC Service Binding: Stellar relay submitTransaction)
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
├── tx-workflow.ts           # Stellar minting Workflow (split sign -> submit -> confirm -> persist)
├── do.ts                    # Durable Objects: SmolDurableObject (v1) & SmolState (v2, retained)
├── utils.ts                 # RFC 9110 byte-range parser
├── ai/
│   ├── pixellab.ts          # Pixel art generation (pixflux, timeout + NonRetryableError)
│   ├── cf.ts                # Image description (@cf/moondream/moondream3.1-9B-A2B)
│   ├── nsfw.ts              # Fail-closed NSFW classification (@cf/meta/llama-guard-3-8b)
│   ├── aisonggenerator.ts   # AISG v6 HTTP Service Binding client (lyrics, split tasks, songs)
│   └── elevenlabs.ts        # ElevenLabs Music v2.5 via Cloudflare AI Gateway BYOK -> R2
├── api/
│   ├── auth.ts              # POST /login, POST /logout
│   ├── smols.ts             # CRUD, provider create/retry, guarded 1-/2-track swap, bulk delete
│   ├── media.ts             # RFC 9110 Range/206, HEAD, ETag/If-Range, edge cache, play counting
│   ├── mint.ts              # Deduped single & batch Stellar mint submission
│   ├── likes.ts             # Likes endpoints
│   ├── mixtapes.ts          # Mixtape CRUD
│   ├── playlists.ts         # Playlist reads
│   ├── artists.ts           # Artist public Smols
│   └── search.ts            # Semantic search, similar tracks, admin backfill/reconcile
└── utils/
    ├── songs.ts             # Provider strategy, retry reuse, fallback, bounded polling, R2 commit
    ├── audio-fingerprint.ts # Stream-capped 32KB audio swap fingerprinting (2-track AISG only)
    ├── search.ts            # Vectorize v2 indexing, queue consumer, DLQ recovery, cron backfill
    ├── cache.ts             # Cloudflare cache tag invalidation
    └── pagination.ts        # Cursor-based pagination
migrations/
└── 0001_smol_music_providers.sql  # Nullable Song_2 + Requested_Provider / Actual_Provider migration
ext/smol-sdk/                # Soroban smart contract SDK (built via scripts/build-sdk.mjs)
```

## API Endpoints

### Auth
- `POST /login` — Passkey registration (`create`) or authentication (`connect`) across `smol.xyz`, `next.smol.xyz`, `noot.smol.xyz` (plus local dev hosts when `ALLOW_LOCALHOST_ORIGINS=true`)
- `POST /logout` — Clear `smol_token` cookie

### Smols
- `GET /` — List public Smols (cursor-paginated)
- `GET /created` — List authenticated user's Smols
- `GET /liked` — List authenticated user's liked Smols
- `GET /:id` — Fetch completed or in-progress Smol (`d1.Song_2` normalized to `null` for 1-track Smols; `kv_do` exposes `payload.provider`, `actual_provider`, `generation_meta`)
- `POST /` — Create Smol (`{ prompt, public?, instrumental?, playlist?, provider?: 'aisonggenerator' | 'elevenlabs' }`) → `200 text/plain` instance ID
- `POST /retry/:id` — Retry failed Smol (caller-independent, deduplicated, preserves original creator & provider; optional `{ override_provider }` or `{ provider }`) → `200 text/plain` instance ID
- `PUT /:id` — Toggle public/private visibility (blocked when NSFW is unsafe or unclassified)
- `PUT /:smol_id/:song_id` — Swap `Song_1`/`Song_2` on 2-track Smols (guarded against `NULL`/empty `Song_2` on 1-track Smols)
- `DELETE /:id` — Delete owned Smol, clean `Likes`/`Playlists`, protect shared MP3s, purge caches
- `DELETE /admin/bulk` — Admin bulk delete (gated behind dedicated `ADMIN_SECRET` via `x-admin-secret` or `Authorization: Bearer`; fails closed with 404 when unset; skips minted and by default public rows)

### Media, Likes, Playlists, Mixtapes, Artists, Search, Minting
- `GET` / `HEAD /song/:id.mp3` — RFC 9110 Range/206, suffix & EOF-clamped ranges, `416` with `Content-Range`, `If-None-Match` (`304`), `If-Range`, edge caching without partial-body poisoning, play counting excluding `HEAD` and `bytes=0-1` probes
- `GET` / `HEAD /image/:id.png[?scale=1..32]` — Pixel art serving with nearest-neighbor scaling and per-scale edge caching
- `GET /likes`, `PUT /likes/:id` — User likes
- `GET /playlist/:title` — Public playlist feed
- `GET /mixtapes`, `GET /mixtapes/:id`, `POST /mixtapes` — Public mixtapes
- `GET /artists/:address/smols` — Public artist feed
- `GET /search`, `GET /search/:id/similar`, `POST /search/admin/{reindex/:id,backfill,reconcile}`, `GET /search/admin/backfill/status` — Semantic search & indexing ops
- `POST /mint/:id`, `POST /mint` — Deduplicated single & batch Stellar minting (`202`)

## Bindings, Vars & Secrets

### Secrets (`wrangler secret put`)
- `SECRET` — User JWT signing secret (never valid for admin routes)
- `ADMIN_SECRET` — Dedicated optional admin token (`x-admin-secret` or `Authorization: Bearer`) for `DELETE /admin/bulk` and `/search/admin/*`; admin routes fail closed with `404` when unset
- `SK` — Stellar secret key for mint auth-entry signing
- `PIXELLAB_KEY` — Pixellab API key
- `CF_API_TOKEN` / `CF_ZONE_ID` — Cloudflare zone cache tag purge credentials
- `CF_AIG_TOKEN` — Cloudflare AI Gateway Run token for ElevenLabs BYOK (fail-closed if missing)

### Variables (`wrangler.jsonc` `vars`)
- `CF_AI_GATEWAY_ID` — AI Gateway ID configured with ElevenLabs BYOK stored key (`smol`, `byok_only: true`)
- `CF_AIG_BYOK_ALIAS` — BYOK key alias (default: `default`)
- `ELEVENLABS_MUSIC_LENGTH_MS` — Optional track duration override in ms (`3000..600000`); omitted on instrumentals by default so ElevenLabs chooses length naturally
- `ELEVENLABS_OUTPUT_FORMAT` — Audio format (default: `mp3_44100_128`)
- `ELEVENLABS_FALLBACK_ENABLED` — Enable automatic AISG → ElevenLabs fallback (`true` / `false`)
- `RPC_URL`, `RPC_URL_TESTNET`, `NETWORK_PASSPHRASE`, `SMOL_CONTRACT_ID` — Stellar RPC & contract config
- `SEARCH_BACKFILL_CRON_*` — Search backfill cron controls

### Bindings
- **Workflows**: `WORKFLOW` (`Workflow`), `TX_WORKFLOW` (`TxWorkflow`)
- **Durable Objects**: `DURABLE_OBJECT` (`SmolDurableObject`, v1) and `DO_STATE` (`SmolState`, v2 — retained; live namespace contains stored data)
- **Storage**: `SMOL_D1` (`smol-d1`), `SMOL_KV`, `SMOL_BUCKET` (`smol-r2`), `SMOL_SEARCH_INDEX` (`smol-search-index`), `SEARCH_QUEUE` (`smol-search-queue` + `smol-search-queue-dlq`)
- **Services & AI**: `AI`, `AISONGGENERATOR` (`aisonggenerator-worker`), `KALE_WORKER` (`kale-worker`)

## Development & Verification

```sh
# Build local ext/smol-sdk artifacts
pnpm run build:sdk

# Type check (builds ext/smol-sdk automatically before tsc)
pnpm run typecheck

# Run full test suite (zero paid calls)
pnpm test

# Dry-run Wrangler bundle verification
npx wrangler deploy --dry-run

# Local dev
pnpm start
```

See [docs/workflows-and-media.md](./docs/workflows-and-media.md), [docs/search-index-setup.md](./docs/search-index-setup.md), and [docs/up-next.md](./docs/up-next.md) for detailed workflow, media streaming, migration, search index operations, and backlog items.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
