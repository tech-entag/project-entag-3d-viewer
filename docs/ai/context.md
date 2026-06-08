<!-- last-verified: 2026-05-16 -->

# AI Context

## Toolchain Status

| Item | Value |
|---|---|
| Workspace marker | `v1.5.0` |
| Source manifest | `~/.copilot/VERSION.md` |
| Sync date | `2026-05-07` |
| Sync mode | Full toolchain sync |

## Copilot Context Surfaces

| Path | Role |
|---|---|
| `.github/copilot-instructions.md` | Always-loaded workspace summary |
| `.github/instructions/*.instructions.md` | Path-scoped editing rules |
| `memories/repo/*.md` | Workspace canonical references |
| `docs/ai/experience-log.md` | Human audit log for durable discoveries |
| `docs/ai/run-logs/*.md` | Session-level operational logs |

## Codex Parity Surfaces

| Path | Role |
|---|---|
| `.codex/config.toml` | Workspace Codex MCP/discovery parity config |
| `.codex/rules/default.rules` | Command safety policy scaffold |
| `.agents/skills/README.md` | Codex project skills scaffold |
| `AGENTS.md` | Cross-tool bridge and policy entrypoint |

## Canonical References Present

- `memories/repo/api-routes.md`
- `memories/repo/code-index.md`
- `memories/repo/env-vars.md`
- `memories/repo/project-map.md`

## Notes

- Native 2D no-translation docs closure (2026-05-16): canonical AI references now document `native2d:<ext>:<fingerprint>` URN generation, `/api/autodesk` thumbnail-mode success contract (`viewer.mode="thumbnail"` + `thumbnailDataUrl`), and direct DigiFabster native sync behavior for direct 2D formats.
- `/api/conversion-status` canonical contract now reflects native fast-path detection (`native2d:*` URN or direct 2D source extension), Autodesk manifest/token bypass in native mode, and credential requirement exception (credentials required only for Autodesk-backed polling).
- Canonical env/index references now include `DIRECT_2D_NO_TRANSLATION_FORMATS` and format-map helpers `shouldSkipAutodeskTranslationForFormat` / `shouldSkipAutodeskTranslationForSource`.
- Repomix/GitNexus coverage for this closure: MCP surfaces were not exposed in this runtime, so the update was validated through deterministic source reads and targeted `api/**` pattern search.
- Embed session bootstrap slice (2026-05-16): added shared helpers in `api/embed_helpers/` for embed
	constants/normalizers, HMAC-signed guest token issuance/verification, and in-memory embed session storage.
- Embed session durability/upload delta (2026-05-16): added Blob helper (`api/embed_helpers/blob-storage.ts`),
	upgraded embed session persistence to async memory + Blob durability with `currentPartId`
	(`api/embed_helpers/session-store.ts`), and added embed part record storage (`api/embed_helpers/part-store.ts`).
- New direct upload contract: `POST /api/embed/sessions/{embedSessionId}/files` now validates guest token +
	multipart file constraints, stages source files to Blob, stores part metadata, and updates session
	`currentPartId` for subsequent reads.
- New embed session routes are now documented as part of the active API surface:
	`POST /api/embed/sessions` for create/resume and `GET /api/embed/sessions/{embedSessionId}` for
	token-validated read/resume state refresh (now including `currentPart` projection when available).
- Frontend scaffold now includes `/embed/part` (`src/pages/embed/part.tsx`) with parent-origin handshake,
	session bootstrap call, direct source upload call, and `postMessage` contract envelopes
	(`bubble.embed.*` / `vercel.embed.*`) including upload-stage and part-created events.
- Validation evidence for this slice: `pnpm build` passed, `pnpm lint` passed, and direct `tsx`
	handler smoke invocation returned 200 for create/read with consistent `embedSessionId`.
- Validation delta for this implementation: direct create/read/upload handler smoke returned
	`create=200`, `read=200`, and `upload=503 Upload storage unavailable` as expected in local runs without
	`BLOB_READ_WRITE_TOKEN`.
- Viewer query-token placeholder regression closure (2026-05-14): `api/viewer-source.cts` now normalizes
	`access_token`/`accessToken` values and treats empty, whitespace-only, `undefined`, and `null` as missing
	token input before branch logic.
- Viewer frontend token parsing in `src/pages/viewer/index.tsx` now applies the same placeholder normalization,
	supports `accessToken` alias parsing, and avoids forwarding placeholder token values to
	`/api/viewer-source`.
- Validation evidence for this regression: `pnpm build` passed; `pnpm test:e2e -- e2e/viewer-and-conversion.spec.ts`
	returned `5 passed, 2 skipped`; local direct handler invocation with `access_token=undefined` returned
	`404 queued`; production post-deploy checks returned `404 queued` for no token, `404 queued` for
	`access_token=undefined`, and `401 unauthorized` for a clearly invalid non-placeholder token.
- Deployment evidence for this regression: inspect URL
	`https://vercel.com/citizendevio/project-entag-3d-viewer/DpcKUxoBxcDHqo1DHjZTAeyEfmHY`, deployment URL
	`https://project-entag-3d-viewer-7dxckqczd-citizendevio.vercel.app`, alias
	`https://project-entag-3d-viewer.vercel.app`.
