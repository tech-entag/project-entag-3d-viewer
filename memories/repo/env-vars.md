<!-- last-verified: 2026-05-16 -->

# Environment Variables

## Runtime (passed in request body, not env vars)

This project does NOT use `.env` files for Autodesk credentials. Instead, credentials are passed per-request in the POST body to `/api/autodesk`:

| Parameter | Source | Purpose |
|---|---|---|
| `client_id` | Request body | Autodesk Forge/APS client ID |
| `client_secret` | Request body | Autodesk Forge/APS client secret |

Also used by `/api/conversion-status` when `dry_run=false` and the request is not in native fast-path mode.

## Optional Runtime Environment Variables

| Variable | Used in | Purpose | Default |
|---|---|---|---|
| `EMBED_SESSION_SECRET` | `api/embed_helpers/session-token.ts` | HMAC secret for signing and verifying embed guest tokens | Empty (falls back to local dev secret with warning) |
| `EMBED_GUEST_TOKEN_TTL_SECONDS` | `api/embed_helpers/session-token.ts` | Guest token/session TTL in seconds for embed session creation and refresh; non-positive/invalid values reset to default and values are clamped to max 30 days | `86400` (24 hours) |
| `BLOB_READ_WRITE_TOKEN` | `api/autodesk_helpers/viewer-cache.ts`, `api/sheet-nesting.cts`, `api/embed_helpers/blob-storage.ts`, `api/embed/sessions/[embedSessionId]/files.cts`, `api/embed_helpers/session-store.ts`, `api/embed_helpers/part-store.ts` | Enables Blob list/put calls for viewer artifact persistence and sheet-nesting staging, plus embed session/part JSON durability and direct source upload storage; token is normalized by stripping whitespace/newlines before Blob SDK calls | Empty (feature disabled) |
| `AUTO_MODELID_ATTEMPTS` | `api/autodesk.cts` | Max server-side auto-followup attempts from `/api/autodesk` to `/api/conversion-status` for Bubble `modelId` writeback | `5` |
| `AUTO_MODELID_INTERVAL_MS` | `api/autodesk.cts` | Delay in milliseconds between auto-followup attempts | `5000` |
| `QUOTE_SUPPORTED_FORMATS` | `api/autodesk_helpers/format-map.ts` | CSV allow-list for short-scope quote conversion inputs | Built-in short-scope set |
| `DIGIFABSTER_NATIVE_FORMATS` | `api/autodesk_helpers/format-map.ts` | CSV list treated as already quote-compatible (no quote conversion required) | Built-in native list |
| `DIRECT_2D_NO_TRANSLATION_FORMATS` | `api/autodesk_helpers/format-map.ts`, `api/autodesk.cts`, `api/conversion-status.cts` | CSV list of source extensions that bypass Autodesk translation (`native2d:*` synthetic URN + thumbnail viewer mode + native DigiFabster sync path) | `dxf,dwg,f2d,slddrw` |
| `DIGIFABSTER_UPLOAD_BASE_URL` | `api/autodesk_helpers/digifabster-sync.ts` | Legacy base URL helper (does not configure upload target by itself) | `https://digifabster.com` |
| `DIGIFABSTER_UPLOAD_ENDPOINT` | `api/autodesk_helpers/digifabster-sync.ts` | Explicit upload endpoint (required for quote sync upload call) | Empty (must be set) |
| `DIGIFABSTER_PRICE_TWEAK_ENDPOINT` | `api/autodesk_helpers/digifabster-sync.ts`, `api/digifabster-price-tweak.cts` | Explicit price-tweaker target endpoint (required for POST `/api/digifabster-price-tweak`) | Empty (must be set) |
| `DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT` | `api/autodesk_helpers/digifabster-sync.ts` | S2S token exchange endpoint used before DigiFabster API calls | `https://digifabster.com/v2/obtain_s2s_token/` |
| `DIGIFABSTER_UPLOAD_TIMEOUT_MS` | `api/autodesk_helpers/digifabster-sync.ts` | Timeout for upload sync call to Digifabster | `270000` |
| `DIGIFABSTER_S2S_TOKEN_TTL_MS` | `api/autodesk_helpers/digifabster-sync.ts` | In-memory cache TTL for exchanged S2S token | `3300000` |
| `DIGIFABSTER_API_KEY` | `api/autodesk_helpers/digifabster-sync.ts` | DigiFabster API key used as `api_key` for S2S token exchange | Empty |
| `DIGIFABSTER_API_TOKEN` | `api/autodesk_helpers/digifabster-sync.ts` | Backward-compatible alias for API key input when `DIGIFABSTER_API_KEY` is unset; also used for direct `Authorization: Token ...` fallback when upload endpoint rejects S2S auth with `401/403` | Empty |
| `DIGIFABSTER_DISABLE_DIRECT_TOKEN_FALLBACK` | `api/autodesk_helpers/digifabster-sync.ts` | Disables retry with direct DigiFabster token auth after an S2S-authenticated upload request receives `401/403` | Empty (fallback enabled) |
| `DIGIFABSTER_UPLOAD_SHARED_SECRET` | `api/autodesk_helpers/digifabster-sync.ts` | Optional shared secret sent as `X-Upload-Secret` header | Empty |
| `BUBBLE_DATA_API_BASE_URL` | `api/conversion-status.cts` | Base URL for Bubble Data API OrderPart `modelId` writeback (normalizes to include `/api/1.1/obj`) | `https://app.entag.co/version-test/api/1.1/obj` |
| `BUBBLE_DATA_API_TOKEN` | `api/conversion-status.cts` | Primary Bubble Data API bearer token for OrderPart PATCH writeback | Empty |
| `BUBBLE_API_TOKEN` | `api/conversion-status.cts` | Backward-compatible Bubble Data API token alias for OrderPart PATCH writeback | Empty |
| `BUBBLE_DATA_API_BEARER_TOKEN` | `api/conversion-status.cts` | Additional Bubble token alias for OrderPart PATCH writeback fallback | Empty |
| `BUBBLE_ORDERPART_TYPE` | `api/conversion-status.cts` | Bubble Data API thing type for writeback target | `orderpart` |
| `BUBBLE_MODELID_FIELD` | `api/conversion-status.cts` | Bubble field name patched with Digifabster `objectModelId` | `modelId` |
| `VERCEL_REGION` | `api/bubble-trigger.cts` | Auto-set by Vercel for health check response | Provided by platform |

