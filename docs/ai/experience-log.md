<!-- last-verified: 2026-05-16 -->

# Experience Log

Append-only log of session discoveries, issues, and lessons learned.

## Known Pitfalls

- Protected Vercel preview deployments require share-token + cookie bootstrap before API verification; direct calls can produce false auth failures.
- For `/api/sheet-nesting` preview checks, `source_url` can 401 against protected fixture URLs unless bypass context is propagated; inline `dxf_content` avoids this verification trap.
- Autodesk APS credential entitlement/product-access can change on the app without code changes, causing `403 AUTH-001` even on previously working credentials. New app credentials may be required. (See 2026-04-09 entry below.)
- Vercel `BLOB_READ_WRITE_TOKEN` with trailing newlines or whitespace corruption breaks `@vercel/blob` read/write operations; always validate token format before using in Blob operations.
- `vite-plugin-vercel` can leave generated lambdas at Vercel's 15s default even when route files export `config.maxDuration`; set `vercel.defaultMaxDuration` in `vite.config.ts`, mirror it in `vercel.json` `functions`, then verify local `.vc-config.json` and production `npx vercel inspect` output.
- Prebuilt Vercel deploys for this Vite SPA require `/viewer` rewrites in Vite plugin output as well as the top-level `vercel.json` SPA fallback; otherwise `/viewer` can return platform 404 after `vercel deploy --prebuilt`.
- Autodesk Viewer SDK shell load is not proof of a working viewer. Real viewer validation must include manifest success, resolved local SVF URL, Blob `HEAD 200`, and rendered canvas/geometry evidence.
- Short frontend polling windows can create false viewer failures for slower Autodesk translations and local-cache generation. Token-backed URN flows need long polling plus explicit `202 processing` semantics.
- Normalize query-token placeholders (`undefined`, `null`, empty, whitespace-only) as missing token input in both API and frontend before branch logic. Forwarding placeholder values can flip expected `404 queued` cache-miss behavior into unintended token-auth branches.
- Embed iframe bootstrap flows should keep validation boundaries strict: enforce `mode` + `parentOrigin` + `bubbleOrderId` consistency at the API edge and require guest-token/session-id match on dynamic read routes.
- Embed direct-upload flows should treat missing `BLOB_READ_WRITE_TOKEN` as a controlled dependency failure (`503 Upload storage unavailable`), not as a contract regression.
- Native 2D no-translation flow has split credential behavior: `/api/autodesk` still validates `client_id`/`client_secret` before native branching, while `/api/conversion-status` can skip Autodesk credential requirements only when native fast-path detection is active (`source_url` present + `native2d:*` URN or direct 2D source extension).

---

## Entries

### 2026-05-16 — Native 2D No-Translation Fast Path Documentation Closure
- **Issue**: Canonical docs still described Autodesk translation as mandatory for all upload/polling paths and did not capture the new `native2d:*` contract.
- **Trigger**: Backend implementation added direct 2D no-translation behavior across `api/autodesk.cts`, `api/conversion-status.cts`, and `api/autodesk_helpers/format-map.ts`.
- **Impact**: Medium — stale docs could cause callers to send unnecessary credentials/assumptions, mis-handle `viewer.mode="thumbnail"`, and miss env/config controls for direct 2D formats.
- **Fix/Workaround**: Updated canonical references (`memories/repo/api-routes.md`, `memories/repo/env-vars.md`, `memories/repo/code-index.md`, `memories/repo/project-map.md`) plus AI context to document synthetic URN generation, thumbnail response fields, native fast-path detection and credential rules, and `DIRECT_2D_NO_TRANSLATION_FORMATS` behavior.
- **Verification outcomes**: Docs closure verified against live source in `api/autodesk.cts`, `api/conversion-status.cts`, and `api/autodesk_helpers/format-map.ts`; Repomix/GitNexus MCP surfaces were unavailable in this runtime, so deterministic file reads + targeted pattern search were used.
- **Prevention**: When conversion behavior bifurcates (Autodesk-backed vs native bypass), keep route contracts explicit about branch conditions, credential expectations, and response-mode markers (`cloud/local/thumbnail`) in both canonical and human docs.
- **Related files**: `api/autodesk.cts`, `api/conversion-status.cts`, `api/autodesk_helpers/format-map.ts`, `memories/repo/api-routes.md`, `memories/repo/env-vars.md`, `memories/repo/code-index.md`, `memories/repo/project-map.md`, `docs/ai/context.md`

### 2026-05-16 — Embed Session Durability Delta: Blob-Backed Session/Part Records + Direct Upload Contract
- **Issue**: The initial embed bootstrap slice could create/resume sessions but did not yet persist uploaded source files or expose current part context across session reads.
- **Trigger**: Added Blob-backed storage helper, async session store upgrade, embed part record store, direct upload route, and embed UI upload/event flow.
- **Impact**: Medium — embed lifecycle now includes durable source upload metadata and `currentPart` projection, which are prerequisites for downstream processing stages.
- **Fix/Workaround**: Added `api/embed_helpers/blob-storage.ts` with token normalization (`replace(/[\r\n\s]+/g, "")`), upgraded `api/embed_helpers/session-store.ts` to async memory + optional Blob durability with `currentPartId`, added `api/embed_helpers/part-store.ts`, implemented `POST /api/embed/sessions/{embedSessionId}/files`, and updated `src/pages/embed/part.tsx` to upload directly and emit `vercel.embed.processing.stage` / `vercel.embed.part.created`.
- **Verification outcomes**: `pnpm build` passed; `pnpm lint` passed; direct create/read/upload handler smoke returned `create=200`, `read=200`, and `upload=503` with `Upload storage unavailable` when local `BLOB_READ_WRITE_TOKEN` is missing (expected contract behavior).
- **Prevention**: Keep guest-token/session-context checks strict on upload route, keep Blob token normalization centralized, and preserve explicit 503 dependency signaling when upload storage is not configured.
- **Related files**: `api/embed_helpers/blob-storage.ts`, `api/embed_helpers/session-store.ts`, `api/embed_helpers/part-store.ts`, `api/embed/sessions/index.cts`, `api/embed/sessions/[embedSessionId].cts`, `api/embed/sessions/[embedSessionId]/files.cts`, `src/pages/embed/part.tsx`, `memories/repo/api-routes.md`, `memories/repo/code-index.md`, `memories/repo/env-vars.md`

