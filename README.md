<!-- last-verified: 2026-05-07 -->

# Entag 3D Viewer

Vite + React + TypeScript app for Autodesk APS upload/translation, Forge Viewer rendering, and Bubble workflow
integration.

## Core Commands

```bash
pnpm dev
pnpm lint
pnpm build
pnpm test:e2e
```

## Viewer Guardrail Checks

Use this command before releases and after API-route edits:

```bash
pnpm test:viewer:guardrail
```

What it validates:

1. Viewer page behavior in local bubble URL mode.
2. Viewer URN lookup behavior and cloud fallback block UX.
3. Direct handler-level dry-run contracts for [api/autodesk.cts](api/autodesk.cts) and
	 [api/conversion-status.cts](api/conversion-status.cts).

## Why Contract Checks Are Handler-Level

In this workspace, local Vite + api-routes can intermittently return EISDIR for POST calls to /api.
For deterministic contract coverage, [scripts/viewer-resilience-smoke.ts](scripts/viewer-resilience-smoke.ts)
imports handlers directly.

## Deploy to Production

```bash
npx vercel --prod --yes
```

After deploy, run at least one dry-run probe:

```bash
curl -X POST "https://project-entag-3d-viewer.vercel.app/api/conversion-status" \
	-H "content-type: application/json" \
	-d '{"dry_run":true,"viewer_status":"success","quote_status":"not_required"}'
```