- Viewer source processing closure (2026-05-14) documents the real rendered-geometry proof after the timeout/rewrite fix: production `/api/autodesk` accepted `phone-holder.STEP`, Autodesk manifest later reached `success` with `output/1/phone-holder.svf`, `/api/viewer-source` generated/persisted the local SVF to Vercel Blob, Blob `HEAD` returned `200 application/octet-stream`, and production `/viewer?urn=...` rendered visible Autodesk geometry with nonblank WebGL pixels.
- `/api/viewer-source` now distinguishes token-backed processing from missing cache: in-progress Autodesk manifests return `202 processing` with `viewerStatus` and retry hint; unauthorized manifest/token errors return `401 autodesk_manifest_unauthorized`; failed translations remain `424`.
- Viewer URN lookup defaults now tolerate slower real translations: token-backed lookup uses `300` attempts at `4s` (about 20 minutes), cache-only lookup uses `24` attempts at `5s` (about 2 minutes), URL override attempts cap at `900`, and cancellation checks stop stale StrictMode/remount loops.
- Production deployment for this closure: `dpl_9QW3Nta6mq8Jn7Fubf78CFgr8pks`, aliased to `https://project-entag-3d-viewer.vercel.app`. Post-deploy proof for the real phone-holder URN returned `source=cache`, local Blob `HEAD=200`, `canvasCount=2`, and WebGL center pixel `[177,185,207,255]`.
- Viewer recovery closure (2026-05-14) documents the post-Blob-upgrade runtime blockers: production `/api/autodesk` was still deployed with a 15s lambda timeout until Vite/Vercel config emitted `maxDuration=60`, and prebuilt output initially lacked `/viewer` SPA rewrites.
- Final production deployment `dpl_J7cjtAFsm1w2guqkQH9FD1MZUMS3` (`https://project-entag-3d-viewer-ohxbpsqju-citizendevio.vercel.app`) is aliased to `https://project-entag-3d-viewer.vercel.app`; `npx vercel inspect` showed `api/autodesk` timeout `60`.
- Runtime duration is now represented in both `vite.config.ts` (`vercel.defaultMaxDuration = 60`) and `vercel.json` (`functions` maxDuration rules). Prebuilt SPA routing guardrails in `vite.config.ts` include `/viewer`, `/viewer/(.*)`, `/embed/part`, and `/embed/part/(.*)` rewrites.
- Backfill closure (2026-05-14) recovered the remaining 5 last-week Bubble records after the timeout fix; each reached `viewer=success/local` and `quote=success`. Latest dry-run report shows `recordsInWindow=24`, `missingUrnAndImage=0`, `missingUrnWithImage=0`, `queued=0`.
- Validation evidence for this closure: `pnpm build` passed, `pnpm lint` passed, local generated Vercel `.vc-config.json` files showed `maxDuration=60`, live probes returned `200` for `/`, `/viewer`, and `/viewer?urn=test&lookupAttempts=1&lookupIntervalMs=20`, and expected controlled responses for POST-only/missing-test-URN API checks.
- Viewer resilience hardening closure (2026-05-07) is documented with deterministic guardrails: `e2e/viewer-and-conversion.spec.ts` now skips API HTTP checks in local Vite mode, and `scripts/viewer-resilience-smoke.ts` verifies `/api/autodesk` + `/api/conversion-status` contracts via direct handler dry runs.
- Viewer guardrail scripts are now standardized in `package.json`: `test:viewer:ui`, `test:viewer:contracts`, and `test:viewer:guardrail`.
- Production deployment verification passed on `https://project-entag-3d-viewer-oud1nrft0-citizendevio.vercel.app` and alias `https://project-entag-3d-viewer.vercel.app`; Node fetch probes returned `200` for `POST /api/autodesk` dry run (`quote.targetFormat=step`, `quote.status=queued`), `POST /api/conversion-status` dry run (`viewer.priority=true` with quote failed), and `GET /viewer?bubbleUrl=...`.
- Drift closed from `v1.4.0` to `v1.5.0`.
- Backfill ops closure (2026-05-07) was recorded for `scripts/backfill-bubble-urn-thumbnail.cjs` with verified report totals: `45 total`, `30 updated`, `3 failed`, `12 skipped`.
- Backfill flow documentation now records a direct Bubble Data API patch fallback when workflow-trigger route checks return upstream 404 for `create_3d_preview`.
- `.github/hooks/post-edit-format.json` was intentionally not deployed because the workspace does not meet the Prettier condition in the sync manifest.
- `.codex/config.toml` keeps resolved runtime values for Pencil and Obsidian and has no unresolved placeholders.
- Workspace Codex MCP server entries remain coherent with the required toolchain server set; user-level `brevo` stays user-scoped due credentialed header configuration.
- Repomix and GitNexus MCP tools were not exposed in this runtime; sync verification used deterministic file-level comparison.
- Experience Memory Curator handoff remains pending manual invocation in environments where that subagent is available.

## Closure Gates

| Gate | Status | Notes |
|---|---|---|
| Documentation gate | Satisfied | `docs/ai/context.md`, `docs/ai/experience-log.md`, canonical refs, and run logs updated for the 2026-05-14 viewer timeout/rewrite/backfill closure, rendered-geometry polling proof, placeholder-token normalization regression closure, the 2026-05-16 embed session bootstrap slice, the 2026-05-16 embed upload/durability delta, and the 2026-05-16 native 2D no-translation documentation closure |
| Toolchain parity gate | Satisfied | Workspace marker, AGENTS/instructions/checks metadata, and Codex parity surfaces verified for v1.5.0 |
| Learning gate | Pending (blocked) | Experience Memory Curator subagent/tool not available in this runtime |
