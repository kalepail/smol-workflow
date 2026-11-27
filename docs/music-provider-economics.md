# SMOL Music Provider Economics & XLM Pricing

> **Snapshot:** vendor pricing and usage as of 2026-11-23; quotas and spend caps as of 2026-11-25.
> **Related:** [`workflows-and-media.md`](./workflows-and-media.md), `aisonggenerator-worker/docs/aisg-api-notes.md`

SMOL runs two music providers: **AISongGenerator `v6`** (default, 2 tracks) and **ElevenLabs `music_v2_5`** (UI toggle and automatic fallback, 1 track, `Song_2 = NULL`).

## 1. Cost per Smol

| Provider | Music cost | + overhead (~$0.02) | Notes |
| :--- | :---: | :---: | :--- |
| AISG `v6`, 2 × ~3 min | $0.05–$0.12 (4 credits flat) | **$0.07–$0.14** | $0.008–$0.030 per credit depending on plan |
| ElevenLabs, 1 × 2 min (typical) | $0.30 | **$0.32** | $0.15/min flat on PAYG and every monthly tier |
| ElevenLabs, 1 × 3 min | $0.45 | **$0.47** | ~$0.125/min on annual billing |
| ElevenLabs, 1 × 10 min (worst case) | $1.50 | $1.52 | Length is uncapped unless `ELEVENLABS_MUSIC_LENGTH_MS` is set |

- Overhead: PixelLab `pixflux` 64×64 (~$0.01) plus Workers AI and storage (~$0.005–$0.01).
- **ElevenLabs length is not pinned.** Instrumentals omit `music_length_ms` (the model picks 3–600 s); vocal composition plans are paced per chunk by `@cf/zai-org/glm-5.3`, 3–120 s per chunk and 600 s total. Typical output is 2–3 min.
- Calling ElevenLabs directly is cheaper than ElevenLabs through AISG ($0.165–$0.30/min on AISG monthly tiers and packs) and is the only route with a real API. Avoid MiniMax on AISG ($0.50–$1.80/min).

## 2. Spend ceilings (live)

- **Classic (AISG):** `GLOBAL_DAILY_LIMIT_CLASSIC = 100` per UTC day (400 credits max); per-user default 10/day.
- **ElevenLabs:** `GLOBAL_DAILY_LIMIT_ELEVENLABS = 50` per UTC day (~$75/day worst case at 10 min, ~$15–$22.50 typical); per-user default 5/day. Per-address grants are rows in the user's `UserQuotaDO` (`POST /admin/quota-override`); the legacy `USER_QUOTA_OVERRIDES` secret covers addresses without a row.
- The global cap fails open when the global quota Durable Object is unreachable (per-user limits still apply), so two outer caps back it:
  - the dedicated least-privilege ElevenLabs key `SMOL` (Music Generation + User only, 100,000 credits per refresh period, Auto Top Up off);
  - the AI Gateway `smol` limit of **60 requests per 86,400 s sliding**, ElevenLabs only. Do not route Workers AI through `smol`. Gateway `$` spend limits never fire for ElevenLabs music because its logs report `cost: 0`.
- Every ElevenLabs gateway request carries `cf-aig-metadata: { source: "explicit" | "fallback", smol_id }`, so gateway logs separate toggle spend from fallback spend. Payload logging stays off.

## 3. Plan sizing

- **Active plan: ElevenLabs Creator ($22/mo):** 147 included minutes, $0.15/min overages, commercial and streaming rights. That covers ~73 Smols/mo at 2 min, ~49 at 3 min, or ~14 if every track ran 10 min.
- Pro ($99/mo, 660 min) adds no per-minute discount; it only matters if ElevenLabs becomes primary at 100+ Smols/mo or for 192 kbps/PCM output.
- Usage baseline (Jul–Nov 2026): ~35–45 public Smols/mo; ~28 workflow runs/mo in steady weeks, with bursts of ~190 runs in 3 days during an AISG outage.

## 4. XLM pricing

At **$0.1325/XLM** (2026-11-23):

| Provider & shape | Break-even | Recommended | Profitable down to |
| :--- | :---: | :---: | :---: |
| AISG `v6`, 2 tracks | 0.5–1.1 XLM | **2 XLM** (~$0.27) | $0.07/XLM |
| ElevenLabs, 1 × 2 min | 2.4 XLM | **4 XLM** (~$0.53) | $0.08/XLM |
| ElevenLabs, 1 × 3 min | 3.6 XLM | **5–6 XLM** (~$0.66–$0.80) | $0.08–$0.09/XLM |

1. Price by provider, not one flat price. A flat ElevenLabs price only holds while length is capped; otherwise price by delivered duration (4 XLM goes negative above ~3.4 min).
2. Prefer USD targets (`$0.25` AISG, `$0.55` / `$0.75` ElevenLabs 2 / 3 min) converted from a cached XLM/USD feed and rounded up to 0.5 XLM.
3. At 4 XLM per ElevenLabs Smol, ~42 paid Smols/mo cover the Creator fee.
4. An AISG-priced Smol that falls back to ElevenLabs loses ~$0.05; the surplus on successful AISG runs absorbs fallback rates up to ~50%.
