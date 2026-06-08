<!-- last-verified: 2026-05-16 -->

# Code Index

## API — Vercel Serverless Functions

| File | Exports | Purpose |
|---|---|---|
| `api/autodesk.cts` | `config`, `POST` | Main conversion endpoint with short-scope format classification and `dry_run` mode, plus dual execution path: native 2D no-translation fast path (`native2d:<ext>:<fingerprint>`, inline thumbnail, direct `syncNativeSourceToDigifabster`) or default SVF-first Autodesk translation kickoff; includes bounded auto-followup to `/api/conversion-status` for Bubble `modelId` writeback |
| `api/conversion-status.cts` | `config`, `POST` | Manifest-driven status endpoint for viewer + optional quote derivative, with native fast-path detection (`native2d:*` URN or direct 2D source), Autodesk bypass + immediate thumbnail-mode success for native path, branch-status inheritance + local cache persistence for Autodesk path, Digifabster sync for quote derivatives (`step`/`dwg`) plus native source fallback (`source_url`/`sourceUrl` + optional file-name aliases), and Bubble writeback diagnostics (`quote.orderPartUpdate`) |
| `api/sheet-nesting.cts` | `config`, `OPTIONS`, `POST` | DXF-only sheet nesting endpoint (`source_url`/`sourceUrl`/`url`, `dxf_content`/`dxfContent`, `dxf_base64`/`dxfBase64`) with grid layout summary, `dry_run` behavior, optional Blob staging for nested output, and optional native-source Digifabster sync |
| `api/viewer-source.cts` | `config`, `GET` | URN lookup endpoint returning cached/generated local viewer source (`localModelUrl` canonical, `bubbleUrl` alias); token-backed cache misses can generate Blob SVF on demand, return `202 processing` for in-progress Autodesk manifests, normalize `access_token`/`accessToken` placeholders (`undefined`, `null`, empty/whitespace) as missing token input so uncached URNs stay on `404 queued`, return `401 autodesk_manifest_unauthorized` for non-placeholder token/manifest auth failures, `424` for failed translation, and `503` when Blob persistence is unavailable |
| `api/bubble-trigger.cts` | `GET`, `POST` | GET: health check. POST: triggers Bubble.io `create_3d_preview` workflow with part_id, image, version, URN |
| `api/embed/sessions/index.cts` | `config`, `POST` | Embed session bootstrap endpoint: validates mode/origin/order constraints, creates new guest session tokens, or resumes/rotates matching guest tokens; persists sessions through async store with `currentPartId` tracking |
| `api/embed/sessions/[embedSessionId].cts` | `config`, `GET` | Dynamic embed session read endpoint: validates query guest token and session-id match, enforces optional `bubbleOrderId` consistency for existing-mode sessions, rotates expiry/token, and returns `currentPart` projection when available |
| `api/embed/sessions/[embedSessionId]/files.cts` | `config`, `POST` | Direct embed upload endpoint: validates guest token/session context, enforces accepted types + max size, uploads source file to Blob, writes part record, and updates session `currentPartId` |
| `api/digifabster-price-tweak.cts` | `config`, `GET`, `POST`, `OPTIONS` | Price-tweaking forwarding endpoint with browser CORS support and hardened Bubble → DigiFabster mapping policy: mapping schema is `{materials, tolerances, postproduction}`; materials map only to live catalog-backed values; tolerance mapping targets exact DigiFabster labels (including vendor typos) and resolves by mapped exact title before tier fallback; postproduction fields (`inspection`, `roughness`, `finish`) all map via `applyTerminologyMapping(..., "postproduction")`; unresolved material labels (for example `Any aluminium`) fail with 400 and available-material diagnostics |
| `api/embed_helpers/contracts.ts` | `EMBED_EVENT_VERSION`, `EMBED_BUBBLE_SOURCE`, `EMBED_VERCEL_SOURCE`, `EMBED_MODES`, `EMBED_SESSION_STATUSES`, `EMBED_STAGE_VALUES`, `EMBED_STAGE_STATUSES`, `DEFAULT_ACCEPTED_FILE_TYPES`, `DEFAULT_MAX_FILE_SIZE_BYTES`, `isEmbedMode`, `normalizeOptionalString`, `normalizeOrigin` | Shared embed contract constants and normalization/type guards used by embed API handlers and iframe page |
| `api/embed_helpers/blob-storage.ts` | `getBlobToken`, `hasBlobToken`, `findBlobByPath`, `readJsonBlob`, `writeJsonBlob` | Shared Blob storage helper for embed slices: normalizes `BLOB_READ_WRITE_TOKEN`, supports JSON read/write durability, and pathname-based Blob lookup |
| `api/embed_helpers/session-token.ts` | `getGuestTokenTtlMs`, `isGuestTokenExpired`, `createGuestToken`, `verifyGuestToken` | Guest token helper: HMAC-SHA256 signing/verification, constant-time signature compare, TTL normalization from env, and structured payload validation for embed session resumability |
| `api/embed_helpers/session-store.ts` | `saveEmbedSession`, `getEmbedSession`, `updateEmbedSession` | Async embed session store: memory-backed cache with optional Blob durability (`embed-sessions/*.json`) and `currentPartId` lifecycle updates |
| `api/embed_helpers/part-store.ts` | `saveEmbedPart`, `getEmbedPart` | Embed part record store for uploaded source files with optional Blob durability (`embed-parts/*.json`) and in-memory fallback |
| `api/autodesk_helpers/index.ts` | `fetchAccessToken`, `createBucket`, `obtainSignedUrl`, `uploadFile`, `finalizeUpload`, `startTranslation`, `getManifest`, `getThumbnail`, `findDerivativeByType`, `getDerivativeDownloadUrl`, `downloadDerivativeFile` | Autodesk helpers for auth/upload/translation + derivative inspection/download with Set-Cookie CloudFront parsing |
| `api/autodesk_helpers/download.ts` | `fetchFileAndConvert` | Fetches a remote file by URL and converts it to a `File` object for upload |
| `api/autodesk_helpers/format-map.ts` | `getQuoteSupportedFormats`, `getDigifabsterNativeFormats`, `getDirect2dNoTranslationFormats`, `getExtension`, `classifySourceFormat`, `shouldSkipAutodeskTranslationForFormat`, `shouldSkipAutodeskTranslationForSource` | Source-format policy helper for quote target mapping (`step`/`dwg`) plus direct 2D Autodesk-translation bypass list (`DIRECT_2D_NO_TRANSLATION_FORMATS`) |
| `api/autodesk_helpers/viewer-cache.ts` | `getViewerCacheRecord`, `ensureViewerBubbleInBlob` | Blob-backed viewer artifact persistence and URN→bubble mapping for local-mode startup; parses root SVF zip manifest and caches dependency assets under output-relative paths |
| `api/autodesk_helpers/digifabster-sync.ts` | `resolveDigifabsterBaseUrl`, `resolveDigifabsterUploadEndpoint`, `resolvePriceTweakingEndpoint`, `resolveDigifabsterTokenExchangeEndpoint`, `buildDigifabsterHeaders`, `syncQuoteDerivativeToDigifabster`, `syncNativeSourceToDigifabster`, `DigifabsterSyncError` | Sync helper for derivative uploads (`step`/`dwg`) and native-source direct uploads, with S2S-first auth plus direct-token fallback on `401/403`, `/v2/upload_models/` job-creation + binary upload compatibility, flexible response parsing (`uj`, array/object payloads), retry/backoff uploads, and Blob-backed sync record caching (`quoteTarget` channels: `step`, `dwg`, `native`) where record writes are best-effort |