### 2026-05-16 — Embed Session Bootstrap: Shared Contracts, Token TTL, And Dynamic Route Guardrails
- **Issue**: The new `/embed/part` flow required a session bootstrap contract that could safely resume state across iframe reloads without leaking cross-session access.
- **Trigger**: Added shared embed helpers plus new API endpoints `POST /api/embed/sessions` and `GET /api/embed/sessions/{embedSessionId}`.
- **Impact**: Medium — this slice defines the security and lifecycle boundary for all future Bubble iframe interactions and event-driven embed state recovery.
- **Fix/Workaround**: Centralized embed constants/normalizers in `api/embed_helpers/contracts.ts`; implemented HMAC-signed guest tokens with constant-time signature checks and TTL clamping in `api/embed_helpers/session-token.ts`; enforced strict create/resume validation (`mode`, `parentOrigin`, `bubbleOrderId`) and token/session consistency checks on both create and dynamic read handlers.
- **Verification outcomes**: `pnpm build` passed; `pnpm lint` passed; direct `tsx` smoke invocation for `api/embed/sessions/index.cts` and `api/embed/sessions/[embedSessionId].cts` returned 200 responses with matching `embedSessionId` for create/read.
- **Prevention**: Keep token signing secret explicit in production (`EMBED_SESSION_SECRET`), keep TTL bounded via `EMBED_GUEST_TOKEN_TTL_SECONDS`, and keep dynamic route reads locked to token-bound `embedSessionId` (plus optional `bubbleOrderId` consistency checks for existing-mode sessions).
- **Related files**: `api/embed_helpers/contracts.ts`, `api/embed_helpers/session-token.ts`, `api/embed_helpers/session-store.ts`, `api/embed/sessions/index.cts`, `api/embed/sessions/[embedSessionId].cts`, `src/pages/embed/part.tsx`, `src/App.tsx`

### 2026-05-14 — Viewer Source Regression: Placeholder Token Query Normalization
- **Issue**: Uncached URN lookups could take the wrong token-backed branch when URL query tokens used placeholder values such as `access_token=undefined`.
- **Trigger**: Production contract check required placeholder token values to behave as missing token input.
- **Impact**: High — API/frontend contract drift on token parsing can change uncached-URN behavior and hide real unauthorized-token responses.
- **Fix/Workaround**: Added query-token normalization in `api/viewer-source.cts` and `src/pages/viewer/index.tsx` to treat `undefined`, `null`, and empty/whitespace values as missing token; frontend URL parsing now supports `accessToken` alias and does not forward placeholder tokens to `/api/viewer-source`.
- **Verification outcomes**: `pnpm build` passed; `pnpm test:e2e -- e2e/viewer-and-conversion.spec.ts` returned `5 passed, 2 skipped`; local direct handler invocation with `access_token=undefined` returned `404 queued`; production post-deploy contract checks returned `404 queued` (uncached URN with no token), `404 queued` (`access_token=undefined`), and `401 unauthorized` (invalid non-placeholder token).
- **Deployment evidence**: Inspect URL `https://vercel.com/citizendevio/project-entag-3d-viewer/DpcKUxoBxcDHqo1DHjZTAeyEfmHY`; deployment URL `https://project-entag-3d-viewer-7dxckqczd-citizendevio.vercel.app`; alias `https://project-entag-3d-viewer.vercel.app`.
- **Prevention**: Keep token placeholder normalization logic aligned between API and viewer URL parsing, and lock the contract with regression coverage.
- **Related files**: `api/viewer-source.cts`, `src/pages/viewer/index.tsx`, `e2e/viewer-and-conversion.spec.ts`, `memories/repo/api-routes.md`, `memories/repo/code-index.md`

### 2026-05-14 — Viewer Recovery: Rendered Geometry Proof + Processing Polling
- **Issue**: Viewer still appeared broken after the Vercel timeout/rewrite fix because the frontend gave up while Autodesk translation/local-cache generation was still in progress.
- **Trigger**: Vercel expanded logs showed real upload `POST /api/autodesk 200` at `2026-05-14 21:27:24` local for `phone-holder.STEP` with URN `dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6MTc3ODc2ODg0NTQwMy9waG9uZS1ob2xkZXIuU1RFUA`; `/api/conversion-status` at `21:27:26` returned `viewerStatus=inprogress`, then the browser repeatedly polled `/api/viewer-source` `404` until timeout.
- **Impact**: High — Autodesk translation was healthy, but the app reported viewer failure before a real translated/local SVF source was ready.
- **Root cause**: Direct Autodesk manifest for the same URN later returned `success`/`complete` with normal SVF graphics node `output/1/phone-holder.svf`; the previous frontend lookup window was too short and `/api/viewer-source` masked token-backed in-progress state as missing cache.
- **Fix/Workaround**: `api/viewer-source.cts` now returns `202 processing` with `viewerStatus`, `retryAfterMs`, and hint for token-backed in-progress translations, returns `401 autodesk_manifest_unauthorized` for token/manifest auth failures, and preserves `424` for failed translations. `src/pages/viewer/index.tsx` now defaults token-backed URN lookup to `300` attempts at `4s`, cache-only lookup to `24` attempts at `5s`, caps overrides at `900`, and cancels stale StrictMode/remount polling loops.
- **Verification outcomes**: Focused Playwright regression passed; full `e2e/viewer-and-conversion.spec.ts` passed `4/4`; `pnpm build` and `pnpm lint` passed; production deployment `dpl_9QW3Nta6mq8Jn7Fubf78CFgr8pks` is Ready and aliased to `https://project-entag-3d-viewer.vercel.app`; production `/api/viewer-source` for the phone-holder URN returned `200 source=cache` with `localModelUrl`; Blob `HEAD` returned `200 application/octet-stream`; production `/viewer?urn=...` rendered real geometry with Autodesk controls, `canvasCount=2`, and WebGL center pixel `[177,185,207,255]`.
- **Prevention**: Do not accept SDK shell load or route availability as viewer proof. Validate the complete chain: Autodesk manifest `success`, local SVF URL resolved/generated, Blob `HEAD 200`, and rendered canvas/visible geometry in browser.
- **Related files**: `src/pages/viewer/index.tsx`, `api/viewer-source.cts`, `e2e/viewer-and-conversion.spec.ts`, `memories/repo/api-routes.md`, `memories/repo/code-index.md`

