<!-- last-verified: 2026-05-16 -->

# Project Map

## Workspace Identity

| Key | Value |
|---|---|
| Project | Entag 3D Viewer |
| Workspace root | `c:/Users/longv/Desktop/entag-3d-viewer/project-entag-3d-viewer` |
| Deployment model | Vercel (serverless API + Vite frontend; API maxDuration 60) |
| Primary package manager | `pnpm` |

## Deployment Targets

| Target | Value |
|---|---|
| Production alias | `https://project-entag-3d-viewer.vercel.app` |
| Final recovery deployment | `dpl_J7cjtAFsm1w2guqkQH9FD1MZUMS3` / `https://project-entag-3d-viewer-ohxbpsqju-citizendevio.vercel.app` |
| Previous failing deployment evidence | `dpl_29aBCEbmEKLbCJsmgTdaJnSJgrKz` inspected with `api/autodesk` timeout `15` |
| Required duration config | `vite.config.ts` `vercel.defaultMaxDuration=60` plus `vercel.json` `functions` maxDuration rules |
| Required prebuilt SPA routing | `vite.config.ts` `vercel.rewrites` for `/viewer`, `/viewer/(.*)`, `/embed/part`, and `/embed/part/(.*)` |

## Core Directory Ownership

| Path | Ownership | Purpose |
|---|---|---|
| `api/` | Backend/API layer | Vercel serverless endpoints and Autodesk/Digifabster helpers |
| `src/` | Frontend/UI layer | React app routes, viewer page, browser utilities |
| `scripts/` | Ops/testing | Handler-level and production-proof automation scripts |
| `e2e/` | Quality | Playwright end-to-end tests |
| `docs/` | Human docs | Architecture, requirements, AI run/experience logs |
| `memories/repo/` | AI canonical refs | Workspace-scoped reference facts for agents |

## Toolchain-Managed Paths

| Path | Role |
|---|---|
| `.github/ai-toolchain-version.md` | Sync marker + executable sync checklist |
| `.github/copilot-instructions.md` | Always-loaded Copilot workspace summary |
| `.github/instructions/` | Path-scoped rule files |
| `.continue/checks/` | Continue review check templates |
| `.codex/config.toml` | Workspace Codex MCP/discovery parity config |
| `.codex/rules/default.rules` | Codex command safety baseline |
| `.agents/skills/README.md` | Codex project-skill scaffold |
| `AGENTS.md` | Cross-tool policy bridge |

## External Service Surfaces

| Service | Integration area |
|---|---|
| Autodesk APS / Forge | `api/autodesk.cts`, `api/conversion-status.cts`, `api/autodesk_helpers/*` (default 3D pipeline; direct 2D no-translation path can bypass Autodesk translation/manifest calls) |
| DigiFabster | `api/digifabster-price-tweak.cts`, `api/autodesk_helpers/digifabster-sync.ts` |
| Bubble.io | `api/bubble-trigger.cts`, `api/conversion-status.cts` |
| Vercel Blob | `api/autodesk_helpers/viewer-cache.ts`, `api/autodesk_helpers/digifabster-sync.ts`, `api/embed_helpers/blob-storage.ts`, `api/embed_helpers/session-store.ts`, `api/embed_helpers/part-store.ts`, `api/embed/sessions/[embedSessionId]/files.cts` |

## Operational Artifacts

| Path | Purpose |
|---|---|
| `scripts/backfill-bubble-urn-thumbnail.cjs` | Ops backfill script for Bubble records missing `urn` + thumbnail (default current month, optional `--window-days=N`, optional `--include-missing-urn-with-image`, Autodesk upload/poll + direct Bubble Data API patch flow, `3mf` default skip, retryable timeout/5xx handling) |
| `bubble-urn-thumbnail-backfill-report.json` | Generated run report with totals, per-extension stats, failed/skipped diagnostics, and per-record outcomes. Latest snapshot (2026-05-14 last-7-days dry run): `recordsInWindow=24`, `missingUrnAndImage=0`, `missingUrnWithImage=0`, `queued=0` |

## AI Toolchain Sync Baseline (v1.5.0)

| Check | Expected state |
|---|---|
| Workspace marker | `.github/ai-toolchain-version.md` is executable and pinned to `v1.5.0` |
| Codex parity minimum | `.codex/config.toml`, `.codex/rules/default.rules`, and `.agents/skills/README.md` are all present |
| Sync closure evidence | `docs/ai/context.md`, `docs/ai/experience-log.md`, and one dated file in `docs/ai/run-logs/` are updated in the same sync session |
| Conditional hooks | `.github/hooks/post-edit-format.json` is deployed only when the Prettier condition is met in `~/.copilot/VERSION.md` sync inventory |

- If Repomix or GitNexus MCP coverage is unavailable during docs-closure or sync validation, fallback evidence can use deterministic file-level checks plus targeted pattern search, and the fallback path must be documented in the matching run log.
