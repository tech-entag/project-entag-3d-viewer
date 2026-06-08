<!-- last-verified: 2026-05-14 -->

# Session Run Log: viewer-placeholder-token-regression-closure

## Summary

- Goal: Close documentation for the production regression where placeholder query token values were being treated as real tokens.
- Outcome: AI context, experience log, and canonical references now document the placeholder-token normalization behavior and regression-proof evidence.
- Agent(s) used: Documentation Manager.

## Actions Taken

1. Reviewed the latest three run logs for continuity and scoped this update to the placeholder-token regression closure.
2. Verified touched implementation/test files: `api/viewer-source.cts`, `src/pages/viewer/index.tsx`, and `e2e/viewer-and-conversion.spec.ts`.
3. Updated `docs/ai/context.md` with concise production regression closure notes and validation/deployment evidence.
4. Appended a durable entry to `docs/ai/experience-log.md` and added a pitfall note for placeholder token normalization.
5. Updated canonical references in `memories/repo/api-routes.md` and `memories/repo/code-index.md`.

## Files Created Or Updated

- `docs/ai/context.md`: added focused closure notes for placeholder-token normalization and production contract outcomes.
- `docs/ai/experience-log.md`: added a 2026-05-14 regression entry and a related known-pitfall bullet.
- `memories/repo/api-routes.md`: documented normalization of `access_token`/`accessToken` placeholder values and expected status outcomes.
- `memories/repo/code-index.md`: updated viewer-source, viewer page, and Playwright test descriptions for this regression.
- `docs/ai/run-logs/2026-05-14-2207-viewer-placeholder-token-regression-closure.md`: this run log.

## Commands And Validation

- Command: `pnpm build`
  - Result: passed.
- Command: `pnpm test:e2e -- e2e/viewer-and-conversion.spec.ts`
  - Result: `5 passed, 2 skipped`.
- Command: Direct handler invocation (local) for `/api/viewer-source` with `access_token=undefined`
  - Result: `404 queued`.
- Command: Production deploy via prebuilt
  - Result: inspect URL `https://vercel.com/citizendevio/project-entag-3d-viewer/DpcKUxoBxcDHqo1DHjZTAeyEfmHY`; deployment URL `https://project-entag-3d-viewer-7dxckqczd-citizendevio.vercel.app`; alias `https://project-entag-3d-viewer.vercel.app`.
- Command: Production contract checks post-deploy
  - Result: uncached URN with no token => `404 queued`; uncached URN with `access_token=undefined` => `404 queued`; uncached URN with invalid non-placeholder token => `401 unauthorized`.

## Issues Encountered

- Issue: None during this documentation closure pass.
  - Resolution: Not applicable.

## Follow-Up

1. Keep token placeholder normalization logic aligned between API and frontend URL parsing paths.
2. Keep the Playwright regression `viewer ignores placeholder token query values` in the focused viewer suite.
3. Optional separate maintenance task: workspace toolchain marker is `v1.5.0` while user-level manifest is `v1.8.0`; run sync mode when appropriate.