### 2026-05-14 — Viewer Recovery: Vercel Function Timeout + Prebuilt Viewer Rewrite
- **Issue**: Viewer recovery still failed after Vercel Blob capacity was upgraded because production API lambdas were deployed with a 15s timeout, and the first prebuilt redeploy returned a platform 404 for `/viewer`.
- **Trigger**: `npx vercel inspect project-entag-3d-viewer.vercel.app --scope citizendevio --format=json` showed `api/autodesk` `timeout: 15` on deployment `dpl_29aBCEbmEKLbCJsmgTdaJnSJgrKz`; prebuilt output lacked the SPA route rewrite for `/viewer`.
- **Impact**: High — `/api/autodesk` timed out on remaining SLDPRT/X_T backfill records with `504 FUNCTION_INVOCATION_TIMEOUT`, and direct viewer entry could fail before the React app loaded.
- **Fix/Workaround**: Added `vercel.defaultMaxDuration = 60` and `/viewer` rewrites to `vite.config.ts`, added matching `functions` `maxDuration` rules to `vercel.json`, and updated `scripts/backfill-bubble-urn-thumbnail.cjs` so last-week backfills can use `--window-days=N`, include records missing URN while preserving existing image values, and pass `auto_modelid: false` because the script already owns `/api/conversion-status` polling.
- **Verification outcomes**: Local generated `.vercel/output/functions/api/autodesk.func/.vc-config.json` and `.vercel/output/functions/api/conversion-status.func/.vc-config.json` showed `maxDuration: 60`; final deployment `dpl_J7cjtAFsm1w2guqkQH9FD1MZUMS3` (`https://project-entag-3d-viewer-ohxbpsqju-citizendevio.vercel.app`) is aliased to `https://project-entag-3d-viewer.vercel.app` and inspected with `api/autodesk` timeout `60`; live probes returned `200` for `/`, `/viewer`, and `/viewer?urn=test&lookupAttempts=1&lookupIntervalMs=20`, `405` for `GET /api/autodesk` as expected, and queued `404` JSON for a missing test URN; production `/api/autodesk` dry-run returned `200`, `success=true`, `viewer=queued`, `quote=not_required`; `pnpm build` and `pnpm lint` passed.
- **Backfill outcome**: After the deploy fix, the remaining 5 last-week records updated successfully (`viewer=success/local`, `quote=success`). Final dry-run report shows `recordsInWindow=24`, `missingUrnAndImage=0`, `missingUrnWithImage=0`, and `queued=0`.
- **Prevention**: Treat generated Vercel output and live deployment inspect results as required evidence for function duration changes; probe SPA deep links after prebuilt deploys; keep external backfill orchestration on `auto_modelid: false` to avoid spending upload-function time on an internal follow-up loop.
- **Related files**: `vite.config.ts`, `vercel.json`, `scripts/backfill-bubble-urn-thumbnail.cjs`, `bubble-urn-thumbnail-backfill-report.json`, `memories/repo/api-routes.md`, `memories/repo/project-map.md`

### 2026-05-07 — Viewer Resilience Guardrail: Local API Proxy Instability + Deterministic Contract Checks
- **Issue**: Viewer resilience verification mixed UI checks with HTTP API checks in Playwright, but local Vite `/api/*` proxy runs can return `EISDIR`/`403`, creating false negatives unrelated to handler contracts.
- **Trigger**: Running viewer/conversion resilience checks across local and deployed environments after hardening updates.
- **Impact**: Medium — local runs can incorrectly fail API assertions, reducing confidence in regression signals.
- **Fix/Workaround**: Added deterministic guardrails by skipping API HTTP tests in `e2e/viewer-and-conversion.spec.ts` when `E2E_BASE_URL` is unset (local Vite mode), introducing `scripts/viewer-resilience-smoke.ts` for direct handler dry-run contract checks, and standardizing scripts `test:viewer:ui`, `test:viewer:contracts`, `test:viewer:guardrail`.
- **Verification outcomes**: Post-deploy Node fetch probes against alias `https://project-entag-3d-viewer.vercel.app` passed: `POST /api/autodesk` dry run (`200`, `quote.targetFormat=step`, `quote.status=queued`), `POST /api/conversion-status` dry run (`200`, `viewer.priority=true` with quote failed), and `GET /viewer?bubbleUrl=...` (`200`). Deployment URL `https://project-entag-3d-viewer-oud1nrft0-citizendevio.vercel.app` and alias are live.
- **Prevention**: Keep local resilience checks split by concern: Playwright for viewer UI behavior and direct-handler smoke checks for API contract assertions.
- **Related files**: `e2e/viewer-and-conversion.spec.ts`, `scripts/viewer-resilience-smoke.ts`, `package.json`

### 2026-05-07 — Bubble URN/Thumbnail Backfill: Timeout Retry + Direct Bubble Patch Fallback
- **Issue**: Current-month Bubble `orderpart` records missing both `urn` and `image` needed bulk remediation, while workflow-trigger route checks did not provide a reliable `create_3d_preview` path in production (`404 upstream` observed).
- **Trigger**: Production ops run via `scripts/backfill-bubble-urn-thumbnail.cjs` and its generated `bubble-urn-thumbnail-backfill-report.json`.
- **Impact**: Medium — run processed 45 candidates and finished with `30 updated`, `3 failed`, `12 skipped`; failed IDs were `1778071806411x619759699973728900`, `1778071565826x663847212970952700`, and `1777810230293x126060533905566050` (all `autodesk_upload` with HTTP `504 FUNCTION_INVOCATION_TIMEOUT`).
- **Fix/Workaround**: Script retries `/api/autodesk` uploads for retryable timeout/5xx failures, polls `/api/conversion-status`, fetches Autodesk thumbnails, then patches Bubble Data API `orderpart/{id}` directly and verifies writeback.
- **Prevention**: Keep default skip for `3mf` (`known_incompatible_with_svf_pipeline`) unless explicitly overridden with `--include-3mf`; preserve failed-ID reporting for deterministic reruns; do not assume `/api/bubble-trigger` is available for bulk backfill operations.
- **Related files**: `scripts/backfill-bubble-urn-thumbnail.cjs`, `bubble-urn-thumbnail-backfill-report.json`, `memories/repo/api-routes.md`

