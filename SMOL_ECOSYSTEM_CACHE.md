# SMOL ECOSYSTEM CACHE - IMMUTABLE REFERENCE
# Generated: 2025-12-26T22:18:40-06:00
# DO NOT EDIT - This is a read-only reference snapshot

================================================================================
## GIT COMMIT HASHES (Original State)
================================================================================
smol-fe:                 2fa73b1 (includes noot.xlm modifications)
smol-workflow:           140a6d5 (upstream kalepail/smol-workflow)
smol-contracts:          07617ca (upstream kalepail/smol-contracts) 
aisonggenerator-worker:  fc7d479 (upstream kalepail/aisonggenerator-worker)

================================================================================
## REPOSITORY URLS
================================================================================
smol-fe (fork):          https://github.com/tacticalnoot/smol-fe
smol-fe (upstream):      https://github.com/kalepail/smol-fe
smol-workflow:           https://github.com/kalepail/smol-workflow
smol-contracts:          https://github.com/kalepail/smol-contracts
aisonggenerator-worker:  https://github.com/kalepail/aisonggenerator-worker

================================================================================
## SMOL-CONTRACTS (Soroban Smart Contract)
================================================================================

### Contract Address (Mainnet)
SMOL_CONTRACT_ID: (configured in wrangler.jsonc of smol-workflow)

### Core Functions
- __constructor(admin, comet_wasm, base_asset)
  - Initializes contract with admin, Comet WASM hash, and base asset (XLM SAC)

- coin_it(user, asset_bytes, salt, fee_rule) -> (token_address, amm_address)
  - Creates new SAC token from asset_bytes
  - Mints 10,000,000 tokens (10_000_000_0000000 stroops) to user
  - Charges 100 base units (100_0000000 = 10 XLM) as mint fee to token issuer
  - Deploys Comet AMM pool with:
    * 99% tokens (9,900,000) + 100 XLM in pool
    * 50/50 weight split
    * 5% min fee, 95% max fee (dynamic based on utilization)
  - Requires both user AND admin authorization

- coin_them(user, asset_bytes[], salts[], fee_rules[]) -> [(token, amm)]
  - Batch version of coin_it for multiple tokens

- swap_them_in(user, comet_addresses[], tokens_out[], token_amount_in, fee_recipients)
  - Multi-pool swap executing swap_exact_amount_in on each pool
  - Total XLM spent = token_amount_in × pool_count

- update(new_admin?, new_comet_wasm?, new_base_asset?)
  - Admin-only: updates contract configuration

- upgrade(wasm_hash)
  - Admin-only: upgrades contract to new WASM

### Storage Keys
- "admin": Address (admin public key)
- "comet_wasm": BytesN<32> (Comet AMM WASM hash)
- "base_asset": Address (XLM SAC address)

### Token Economics
- Initial Supply: 10,000,000 tokens per song
- Pool Ratio: 99% tokens / 1% XLM
- Mint Fee: 10 XLM (goes to token issuer)
- Pool Fees: 5-95% dynamic based on utilization

================================================================================
## SMOL-WORKFLOW (Cloudflare Worker Backend)
================================================================================

