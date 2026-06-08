<!-- last-verified: 2026-05-14 -->

# Session Run Log: viewer-source-processing-proof-closure

## Summary

- Goal: Record the latest 3D viewer recovery work after the Vercel timeout/rewrite fix, focused on real Autodesk translation, local SVF cache readiness, and rendered geometry proof.
- Outcome: Documentation now captures the root cause, new `/api/viewer-source` response semantics, longer frontend polling behavior, regression coverage, deployment evidence, and browser-rendered production proof.
- Agent(s) used: GitHub Copilot implementation session; Documentation Manager closure.

## Actions Taken

1. Investigated user-reported persistent viewer failure after Vercel upgrade/deploy; user rejected shell-only checks and required real Autodesk translation/local SVF/rendered geometry evidence.
2. Correlated Vercel expanded logs for a real `phone-holder.STEP` upload with Autodesk manifest state and browser polling behavior.
3. Updated viewer recovery logic to treat token-backed in-progress cache generation as retryable processing instead of missing cache.
4. Added regression coverage for token-backed `/api/viewer-source` `202 processing` responses followed by successful `localModelUrl` resolution.
5. Validated locally and against production after prebuilt deploy.
6. Updated project documentation and canonical references for this recovery slice.

## Evidence From Production Failure

- Upload log: `2026-05-14 21:27:24` local, `POST /api/autodesk 200` for `phone-holder.STEP`.
- URN: `dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6MTc3ODc2ODg0NTQwMy9waG9uZS1ob2xkZXIuU1RFUA`.
- Early status: `/api/conversion-status` at `21:27:26` returned `viewerStatus=inprogress`.
- Failure mode: browser repeatedly polled `/api/viewer-source` `404` until giving up.
- Autodesk follow-up: direct manifest later returned `status=success`, `progress=complete`, and normal SVF graphics node `output/1/phone-holder.svf`.

## Fixes Documented

- `src/pages/viewer/index.tsx`: added lookup constants; token-backed lookup default is now `300` attempts at `4s`; cache-only default is `24` attempts at `5s`; URL override attempts cap at `900`; cancellation checks stop stale StrictMode/remount polling loops.
- `api/viewer-source.cts`: token-backed in-progress translations now return HTTP `202` with `status=processing`, `viewerStatus`, `retryAfterMs`, and `hint`; unauthorized Autodesk manifest/token errors return HTTP `401` with reason `autodesk_manifest_unauthorized`; failed translations still return `424`.
- `e2e/viewer-and-conversion.spec.ts`: added `viewer keeps polling while token-backed local source is processing`, simulating `202 processing` responses followed by successful `localModelUrl`; assertion tolerates React StrictMode duplicate initial requests.

## Commands And Validation

- VS Code diagnostics: no diagnostics in `src/pages/viewer/index.tsx`, `api/viewer-source.cts`, or `e2e/viewer-and-conversion.spec.ts`.
- Focused Playwright test: `viewer keeps polling while token-backed local source is processing` passed.
- `pnpm build`: passed.
- `pnpm lint`: passed.
- Full `e2e/viewer-and-conversion.spec.ts`: `4` passed.
- Production deploy: `npx vercel deploy --prebuilt --prod --scope citizendevio`; deployment `dpl_9QW3Nta6mq8Jn7Fubf78CFgr8pks`, Ready, aliased to `https://project-entag-3d-viewer.vercel.app`.

## Production Proof After Deploy

- API proof: `GET /api/viewer-source` for the real phone-holder URN returned `200`, `source=cache`, `mode=local`, and `localModelUrl` present.
- Blob proof: `HEAD localModelUrl` returned `200 application/octet-stream`.
- Browser proof: opened `/viewer?urn=<phone-holder URN>` against production; after 12s, `canvasCount=2`, body contained Rendering/Optimizing text, WebGL center pixel was `[177,185,207,255]`, and screenshot showed actual part geometry in Autodesk Viewer.

## Files Created Or Updated

- `src/pages/viewer/index.tsx`: implementation change recorded; not modified during this documentation pass.
- `api/viewer-source.cts`: implementation change recorded; not modified during this documentation pass.
- `e2e/viewer-and-conversion.spec.ts`: regression test recorded; not modified during this documentation pass.
- `docs/ai/context.md`: added concise latest proof and polling-semantics notes.
- `docs/ai/experience-log.md`: added durable viewer-proof and polling lesson.
- `memories/repo/api-routes.md`: updated `/api/viewer-source` canonical contract.
- `memories/repo/code-index.md`: updated viewer-source, viewer page, and Playwright test descriptions.
- `docs/ai/run-logs/2026-05-14-2130-viewer-source-processing-proof-closure.md`: this run log.

## Issues Encountered

- Issue: Shell/API route availability was not enough proof for the reported viewer failure.
  - Resolution: Required full chain evidence: Autodesk manifest success, local SVF URL resolution, Blob `HEAD 200`, and browser-rendered canvas/geometry.
- Issue: Slow Autodesk translation/local-cache readiness looked like an app failure when the frontend polling window was too short.
  - Resolution: Added explicit processing semantics and longer token-backed polling defaults.
- Issue: Repomix and GitNexus MCP tools were not exposed in this runtime.
  - Resolution: Used the user-provided validation record plus targeted reads of the touched docs/source files.

## Follow-Up

1. Keep viewer release proof tied to rendered geometry, not SDK shell load or HTTP-only checks.
2. Treat `/api/viewer-source` `202 processing` as the expected retryable state for token-backed in-progress translations.
3. Run toolchain sync separately when ready; user-level manifest is `v1.8.0` while this workspace marker remains `v1.5.0`.