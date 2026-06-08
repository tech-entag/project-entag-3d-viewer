<!-- last-verified: 2026-05-07 -->

# Session Run Log: docs-viewer-resilience-guardrail-deploy-verification

## Objective

- Record documentation closure for viewer resilience hardening and production deployment verification.

## Summary

- Goal: Capture deterministic viewer guardrail workflow updates and deployment probe outcomes.
- Outcome: Updated AI context, experience log, and canonical references for the new guardrail scripts and local-proxy test policy.
- Agent(s) used: Documentation Manager.

## Actions Taken

1. Reviewed latest run logs for continuity and verified this session scope.
2. Confirmed guardrail changes in `e2e/viewer-and-conversion.spec.ts`, `scripts/viewer-resilience-smoke.ts`, and `package.json`.
3. Updated `docs/ai/context.md` with concise deployment and verification status notes.
4. Appended a durable root-cause/fix/verification entry to `docs/ai/experience-log.md`.
5. Updated canonical references in `memories/repo/api-routes.md` and `memories/repo/code-index.md` for the local-proxy guardrail workflow.

## Deployment URLs

- Production deployment: `https://project-entag-3d-viewer-oud1nrft0-citizendevio.vercel.app`
- Live alias: `https://project-entag-3d-viewer.vercel.app`

## Validation Evidence

- Probe method: Node `fetch` requests against live alias.
- `POST /api/autodesk` with `dry_run=true`: `200`; `quote.targetFormat=step`; `quote.status=queued`.
- `POST /api/conversion-status` with `dry_run=true`, `viewer_status=success`, `quote_status=failed`: `200`; `viewer.priority=true`.
- `GET /viewer?bubbleUrl=https://blob.vercel-storage.com/saved/model.svf`: `200`.

## Files Created Or Updated

- `docs/ai/context.md`: added concise status notes for guardrail workflow and production probe outcomes.
- `docs/ai/experience-log.md`: added durable viewer resilience guardrail entry.
- `memories/repo/api-routes.md`: documented local Vite proxy `EISDIR` guardrail guidance for API contract verification.
- `memories/repo/code-index.md`: indexed `scripts/viewer-resilience-smoke.ts` and viewer guardrail scripts.
- `docs/ai/run-logs/2026-05-07-0951-docs-viewer-resilience-guardrail-deploy-verification.md`: this run log.

## Known Residual Risks

- Local Vite `/api/*` HTTP proxy behavior remains nondeterministic for contract testing (`EISDIR`/`403`), so direct-handler smoke checks remain required for reliable local API assertions.
- Post-deploy probes were dry-run route checks; they verify contract shape and route availability but do not prove end-to-end non-dry-run Autodesk entitlement health.

## Follow-Up

1. Keep CI/local guardrail sequence on `pnpm test:viewer:guardrail` so UI and handler contract coverage remains split and deterministic.