### 2026-05-07 — AI Toolchain Sync: Workspace Drift Closed From v1.4.0 To v1.5.0
- **Issue**: Workspace marker and policy surfaces lagged user-level toolchain `v1.5.0`, so session-continuity and lifecycle-routing updates were not fully reflected in workspace docs.
- **Trigger**: Explicit toolchain sync request against `~/.copilot/VERSION.md` (`v1.5.0`).
- **Impact**: Medium — stale workspace policy metadata can cause cross-tool behavior drift and incomplete sync-state visibility.
- **Fix/Workaround**: Updated marker and policy surfaces to `v1.5.0`, including `AGENTS.md`, `.github/ai-toolchain-version.md`, `.github/copilot-instructions.md`, `.github/instructions/*`, and `.continue/checks/*`; refreshed AI context and added run-log evidence.
- **Prevention**: Treat `.github/ai-toolchain-version.md` as a hard closure gate and update toolchain-managed metadata files in the same sync run so policy surfaces stay consistent.
- **Related files**: `.github/ai-toolchain-version.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `docs/ai/context.md`

### 2026-05-04 — Protected Preview DXF Source Fetch Can 401 Without Bypass Context
- **Issue**: Protected preview verification of `/api/sheet-nesting` can fail when `source_url` points to protected fixture URLs.
- **Trigger**: Using remote `source_url` in preview checks without replaying bypass cookie/header context to that source fetch path.
- **Impact**: Medium — false-negative endpoint verification despite valid nesting route behavior.
- **Fix/Workaround**: For contract verification, post inline `dxf_content` (or `dxf_base64`) directly; when URL source is required, bootstrap and pass bypass context.
- **Prevention**: Prefer inline DXF payloads for protected-preview endpoint checks to isolate route logic from protected source-fetch auth.
- **Related files**: `api/sheet-nesting.cts`, `scripts/sheet-nesting-dxf-proof.ts`, `live-preview-sheet-nesting-result.json`

### 2026-05-01 — AI Toolchain Sync: Workspace Drift Closed From v1.0.0 To v1.4.0
- **Issue**: Workspace toolchain marker and managed assets were still at `v1.0.0`, and Codex parity surfaces (`.codex/`, `.agents/skills/`) were missing.
- **Trigger**: Full sync request against user-level manifest `~/.copilot/VERSION.md` (`v1.4.0`).
- **Impact**: Medium — stale policy/load-order guidance can cause agent behavior drift and incomplete dual-tool compatibility in future sessions.
- **Fix/Workaround**: Updated marker and managed markdown assets to `v1.4.0`, added executable sync checklist in `.github/ai-toolchain-version.md`, created `.codex/config.toml`, `.codex/rules/default.rules`, and `.agents/skills/README.md` with resolved local runtime paths where available.
- **Prevention**: Treat `.github/ai-toolchain-version.md` as a hard gate; run sync whenever the user-level manifest version is newer and always close with run-log + experience-log entries. If Experience Memory Curator tooling is unavailable, explicitly log the pending handoff instead of silently skipping it.
- **Related files**: `.github/ai-toolchain-version.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.codex/config.toml`, `.codex/rules/default.rules`, `.agents/skills/README.md`

### 2026-04-21 - Viewer Source 500 From Unauthorized Autodesk Manifest Fetch
- **Issue**: `GET /api/viewer-source` returned `500` when called with `urn` + `access_token`.
- **Trigger**: On-demand local cache generation (`ensureViewerBubbleInBlob`) attempted Autodesk manifest fetch with an expired/invalid token.
- **Impact**: High - local-only viewer flow failed with generic server error instead of actionable auth guidance.
- **Root cause (Vercel logs)**: Runtime stack trace showed `Failed to fetch manifest: Unauthorized` bubbling from `getManifest` through `ensureViewerBubbleInBlob` into `viewer-source` catch-all `500` response.
- **Fix/Workaround**:
  1. `api/viewer-source.cts` now classifies this as `401 unauthorized` with retry hint, and maps other upstream generation faults to `502`.
  2. `src/pages/viewer/index.tsx` polling now handles non-404 statuses more safely and shows explicit token-expired guidance.
- **Validation**:
  1. `pnpm build` passed.
  2. Focused viewer Playwright tests passed (3/3).
  3. Production redeployed at `https://project-entag-3d-viewer-gz08iiitk-citizendevio.vercel.app`.
  4. Reproduced same payload now returns `401` with structured unauthorized JSON instead of `500`.
- **Related files**: `api/viewer-source.cts`, `src/pages/viewer/index.tsx`

### 2026-04-21 — Viewer Source 404 After Local-Only Switch: Persistence Bootstrap Gap
- **Issue**: `/api/viewer-source` returned repeated 404 and viewer modal showed local-source-not-ready after cloud fallback was removed.
- **Trigger**: Local-only viewer opened with `urn` + `access_token` while no cached `localModelUrl` record existed yet.
- **Impact**: High — viewer blocks with local-only error even though upload/translation flow started successfully.
- **Root cause (Vercel evidence)**:
  1. Deployment logs showed repeated `GET /api/viewer-source` with `404`.
  2. `POST /api/conversion-status` logs showed `viewerStatus: "inprogress"` and `viewerMode: "cloud"` at auto-followup time, so local cache persistence branch (`viewerStatus === "success"`) did not run yet.
  3. Viewer page still used token-short-circuit retries (`2` attempts), which is too short for local readiness after strict local-only behavior.
- **Fix/Workaround**:
  1. `api/viewer-source.cts` now accepts `access_token` query param and calls `ensureViewerBubbleInBlob()` on cache miss to bootstrap local cache generation on demand.
  2. `src/pages/viewer/index.tsx` now forwards `access_token` to `/api/viewer-source` and uses longer polling defaults suitable for local-only flow.
  3. Added optional URL overrides (`lookupAttempts`, `lookupIntervalMs`) for controlled test/runtime tuning.
- **Validation**: `pnpm build` passed; focused viewer Playwright tests passed (3/3).
- **Related files**: `api/viewer-source.cts`, `src/pages/viewer/index.tsx`, `e2e/viewer-and-conversion.spec.ts`

### 2026-04-20 — Viewer Enforced As Strict Local-Only (Cloud Fallback Removed)
- **Issue**: URLs containing `urn` + `access_token` could still enter Autodesk cloud document loading when local source lookup failed.
- **Trigger**: Requirement to prevent all Autodesk cloud model/manifest loading and keep playback local SVF-only.
- **Impact**: High (intentional behavior change) — viewer no longer attempts cloud `Document.load`; it now blocks with explicit error when local source is unavailable.
- **Fix/Workaround**: Removed cloud initialization path from `src/pages/viewer/index.tsx` and made viewer bootstrap always use `env: "Local"` + `viewer.loadModel(localUrl)` only.
- **Prevention**: Keep local-source readiness (`/api/viewer-source`) as a hard prerequisite for playback; treat missing local source as user-visible error, not a cloud fallback condition.
- **Validation**: `pnpm build` passed; focused Playwright viewer tests passed (3/3) including cloud-fallback-blocked scenario.
- **Deployment**: Production deploy `https://project-entag-3d-viewer-54p8ew53b-citizendevio.vercel.app` aliased to `https://entag.project.citizendev.io`.
- **Related files**: `src/pages/viewer/index.tsx`, `e2e/viewer-and-conversion.spec.ts`

### 2026-04-20 — Viewer URN Mode No Longer Skips Local Resolution When Token Exists [superseded]
- **Issue**: Viewer startup treated `access_token` in URL as cloud-first and skipped local URN source resolution.
- **Trigger**: Opening `/viewer?urn=...&access_token=...` while expecting local SVF playback from Blob cache.
- **Impact**: High for local-first architecture — viewer calls Autodesk derivative CDN and can fail on token/401.
- **Fix/Workaround**: Updated `src/pages/viewer/index.tsx` to always attempt URN local resolution first,
  wait for resolution completion before initializing the viewer, and only fallback to cloud when local
  source remains unavailable and token is present.
- **Prevention**: Treat token presence as cloud fallback capability, not as a reason to bypass local
  source lookup; monitor `viewer.mode` and `viewer.localError` from `/api/conversion-status`.
