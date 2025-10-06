# Smol Workflow

An AI-powered music generation platform built on Cloudflare Workers that transforms text prompts into complete musical compositions with AI-generated artwork, lyrics, and songs.

## Overview

Smol Workflow uses [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) to orchestrate a complex, multi-step AI generation pipeline that creates "Smols" - unique music experiences combining:

- **AI-Generated Pixel Art** (via Pixellab)
- **AI-Described Image Metadata** (via Cloudflare AI)
- **AI-Generated Lyrics** (via AI Song Generator)
- **AI-Generated Songs** (via AI Song Generator / DiffRhythm)
- **NSFW Content Detection** (via Cloudflare AI)
- **Stellar Blockchain Integration** for minting songs as tokens

## Architecture

### Core Technologies

- **[Cloudflare Workers](https://workers.cloudflare.com/)** - Serverless compute platform
- **[Cloudflare Workflows](https://developers.cloudflare.com/workflows/)** - Durable execution engine for complex, multi-step processes
- **[Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)** - Stateful storage for workflow steps
- **[Hono](https://hono.dev/)** - Lightweight web framework
- **[Stellar SDK](https://github.com/stellar/js-stellar-sdk)** - Blockchain integration

### Storage & Data

- **D1** (SQLite) - Relational database for Smols, Users, Likes, Mixtapes
- **KV** - Key-value store for workflow state
- **R2** - Object storage for images and audio files

### AI Services

- **Pixellab** - Pixel art generation
- **Cloudflare AI** - Image description and NSFW detection
- **AI Song Generator** - Lyrics and music generation
- **DiffRhythm** - Fallback music generation service

## Project Structure

```
src/
├── index.ts              # Main application entry point
├── workflow.ts           # Main Smol generation workflow
├── tx-workflow.ts        # Stellar blockchain transaction workflow
├── do.ts                 # Durable Objects for state management
├── types.ts              # TypeScript type definitions
├── utils.ts              # Utility functions
├── utils/
│   └── pagination.ts     # Pagination helpers
├── middleware/
│   └── auth.ts           # JWT authentication middleware
├── api/
│   ├── auth.ts           # Authentication endpoints (login/logout)
│   ├── smols.ts          # Smol CRUD operations
│   ├── likes.ts          # Like/unlike functionality
│   ├── mixtapes.ts       # Mixtape creation and retrieval
│   ├── mint.ts           # Stellar blockchain minting
│   ├── media.ts          # Audio/image serving with range requests
│   └── playlists.ts      # Playlist management
└── ai/
    ├── pixellab.ts       # Pixel art generation
    ├── cf.ts             # Cloudflare AI integration
    ├── aisonggenerator.ts # Song and lyrics generation
    └── nsfw.ts           # NSFW content detection

ext/
└── smol-sdk/             # Stellar smart contract SDK
```

## Workflow Pipeline

The main workflow (`src/workflow.ts`) executes the following steps:

1. **Validate Input** - Ensure address and prompt are provided
2. **Save Payload** - Store initial parameters in Durable Object
3. **Generate Image** - Create pixel art based on prompt
4. **Describe Image** - Generate metadata description
5. **Generate Lyrics** - Create title, lyrics, and style
6. **Check NSFW** - Validate content safety
7. **Generate Songs** - Create 2 song variations
8. **Wait for Completion** - Poll until songs finish processing
9. **Store Results** - Save to D1, KV, and R2
10. **Complete Workflow** - Clean up and optionally add to playlist

Each step is retryable with exponential backoff and has a 5-minute timeout.

## API Endpoints

### Authentication
- `POST /login` - Create account or authenticate with passkey
- `POST /logout` - Clear authentication

### Smols
- `GET /` - List all public Smols (paginated)
- `GET /created` - List authenticated user's Smols
- `GET /liked` - List authenticated user's liked Smols
- `GET /:id` - Get specific Smol with workflow status
- `POST /` - Create new Smol (starts workflow)
- `POST /retry/:id` - Retry failed Smol generation
- `PUT /:id` - Toggle public/private visibility
- `PUT /:smol_id/:song_id` - Swap song order
- `DELETE /:id` - Delete Smol and associated media

### Likes
- `GET /likes` - Get authenticated user's liked Smol IDs
- `PUT /likes/:id` - Toggle like on a Smol

### Mixtapes
- `GET /mixtapes` - List all mixtapes
- `GET /mixtapes/:id` - Get specific mixtape
- `POST /mixtapes` - Create new mixtape (collection of Smols)

### Media
- `GET /song/:id.mp3` - Stream song with range request support
- `GET /image/:id.png` - Serve image with optional scaling

### Minting
- `POST /mint/:id` - Mint single Smol as Stellar token
- `POST /mint` - Batch mint multiple Smols

## Database Schema

### Smols
```sql
Id              TEXT PRIMARY KEY
Title           TEXT NOT NULL
Song_1          TEXT NOT NULL
Song_2          TEXT NOT NULL
Created_At      DATETIME DEFAULT CURRENT_TIMESTAMP
Public          BOOLEAN DEFAULT 1
Instrumental    BOOLEAN DEFAULT 0
Plays           INTEGER DEFAULT 0
Views           INTEGER DEFAULT 0
Address         TEXT NOT NULL
Mint_Token      TEXT DEFAULT NULL
Mint_Amm        TEXT DEFAULT NULL
```

### Users
```sql
Username        TEXT NOT NULL
Address         TEXT NOT NULL
UNIQUE (Username, Address)
```

### Likes
```sql
Id              TEXT NOT NULL
Address         TEXT NOT NULL
UNIQUE (Id, Address)
```

### Mixtapes
```sql
Id              TEXT PRIMARY KEY
Title           TEXT NOT NULL
Desc            TEXT NOT NULL
Smols           TEXT NOT NULL  -- Comma-separated list
Address         TEXT NOT NULL
Created_At      DATETIME DEFAULT CURRENT_TIMESTAMP
```

## Development

### Prerequisites
- Node.js 18+
- Wrangler CLI
- Cloudflare account

### Setup

```sh
# Install dependencies
npm install

# Start local development server
npm start

# Start with remote bindings (production-like environment)
npm run start:remote

# Type check
npm run typecheck

# Deploy to Cloudflare
npm run deploy
```

### Environment Variables

Required secrets (set via `wrangler secret put`):
- `SECRET` - JWT signing secret
- `SK` - Stellar secret key for transaction signing
- `LAUNCHTUBE_TOKEN` - Authorization token for Launchtube service

Environment variables (in `wrangler.jsonc`):
- `RPC_URL` - Stellar RPC endpoint
- `NETWORK_PASSPHRASE` - Stellar network identifier
- `SMOL_CONTRACT_ID` - Deployed smart contract address

### Bindings

**Workflows:**
- `WORKFLOW` - Main Smol generation workflow
- `TX_WORKFLOW` - Stellar transaction workflow

**Durable Objects:**
- `DURABLE_OBJECT` (SmolDurableObject) - Workflow state storage
- `DO_STATE` (SmolState) - Additional state management

**Storage:**
- `SMOL_D1` - D1 database
- `SMOL_KV` - KV namespace
- `SMOL_BUCKET` - R2 bucket

**AI & Services:**
- `AI` - Cloudflare AI binding
- `AISONGGENERATOR` - Song generation service binding
- `LAUNCHTUBE` - Stellar transaction submission service

## Stellar Integration

The project includes a custom SDK (`ext/smol-sdk`) for interacting with Stellar smart contracts. The `TxWorkflow` handles:

- **Single Mints** - Create token and AMM for individual Smols
- **Batch Mints** - Efficiently mint multiple Smols in one transaction
- **Auth Entry Signing** - Sign Stellar transactions with stored keypair

Minted tokens are recorded in the database (`Mint_Token`, `Mint_Amm`) for future reference.

## Features

### Workflow Retry System
Failed workflows can be retried while preserving completed steps, saving time and API credits.

### Pagination
All list endpoints support cursor-based pagination via `limit` and `cursor` query parameters.

### Media Streaming
Songs support HTTP range requests for efficient streaming and seeking.

### Image Scaling
Images can be scaled on-demand via the `scale` query parameter using nearest-neighbor interpolation.

### NSFW Protection
Content is automatically analyzed and flagged/hidden if deemed unsafe.

### Durable State Management
Workflow state is persisted in Durable Objects and auto-cleaned after completion via scheduled alarms.

## License

Apache 2.0 - See [LICENSE](./LICENSE) file for details.

Copyright 2024, Cloudflare.
