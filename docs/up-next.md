# SMOL Up Next / Notes

Durable implementation notes and remaining follow-ups for `smol-workflow`.

---

## 1. NSFW / Content Safety Classifier: Tuned `@cf/cloudflare/clef` (Live)

**Status:** Live on `api.smol.xyz` (`NSFW_PROVIDER="clef"` in `wrangler.jsonc`). Rollback is one var: `NSFW_PROVIDER="llama-guard"` restores the legacy Guard call exactly (text-only, JSON-stringified lyrics).

### What runs in Step 5
- `@cf/cloudflare/clef` (27B, `model: "clef"`) with `state: { prompt, description, lyrics }` (raw lyrics; empty for instrumentals), the frozen 12-question `noul` rubric (`S1`–`S5`, `S7`–`S13`; pinned by `test/fixtures/nsfw-clef-questions.json`), and the cover as `images: [{ content_type: "image/png", base64 }]`.
- Policy: nonsexual affection, heartbreak, family and children's songs are allowed; sex acts, focused intimate nudity, deliberate sexual innuendo (text or cover) and all S1–S13 harms are blocked. This intentionally replaces the old "no romance at all" S12 wording.
- Decision: review cutoffs `S8 .45`, `S12 .40`, others `.50`; definite block = review + `.05`, inclusive. Any definite → `{ safe: false, categories: [highest definite code] }` (exact tie → no code). Review-only → `{ safe: false, categories: [], unknown: true }`. Else safe.
- Fail-closed to `unknown` (kept unlisted, song still completes, no refund) on: missing/invalid/non-PNG/> 4 MiB cover, combined text > 48,000 chars, 5 s timeout, AI throw, or any envelope/model/usage/answer defect. Stored legacy KV shapes still normalize unchanged.

### Eval summary (`orchestration/modernization/nsfw-clef-eval.md`, 2026-11-25)
- Holdout 22 songs: tuned 27B + PNG **6 TP / 0 FP / 0 FN / 16 TN** (Guard: 4/2/2/14); full 66 cases: 0 FP / 0 FN. Only the PNG arm caught an image-only solicitation.
- 27B + PNG latency p50 350 ms / p95 573 ms / max 923 ms (REST client wall-clock); ~$0.0005 per song, $0 output tokens.
- Caveat: 6 unsafe holdout cases bound the miss rate at ≤ 39% (one-sided 95%); watch `nsfw_clef_unknown` logs and the unknown/blocked rate after deploy.

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
- Spend ceilings are live (closes 47a H3): `GLOBAL_DAILY_LIMIT_ELEVENLABS = 50` (~$75/day worst case), dedicated `SMOL` ElevenLabs key (`••••••087e`, 100k credits/refresh period, Auto Top Up Off), and Cloudflare AI Gateway `smol` at `60 req / 86400 s` sliding (ElevenLabs-only). See `docs/music-provider-economics.md` §1.

---

## 3. Open Low-Priority Follow-Ups (from 2026-11-25 Post-Audit Wave)

- **Zero-sung-line ElevenLabs vocal (`NDM-2`):** Currently rejected pre-dispatch with full quota refund (0/73 corpus); optionally auto-route to `force_instrumental`.
- **Classic instrumental Custom mode (`NDM-3`):** Classic instrumentals currently use AISG Easy mode (exclusions go as prose); consider Custom + `instrumental: true` only after listening A/B.
- **Song-intent fallback watch (`NDM-5`):** Spot-check `{"event":"song_intent","source":"det"}` rate in Workers logs for DeepSeek timeouts/429s.