## E2E Environment Variables

| Variable | Used in | Purpose | Default |
|---|---|---|---|
| `E2E_BASE_URL` | `playwright.config.ts` | Run Playwright against an external deployment instead of local dev server | `http://127.0.0.1:4173` |
| `E2E_VERCEL_SHARE` | `e2e/viewer-and-conversion.spec.ts` | Adds `_vercel_share` query value for protected preview deployments | Empty |

## Script Suite Environment Variables

| Variable | Used in | Purpose | Default |
|---|---|---|---|
| `STEP_FIXTURE_PATH` | `scripts/bubble-flow-e2e.ts`, `scripts/mock-price-tweaker.cjs` | Path to STEP fixture consumed by Bubble flow simulation suite | `cutting-blade-1-k110-1.STEP` in project root |
| `MOCK_PRICE_TWEAKER_PORT` | `scripts/bubble-flow-e2e.ts`, `scripts/mock-price-tweaker.cjs` | Port for local mock price-tweaker endpoint used by suite | `7788` |
| `NESTING_DXF_FIXTURE_PATH` | `scripts/sheet-nesting-dxf-proof.ts` | Optional DXF fixture path override for local sheet-nesting proof script | `public/test-fixtures/nesting-sample-plate.dxf` |
| `BUBBLE_API_TOKEN` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Bubble Data API bearer token for PATCH/GET `orderpart/{id}` during backfill (required unless `--dry-run`) | Empty |
| `BUBBLE_TOKEN` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Backward-compatible alias for `BUBBLE_API_TOKEN` in backfill script | Empty |
| `PRODUCTION_BASE_URL` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Base URL used for `/api/autodesk` and `/api/conversion-status` during backfill | `https://project-entag-3d-viewer.vercel.app` |
| `BUBBLE_DATA_API_BASE_URL` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Bubble Data API base used by backfill script | `https://app.entag.co/api/1.1/obj` |
| `BUBBLE_VERSION` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Bubble version string forwarded to API route calls during backfill | `live` |
| `POLL_MAX_ATTEMPTS` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Max `/api/conversion-status` polls per record | `40` |
| `POLL_INTERVAL_MS` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Delay between conversion-status polls in milliseconds | `12000` |
| `UPLOAD_MAX_ATTEMPTS` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Max upload attempts per record for retryable `/api/autodesk` failures | `3` |

