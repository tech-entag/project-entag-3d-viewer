<!-- last-verified: 2026-04-08 -->

# Module Ownership Guide

## `api/` — Vercel Serverless Functions

Owner: Backend / API layer. Runs on Vercel as serverless functions.

| File | Responsibility |
|---|---|
| `autodesk.cts` | Main orchestration: validate → classify source → auth/upload/translate (SVF-first) → return viewer + quote metadata |
| `conversion-status.cts` | Poll Autodesk manifest, normalize status (including nested graphics URNs), persist local viewer bubble + dependencies, and sync ready STEP/DWG quote derivatives to Digifabster upload API |
| `viewer-source.cts` | URN lookup endpoint for local-mode startup (`/api/viewer-source?urn=...`) |
| `bubble-trigger.cts` | Forward 3D preview data to Bubble.io workflow |
| `autodesk_helpers/index.ts` | Autodesk API helpers for auth/upload/translate + derivative discovery/download + signed cookie extraction from `Set-Cookie` |
| `autodesk_helpers/download.ts` | Fetch remote file by URL → convert to File object |
| `autodesk_helpers/format-map.ts` | Source extension classification and short-scope quote target mapping |
| `autodesk_helpers/viewer-cache.ts` | Blob-backed URN mapping + viewer derivative persistence (`ensureViewerBubbleInBlob`), including root SVF internal manifest parsing and dependency upload under output-relative paths |
| `autodesk_helpers/digifabster-sync.ts` | Quote derivative download (`step`/`dwg`), Blob staging, DigiFabster S2S token exchange + shared auth header builder, direct-token fallback on `401/403`, `/v2/upload_models/` upload-job + binary upload compatibility, retry/backoff, and best-effort sync-record caching |

**Convention:** `.cts` extension = CommonJS TypeScript for Vercel. Helper files use `.ts`.

## `src/` — React Frontend

Owner: Client-side SPA. Bundled by Vite.

| Directory/File | Responsibility |
|---|---|
| `main.tsx` | Entry point: mounts App into `#root` |
| `App.tsx` | Router: `/` → Home, `/viewer` → Viewer |
| `pages/index.tsx` | Home page (placeholder) |
| `pages/viewer/index.tsx` | Forge Viewer embed — supports cloud mode (`urn` + `access_token`), direct local mode (`bubbleUrl`), and URN-only local resolution by polling `/api/viewer-source` |
| `helpers/base64converter.ts` | Blob → Base64/File conversion utilities |
| `helpers/download.ts` | Client-side file download helper (duplicate of API helper) |
| `assets/script.js` | Legacy Forge Viewer init (unused in production flow) |

## `public/` — Static Assets

| File | Purpose |
|---|---|
| `_redirects` | Netlify-style redirects (may be unused on Vercel) |

## `scripts/` — Local Test And Trace Utilities

Owner: Engineering tooling / verification helpers.

| File | Responsibility |
|---|---|
| `bubble-flow-e2e.ts` | Handler-level Bubble STEP flow simulation suite (upload dry-run, status progression, price-tweaker contract + payload normalization checks) |
| `mock-price-tweaker.cjs` | Local mock service for price-tweaker endpoint verification used by the Bubble flow suite |
| `trace-log-smoke.cjs` | Request-trace smoke script for timeline instrumentation verification |

## Cross-Module Rules

- API helpers (`api/autodesk_helpers/`) are server-only — never import from `src/`.
- `src/helpers/download.ts` duplicates `api/autodesk_helpers/download.ts` — consider consolidating if shared logic needed.
- Autodesk Viewer SDK is loaded via CDN in `index.html`, not installed as npm package. Access via `Autodesk.Viewing.*` globals.
- URN-only local playback requires Blob-backed cache population in `conversion-status.cts` and a configured `BLOB_READ_WRITE_TOKEN`.
- Local cache refresh uses overwrite semantics to keep persisted SVF dependency assets in sync after retranslations.
- Quote upload sync requires `part_id` + `version`, explicit `DIGIFABSTER_UPLOAD_ENDPOINT`, and Blob access for derivative staging; helper logic now supports both classic `file_url` uploads and `/v2/upload_models/` job-based uploads.
- Price tweak forwarding requires explicit `DIGIFABSTER_PRICE_TWEAK_ENDPOINT` and shared helper auth headers: exchange API key (`DIGIFABSTER_API_KEY`, fallback `DIGIFABSTER_API_TOKEN`) at `DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT`, then send `Authorization: Token ...` with the returned token.
- Sync-record Blob writes are best-effort after a successful DigiFabster submission and should not be treated as the primary success/failure boundary.
