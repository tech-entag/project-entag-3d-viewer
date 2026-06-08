<!-- last-verified: 2026-05-14 -->

# Session Run Log: viewer-timeout-route-fix-backfill-closure

## Summary

- Goal: Document phase closure for the 3D viewer recovery after Vercel Blob limit exhaustion, the Vercel timeout/SPA rewrite fixes, and the Bubble backfill rerun.
- Outcome: Canonical refs and human AI docs now record the root causes, deployment evidence, backfill closure status, and residual risks.
- Agent(s) used: Documentation Manager.

## Actions Taken

1. Reviewed existing run logs and documentation style for continuity.
2. Verified current config/script state in `vite.config.ts`, `vercel.json`, `scripts/backfill-bubble-urn-thumbnail.cjs`, and `bubble-urn-thumbnail-backfill-report.json`.
3. Updated `docs/ai/context.md` with the May 14 recovery status, deployment evidence, route probes, and backfill outcome.
4. Appended a durable root-cause/prevention entry to `docs/ai/experience-log.md`.
5. Refreshed canonical references in `memories/repo/api-routes.md`, `memories/repo/code-index.md`, `memories/repo/env-vars.md`, and `memories/repo/project-map.md`.

## Root Causes Documented

1. Production deployment `dpl_29aBCEbmEKLbCJsmgTdaJnSJgrKz` still had `api/autodesk` lambda `timeout: 15` even though route files exported `config.maxDuration = 60`.
2. Prebuilt output initially lacked the SPA rewrite for `/viewer`, causing a Vercel platform 404 before React could load.

## Fixes Documented

- `vite.config.ts`: `vercel.defaultMaxDuration = 60` and prebuilt rewrites for `/viewer` and `/viewer/(.*)`.
- `vercel.json`: schema plus `functions` maxDuration rules for `api/*.cts` and `api/**/*.ts`.
- `scripts/backfill-bubble-urn-thumbnail.cjs`: `--window-days=N`, `--include-missing-urn-with-image`, existing-image preservation, and `auto_modelid:false` for script-owned conversion polling.

## Validation Evidence

- `pnpm build`: passed after config changes.
- `pnpm lint`: passed with no reported errors.
- VS Code diagnostics: no errors for `vite.config.ts`, `vercel.json`, or `scripts/backfill-bubble-urn-thumbnail.cjs`.
- Local generated Vercel configs: `.vercel/output/functions/api/autodesk.func/.vc-config.json` and `.vercel/output/functions/api/conversion-status.func/.vc-config.json` showed `maxDuration: 60`.
- Final production deployment: `dpl_J7cjtAFsm1w2guqkQH9FD1MZUMS3`, URL `https://project-entag-3d-viewer-ohxbpsqju-citizendevio.vercel.app`, aliased to `https://project-entag-3d-viewer.vercel.app`.
- Production inspect: `api/autodesk` lambda `timeout: 60`.
- Live probes after final deploy: `/` `200`, `/viewer` `200`, `/viewer?urn=test&lookupAttempts=1&lookupIntervalMs=20` `200`, `GET /api/autodesk` `405` expected, and `GET /api/viewer-source?urn=test` `404` JSON queued expected.
- Production `/api/autodesk` dry-run POST: `200`, `success=true`, `viewer=queued`, `quote=not_required`.

## Backfill Outcome

- Initial last-7-days dry run found `22` records, `6` missing URN + image, and `0` missing URN with image.
- First real pass before the timeout fix recovered `1` DXF and failed `5` SLDPRT/X_T records with `504 FUNCTION_INVOCATION_TIMEOUT`.
- After the deployment fix, the remaining `5/5` records updated successfully; each reached `viewer=success/local` and `quote=success`.
- Final dry-run report in `bubble-urn-thumbnail-backfill-report.json` shows `recordsInWindow=24`, `missingUrnAndImage=0`, `missingUrnWithImage=0`, `includeMissingUrnWithImage=true`, and `queued=0`.

## Files Created Or Updated

- `docs/ai/context.md`: added May 14 recovery status and verification notes.
- `docs/ai/experience-log.md`: added durable Vercel timeout/prebuilt rewrite/backfill closure entry and known-pitfall bullets.
- `docs/ai/run-logs/2026-05-14-1425-viewer-timeout-route-fix-backfill-closure.md`: this run log.
- `memories/repo/api-routes.md`: documented `/api/autodesk` duration enforcement, production inspect requirement, and `auto_modelid:false` guidance for external backfills.
- `memories/repo/code-index.md`: refreshed backfill script and Vercel config descriptions.
- `memories/repo/env-vars.md`: added backfill CLI flags and platform config notes.
- `memories/repo/project-map.md`: added deployment target evidence and refreshed operational artifact summaries.

## Issues Encountered

- Issue: Repomix and GitNexus MCP tools were not exposed in this runtime.
  - Resolution: Used the issue handoff, existing run logs, and targeted file reads as deterministic documentation evidence.

## Residual Risks

- Future timeout-sensitive route changes must be verified in generated `.vc-config.json` and with `npx vercel inspect`; route-level exported config alone is not sufficient evidence for this build path.
- The final backfill artifact is a queue-empty dry run; terminal output contains the successful `5/5` update run details.
- Experience Memory Curator handoff remains unavailable in this runtime, so cross-project learning promotion is pending outside this documentation pass.

## Follow-Up

1. Keep production release checks for timeout-sensitive API routes tied to generated Vercel output plus live `vercel inspect` evidence.
2. Probe direct SPA routes such as `/viewer` after every prebuilt production deployment.
3. Keep backfill runs on `auto_modelid:false` when the script already polls `/api/conversion-status`.