### Database Schema (D1 - SQLite)
```sql
CREATE TABLE IF NOT EXISTS Smols (
    Id TEXT PRIMARY KEY,
    Title TEXT NOT NULL,
    Song_1 TEXT NOT NULL,
    Song_2 TEXT NOT NULL,
    Created_At DATETIME DEFAULT CURRENT_TIMESTAMP,
    Public BOOLEAN DEFAULT 1,
    Instrumental BOOLEAN DEFAULT 0,
    Plays INTEGER DEFAULT 0,
    Views INTEGER DEFAULT 0,
    "Address" TEXT NOT NULL,
    Mint_Token TEXT DEFAULT NULL,
    Mint_Amm TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS Users (
    Username TEXT NOT NULL,
    "Address" TEXT NOT NULL,
    UNIQUE (Username, "Address")
);

CREATE TABLE IF NOT EXISTS Likes (
    Id TEXT NOT NULL,
    "Address" TEXT NOT NULL,
    UNIQUE (Id, "Address")
);

CREATE TABLE IF NOT EXISTS Playlists (
    Id TEXT NOT NULL,
    Title TEXT NOT NULL,
    UNIQUE (Id, Title)
);

CREATE TABLE IF NOT EXISTS Mixtapes (
    Id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    Title TEXT NOT NULL,
    Desc TEXT NOT NULL,
    Smols TEXT NOT NULL,
    "Address" TEXT NOT NULL,
    Created_At DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Storage Tiers
- D1: Structured metadata (Smols, Users, Likes, Mixtapes)
- R2: Binary files (images/*.png, songs/*.mp3)
- KV: JSON workflow state, low-latency key-value access

### API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | / | List public smols (paginated) |
| POST | / | Create new smol (starts workflow) |
| GET | /:id | Get smol by ID with workflow status |
| PUT | /:id | Toggle public/private |
| DELETE | /:id | Delete smol and media |
| POST | /retry/:id | Retry failed generation |
| GET | /created | User's created smols |
| GET | /liked | User's liked smols |
| GET | /likes | Get user's liked IDs |
| PUT | /likes/:id | Toggle like |
| GET | /mixtapes | List mixtapes |
| GET | /mixtapes/:id | Get mixtape by ID |
| POST | /mixtapes | Create mixtape |
| POST | /mint/:id | Mint single smol |
| POST | /mint | Batch mint smols |
| GET | /song/:id.mp3 | Stream audio (range requests) |
| GET | /image/:id.png | Serve image (optional scale) |
| POST | /login | Authenticate with passkey |
| POST | /logout | Clear authentication |

### Workflow System (Cloudflare Workflows)

#### Main Workflow (WORKFLOW) - Smol Generation
10-step durable workflow:
1. validate_input - Check address and prompt
2. save_payload - Store to Durable Object
3. generate_image - Pixellab pixel art
4. describe_image - Cloudflare AI LLaVA
5. generate_lyrics - AI Song Generator Worker
6. check_nsfw - Content moderation
7. generate_songs - Create 2 song variants (aisonggenerator → diffrhythm fallback)
8. wait_for_completion - Poll until songs ready
9. store_results - Save to D1/KV/R2
10. complete_workflow - Cleanup, add to playlist

Step Configuration:
- Retry limit: 5 attempts
- Initial delay: 10 seconds
- Backoff: Exponential (10s, 20s, 40s, 80s, 160s)
- Timeout: 5 minutes per step

#### Transaction Workflow (TX_WORKFLOW) - Blockchain Minting
Steps:
1. submit_transaction - Sign auth entries, submit via LaunchTube
2. persist_result - Store Mint_Token/Mint_Amm to D1

Params:
- type: 'mint' | 'batch_mint'
- xdr: User-signed transaction envelope
- entropy: Smol ID (deterministic salt)
- sub: User's JWT subject claim
- ids: Array of smol IDs (batch only)

### Environment Variables (wrangler.jsonc)
```
RPC_URL - Stellar RPC endpoint
NETWORK_PASSPHRASE - Stellar network identifier
SMOL_CONTRACT_ID - Deployed smol contract address
```

### Secrets (wrangler secret)
```
SECRET - JWT signing secret
SK - Server's Stellar secret key
LAUNCHTUBE_TOKEN - LaunchTube bearer token
```

### Bindings
- WORKFLOW: Main generation workflow
- TX_WORKFLOW: Transaction workflow
- DURABLE_OBJECT: SmolDurableObject
- DO_STATE: SmolState
- SMOL_D1: D1 database
- SMOL_KV: KV namespace
- SMOL_BUCKET: R2 bucket
- AI: Cloudflare AI
- AISONGGENERATOR: Song generator service binding
- LAUNCHTUBE: Transaction relay service

================================================================================
## AISONGGENERATOR-WORKER (Song Generation Service)
================================================================================

### API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/lyrics | Generate lyrics from prompt |
| POST | /api/songs | Generate songs |
| GET | /api/songs | Get song status/results |

### Lyrics Generation Fallback Chain
1. tommy-ni1997 (https://lyrics-generator.tommy-ni1997.workers.dev)
2. Suno API (getLyrics)
3. aisonggenerator.io (/api/lyrics-generate)
4. Cloudflare AI (songWrite function)

### Song Generation Routing
- source=aisonggenerator: Uses aisonggenerator.io → Supabase for results
- source=diffrhythm: Uses DiffRhythm service

### Cloudflare AI Pre-Prompt (src/api/cf.ts)
```
You are a creative and comedic song writer.

Your task is to write a song based on a prompt and a description of an image which the prompt generated.

Your output should be formatted with musical tags such as [Intro], [Verse], [Chorus], [Bridge], [Outro], etc. The key being each tag is a section of the song and denoted with brackets [].

Feel free to include instrumental, gender and genre clues in the tags should the song need it.

Songs should be relatively short, just 2-3 verses long.