- **Related files**: `src/pages/viewer/index.tsx`, `api/conversion-status.cts`,
  `api/autodesk_helpers/viewer-cache.ts`, `checkpoint-state.json`

### 2026-04-09 — DigiFabster Terminology Mapping Policy Hardened To Live Catalog Values
- **Issue**: Legacy mapping structure and broad material aliases could resolve to non-catalog targets, making request outcomes less deterministic.
- **Trigger**: Hardened `POST /api/digifabster-price-tweak` mapping policy and terminology schema in `api/digifabster-price-tweak.cts`.
- **Impact**: Medium — invalid generic material labels now fail fast with explicit 400 diagnostics; tolerance and post-production mapping behavior is more deterministic.
- **Fix/Workaround**: Replaced mapping schema with `{ materials, tolerances, postproduction }`, removed separate `inspection`/`roughness`/`finish` tables, restricted material mappings to live machine catalog values, mapped tolerances to exact DigiFabster labels (including vendor typos) with exact-mapped-title-first resolution, and switched post-production call sites to `applyTerminologyMapping(..., "postproduction")`.
- **Prevention**: Keep mapping tables synchronized only with live DigiFabster option titles; reject non-catalog labels (for example `Any aluminium`) with `details.available` guidance instead of applying loose category inference.
- **Related files**: `api/digifabster-price-tweak.cts`, `memories/repo/api-routes.md`, `memories/repo/code-index.md`

### 2026-04-09 — Strict Catalog-Backed Material Validation In Price Tweaker
- **Issue**: Loose material matching could allow ambiguous material resolution and hide catalog mismatch cases.
- **Trigger**: Updated `POST /api/digifabster-price-tweak` to validate material strictly against DigiFabster catalog titles.
- **Impact**: Medium — incompatible material labels now fail fast with actionable 400 payloads; valid exact catalog labels continue to succeed.
- **Fix/Workaround**: Enforced exact normalized-title matching, validated requested/mapped material against all materials from `/v2/machines_materials/`, returned global-catalog 400 diagnostics (`details.requested`, `details.mapped`, `details.available`), returned machine-scoped 400 diagnostics when explicit machine/material is incompatible, and allowed machine switch only when machine is implicit.
- **Prevention**: Keep material resolution deterministic by validating against live catalog data and returning full available-material diagnostics on mismatch.
- **Related files**: `api/digifabster-price-tweak.cts`, `memories/repo/api-routes.md`, `memories/repo/code-index.md`

### 2026-04-09 — Price Tweaker Material Fallback + Non-Fatal Tolerance/Postproduction Resolution
- **Issue**: Price tweaker requests could fail with `400 Missing materialId` when payload supplied labels (`machineName`, `materialName`, post-production fields) that did not resolve cleanly against a single machine context.
- **Trigger**: Updated `POST /api/digifabster-price-tweak` resolution flow to support cross-catalog material lookup and relaxed strict failure behavior for certain optional mappings.
- **Impact**: Medium — production payloads that previously failed now return successful price responses when core model + machine/material can be resolved, while still exposing diagnostics/warnings for partial mapping gaps.
- **Fix/Workaround**: Added cross-catalog material fallback when explicit `machineId` is missing, enriched material resolution diagnostics in 400 payload, made tolerance-text override non-fatal when tolerance options list is empty, and surfaced unresolved post-production labels under `warnings.skippedPostproductionLabels` instead of failing.
- **Prevention**: Keep label-based mapping paths fault-tolerant and observable: fail only for hard requirements (`objectModelId`, unresolved material), and return warning envelopes for optional decoration fields (post-production labels) to preserve quote continuity.
- **Related files**: `api/digifabster-price-tweak.cts`, `memories/repo/api-routes.md`, `memories/repo/code-index.md`

### 2026-04-09 — Autodesk Auto-Followup ModelId Writeback After Translation Kickoff
- **Issue**: Bubble OrderPart `modelId` writeback depended on client-side polling timing after `/api/autodesk` returned.
- **Trigger**: Added bounded server-side follow-up loop in `POST /api/autodesk` that calls `POST /api/conversion-status` after translation starts.
- **Impact**: Medium — kickoff response now includes immediate follow-up diagnostics and can complete Bubble writeback without waiting for a separate client poll cycle.
- **Fix/Workaround**: Added request flags `auto_modelid` / `autoModelId` (default enabled) to control follow-up, returned `autoFollowup` in response (`updated`/`failed`/`timeout`/`disabled`) with attempts, endpoint, and last snapshot, and added runtime knobs `AUTO_MODELID_ATTEMPTS` + `AUTO_MODELID_INTERVAL_MS`.
- **Prevention**: Keep bounded retry defaults in env and monitor `autoFollowup.status` in API consumers; disable only when external orchestration handles writeback explicitly.
- **Related files**: `api/autodesk.cts`, `memories/repo/api-routes.md`, `memories/repo/env-vars.md`, `docs/architecture/edge-functions.md`

### 2026-04-09 — Bubble Data API OrderPart modelId Writeback In Conversion Status
- **Issue**: Digifabster quote upload could succeed (`quote.upload.objectModelId`) without persisting the generated `modelId` back to Bubble Data API `orderpart/{part_id}`.
- **Trigger**: Added writeback support in `POST /api/conversion-status` after quote sync when `objectModelId` is present.
- **Impact**: Medium — Bubble records can now be updated in-line during conversion polling; failed/omitted writeback is surfaced as diagnostics and can hard-fail quote status for observability.
- **Fix/Workaround**: Added Bubble Data API PATCH call with configurable base URL/type/field and token inputs from request body or env; response now includes `quote.orderPartUpdate` (`updated`/`skipped`/`failed`) with endpoint/status/error context.
- **Prevention**: Keep Bubble Data API credentials and modelId field mapping explicit per environment, and monitor `quote.orderPartUpdate.status` in polling clients instead of assuming quote sync implies Bubble writeback success.
- **Related files**: `api/conversion-status.cts`, `memories/repo/api-routes.md`, `memories/repo/env-vars.md`

### 2026-04-09 — Missing Explicit CORS Preflight Handling On Price Tweaker Route
- **Issue**: Browser calls from Bubble/app origins to `/api/digifabster-price-tweak` could fail at preflight or consume non-CORS error payloads because the route did not explicitly answer `OPTIONS` and did not consistently attach request-aware CORS headers on all responses.
- **Trigger**: Cross-origin validation against production alias from `https://app.entag.co` exposed the need for explicit preflight handling and consistent CORS headers on both success and error paths.
- **Impact**: High — endpoint appears unavailable to browser clients even when server logic is correct, blocking Bubble-integrated pricing flow.
- **Fix/Workaround**: Added `buildCorsHeaders(req)`, implemented `OPTIONS` with `204`, and updated `json()` so GET/POST success + error responses include merged CORS headers.
- **Prevention**: Treat CORS as part of route contract for browser-consumed APIs: implement explicit `OPTIONS`, centralize header generation, and include preflight + error-path CORS assertions in deployment smoke checks.
- **Related files**: `api/digifabster-price-tweak.cts`

