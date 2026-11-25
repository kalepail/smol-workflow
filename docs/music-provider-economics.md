# SMOL Music Provider Economics, Plan Sizing & XLM Pricing

> **Snapshot date:** 2026-11-23 (updated 2026-11-25 for live quotas, scoped `SMOL` ElevenLabs key, and 60/day gateway cap)
> **Applies to:** `smol-workflow`, `aisonggenerator-worker`, and `smol-fe` (`smol.xyz`)
> **Related docs:** [`docs/workflows-and-media.md`](./workflows-and-media.md), `aisonggenerator-worker/docs/aisg-api-notes.md`

This document records the vendor pricing research, live SMOL production usage baseline, ElevenLabs plan sizing, and XLM per-song pricing math behind SMOL's dual-provider music architecture (**AISongGenerator `v6` primary + ElevenLabs `music_v2_5` UI toggle & automatic fallback**).

---

## 1. Executive Summary

- **AISongGenerator (`aisonggenerator.io`) native `v6` ("V4")** remains the most cost-effective default engine at **4 credits flat per generation for 2 × ~3-minute tracks** (**~$0.05–$0.14 / Smol** total including non-music overhead).
- **ElevenLabs Music API directly** (`music_v2_5` via Cloudflare AI Gateway BYOK) costs a flat **$0.15 / min** across Pay-As-You-Go and all monthly tiers (**~$0.125 / min** annual), which is cheaper than routing ElevenLabs through AISongGenerator on every monthly and one-time credit-pack tier (**$0.165–$0.30 / min** on AISG) and is the only option with a real developer API.
- **Active ElevenLabs Plan:** **Creator ($22 / mo, 147 min included + $0.15/min usage-based overages, commercial streaming rights)**. Fits SMOL's fallback role and normal baseline usage without overpaying for idle capacity.
- **Settled Track Shape (Q5):** AISG `v6` generates **2 tracks** (`Song_1`, `Song_2`); ElevenLabs generates **1 track** (`Song_2 = NULL`).
- **ElevenLabs track length (since `37bd537`):** there is **no fixed 2-minute default any more**. Instrumentals omit `music_length_ms`, so `music_v2_5` picks the length itself (anything from 3 s to 600 s). Vocal composition plans are paced per chunk by `@cf/zai-org/glm-5.3` and clamped to 3–120 s per chunk and **600 s total**. Typical output is still ~2–3 min, but the per-song cost is **not bounded below $1.50** (10 min × $0.15/min) unless `ELEVENLABS_MUSIC_LENGTH_MS` is set. The 2-min and 3-min figures below are typical-case estimates, not caps.
- **Spend ceilings (live 2026-11-25):**
  - **Classic (AISG):** `GLOBAL_DAILY_LIMIT_CLASSIC = 100` (400 credits/day max), per-user default `10/day`.
  - **ElevenLabs:** `GLOBAL_DAILY_LIMIT_ELEVENLABS = 50` paid generations/UTC day (~$75/day worst case, ~$15–$22.50/day typical at 2–3 min), per-user default `5/day` (optional per-address `USER_QUOTA_OVERRIDES` Worker secret).
  - **Outer hard caps (closes 47a H3):** dedicated least-privilege ElevenLabs key `SMOL` (`••••••087e`, Music Generation + User only, **100,000 credits / refresh period**, **Auto Top Up Off**) + Cloudflare AI Gateway `smol` edge cap at **`60 req / 86400 s` sliding** (ElevenLabs-only — do not route Workers AI through `smol`; AI Gateway `$` spend limits do not fire on ElevenLabs music because logs report `cost: 0` / `0` tokens).
