# SMOL Up Next / Backlog

Durable research notes and upcoming work for `smol-workflow` and the `next.smol.xyz` → `smol.xyz` cutover.

---

## 1. Upgrade NSFW / Content Safety Classifier (`llama-guard-3-8b` → `@cf/cloudflare/clef`)

**Status:** Research complete, not urgent (current model is still active and supported).

### Current State (`src/ai/nsfw.ts`)
- Model: `@cf/meta/llama-guard-3-8b` (Llama 3.1 8B base, `$0.484/M` input, `$0.03/M` output, ZDR).
- **Not deprecated:** Survived Cloudflare's May 30, 2026 and November 20, 2026 Workers AI deprecation sweeps and still backs Cloudflare's own AI Gateway Guardrails (`S1`–`S14`).
- **Why it is a weak fit for SMOL's actual check:**
  1. **Custom rubric mismatch:** Llama Guard 3 is fine-tuned on Meta's fixed MLCommons `S1`–`S14` definitions and plain-text `safe` / `unsafe\nS12` output. `src/ai/nsfw.ts` rewrites `S12` into a strict G-rated / no-romance policy and requests `response_format: { type: 'json_object' }`, which fights its fine-tune.
  2. **Narrow language support:** Documented for 8 languages (`EN, FR, DE, HI, IT, PT, ES, TH`), while SMOL now enforces matching any prompt language.
  3. **Text-only:** Evaluates only the text `description`, never the actual generated pixel-art cover image.

### Recommended Replacement: `@cf/cloudflare/clef` (or `@cf/cloudflare/clef-flash`)
- Cloudflare's open-source multimodal decision models (launched Oct 2026):
  - `@cf/cloudflare/clef` (27B, `$0.24/M` input, `$0` output, 64K context, Vision, ZDR) — highest precision.
  - `@cf/cloudflare/clef-flash` (9B) — lower latency hot-path option.
- **Why it fits SMOL much better:**
  - Designed specifically for custom **trust-and-safety policy rubrics**: accepts structured `state` + typed `questions` schema and returns calibrated probabilities per option (no free-form text/JSON parsing or reasoning-token latency).
  - **~Half the input cost** of `llama-guard-3-8b` (`$0.24/M` vs `$0.484/M`) and `$0` output tokens.
  - **Multimodal:** Can pass the actual generated pixel-art image (`images[]`) alongside `prompt`, `description`, and `lyrics`.
- **Alternative if staying on a standard chat/JSON model:** `@cf/google/gemma-4-26b-a4b-it` (already used for search tag extraction in `src/utils/search.ts`; multimodal + multilingual).

### Migration Checklist
- [ ] Define typed Clef `questions` rubric matching SMOL's G-rated public-listing policy (harm categories + sexual/romantic/NSFW checks).
- [ ] Preserve `NormalizedNsfwResult` (`{ safe: boolean, categories: string[], unknown?: boolean }`) and fail-closed semantics on errors or ambiguous probabilities.
- [ ] Pass `image_base64` alongside `prompt`, `description`, and `lyrics`.
- [ ] Shadow-test / calibrate probability thresholds against a sample of historical safe + unsafe Smols before switching production traffic.

---

## 2. ElevenLabs Vocal & Instrumental Length (Implemented — Monitor Live Spend & Feel)

**Status:** Implemented for both instrumentals and vocals in `src/ai/elevenlabs.ts` + `src/utils/songs.ts`.

### Verified ElevenLabs `music_v2_5` API Constraints (`POST /v1/music`)
- **Instrumentals (`prompt` + `force_instrumental: true`):** `music_length_ms` is **optional** — omitted by default so `music_v2_5` picks natural duration (`3,000–600,000` ms).
- **Vocals (`composition_plan`):** In `CompositionPlan` (`music_v2` / `music_v2_5`), `chunks[].duration_ms` is **strictly required** (`3,000–120,000` ms per chunk; `422` if omitted), `respect_sections_durations` is ignored on v2/v2.5, and each chunk must stay within `<= 30` lines and `<= 200` chars/line.
- **`POST /v1/music/plan`:** Free (`0` credits), **but requires a text `prompt`** — rejected because SMOL sends verbatim Step 4 lyrics without a competing prompt.

### Live Data Calibration (2026-11-23, `n = 116` real measured SMOL vocal MP3s)
- Real SMOL vocal track lengths range from **124s to 405s** (`p25 = 192s`, `p50 = 235s`, `p75 = 266s`); raw line count alone correlates poorly (`r = 0.304`) because fast rap/K-pop (`3.1s/line`) and slow ballads/blues/progressive metal (`8–9.4s/line`) vary by **2.5–3×** at identical line counts.
- **Implemented architecture (zero hardcoded semantic/lexical word lists):**
  - Pre-submit workflow step (`plan elevenlabs vocal pacing`) runs `@cf/zai-org/glm-5.3` (`reasoning_effort: "low"`) anchored on an L1-fitted empirical baseline (`12s/chunk + 2.5s/sungLine`), sizing each chunk strictly to perform its lyrics/style while ignoring arbitrary prompt runtime claims (e.g., `"9-minute suite"`).
  - Gracefully falls back to the pure empirical baseline on any AI error or malformed output; explicit `ELEVENLABS_MUSIC_LENGTH_MS` still works as an optional env override.
  - Also splits unheaded multi-stanza and `> 30`-line chunks (caught in 5/117 live Smols) so ElevenLabs never rejects valid songs with `422`.
- **Follow-up:** Monitor live ElevenLabs per-minute spend (`$0.15/min`) and listen to uncapped instrumental + vocal tracks to confirm feel (`docs/music-provider-economics.md`). With lengths uncapped (up to 600 s, $1.50 each) and `GLOBAL_DAILY_LIMIT_ELEVENLABS = 20`, worst-case spend is ~$30/day, assuming the global quota Durable Object responds (global quota RPC errors fail open to per-user limits only, so during a global-quota outage spend is bounded by `DAILY_LIMIT_ELEVENLABS` × active users instead; see `docs/music-provider-economics.md` §1); an AI Gateway spend limit and ElevenLabs usage alert are still open (audit 47a H3).

---

## 3. `next.smol.xyz` → `smol.xyz` (`main`) Cutover

> **Source of truth:** the step-by-step runbook (gates, `smol-fe` deploy, `noindex` checks, the `PLAY_COUNT_MODE='beacon'` flip, rollback) lives in `smol/orchestration/CUTOVER_CHECKLIST.md`, outside this repo. The notes below are background only; follow the checklist when cutting over.

- **ElevenLabs automatic fallback:** Already enabled by default on `api.smol.xyz` (`ELEVENLABS_FALLBACK_ENABLED: "true"` in `wrangler.jsonc`), serving both `next.smol.xyz` and `smol.xyz`. Keep enabled through and after cutover to `main`.
- **Frontend cutover checks:** Verify 1-track fallback notice (`"Made with ElevenLabs — Classic was unavailable."`), provider badges, and daily quota display carry cleanly when `smol-fe` `next` merges into `main`.