## Script CLI Flags

| Flag | Used in | Purpose | Default |
|---|---|---|---|
| `--dry-run` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Query and report eligible records without upload/poll/patch side effects | Disabled |
| `--window-days=N` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Scope candidate records to the last `N` days by Bubble `Created Date` | `0` = current month |
| `--include-missing-urn-with-image` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Also queue records that are missing `urn` but already have an `image`; existing image is preserved on patch | Disabled |
| `--include-3mf` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Include `3mf` records despite the default SVF incompatibility skip | Disabled |
| `--limit=N` / `--max=N` | `scripts/backfill-bubble-urn-thumbnail.cjs` | Cap queued records for partial recovery runs | `0` = no cap |

## Platform Config (not env vars)

| Setting | Location | Purpose | Verified value |
|---|---|---|---|
| Vercel default function duration | `vite.config.ts` `vercel.defaultMaxDuration` | Ensures `vite-plugin-vercel` emits 60s function configs in prebuilt output | `60` |
| Vercel API function duration rules | `vercel.json` `functions` | Mirrors the duration setting for `api/*.cts` and `api/**/*.ts` | `60` |
| Viewer SPA rewrites for prebuilt output | `vite.config.ts` `vercel.rewrites` | Prevents platform 404 for direct `/viewer` entry after `vercel deploy --prebuilt` | `/viewer` and `/viewer/(.*)` -> `/` |

## Hardcoded Secrets (in source)

| Location | Value | Purpose |
|---|---|---|
| `api/bubble-trigger.cts` | Bubble API Bearer token | Auth for Bubble.io workflow trigger |
| `src/assets/script.js` | Autodesk access token (expired) | Legacy dev script, not used in production flow |

## Vercel Platform

| Variable | Purpose |
|---|---|
| `VERCEL_REGION` | Auto-set by Vercel — used in bubble-trigger health check |

## Deployment Protection

The Vercel project uses SSO protection on all deployments. Access is granted via:

| Mechanism | Header | Value Source |
|---|---|---|
| Automation bypass | `x-vercel-protection-bypass` | `protectionBypass` secret from Vercel project API (scope: `automation-bypass`) |

The bypass secret is exposed as an env var (`VERCEL_AUTOMATION_BYPASS_SECRET`) on the Vercel project. For local test scripts, pass it as a header on every HTTP request to the deployment.

## Notes