- **Recommended XLM Pricing (at $0.1325 / XLM):**
  - **AISongGenerator (`v6`, 2 tracks):** **2 XLM** (~$0.27)
  - **ElevenLabs (`music_v2_5`, 1 track × ~2 min typical):** **4 XLM** (~$0.53)
  - **ElevenLabs (`music_v2_5`, 1 track × 3 min):** **5–6 XLM** (~$0.66–$0.80)
  - **Best long-term pattern:** Quote in **USD** (`$0.25` AISG / `$0.55–$0.75` ElevenLabs) and convert using a cached XLM/USD spot feed at generation time (rounded up to `0.5 XLM`) so crypto volatility cannot erode margins.

---

## 2. AISongGenerator vs. ElevenLabs Direct API

### 2.1 Apples-to-Apples: ElevenLabs Music Model

- **ElevenLabs Direct API (`elevenlabs.io/pricing/api`):** **$0.150 / min** flat across PAYG and all monthly subscription plans; **~$0.125 / min** on annual billing (2 months free). Billed proportionally down to 3 seconds.
- **AISongGenerator (`aisonggenerator.io/pricing`):** Bills its embedded ElevenLabs model at **10 credits / min** with a **10-credit (1-minute) minimum** (`Math.max(10, Math.ceil(durationMs * 10 / 60000))`).

| Service & Plan | Cost / Credit | Effective Cost / Min | 2-Min Track | 3-Min Track | vs. ElevenLabs API Monthly |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **ElevenLabs API (PAYG / Monthly)** | — | **$0.150** | **$0.30** | **$0.45** | Baseline |
| **ElevenLabs API (Annual)** | — | **$0.125** | **$0.25** | **$0.38** | -17% |
| AISG Basic Monthly ($15 / 500 cr) | $0.0300 | $0.300 | $0.60 | $0.90 | +100% (2× cost) |
| AISG Basic Yearly ($120 / 6K cr) | $0.0200 | $0.200 | $0.40 | $0.60 | +33% |
| AISG Pro 1.5K Monthly ($29 / 1.5K cr) | $0.0193 | $0.193 | $0.39 | $0.58 | +29% |
| AISG Pro 3.2K Monthly ($59 / 3.2K cr) | $0.0184 | $0.184 | $0.37 | $0.55 | +23% |
| AISG One-Time Packs ($50–$200) | $0.0167 | $0.167 | $0.33 | $0.50 | +11% |
| AISG Pro 6K Monthly ($99 / 6K cr) | $0.0165 | $0.165 | $0.33 | $0.50 | +10% |
| AISG Pro 1.5K Yearly ($216 / 18K cr) | $0.0120 | $0.120 | $0.24 | $0.36 | -20% (~even w/ EL annual) |
| AISG Pro 3.2K Yearly ($420 / 38.4K cr) | $0.0109 | $0.109 | $0.22 | $0.33 | -27% |
| AISG Pro 6K Yearly ($600 / 72K cr) | $0.0083 | **$0.083** | **$0.17** | **$0.25** | **-44%** |

*(Note: ElevenLabs also ran a Black Friday annual promo through Dec 1, 2026: Creator $8.25/mo year 1, Pro $37.13/mo year 1 ≈ $0.056/min on Pro.)*

### 2.2 AISongGenerator Native `v6` ("V4") vs. ElevenLabs Direct API

- **AISG `v6` (flat 4 credits per generation → 2 tracks up to 4–8 min):**
  - Basic Monthly ($0.030/cr): **$0.12 / Smol**
  - Pro Monthly / One-Time Packs ($0.0165–$0.0193/cr): **$0.066–$0.077 / Smol**
  - Pro Yearly ($0.0083–$0.0120/cr): **$0.033–$0.048 / Smol**
- **MiniMax Music 3.0 on AISG** (avoid for cost): 1 credit/sec = 60 credits/min (**$0.50–$1.80 / min**).

### 2.3 Non-Price Architectural Factors

