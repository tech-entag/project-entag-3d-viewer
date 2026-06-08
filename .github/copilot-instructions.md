<!-- ai-toolchain-version: v1.5.0 -->
<!-- last-verified: 2026-05-07 -->

# Entag 3D Viewer

Vite + React + TypeScript app for 3D model viewing via the Autodesk Forge/APS API. Deployed on Vercel with serverless API functions. Integrates with Bubble.io for 3D preview workflows.

## Build & Run

- **Package manager**: pnpm
- `pnpm dev` — start Vite dev server
- `pnpm build` — `tsc -b && vite build`
- `pnpm lint` — ESLint
- `pnpm preview` — preview production build
- `pnpm test:e2e` — run Playwright end-to-end tests

## Architecture

```
api/                      # Vercel serverless functions (.cts)
  autodesk.cts            # POST: upload → SVF-first translation (+ optional quote) → return URN + access token
  conversion-status.cts   # POST: conversion polling + local viewer cache persistence + STEP/DWG quote sync + native-source Digifabster fallback
  viewer-source.cts       # GET: resolve URN to cached local bubble URL
  bubble-trigger.cts      # POST: trigger Bubble.io 3D preview workflow
  autodesk_helpers/       # Auth/upload/translation + viewer-cache + Digifabster quote-sync helpers
src/
  App.tsx                 # BrowserRouter: / and /viewer routes
  pages/index.tsx         # Home page
  pages/viewer/index.tsx  # Forge Viewer embed
  helpers/                # base64converter, download utilities
  assets/script.js        # Forge Viewer init script
```

## Key Dependencies

- `react` 18, `react-router-dom` 7 — SPA routing
- `vite` 5 + `@vitejs/plugin-react` — build tooling
- `vite-plugin-vercel` + `vite-plugin-api-routes` — serverless function support
- `axios` — HTTP client (API helpers + Bubble integration)
- `@vercel/blob` — persistent storage for cached viewer derivatives, URN mapping, and staged quote files
- `fflate` — parse root `.svf` zip manifest and extract dependency URIs for local cache upload
- `@types/forge-viewer` — Autodesk Forge Viewer type definitions

## Conventions

- ESLint 9 flat config (`eslint.config.js`) with typescript-eslint, react-hooks, react-refresh
- Serverless functions use `.cts` extension (CommonJS TypeScript for Vercel)
- `vercel.json` configures CORS headers and SPA rewrites
- Vite config sets permissive `X-Frame-Options` and CSP for iframe embedding
- Viewer conversion pipeline is SVF-first, with SVF2 fallback when resolving derivatives from existing manifests
- `conversion-status` accepts `source_url`/`sourceUrl` and `source_file_name`/`sourceFileName` for native-source quote sync fallback when quote target cannot be resolved
- pnpm for dependency management (not npm/yarn)

## Documentation Assets

| File | Loaded | Purpose |
|---|---|---|
| `.github/ai-toolchain-version.md` | Always | Workspace toolchain marker + executable sync checklist |
| `.github/copilot-instructions.md` | Always | This file — project summary |
| `AGENTS.md` | On demand | Cross-tool agent instructions |
| `.github/instructions/api.instructions.md` | When editing `api/**` | API route conventions |
| `.codex/config.toml` | On demand | Workspace Codex MCP/discovery parity config |
| `.codex/rules/default.rules` | On demand | Codex command safety guardrails |
| `.agents/skills/README.md` | On demand | Codex skills scaffold for project-level skill packs |
| `memories/repo/code-index.md` | Listed | Module index — exports, deps, purpose per file |
| `memories/repo/api-routes.md` | Listed | API route catalog with request/response schemas |
| `memories/repo/env-vars.md` | Listed | Environment variables and secrets reference |
| `memories/repo/project-map.md` | Listed | Project IDs, directories, toolchain-managed paths |
| `docs/ai/context.md` | — | Human-readable AI context snapshot (sync + structure status) |
| `docs/ai/experience-log.md` | — | Append-only session discovery log (human) |
| `docs/ai/run-logs/` | — | Per-session run logs (human) |
| `docs/requirements/dashboard.md` | — | Requirements overview (human) |
| `docs/architecture/codebase-guide.md` | — | Architecture narrative with Mermaid diagrams (human) |
| `docs/architecture/edge-functions.md` | — | Serverless function catalog (human) |

## Session Completion Checklist

After any multi-step coding session:
1. Verify build passes: `pnpm build`
2. Run lint: `pnpm lint`
3. Update documentation if structure changed
4. Log session discoveries to experience log
5. Recover context from the latest 3 run logs when SessionStart bootstrap context is unavailable
6. Create run logs for planned chunk milestones and refactor/issue-fix sessions, not only full feature deliveries
7. After feature completion or significant integration changes, trigger **Experience Memory Curator** to extract durable lessons into `/memories/` and reusable skills
