<!-- last-verified: 2026-04-07 -->

# Session Run Log: Docs Update For URN-Only Local Viewer Flow

## Summary
- Goal: Update documentation and repo memories for Blob-backed URN local viewer changes
- Outcome: Updated API/routes/env/code index docs and logged deployment blocker
- Agent(s) used: Documentation Manager (Update mode)

## Actions Taken
1. Reviewed changed code paths in API, frontend viewer, and e2e tests.
2. Updated AI context docs: `memories/repo/api-routes.md`, `memories/repo/code-index.md`, `memories/repo/env-vars.md`.
3. Updated human architecture docs: `docs/architecture/edge-functions.md`, `docs/architecture/modules.md`.
4. Updated always-loaded project summary: `.github/copilot-instructions.md`.
5. Appended a concise session discovery entry to `docs/ai/experience-log.md`.

## Files Created Or Updated
- `.github/copilot-instructions.md`: Added e2e command, new API routes, Blob helper notes
- `memories/repo/api-routes.md`: Added `/api/viewer-source`; expanded `/api/conversion-status` viewer payload
- `memories/repo/code-index.md`: Indexed `viewer-source.cts`, `viewer-cache.ts`, and URN-only viewer flow
- `memories/repo/env-vars.md`: Added `BLOB_READ_WRITE_TOKEN` and blocker note
- `docs/architecture/edge-functions.md`: Updated serverless route catalog and external dependencies
- `docs/architecture/modules.md`: Updated module responsibilities for new route/helper flow
- `docs/ai/experience-log.md`: Added URN local cache blocker entry
- `docs/ai/run-logs/2026-04-07-0100-docs-urn-local-viewer-update.md`: This file

## Commands And Validation
- No build/lint/test commands run (docs-only update)

## Issues Encountered
- Repomix and GitNexus MCP tools were not available in this session, so updates were derived from direct file reads and git diff.
- Blocker captured: `BLOB_READ_WRITE_TOKEN` is missing in Vercel env; URN-only local playback remains unavailable until configured.

## Follow-Up
- Add `BLOB_READ_WRITE_TOKEN` to Vercel Preview and Production environments.
- Re-run the URN-only local check after env update to confirm `/api/viewer-source` resolves cached bubble URLs.
