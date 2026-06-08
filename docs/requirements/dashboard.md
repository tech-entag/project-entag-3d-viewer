<!-- last-verified: 2026-04-07 -->

# Requirements Dashboard

**Total**: 4 | **Implemented**: 4 | **Tested**: 2 | **Open blockers**: 1

| Req ID | Title | Priority | Status | Owner | Impl Files | Test Files |
|--------|-------|----------|--------|-------|------------|------------|
| REQ-001 | Upload & translate 3D model via Autodesk | High | implemented | — | `api/autodesk.cts`, `api/autodesk_helpers/index.ts`, `api/autodesk_helpers/format-map.ts` | `e2e/viewer-and-conversion.spec.ts` |
| REQ-002 | Embed Forge Viewer with URN | High | implemented | — | `src/pages/viewer/index.tsx`, `api/viewer-source.cts`, `api/autodesk_helpers/viewer-cache.ts` | `e2e/viewer-and-conversion.spec.ts` |
| REQ-003 | Trigger Bubble.io 3D preview workflow | Medium | implemented | — | `api/bubble-trigger.cts` | — |
| REQ-004 | Sync ready STEP/DWG quote derivatives to Digifabster | High | implemented | — | `api/conversion-status.cts`, `api/autodesk_helpers/digifabster-sync.ts` | — |