## SRC — React Frontend

| File | Exports | Purpose |
|---|---|---|
| `src/main.tsx` | — | App entry: mounts `<App />` into `#root` with StrictMode |
| `src/App.tsx` | `App` (default) | BrowserRouter with `/` (Home), `/viewer` (Viewer), and `/embed/part` (Embed Part Workbench) routes |
| `src/pages/index.tsx` | `Home` (default) | Placeholder home page (`<h1>Home</h1>`) |
| `src/pages/viewer/index.tsx` | `Viewer` (default) | Forge Viewer embed for strict local playback: direct `localModelUrl`/`bubbleUrl` mode plus URN-only lookup through `/api/viewer-source`; token-backed lookup defaults to `300` attempts at `4000ms`, cache-only lookup defaults to `24` attempts at `5000ms`, URL parsing supports `accessToken` alias and normalizes placeholder token values before forwarding, override attempts cap at `900`, and polling cancels stale StrictMode/remount loops before fetch and after delay |
| `src/pages/embed/part.tsx` | `EmbedPartWorkbench` (default) | Embed iframe scaffold: parses and validates query bootstrap params (`mode`, `parentOrigin`, `bubbleOrderId`, `guestToken`), creates/resumes sessions through `/api/embed/sessions`, uploads source files through `/api/embed/sessions/{embedSessionId}/files`, and emits host-facing `postMessage` events for ready/session/upload/part/error lifecycle states |
| `src/helpers/base64converter.ts` | `convertImageToBase64`, `convertBlobToImageFile` | Blob URL → Base64 string / File conversion utilities |
| `src/helpers/download.ts` | `fetchFileAndConvert` | Client-side duplicate of `api/autodesk_helpers/download.ts` (same logic) |
| `src/assets/script.js` | — | Legacy Forge Viewer init script (hardcoded token, mostly commented out) |

## E2E — Playwright

