<!-- last-verified: 2026-04-09 -->
# Session Run Log: Digifabster Mapping Hardening Docs Update

## Summary
- Goal: Update project documentation to reflect hardened Bubble -> DigiFabster terminology mapping behavior in `api/digifabster-price-tweak.cts`.
- Outcome: API route docs, code index, and experience log were updated with the new mapping schema and behavior guarantees.
- Agent(s) used: Documentation Manager

## Actions Taken
1. Reviewed `api/digifabster-price-tweak.cts` mapping, tolerance-resolution, and post-production resolution logic.
2. Updated `memories/repo/api-routes.md` to document:
   - mapping schema change to `{materials, tolerances, postproduction}`
   - exact-label tolerance mapping behavior and fallback order
   - post-production mapping via `applyTerminologyMapping(..., "postproduction")`
   - 400 behavior for non-catalog material labels with available-material diagnostics.
3. Updated `memories/repo/code-index.md` `api/digifabster-price-tweak.cts` entry with the hardened mapping-policy summary.
4. Appended a durable discovery entry to `docs/ai/experience-log.md`.

## Files Created Or Updated
- docs/ai/run-logs/2026-04-09-2355-docs-digifabster-mapping-hardening.md: new run log for this session
- memories/repo/api-routes.md: mapping and behavior notes updated
- memories/repo/code-index.md: route index summary updated
- docs/ai/experience-log.md: added 2026-04-09 mapping-hardening discovery entry

## Commands And Validation
- Command: documentation-only edits (no build/lint required)
  - Result: completed successfully; no runtime code changes introduced.

## Issues Encountered
- Issue: session checkpoint file path from injected context was not present under workspace path.
  - Resolution: proceeded with direct source-of-truth inspection from `api/digifabster-price-tweak.cts` and current docs.

## Follow-Up
- Optionally run `pnpm lint` and `pnpm build` in next implementation session gate if additional code changes are made after this doc update.