- **API availability:** `aisonggenerator.io` has no official public developer API (SMOL drives its web endpoints via session tokens in `aisonggenerator-worker`). ElevenLabs provides a first-class `/v1/music` API natively supported by Cloudflare AI Gateway BYOK.
- **Commercial licensing:** ElevenLabs Music v2/v2.5 is trained on cleared/licensed catalogs; commercial use starts on Starter ($6/mo), and streaming distribution (Spotify/Apple) starts on **Creator ($22/mo)**. AISG includes commercial rights on paid plans (free general/song-specific certificates on annual plans; 100 credits/song without a subscription).
- **Credit rollover vs. PAYG:** AISG paid credits never expire (including after cancellation), but sub-$0.15/min ElevenLabs rates require $216–$600 upfront annual lock-in. ElevenLabs Creator+ provides true monthly usage-based overages at $0.15/min.

---

## 3. Live SMOL Usage Baseline (as of 2026-11-23)

Measured from production `api.smol.xyz` (2,541 public Smols over 20 months) and Cloudflare `smol-workflow` instances (last 30 days, public + private):

- **Long-term public volume (`api.smol.xyz`, Apr 2025 – Nov 2026):**
  - **Recent 5-month steady pace (Jul–Nov 2026):** **~35–45 public Smols / mo** (`Jul: 30`, `Aug: 31`, `Sep: 33`, `Oct: 43`, `Nov 1–23: 25`).
  - **12-month average (Dec 2025 – Nov 2026):** **~64 public Smols / mo**.
  - **Historical peaks:** May 2025 (`580`), Jun 2025 (`418`), Jan 2026 (`155`), Dec 2025 (`142`), May 2026 (`131`).
- **Last 30 days total workflow runs (`smol-workflow`, Oct 25 – Nov 23, 2026):**
  - **212 total runs:** **113 completed**, **99 errored**.
  - **Steady baseline (Oct 25 – Nov 19, 26 days):** 24 runs (24/24 completed → **~28 runs / mo**).
  - **Burst window (Nov 21 – Nov 23, 3 days):** 188 runs (89 completed, 99 errored when AISG failed and fell back to broken DiffRhythm), driven primarily by private batch generation (~80% private in a 25-run sample).
- **Observed AISG track durations:** ~167–202s (**~3.0–3.2 min per track**, 2 tracks per Smol).

---

## 4. ElevenLabs Plan Sizing

| ElevenLabs API Tier | Monthly Price | Included Music Min | Overages | Commercial / Streaming | Fit for SMOL |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Starter** | $6/mo ($5/mo yr) | 40 min | No standard overages | Commercial, **no streaming** | Too small; lacks streaming rights & overages |
| **Creator (Active)** | **$22/mo** ($18.33/mo yr) | **147 min** | **$0.15/min** | **Commercial + streaming** | **Best fit** for fallback + toggle + normal baseline |
| **Pro** | $99/mo ($82.50/mo yr) | 660 min | $0.15/min | Commercial + streaming + 192kbps/PCM + 10 conc. | Only needed if ElevenLabs becomes primary at 100+ Smols/mo sustained, or for 192kbps/PCM |
| **Scale** | $299/mo ($249.17/mo yr) | 1,993 min | $0.15/min | Same + 15 conc. | Only for >600+ ElevenLabs Smols/mo |

Because the per-minute API rate is flat (**$0.15/min**) across Creator and Pro monthly plans, there is **no monthly volume discount** for jumping to Pro early. **Creator ($22/mo)** covers:
- **~73 ElevenLabs Smols/mo** at ~2 minutes per track, or
- **~49 ElevenLabs Smols/mo** at 3 minutes per track, or
- as few as **~14 ElevenLabs Smols/mo** if every track ran to the 10-minute maximum,
with seamless `$0.15/min` overages during burst weeks or AISG outages. Lengths are no longer pinned (see §1), so size the plan from measured ElevenLabs durations, not from a configured default. At the global cap of 50/day, overages are bounded at ~$75/day while the global quota DO responds (global RPC errors fail open to per-user limits only).

---

## 5. Per-Smol Unit Economics & XLM Pricing

### 5.1 Non-Music Variable Overhead per Smol