| File | Exports | Purpose |
|---|---|---|
| `playwright.config.ts` | `default` | Playwright config with local webServer fallback and optional remote base URL (`E2E_BASE_URL`) |
| `e2e/viewer-and-conversion.spec.ts` | — | Covers viewer local mode, URN-only local-resolution mode, token-backed `202 processing` polling until `localModelUrl`, placeholder token regression (`viewer ignores placeholder token query values`), cloud-fallback blocking, and dry-run conversion/quote status scenarios; tolerates React StrictMode duplicate initial lookup; skips API HTTP assertions when running against local Vite dev (`E2E_BASE_URL` unset) to avoid local `EISDIR` proxy false negatives; captures screenshots to `test-results/` |

## Scripts — Handler-Level Test Utilities

| File | Exports | Purpose |
|---|---|---|
| `scripts/backfill-bubble-urn-thumbnail.cjs` | — | Ops backfill for Bubble `orderpart` records missing `urn` + thumbnail: defaults to current-month missing-both records, supports `--window-days=N` and `--include-missing-urn-with-image`, preserves existing images, sends `auto_modelid:false` because the script owns conversion-status polling, skips `3mf` by default, retries `/api/autodesk` on timeout/5xx, patches Bubble Data API directly, verifies writeback, and emits `bubble-urn-thumbnail-backfill-report.json` (`2026-05-14` final last-week dry run: `24` records in window, `0` queued) |
| `scripts/viewer-resilience-smoke.ts` | — | Direct-handler viewer resilience guardrail smoke: imports `POST` handlers from `api/autodesk.cts` and `api/conversion-status.cts`, runs deterministic `dry_run` contract checks, and validates viewer-priority behavior when quote fails |
| `scripts/bubble-flow-e2e.ts` | — | Reusable handler-level Bubble STEP flow suite: simulates `/api/autodesk` dry-run upload, polls `/api/conversion-status` through queued/inprogress/success, and validates `/api/digifabster-price-tweak` GET/POST with normalized payload checks |
| `scripts/sheet-nesting-dxf-proof.ts` | — | Handler-level DXF nesting proof for `/api/sheet-nesting`: posts inline `dxf_content` with `dry_run`, validates placement summary and nested geometry, and writes `live-local-nesting-proof-result.json` |
| `scripts/mock-price-tweaker.cjs` | — | Local Express mock endpoint for price-tweaker integration tests; serves fixture, captures calls, and exposes health/reset/introspection endpoints |
| `scripts/e2e-production-proof.cjs` | — | Monolithic production E2E proof: auth cookie → upload → poll conversion/quote upload signals (including `sourceUrl`/`sourceFileName` fallback payload) → price tweak → Playwright screenshot → strict verdict requiring fresh Digifabster quote submission by default (`REQUIRE_FRESH_UPLOAD=0` allows viewer-only compatibility runs) |

## Test Fixtures

| File | Purpose |
|---|---|
| `public/test-fixtures/cutting-blade-1-k110-1.STEP` | 192 KB STEP file for production E2E testing; Digifabster-native format (`quote.status = not_required`) |
| `public/test-fixtures/nesting-sample-plate.dxf` | DXF fixture used by `test:sheet-nesting:dxf` local proof and protected preview `/api/sheet-nesting` contract validation |

## Test Documentation

| File | Purpose |
|---|---|
| `docs/requirements/production-e2e-checkpoint-plan.md` | Step-by-step production checkpoint plan with business context, format classification, and expected outcomes |

## Ops Artifacts

| File | Purpose |
|---|---|
| `bubble-urn-thumbnail-backfill-report.json` | Backfill execution artifact with run summary, per-extension counts, failed/skipped diagnostics, and per-record outcomes |

## Config

| File | Purpose |
|---|---|
| `vite.config.ts` | Vite 5 config: plugins (vercel, react, tsconfigPaths, apiRoutes), permissive iframe headers, Vercel `defaultMaxDuration=60`, and prebuilt SPA rewrites for `/viewer`, `/viewer/(.*)`, `/embed/part`, and `/embed/part/(.*)` |
| `vercel.json` | Vercel schema, API function `maxDuration=60` rules, CORS headers for `/api/*`, and SPA rewrite fallback to `/` |
| `eslint.config.js` | ESLint 9 flat config: typescript-eslint, react-hooks, react-refresh |
| `package.json` | Includes `@vercel/blob` and `fflate` dependencies; includes `test:e2e`, `test:e2e:install`, `test:sheet-nesting:dxf`, and viewer guardrail scripts (`test:viewer:ui`, `test:viewer:contracts`, `test:viewer:guardrail`) |
| `index.html` | HTML shell: loads Autodesk Viewer JS/CSS from CDN, Google Fonts (Akshar) |
| `tsconfig.json` | Root TS config referencing `tsconfig.app.json` and `tsconfig.node.json` |