### 2026-04-09 — Credential Entitlement Change + E2E Runtime Injection Pattern 
- **Issue**: Autodesk API returned `403 AUTH-001` despite identical code working moments before, suggesting infrastructure/entitlement change on the app side, not logic errors.
- **Trigger**: Existing Autodesk credentials failed; new APS app credentials provided by user worked immediately with no code changes.
- **Impact**: High — production-blocking until credentials rotated; suggests APS API access can be revoked without developer notification.
- **Fix/Workaround**: 
  1. Updated E2E runner (`scripts/full-e2e-proof.cjs`) to accept runtime credential injection via `E2E_CLIENT_ID` and `E2E_CLIENT_SECRET` env vars.
  2. Modified `readCreds()` to prioritize env vars over local `creds.txt` file, enabling Bubble-like credential passing without hardcoding.
  3. Validated new credentials work directly (OAuth token exchange succeeds).
  4. Full E2E ran successfully with new creds: upload → local viewer (SVF mode) → DigiFabster model creation → price tweaker.
- **Prevention**: 
  1. Keep APS credentials in Bubble secrets, not Vercel env.
  2. Use runtime credential injection in E2E/pre-deploy checks to simulate real Bubble payload flows.
  3. Add monitoring/alerting for `403` responses on `/api/autodesk` to detect entitlement changes early.
- **Related files**: `scripts/full-e2e-proof.cjs`, `api/autodesk.cts`
- **Deployment**: New production alias created `https://entag.project.citizendev.io`; E2E validates full flow end-to-end.

### 2026-04-09 — Local Viewer Mode Architecture & Cache Generation vs. Playback
- **Issue**: User clarified architectural concern: whether Autodesk API is still needed after first-time cache generation for local-only playback.
- **Trigger**: Traced code flow between `/api/autodesk` (cache generation), `/api/conversion-status` (SVF polling + cache build), `/api/viewer-source` (cached bubble URL lookup).
- **Impact**: Low — clarifies deployment model; no code changes needed.
- **Fix/Workaround**:
  1. Confirmed: First cache generation requires APS manifest fetch (`GET /modelderivative/v2/designdata/{urn}/manifest`).
  2. Verified: Local playback uses only cached Blob SVF URLs from `viewer-cache.ts` — no APS calls needed.
  3. Deployment model is sound: cache built once, reused indefinitely until model updated.
- **Prevention**: Document the two-phase model clearly; don't store APS tokens in Vercel — credentials come from Bubble on each upload.
- **Related files**: `api/autodesk_helpers/viewer-cache.ts`, `api/conversion-status.cts`, `api/viewer-source.cts`

### 2026-04-09 — Full Production E2E Validated With New Credentials
- **Issue**: Needed to validate entire flow with working credentials after entitlement issue resolved.
- **Trigger**: Ran `scripts/full-e2e-proof.cjs` with env-injected credentials against production deployment.
- **Impact**: Low — validates all integration points.
- **Fix/Workaround**: 
  1. Auth check: PASS (deployment reachable)
  2. Upload: PASS (HTTP 200, URN returned, format step, viewer queued)
  3. Viewer polling: PASS (reached `status=success`, `mode=local`, localModelUrl present after 2 polls)
  4. DigiFabster sync: PASS (objectModelId 4290754, quote status success with upload status cached)
  5. Price tweaker: PASS (HTTP 200, first machine/material selected, price $1462.66, holes 1)
  6. **Verdict: PASS** — entire Bubble-style flow works.
- **Prevention**: Run this E2E after every production deploy; production deployment URL in script defaults to canonical `project-entag-3d-viewer.vercel.app`.
- **Related files**: `scripts/full-e2e-proof.cjs`, `full-e2e-result.json`
- **Proof**: Complete JSON result saved to `full-e2e-result.json` with all step details.

### 2026-04-09 — STEP Upload Recovery And DigiFabster `upload_models` Compatibility
- **Issue**: Live STEP flow could fail across two boundaries: `/api/autodesk` was not reliably returning success for STEP kickoff, and downstream DigiFabster upload handling assumed a single JSON-style upload contract with S2S-only auth.
- **Trigger**: Production validation against DigiFabster endpoints that expect `multipart/form-data` upload calls, `/v2/upload_models/` job creation + binary model upload, and inconsistent response shapes (`uj`, array payloads).
- **Impact**: High — Bubble flow could stop before quote handoff, leaving `quote.status` unresolved and no `objectModelId` for price tweaking.
- **Fix/Workaround**: Kept STEP uploads on the successful Autodesk kickoff path, added DigiFabster auth fallback (S2S first, direct token on `401/403`), removed forced JSON content-type from upload calls, added `/v2/upload_models/` compatibility, parsed `uj` plus array/object upload responses, made sync-record Blob writes best-effort, and surfaced `detail` in error parsing.
- **Prevention**: Validate third-party upload integrations against live endpoint behavior, not just one documented payload shape; avoid forcing JSON headers on multipart/binary upload routes; keep non-critical cache writes non-fatal when the external submission already succeeded.
- **Related files**: `api/autodesk.cts`, `api/autodesk_helpers/digifabster-sync.ts`

### 2026-04-09 — Native Source Upload Fallback For Quote Sync
- **Issue**: Quote sync could remain unresolved when Autodesk manifest did not expose a STEP/DWG quote target for polling.
- **Trigger**: Added `syncNativeSourceToDigifabster` and wired `/api/conversion-status` to accept `source_url`/`sourceUrl` plus `source_file_name`/`sourceFileName`.
- **Impact**: Medium — quote pipeline can now complete from the original source URL even without derivative target resolution.
- **Fix/Workaround**: When `quoteTarget` is unresolved and source URL is supplied, conversion-status calls native sync and treats `submitted`/`cached` upload states as quote success.
- **Prevention**: Always send source URL metadata in strict polling flows so native upload fallback remains available for fresh production proofs.
- **Related files**: `api/autodesk_helpers/digifabster-sync.ts`, `api/conversion-status.cts`, `scripts/e2e-production-proof.cjs`

### 2026-04-09 — Strict E2E Gate Prevents False PASS Without Digifabster Submission
- **Issue**: Production proof could report PASS even when no fresh Digifabster quote upload was actually submitted.
- **Trigger**: `scripts/e2e-production-proof.cjs` previously allowed verdict success without enforcing upload evidence fields.
- **Impact**: High — false-positive release confidence for quote pipeline readiness.
- **Fix/Workaround**: Default PASS gate now requires `quote.upload.status = submitted`, `quote.upload.source = digifabster`, and valid object/order IDs; poll logs include upload status/source; no forced `quoteTarget = step` fallback on null upload target.
- **Prevention**: Keep strict default gate enabled for production proof; only use `REQUIRE_FRESH_UPLOAD=0` for viewer-only compatibility runs.

