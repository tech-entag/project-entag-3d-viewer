<!-- last-verified: 2026-04-07 -->

# Traceability Matrix

| Req ID | User Story | Impl Files | Test Files | Status | Risk |
|--------|-----------|------------|------------|--------|------|
| REQ-001 | As a Bubble user, I want to upload a 3D file so it gets translated for viewing | `api/autodesk.cts`, `api/autodesk_helpers/index.ts`, `api/autodesk_helpers/download.ts`, `api/autodesk_helpers/format-map.ts` | `e2e/viewer-and-conversion.spec.ts` (dry-run conversion/quote scenarios) | implemented | Medium — no upload file size guardrails at API boundary |
| REQ-002 | As a viewer, I want to see a 3D model in-browser given a URN and token | `src/pages/viewer/index.tsx`, `api/viewer-source.cts`, `api/autodesk_helpers/viewer-cache.ts`, `index.html` (CDN scripts) | `e2e/viewer-and-conversion.spec.ts` (cloud/local/URN-only modes) | implemented | Low — relies on Autodesk CDN and Blob availability for URN-only local mode |
| REQ-003 | As the system, I want to trigger Bubble.io to store the 3D preview data | `api/bubble-trigger.cts` | — | implemented | High — hardcoded Bearer token in source |
| REQ-004 | As the quoting pipeline, I want ready STEP/DWG derivatives uploaded to Digifabster with part context | `api/conversion-status.cts`, `api/autodesk_helpers/digifabster-sync.ts` | — | implemented | Medium — requires `BLOB_READ_WRITE_TOKEN` and external Digifabster API availability |
