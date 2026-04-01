# Search Index Setup

This search implementation expects a single Vectorize V2 index named `smol-search-index` and the queue resources declared in [wrangler.jsonc](/Users/kalepail/Desktop/Web/Soroban/SMOL/smol-workflow/wrangler.jsonc).

## 1. Confirm the embedding dimension

`@cf/baai/bge-m3` currently emits 1024-dimensional dense vectors according to the upstream model card, so this repo provisions the index at `1024`. If Cloudflare swaps the backing model shape in the future, re-verify before recreating the index.

## 2. Create the queue resources

Create the producer queue and its DLQ before deploying the Worker:

```bash
npx wrangler@latest queues create smol-search-queue
npx wrangler@latest queues create smol-search-queue-dlq
```

## 3. Create the Vectorize index

```bash
npx wrangler@latest vectorize create smol-search-index --dimensions=1024 --metric=cosine
```

## 4. Create metadata indexes before inserting vectors

Filtering in this Worker depends on these metadata indexes existing before the first upsert:

```bash
npx wrangler@latest vectorize create-metadata-index smol-search-index --propertyName=smol_id --type=string
npx wrangler@latest vectorize create-metadata-index smol-search-index --propertyName=modality --type=string
npx wrangler@latest vectorize create-metadata-index smol-search-index --propertyName=public --type=boolean
npx wrangler@latest vectorize create-metadata-index smol-search-index --propertyName=instrumental --type=boolean
npx wrangler@latest vectorize create-metadata-index smol-search-index --propertyName=brightness_level --type=string
npx wrangler@latest vectorize create-metadata-index smol-search-index --propertyName=energy_level --type=string
npx wrangler@latest vectorize create-metadata-index smol-search-index --propertyName=modality_guess --type=string
npx wrangler@latest vectorize create-metadata-index smol-search-index --propertyName=lyric_presence --type=string
npx wrangler@latest vectorize create-metadata-index smol-search-index --propertyName=search_version --type=string
```

## 5. Verify metadata indexes

```bash
npx wrangler@latest vectorize list-metadata-index smol-search-index
```

## 6. Deploy and backfill

After deployment, enqueue backfill for the existing public corpus:

```bash
curl -X POST \
  -H "x-admin-secret: $SMOL_ADMIN_SECRET" \
  "https://YOUR_WORKER_HOST/search/admin/backfill?limit=100"
```

Repeat with the returned `pagination.nextCursor` until `hasMore` is `false`.

For production, prefer the wave runner over manual curl loops. It paces backfill by the
Vectorize watermark and runs reconcile between waves so it stops when Vectorize stalls
instead of piling on more mutations:

```bash
SMOL_ADMIN_SECRET=... npm run backfill:search -- --resume-from-state --max-waves=10
```

This script requires:
- local Wrangler auth, because it polls `wrangler vectorize info`
- `SMOL_ADMIN_SECRET`, because it calls the admin backfill/reconcile routes

By default it now:
- polls every 30 seconds
- tolerates longer stalls before exiting
- writes checkpoint state to `.wrangler/tmp/search-backfill-state.json`

If the script reports a stall, resume later with `--resume-from-state` or the cursor it prints.

## 7. Optional cron backfill

This repo now includes a bounded scheduled backfill step in the Worker itself.
It is intended as a safe maintenance pass, not a high-throughput bulk loader:

- it processes up to a bounded number of pages per cron run
- it uses the same backfill + reconcile helpers as the admin routes
- it keeps a cursor checkpoint in `SMOL_KV`
- it does not advance the cursor while the current page still has pending items
- it records health, recent run history, and Vectorize watermark snapshots for monitoring
- once a full pass completes for the current `SEARCH_INDEX_VERSION`, it stops re-scanning

The default production config runs every 5 minutes with a page limit of 20 and up to 5
stable pages per invocation:

```jsonc
"vars": {
  "SEARCH_BACKFILL_CRON_ENABLED": "true",
  "SEARCH_BACKFILL_CRON_PAGE_LIMIT": "20",
  "SEARCH_BACKFILL_CRON_STALL_RUNS": "6",
  "SEARCH_BACKFILL_CRON_MAX_WAVES": "5"
},
"triggers": {
  "crons": ["*/5 * * * *"]
}
```

The cron worker now behaves more like the local backfill runner:
- it can advance through several already-current pages in one invocation
- it still stops immediately once a page queues new work or has pending items
- it resumes from the held cursor on the next scheduled run

If you need a faster catch-up, use the manual wave runner first, then leave cron enabled as a
safe low-pressure completion and repair loop.

To inspect the cron monitor remotely, call:

```bash
curl -H "x-admin-secret: $SMOL_ADMIN_SECRET" \
  https://api.smol.xyz/search/admin/backfill/status
```

The response includes:
- current cron `status` and `health`
- the held or next cursor
- `consecutiveStalledRuns` against the configured threshold
- the latest Vectorize watermark snapshot
- a short `recentRuns` history for debugging

## Notes

- Existing vectors inserted before metadata indexes were created must be re-upserted.
- Search results only include smols whose KV record reports `search.status = "ready"`.
- Queue delivery is asynchronous by design; new smols become searchable only after the finalize step sees the upsert mutation reflected by Vectorize index info.
- This search version uses 9 metadata indexes. Vectorize currently caps metadata indexes at 10 per index, so treat this set as part of the schema contract for `SEARCH_INDEX_VERSION = "v2"`.
- `wrangler types` on the current repo version still emits the legacy `VectorizeIndex` binding type for this index. The Worker code keeps a narrow compatibility cast until Wrangler emits the V2 `Vectorize` binding shape.