### 2026-04-07 — Short-Scope Conversion + Status Tracking
- **Issue**: Conversion flow needed quote-target awareness without delaying viewer readiness.
- **Trigger**: Added short-scope format classification, `dry_run` branches, and a dedicated status endpoint.
- **Impact**: Medium — API contract expanded across upload/status endpoints and viewer/e2e assumptions.
- **Fix/Workaround**: Standardized response shape with `viewer` + `quote` objects, introduced `format-map.ts`, and added Playwright coverage for local/cloud viewer modes and dry-run status paths.
- **Prevention**: Keep `/api/autodesk` and `/api/conversion-status` response/status semantics aligned when extending format support.

### 2026-04-07 — Initial Documentation Bootstrap
- **Issue**: No documentation scaffold existed beyond copilot-instructions.md and AGENTS.md
- **Trigger**: First documentation session for this workspace
- **Impact**: Low — project is small and straightforward
- **Fix/Workaround**: Created full doc scaffold: memories/repo/ indexes, experience log, run logs, architecture docs
- **Prevention**: Run Documentation Manager bootstrap early in any new project

### 2026-04-07 — URN Local Viewer Cache + Source Lookup
- **Issue**: URN-only local playback path was implemented, but local source resolution is blocked in deployment.
- **Trigger**: Added Blob-backed cache helper (`viewer-cache.ts`), `/api/viewer-source`, and frontend URN-only polling flow.
- **Impact**: Medium — local-mode startup by URN returns `404 queued` and cannot load cached bubble assets in Vercel.
- **Fix/Workaround**: API now reports `viewer.mode`, `viewer.bubbleUrl`, and `viewer.localError`; frontend keeps cloud mode and retry flow when local source is unavailable.
- **Prevention**: Configure `BLOB_READ_WRITE_TOKEN` in Vercel environment for preview/production before relying on URN-only local playback.

### 2026-04-07 — Quote Derivative Upload Sync To Digifabster
- **Issue**: STEP/DWG quote derivatives could complete in Autodesk without being synchronized to the downstream Digifabster upload pipeline.
- **Trigger**: Added quote sync flow in `conversion-status.cts` and new helper `autodesk_helpers/digifabster-sync.ts`.
- **Impact**: Medium — quote pipeline now depends on Blob staging + Digifabster API availability and correct `part_id`/`version` wiring.
- **Fix/Workaround**: Added retry/backoff upload client, Blob-backed sync record caching, and fail-fast error response (`error`, `code`, `details`) when sync fails.
- **Prevention**: Ensure callers always provide `part_id` and `version`; monitor Digifabster upload failures explicitly instead of treating quote readiness as final success.

### 2026-04-07 — SVF Local Cache Requires Dependency Upload + Header Cookie Parsing
- **Issue**: Local viewer failed when only root `.svf` was cached or when signed cookies were read from payload-only fields.
- **Trigger**: Enabling local-mode playback on preview surfaced missing dependency assets and CloudFront cookie variants in `Set-Cookie` headers.
- **Impact**: High — viewer may show rendering/network failures even with successful conversion status.
- **Fix/Workaround**: Added `Set-Cookie` parsing for signed cookie extraction, parsed root `.svf` internal `manifest.json`, and uploaded dependency assets to Blob under output-relative paths with overwrite enabled.
- **Prevention**: Keep cache persistence as a full bubble upload (root + dependencies), and include a 30s viewer smoke-check (`modalError`, `canvasCount`, failed/bad requests) after cache pipeline changes.

### 2026-04-07 — Protected Endpoint Verification Needs Share + Cookie Handshake
- **Issue**: Preview deployment endpoint checks returned auth failures when called directly, despite valid implementation.
- **Trigger**: Verifying `GET /api/digifabster-price-tweak` and `POST /api/conversion-status` against Vercel-protected deployment URLs.
- **Impact**: Medium — can cause false-negative production checks and wasted debugging time.
- **Fix/Workaround**: Bootstrap with `/?_vercel_share=...` to capture `Set-Cookie`, then replay protected API calls using both the share token and cookie.
- **Prevention**: Standardize protected-preview verification scripts to always include the share-token bootstrap step before endpoint assertions.
- **Related files**: `api/digifabster-price-tweak.cts`, `api/conversion-status.cts`

### 2026-04-07 — Nullable Enum Contract For Bubble Config Fields
- **Issue**: Bubble quote config inputs may be intentionally unset during early pricing flows.
- **Trigger**: Extending `GET/POST /api/digifabster-price-tweak` contract to allow null values across quantity and enum config fields.
- **Impact**: Low — avoids contract mismatch failures and improves compatibility with partial upstream payloads.
- **Fix/Workaround**: Accept nullable `quantity`, `tightest_tolerance`/`tightestTolerance`, `inspection`, `roughness`, `finish`, normalize minor aliases, and return `configFields` metadata for consumers.
- **Prevention**: Treat optional enum-like quote preferences as nullable in API contracts and drive UI mapping from server metadata.
- **Related files**: `api/digifabster-price-tweak.cts`

### 2026-04-07 — Vercel Request Log Consolidation And Trace Timeline Aggregation
- **Issue**: Production request logs can appear as one consolidated message per request, reducing visibility into step-level progression.
- **Trigger**: Verifying trace smoke output for `trace-log-smoke-1775571710743` after logging instrumentation changes.
- **Impact**: Medium — piecemeal helper logs were noisy and obscured request-level debugging context.
- **Fix/Workaround**: Added end-of-request timeline aggregation with `traceId` across `/api/autodesk`, `/api/conversion-status`, and Digifabster sync paths; removed noisy helper log in download helper.
- **Prevention**: Prefer a stable, structured per-request timeline event over scattered step logs for serverless request tracing.
- **Related files**: `api/autodesk.cts`, `api/conversion-status.cts`, `api/autodesk_helpers/digifabster-sync.ts`, `api/autodesk_helpers/download.ts`, `scripts/trace-log-smoke.cjs`

### 2026-04-07 — Reusable Handler-Level Bubble STEP Flow Suite
- **Issue**: Bubble STEP flow verification depended on intermediate Playwright-only artifacts that were harder to reuse for API-contract checks.
- **Trigger**: Added `scripts/bubble-flow-e2e.ts` and `scripts/mock-price-tweaker.cjs` and switched `test:e2e:bubble-flow` to run with `tsx`.
- **Impact**: Medium — adds a deterministic handler-level regression path for upload/status/price-tweaker integration without browser overhead.
- **Fix/Workaround**: New suite simulates Bubble upload (`/api/autodesk` dry-run), status progression (`/api/conversion-status`), then validates `/api/digifabster-price-tweak` GET/POST against a local mock endpoint.
- **Prevention**: Keep this suite as the default Bubble STEP flow smoke path and reserve Playwright for viewer/UI behavior.
- **Related files**: `scripts/bubble-flow-e2e.ts`, `scripts/mock-price-tweaker.cjs`, `package.json`