You MUST format your response as a valid JSON object strictly adhering to this format:
{
    "title": "<song title>", 
    "lyrics": "<song lyrics>", 
    "style": ["<song_genre_1>", ...]
}
```

Model: @cf/meta/llama-3.3-70b-instruct-fp8-fast
Max tokens: 512
Temperature: 0.7

### Song Generation Parameters (aisonggenerator.io)
```json
{
    "lyrics_mode": true,
    "instrumental": false,
    "lyrics": "<lyrics>",
    "description": "<description for instrumental>",
    "title": "<title>",
    "styles": "<comma-separated styles>",
    "type": "lyrics" | "desc",
    "model": "v1.0",
    "user_id": "<AISONGGENERATOR_USER_ID>",
    "is_private": true/false
}
```

### Durable Object State
- Singleton ID: 'v0.0.0'
- Stores: access_token, refresh_token, diffrhythm_session
- Scheduled refresh: Every minute (cron trigger)

================================================================================
## SMOL-FE (Astro + Svelte Frontend)
================================================================================

### Technology Stack
- Astro 5 (SSR framework)
- Svelte 5 (Reactive UI with runes)
- Tailwind CSS 4 (Vite plugin)
- Cloudflare Pages deployment

### Environment Variables (.env)
```
PUBLIC_RPC_URL - Stellar RPC endpoint (soroban-rpc)
PUBLIC_NETWORK_PASSPHRASE - Stellar network identifier
PUBLIC_WALLET_WASM_HASH - PasskeyKit wallet WASM hash
PUBLIC_LAUNCHTUBE_URL - LaunchTube service URL
PUBLIC_LAUNCHTUBE_JWT - LaunchTube auth token
PUBLIC_API_URL - Backend API URL (smol-workflow)
PUBLIC_KALE_SAC_ID - KALE token SAC address
PUBLIC_SMOL_CONTRACT_ID - Smol contract address
```

### Svelte Stores
- userState: { contractId, keyId, wallet }
- audioState: { currentSmol, playing, progress }
- balanceStore: Token balance cache
- mixtapeState: Mixtape builder state

### SDK Packages (ext/)
- passkey-kit: WebAuthn wallet (no seed phrases)
- smol-sdk: Smol contract client
- comet-sdk: AMM pool client

### Key Components
- src/components/Smol.svelte - Main smol detail view
- src/components/smol/SmolGrid.svelte - Grid with search/filter
- src/components/smol/SmolCard.svelte - Card component
- src/components/audio/BarAudioPlayer.svelte - Persistent player
- src/components/mixtape/builder/ - Mixtape builder

### Pages (Astro routes)
- / - Home feed
- /[id] - Smol detail
- /create - Generation interface
- /created - User's created smols
- /liked - User's liked smols
- /account - Account management
- /artists - Artist index (NOOT ADDITION)
- /artist/[address] - Artist profile (NOOT ADDITION)
- /mixtapes - Mixtape index
- /mixtapes/[id] - Mixtape detail
- /playlist/[id] - Playlist view

### KALE Token
- Type: Stellar Asset Contract (SAC)
- Decimals: 7 (1 KALE = 10,000,000 stroops)
- Used for: Mint fees, trading

### Transaction Flow
1. Build transaction using SDK client
2. Get latest ledger sequence (+ 60 ledger buffer for expiration)
3. Sign with passkey (WebAuthn)
4. Submit to Horizon server
5. Update balance state

================================================================================
## NOOT.XLM MODIFICATIONS (tacticalnoot/smol-fe fork)
================================================================================

### Added Features (v1.1.0)
1. Artists Index (/artists)
   - New page listing all creators
   - Navigation menu link

2. Artist Profile Tabs
   - Discography: Songs created by artist
   - Minted: Songs from discography that have been minted
   - Collection: Songs artist minted from other creators

3. Artist Profile Stats
   - Published count badge (lime)
   - Collected count badge (purple)
   - Genre tags from discography

4. Mint Badges
   - Visual indicator on minted songs

5. SmolCard Data Attributes
   - data-creator, data-address, data-minted-by

6. Minter Tracking (generate_snapshot.py)
   - Horizon API integration to identify minters
   - Minted_By field in snapshot data
   - build_minter_cache() function

### Modified Files
- src/components/smol/SmolGrid.svelte
- src/components/smol/SmolCard.svelte
- src/pages/artist/[address].astro
- src/pages/artists.astro
- src/components/artist/ArtistsIndex.svelte
- src/types/domain.ts (added Minted_By field)
- src/data/smols-snapshot.json (enriched with minter data)
- README.md
- CHANGELOG.md

================================================================================
## HORIZON API MINTER LOOKUP
================================================================================

### Smol Issuer Address
GBVJZCVQIKK7SL2K6NL4BO6ZYNXAGNVBTAQDDNOIJ5VPP3IXCSE2SMOL

### Mint Operation Detection
Query: https://horizon.stellar.org/accounts/{SMOL_ISSUER}/operations?limit=200

Parse asset_balance_changes where:
- type: "mint"
- asset_issuer: SMOL_ISSUER
- asset_code: First 12 chars of song ID
- to: Minter's address

### Cache Structure
MINTER_CACHE = { asset_code: minter_address }

================================================================================
## END OF CACHE DOCUMENT
================================================================================