- No `.env` or `.env.local` file exists in the repo.
- Autodesk credentials flow from Bubble.io → API request body → Autodesk OAuth2.
- `POST /api/autodesk` still validates `client_id`/`client_secret` before native/no-translation branching; native 2D upload path bypasses Autodesk translation but keeps credentialed auto-followup compatibility.
- `POST /api/conversion-status` allows credential-less polling only for native fast-path requests (`source_url` provided and URN/source extension resolves to direct 2D no-translation path).
- `DIRECT_2D_NO_TRANSLATION_FORMATS` changes behavior in both routes at once: matching extensions skip Autodesk translation in `/api/autodesk` and can unlock credential-less polling in `/api/conversion-status` when native fast-path guards are met.
- Expanding `DIRECT_2D_NO_TRANSLATION_FORMATS` should be treated as an API-contract change (`viewer.mode="thumbnail"`, synthetic `native2d:*` URN, `accessToken=null` on kickoff) and coordinated with callers before rollout.
- `/api/autodesk` auto-followup for Bubble `modelId` writeback is enabled by default and can be disabled per-request with `auto_modelid=false` or `autoModelId=false`.
- Embed session guest tokens should use an explicit `EMBED_SESSION_SECRET` in production; the built-in fallback secret is intended for local development only.
- Embed Blob helper (`api/embed_helpers/blob-storage.ts`) normalizes `BLOB_READ_WRITE_TOKEN` by removing whitespace/newlines before `list`/`put` calls.
- `POST /api/embed/sessions/{embedSessionId}/files` requires `BLOB_READ_WRITE_TOKEN`; missing token returns controlled `503 Upload storage unavailable`.
- URN-only local viewer flow depends on `BLOB_READ_WRITE_TOKEN`; if missing, `/api/conversion-status` reports local mode unavailable and `/api/viewer-source` cannot resolve a local bubble URL.
- Quote derivative sync to Digifabster also depends on `BLOB_READ_WRITE_TOKEN`, because STEP/DWG is staged into Vercel Blob and sent to Digifabster via `file_url`.
- Digifabster upload and price tweak forwarding are fail-fast when `DIGIFABSTER_UPLOAD_ENDPOINT` / `DIGIFABSTER_PRICE_TWEAK_ENDPOINT` are not set.
- `DIGIFABSTER_UPLOAD_ENDPOINT` can point either to the classic multipart `file_url` contract or to `/v2/upload_models/`; the helper auto-switches to upload-job creation + binary model upload for the latter.
- Native-source sync can still return success if the final sync-record Blob write fails; that cache write is best-effort and should not mask a completed DigiFabster submission.
- No implicit bridge endpoint fallback is used for Digifabster runtime calls.
- Bubble OrderPart writeback is attempted in `/api/conversion-status` when `quote.upload.objectModelId` and `part_id` are available; failures are reported in `quote.orderPartUpdate` diagnostics.
- Bubble flow handler-level suite sets `DIGIFABSTER_PRICE_TWEAK_ENDPOINT` to its local mock endpoint so `POST /api/digifabster-price-tweak` can be verified deterministically.
- Preview validation (2026-04-07) confirmed local mode works when Blob cache persistence succeeds (`viewer.mode="local"` with bubble URL under `/output/1/slotted_disk.svf`).
- `scripts/backfill-bubble-urn-thumbnail.cjs` skips `3mf` by default (`known_incompatible_with_svf_pipeline`); use `--include-3mf` only for explicit compatibility tests.
- Backfill recovery can be scoped with `--window-days=N`; final 2026-05-14 closure used a last-7-days dry run with `--include-missing-urn-with-image` and found `queued=0`.
- Backfill uploads send `auto_modelid:false` so `/api/autodesk` does not spend lambda time on the server-side follow-up loop when the script already polls `/api/conversion-status`.
- Vercel function duration is source-controlled, not env-driven; verify generated `.vc-config.json` and production `vercel inspect` after changing timeout-sensitive routes.
- The hardcoded Bubble Bearer token in `api/bubble-trigger.cts` is a security concern — should be moved to Vercel env vars.
- `/api/sheet-nesting` introduces no required new env vars; it reuses existing `BLOB_READ_WRITE_TOKEN` (optional Blob staging) and existing `DIGIFABSTER_*` settings only when `sync_digifabster=true`.