### 2026-04-09 — Bubble ↔ DigiFabster Terminology Mapping Infrastructure Completed
- **Issue**: Bubble field values (material names, tolerance labels, finish options) often differ from DigiFabster's canonical catalog terminology, causing silent mapping failures or requiring manual Bubble→DigiFabster translation on every request.
- **Trigger**: Populated comprehensive terminology mapping infrastructure in `POST /api/digifabster-price-tweak` with 70+ entries across materials (50), tolerances (3), inspection (3), roughness (4), finish (10).
- **Impact**: Low-to-medium — improves data translation robustness and price quote reliability, but Bubble field remapping to DigiFabster is already handled server-side in the price-tweaker logic; mappings extend existing capability rather than unblock new flows.
- **Fix/Workaround**: 
  1. Created `TerminologyMappingType` TypeScript interface to define mapping structure (5 field categories).
  2. Populated `BUBBLE_TO_DIGIFABSTER_MAPPING` constant with 70+ canonical mappings (e.g., "aluminium 6061" → "Aluminium 6061", "iso 2768 medium standard" → "ISO 2768-m").
  3. Implemented `applyTerminologyMapping()` helper with normalization + exact/prefix match resolution (handles diacritics, case, punctuation).
  4. Integrated mapping into `pickMaterialId()` call path so material labels are normalized before DigiFabster catalog lookup.
  5. Built, linted, deployed to production successfully.
- **Prevention**: 
  1. Keep mappings close to the route that uses them (not in shared helpers) to maintain clear ownership.
  2. Document normalization behavior (NFKD stripping, ASCII-safe lowercasing) in code comments.
  3. Monitor for prefix-match collisions if mappings grow beyond ~100 entries; consider indexed lookup strategy.
  4. Add observability for unmapped inputs (currently silent fallback) to surface missing mappings.
- **Related files**: `api/digifabster-price-tweak.cts`, `memories/repo/api-routes.md`, `docs/ai/run-logs/2026-04-09-terminology-mapping-population.md`
- **Deployment**: Production deployment successful; terminology mappings active on `https://entag.project.citizendev.io`.

### 2026-04-08 — Legacy Digifabster Bridge Default Caused Wrong Target Calls
- **Issue**: The integration defaulted to `https://digifabster.vercel.app` with bridge-style paths (`/api/upload`, `/api/price-tweaking`) instead of explicit official DigiFabster API targets.
- **Trigger**: Production smoke POST to `/api/digifabster-price-tweak` returned 404 from the bridge endpoint while official docs point to token-authenticated `/v2/...` API routes.
- **Impact**: High — calls can silently hit the wrong host/path and produce false integration assumptions.
- **Fix/Workaround**: Removed implicit bridge fallback for upload/price tweak forwarding, added explicit endpoint requirements (`DIGIFABSTER_UPLOAD_ENDPOINT`, `DIGIFABSTER_PRICE_TWEAK_ENDPOINT`), and added token auth support (`Authorization: Token ...`) via `DIGIFABSTER_API_TOKEN`.
- **Prevention**: Never hardcode third-party bridge hosts as runtime defaults; require explicit endpoint configuration for external integrations and align against provider OpenAPI docs.
- **Related files**: `api/autodesk_helpers/digifabster-sync.ts`, `api/digifabster-price-tweak.cts`, `memories/repo/env-vars.md`

### 2026-04-08 — Base `/v2/` Endpoint Is Not Directly POSTable
- **Issue**: Using `https://digifabster.com/v2/` as the exact runtime forwarding endpoint for price tweak requests returns a 404 HTML page from DigiFabster.
- **Trigger**: Fresh preview deployment was configured with `DIGIFABSTER_PRICE_TWEAK_ENDPOINT=https://digifabster.com/v2/` and `DIGIFABSTER_API_TOKEN`; direct POST smoke via `/api/digifabster-price-tweak` failed with `404`.
- **Impact**: Medium — integration remains blocked until concrete `/v2/...` resource paths are configured.
- **Fix/Workaround**: Keep base host at `https://digifabster.com` but set route env vars to concrete API paths (for example `/v2/upload_models/` and a specific `/v2/price_tweaker/.../` endpoint) that match DigiFabster account/workflow.
- **Prevention**: Validate third-party endpoint env vars with a live POST smoke immediately after configuration instead of assuming API base paths are callable endpoints.
- **Related files**: `scripts/checkpoint-runner.cjs`, `checkpoint-state.json`

### 2026-04-08 — DigiFabster API Key Requires S2S Token Exchange
- **Issue**: Calling DigiFabster endpoints directly with the provided API key in `Authorization` fails with `401 Invalid token`.
- **Trigger**: Probes to `/v2/clients/me/`, `/v2/upload_job/`, and `/v2/upload_models/` returned `401` until S2S exchange flow was introduced.
- **Impact**: High — all DigiFabster forwarding calls fail auth despite valid endpoint paths.
- **Fix/Workaround**: Added S2S token exchange call to `/v2/obtain_s2s_token/` using `{ api_key }`, then use returned `token` as `Authorization: Token ...` for upload and price-tweak forwarding.
- **Prevention**: Treat `DIGIFABSTER_API_KEY` as exchange input, not a bearer token; verify auth by checking for downstream validation errors (400) vs auth errors (401).
- **Related files**: `api/autodesk_helpers/digifabster-sync.ts`, `api/digifabster-price-tweak.cts`, `memories/repo/env-vars.md`

### 2026-04-08 — Route-Level `price_tweaker` Validation Catches Payload Shape Early
- **Issue**: Bubble payloads can omit required DigiFabster `price_tweaker` fields and fail later at the downstream endpoint.
- **Trigger**: `POST /api/digifabster-price-tweak` now validates required shape (`objectModelId`, `price_config`, `material`, `printer`) before forwarding.
- **Impact**: Medium — malformed payloads now fail fast with actionable 400 responses instead of opaque downstream failures.
- **Fix/Workaround**: Added boundary validation and explicit `details` + `required` objects in 400 response payload.
- **Prevention**: Keep route-level contract checks aligned with DigiFabster request schema and use `GET /api/digifabster-price-tweak` metadata to drive Bubble mapping.
- **Related files**: `api/digifabster-price-tweak.cts`, `memories/repo/api-routes.md`, `docs/architecture/edge-functions.md`