| Component | Est. Cost / Smol | Notes |
| :--- | :---: | :--- |
| PixelLab (`pixflux`, 64×64) | ~$0.010 | $0.008–$0.013 pay-per-gen (~$0.006 on Tier 1 sub) |
| Cloudflare Workers AI + Infra | ~$0.005–$0.010 | Image describe, lyrics, NSFW check, Workflows/DO/R2/D1/KV |
| **Total non-music overhead** | **~$0.020** | Constant across music providers |

### 5.2 Per-Smol Break-Even & Recommended XLM Charge

Reference spot rate on 2026-11-23: **$0.1325 / XLM** (~7.55 XLM per $1; Coinbase `$0.1325`, CoinGecko `$0.1329`).

| Provider & Track Config | Music Cost | Total Cost (incl. $0.02) | Break-Even (XLM) | Recommended Charge | Downside XLM Floor |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **AISG `v6` (2 × ~3 min)** | $0.05–$0.12 | **$0.07–$0.14** | 0.5–1.1 XLM | **2 XLM** (~$0.27) | Profitable down to **$0.07 / XLM** |
| **ElevenLabs `music_v2_5` — 1 × 2 min** *(typical)* | $0.30 | **$0.32** | 2.42 XLM | **4 XLM** (~$0.53) | Profitable down to **$0.08 / XLM** |
| **ElevenLabs `music_v2_5` — 1 × 3 min** *(longer vocal)* | $0.45 | **$0.47** | 3.55 XLM | **5–6 XLM** (~$0.66–$0.80) | Profitable down to **$0.08–$0.09 / XLM** |
| *ElevenLabs `music_v2_5` — 1 × 10 min* *(worst case, uncapped)* | $1.50 | $1.52 | 11.47 XLM | — (cap length or price by duration) | — |
| *Ref: ElevenLabs 2 × 2 min* | $0.60 | $0.62 | 4.68 XLM | 7 XLM (~$0.93) | Profitable down to $0.09 / XLM |
| *Ref: ElevenLabs 2 × 3 min* | $0.90 | $0.92 | 6.94 XLM | 10–11 XLM (~$1.33–$1.46) | Profitable down to $0.085–$0.09 / XLM |

### 5.3 Pricing Policy Guidelines

1. **Tie pricing to the UI provider toggle:** Do not charge one flat price across AISG and ElevenLabs. Price AISG at **2 XLM** (Standard) and ElevenLabs at **4 XLM** (~2-min typical) or **5–6 XLM** (3-min). A flat ElevenLabs price only holds if length is capped via `ELEVENLABS_MUSIC_LENGTH_MS`; otherwise price by delivered duration.
2. **Prefer USD-pegged dynamic XLM quoting:** Store USD target prices (e.g., `$0.25` AISG, `$0.55` ElevenLabs 2-min / `$0.75` ElevenLabs 3-min) and compute the XLM amount from a cached XLM/USD oracle/spot feed (rounded up to `0.5 XLM`) so XLM rallies do not overcharge users and 40%+ drawdowns do not put generation underwater.
3. **Creator base-fee break-even ($22/mo):** At **4 XLM** (~$0.53) per 2-min ElevenLabs track, **~42 paid ElevenLabs Smols/mo** cover the entire $22/mo Creator subscription (or **~30–33 Smols/mo** at 5–6 XLM for 3-min tracks). Beyond the 147 included minutes, every additional Smol stays net-positive against the `$0.15/min` overage rate at typical 2–3 min lengths (a 4 XLM flat price goes negative above ~3.4 min while lengths are uncapped).
4. **Silent AISG → ElevenLabs fallback absorption:** If a user pays the 2 XLM AISG price and AISG fails over to ElevenLabs (1 × 2-min = $0.32 cost vs. ~$0.27 revenue = -$0.05 net on that run), the ~$0.15–$0.19 surplus per successful AISG generation comfortably absorbs fallback rates up to ~50% without losing money overall.
