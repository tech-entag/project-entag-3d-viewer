<!-- last-verified: 2026-05-16 -->

# API Routes

All routes are Vercel serverless functions in `api/` using `.cts` extension.

**IMPORTANT: Credentials pattern**
- Autodesk client ID and secret are **passed by Bubble in request body**, not stored in Vercel env.
- This allows Bubble to rotate/inject credentials per request without redeploying Vercel.
- Credentials are validated directly on each `/api/autodesk` call; no cached auth token is returned to client.
- See `/api/autodesk` and `/api/conversion-status` for credential injection points.

## Durable Native 2D Split Rules

- `/api/autodesk` still requires `client_id` and `client_secret` even when the request resolves to native 2D bypass.
- `/api/conversion-status` allows credential-less polling only when native fast path is active.
- Native fast path in `/api/conversion-status` requires: no explicit `quoteTarget`, `source_url`/`sourceUrl` present, and either `urn` starts with `native2d:` or source extension matches `DIRECT_2D_NO_TRANSLATION_FORMATS`.
- Consumers must not assume identical credential behavior between upload kickoff and status polling routes.

## POST /api/autodesk

Upload a 3D file to Autodesk and start short-scope translation.

**Request body:**
```json
{
  "url": "string — remote file URL to download",
  "part_id": "string — Bubble part identifier",
  "version": "string — Bubble app version",
  "client_id": "string — Autodesk APS client ID (injected from Bubble secrets, NOT from Vercel env)",
  "client_secret": "string — Autodesk APS client secret (injected from Bubble secrets, NOT from Vercel env)",
  "auto_modelid": "boolean — optional, default true; set false to disable server-side follow-up",
  "autoModelId": "boolean — optional camelCase alias, default true; set false to disable server-side follow-up",
  "dry_run": "boolean — optional, skips Autodesk calls and returns simulated statuses"
}
```

**Response (200):**
```json
{
  "success": true,
  "urn": "string — Autodesk URN | native2d:<ext>:<fingerprint> | dryrun:*",
  "accessToken": "string | null — Autodesk OAuth2 bearer token (null on native2d fast path)",
  "bucketKey": "string | null",
  "objectKey": "string | null",
  "sourceFormat": "string — detected extension (.step, .dwg, etc.)",
  "sourceUrl": "string | undefined — echoed source URL on native2d fast path",
  "sourceFileName": "string | undefined — detected source file name on native2d fast path",
  "viewer": {
    "status": "queued | inprogress | success | failed",
    "priority": true,
    "mode": "cloud | local | thumbnail | null (once polling reveals derivative type)",
    "thumbnailDataUrl": "string | undefined — inline SVG thumbnail for native2d fast path"
  },
  "quote": {
    "status": "not_required | queued | inprogress | success | failed",
    "targetFormat": "step | dwg | null",
    "reason": "string",
    "error": "string | null",
    "upload": "object | null | undefined — DigiFabster upload metadata"
  },
  "thumbnailDataUrl": "string | undefined — top-level alias for viewer.thumbnailDataUrl on native2d fast path",
  "autoFollowup": {
    "status": "updated | failed | timeout | disabled",
    "attempts": "number | undefined",
    "endpoint": "string | undefined",
    "last": "object | null | undefined",
    "reason": "string | undefined"
  }
}
```

**Error (400/403/500):**
```json
{
  "error": "string",
  "code": "string (e.g., AUTH-001)",
  "details": "string"
}
```

**Flow:**
1. Validate `url`, `part_id`, `version`, `client_id`, `client_secret`
2. If `dry_run=true`: classify source format and return simulated viewer/quote statuses
3. Else:
   - Download source file from `url` and classify format.
   - If source extension is in direct 2D no-translation list (`DIRECT_2D_NO_TRANSLATION_FORMATS`, default `dxf,dwg,f2d,slddrw`):
     - Build synthetic URN `native2d:<ext>:<fingerprint>`.
     - Skip Autodesk OAuth/upload/translation pipeline.
     - Generate inline thumbnail data URL and return viewer success with `viewer.mode="thumbnail"`.
     - Sync source directly to DigiFabster via `syncNativeSourceToDigifabster`.
   - Otherwise:
     - Exchange Autodesk credentials for access token (OAuth2)
     - Create temporary bucket and OSS object key
     - Upload to Autodesk OSS
     - Finalize/translate to SVF (primary, always)
     - Queue optional quote format (STEP or DWG) for Autodesk Model Derivative API
   - If `auto_modelid`/`autoModelId` are not false, call `/api/conversion-status` in a bounded retry loop to attempt Bubble `orderpart/{part_id}` `modelId` writeback server-side
4. Return URN, viewer status, and quote status

**Important notes:**
- Credentials are validated fresh on each call; no caching in Vercel env.
- Native 2D fast path still requires request-body credentials because this route validates `client_id`/`client_secret` before branching and can reuse them for follow-up polling compatibility.
- Native 2D fast path returns synthetic URN `native2d:<ext>:<fingerprint>`, `viewer.mode="thumbnail"`, and inline `thumbnailDataUrl` while bypassing Autodesk translation.
- Direct 2D no-translation source extensions are configurable via `DIRECT_2D_NO_TRANSLATION_FORMATS` (`api/autodesk_helpers/format-map.ts`).
- Autodesk APS product entitlement can change server-side; if `403 AUTH-001` appears on unchanged code, new credentials may be needed from user's APS account.
- `accessToken` is returned for caching by client (not stored server-side).
- Local Vite dev-server `/api/*` proxy can return `EISDIR`/`403` during HTTP-level route checks; use `scripts/viewer-resilience-smoke.ts` for deterministic direct-handler contract verification in local workflows.
- Auto follow-up defaults to enabled; set either `auto_modelid=false` or `autoModelId=false` to disable it.
- Auto follow-up loop config is controlled by env vars `AUTO_MODELID_ATTEMPTS` (default `5`) and `AUTO_MODELID_INTERVAL_MS` (default `5000`).
- Vercel runtime duration must be enforced through `vite.config.ts` `vercel.defaultMaxDuration = 60` plus `vercel.json` `functions` maxDuration rules; per-route exported `config.maxDuration` alone did not propagate through `vite-plugin-vercel` build output during the 2026-05-14 incident.
- Verify duration changes in both local generated `.vercel/output/functions/api/autodesk.func/.vc-config.json` and production `npx vercel inspect` output; final deployment `dpl_J7cjtAFsm1w2guqkQH9FD1MZUMS3` inspected with `api/autodesk` timeout `60`.
- External orchestration/backfill callers should send `auto_modelid: false` because they already poll `/api/conversion-status`; this preserves `/api/autodesk` lambda time for upload/translation kickoff.
- Batch backfill operations previously observed intermittent `504 FUNCTION_INVOCATION_TIMEOUT` on this route for SLDPRT/X_T files; after the 2026-05-14 timeout fix, the remaining 5 last-week records updated successfully.
- Latest last-week backfill snapshot (2026-05-14): final dry-run report shows `recordsInWindow=24`, `missingUrnAndImage=0`, `missingUrnWithImage=0`, `queued=0`.
- Workflow route checks for `create_3d_preview` can return upstream `404` in production contexts; backfill remediation should use direct Bubble Data API `orderpart/{id}` PATCH + readback as the default path.

**Runtime config:** `maxDuration = 60` (source-controlled in both `vite.config.ts` and `vercel.json`).

## POST /api/conversion-status

Check conversion state for viewer and optional quote derivative.

**Request body:**
```json
{
  "urn": "string — required when dry_run=false; accepts Autodesk URN or native2d:<ext>:<fingerprint>",
  "client_id": "string — required when dry_run=false and native fast path is not active",
  "client_secret": "string — required when dry_run=false and native fast path is not active",
  "quoteTarget": "step | dwg | null",
  "part_id": "string — optional, Bubble orderpart id for Digifabster upload sync",
  "version": "string — optional, Bubble version (for Digifabster upload sync)",
  "source_url": "string — optional source URL; required for native fast-path/native fallback sync",
  "sourceUrl": "string — optional camelCase alias for source_url",
  "source_file_name": "string — optional file name override; used by native fast-path detection",
  "sourceFileName": "string — optional camelCase alias for source_file_name",
  "bubble_data_api_base_url": "string — optional Bubble Data API base URL override",
  "bubbleDataApiBaseUrl": "string — optional camelCase alias for bubble_data_api_base_url",
  "bubble_api_token": "string — optional Bubble Data API bearer token",
  "bubbleApiToken": "string — optional camelCase alias for bubble_api_token",
  "bubble_orderpart_type": "string — optional Bubble Data API thing type for order part writeback",
  "bubbleOrderPartType": "string — optional camelCase alias for bubble_orderpart_type",
  "bubble_modelid_field": "string — optional Bubble field name to patch with modelId",
  "bubbleModelIdField": "string — optional camelCase alias for bubble_modelid_field",
  "dry_run": "boolean — optional",
  "viewer_status": "queued | inprogress | success | failed (dry_run only)",
  "quote_status": "not_required | queued | inprogress | success | failed (dry_run only)",
  "quote_error": "string — optional (dry_run only)"
}
```

**Response (200/500):**
```json
{
  "success": "boolean",
  "viewer": {
    "status": "queued | inprogress | success | failed",
    "priority": true,
    "mode": "cloud | local | thumbnail",
    "localModelUrl": "string | null",
    "bubbleUrl": "string | null",
    "localError": "string | null",
    "accessToken": "string | null"
  },
  "quote": {
    "status": "not_required | queued | inprogress | success | failed",
    "targetFormat": "step | dwg | null",
    "error": "string | null",
    "upload": {
      "status": "skipped | submitted | cached",
      "source": "none | digifabster | cache",
      "objectModelId": "number | null",
      "orderId": "number | null",
      "sessionId": "string | null",
      "reason": "string | null"
    },
    "orderPartUpdate": {
      "status": "updated | skipped | failed",
      "endpoint": "string | undefined",
      "orderPartId": "string | undefined",
      "modelId": "number | undefined",
      "thingType": "string | undefined",
      "fieldName": "string | undefined",
      "reason": "string | undefined",
      "httpStatus": "number | undefined",
      "error": "string | undefined",
      "response": "unknown"
    },
    "priceTweaking": {
      "endpoint": "string",
      "digifabsterEndpoint": "string",
      "payload": "object | null"
    }
  }
}
```

**Notes:**
- Uses Autodesk manifest + derivative tree lookup to normalize status.
- Native fast path is detected when `quoteTarget` is absent, `source_url`/`sourceUrl` is present, and either:
  - `urn` starts with `native2d:`, or
  - source file name extension is in `DIRECT_2D_NO_TRANSLATION_FORMATS`.
- In native fast path, Autodesk token/manifest calls are skipped and viewer resolves immediately as `viewer.status="success"` with `viewer.mode="thumbnail"`.
- `client_id`/`client_secret` are optional only for native fast-path requests; Autodesk-backed polling still requires them.
- Native fast path keeps native DigiFabster sync and Bubble `modelId` writeback compatibility through `quote.upload` and `quote.orderPartUpdate`.
- If `quoteTarget` is not provided, auto-selects between `step`/`dwg` based on manifest derivative availability and readiness priority (`success` > `inprogress` > `queued` > `failed`).
- Local Vite dev-server `/api/*` proxy may return `EISDIR`/`403` in HTTP tests; local contract checks should call handlers directly via `scripts/viewer-resilience-smoke.ts`.
- When graphics URN is nested under the target output branch, inherited branch `status`/`progress` are used to normalize viewer readiness.
- When viewer status is `success`, attempts `ensureViewerBubbleInBlob(urn, accessToken)` to persist a local viewer artifact and URN mapping.
- If quote target cannot be resolved from manifest but `source_url`/`sourceUrl` is supplied, attempts native source upload sync via `syncNativeSourceToDigifabster`.
- Native source sync uses the same Digifabster sync cache with `quoteTarget = "native"` and marks `quote.status = success` when upload status is `submitted` or `cached`.
- Native source sync validates `part_id`, `version`, and URL format; invalid source URL returns non-retryable sync failure details.
- Signed cookies are parsed from both Autodesk JSON payload and `Set-Cookie` headers (CloudFront cookie variants).
- Local cache persistence uploads root `.svf` plus dependency assets discovered from internal `manifest.json` under output-relative paths (for example, `output/1/*`).
- Blob writes use overwrite to refresh stale local cache artifacts after retranslations.
- If Blob token is missing, returns `viewer.mode="cloud"` and `viewer.localError` describing `BLOB_READ_WRITE_TOKEN` as missing.
- If persistence fails, `viewer.localError` returns a detailed message with the persistence failure reason.
- Durable cache rules from 2026-04-07 session:
  - Forward CloudFront signed cookies on every derivative/dependency download.
  - Treat root SVF as an archive and cache all sidecar assets listed in inner `manifest.json`.
  - Keep blob writes overwrite-enabled for URN recache paths.
  - Use parent output-branch status/progress when nested graphics nodes are ambiguous.
- When `quoteTarget` resolves to `step`/`dwg` and quote status is `success`, the function attempts to:
  1) download the quote derivative,
  2) persist it to Vercel Blob,
  3) call Digifabster upload endpoint (`DIGIFABSTER_UPLOAD_ENDPOINT`) with `file_url`, `part_id`, `version`.
- When `quoteTarget` is unresolved and native source URL is provided, the function uploads `source_url`/`sourceUrl` directly to Digifabster and reports upload metadata in `quote.upload`.
- There is no implicit bridge default endpoint for quote upload or price tweak forwarding; endpoint env vars must be explicitly configured.
- Digifabster upload and price tweak forwarding share helper-built auth headers (`buildDigifabsterHeaders`) that exchange API key for S2S token and cache it by TTL.
- Upload retries up to 2 times for 5xx/network failures with exponential backoff and uses a 270s timeout.
- Upload failures return a fail-fast error payload containing `error`, `code`, and `details`.
- When `quote.upload.objectModelId` exists, route attempts Bubble Data API PATCH writeback to `/{thingType}/{part_id}` with configurable field name (default `modelId`).
- Bubble writeback token is resolved from request body (`bubble_api_token` / `bubbleApiToken`) then env (`BUBBLE_DATA_API_TOKEN`, `BUBBLE_API_TOKEN`, `BUBBLE_DATA_API_BEARER_TOKEN`).
- `viewer.localModelUrl` is the canonical local SVF URL field; `viewer.bubbleUrl` is kept for backward compatibility.
- `quote.priceTweaking.endpoint` exposes a Bubble-facing endpoint (`POST /api/digifabster-price-tweak`) to trigger downstream pricing workflows.
- `quote.priceTweaking.digifabsterEndpoint` is resolved from `DIGIFABSTER_PRICE_TWEAK_ENDPOINT` and can be an empty string when not configured.
- Returns HTTP 500 only when viewer status is failed.
- Runtime config: `maxDuration = 60`.

## POST /api/sheet-nesting

Generate a nested DXF output from a single-part DXF input using a grid-based sheet layout.

**Request body:**
```json
{
  "source_url": "string — optional DXF URL source (aliases: sourceUrl, url)",
  "dxf_content": "string — optional inline DXF text (alias: dxfContent)",
  "dxf_base64": "string — optional base64-encoded DXF text (alias: dxfBase64)",
  "source_file_name": "string — optional filename hint; must end in .dxf (alias: sourceFileName)",
  "quantity": "integer > 0, optional (aliases: count, qty), default 1",
  "sheet_width": "number > 0, optional (alias: sheetWidth)",
  "sheet_height": "number > 0, optional (alias: sheetHeight)",
  "spacing": "number > 0, optional (aliases: part_spacing, partSpacing), default 5",
  "allow_rotation": "boolean, optional (alias: allowRotation), default true",
  "dry_run": "boolean, optional (alias: dryRun), default false",
  "include_dxf_content": "boolean, optional (alias: includeDxfContent), default dry_run value",
  "sync_digifabster": "boolean, optional (alias: syncDigifabster), default true",
  "technology_slug": "string, optional (alias: technologySlug)",
  "machine_id": "integer > 0, optional (alias: machineId)",
  "material_id": "integer > 0, optional (alias: materialId)",
  "part_id": "string, optional (alias: partId)",
  "version": "string, optional"
}
```

**Response (200):**
```json
{
  "success": true,
  "traceId": "string",
  "source": {
    "fileName": "string",
    "sourceUrl": "string | null"
  },
  "sheet": {
    "width": "number",
    "height": "number",
    "source": "request | digifabster_machine | digifabster_material | fallback",
    "technologySlug": "string",
    "machineId": "number | null",
    "materialId": "number | null"
  },
  "nesting": {
    "engine": "single-part-grid-v1",
    "rotationDeg": "0 | 90",
    "partWidth": "number",
    "partHeight": "number",
    "quantityRequested": "number",
    "partsPlaced": "number",
    "perSheetCapacity": "number",
    "sheetCount": "number",
    "spacing": "number",
    "inputEntityCount": "number",
    "supportedEntityCount": "number",
    "unsupportedEntityCount": "number"
  },
  "output": {
    "fileName": "string",
    "fileUrl": "string | null",
    "bytes": "number",
    "dxf": "string | undefined"
  },
  "digifabsterUpload": {
    "status": "skipped | submitted | cached | failed",
    "reason": "string | null",
    "source": "string | undefined",
    "objectModelId": "number | null | undefined",
    "orderId": "number | null | undefined",
    "sessionId": "string | null | undefined",
    "quoteStatus": "string | undefined"
  },
  "warnings": ["string"]
}
```

**Error (400/500):**
```json
{
  "error": "string",
  "details": "string"
}
```

**Notes:**
- DXF-only contract in v1: `source_file_name` / `sourceFileName` must resolve to `.dxf`.
- Source input can be remote URL, inline DXF text, or base64 DXF payload.
- Supported DXF entities are `LINE`, `LWPOLYLINE`, `POLYLINE`, `ARC`, and `CIRCLE`.
- `dry_run=true` skips Blob staging and Digifabster sync, and defaults `include_dxf_content=true`.
- Optional Blob staging uploads nested output to `sheet-nesting/{hash}/{file}.dxf` when `BLOB_READ_WRITE_TOKEN` exists.
- Optional Digifabster sync (`sync_digifabster=true`) runs only when not dry-run and staged `output.fileUrl` exists.
- Response summary fields are grouped under `sheet`, `nesting`, `output`, and `digifabsterUpload` for quick consumer checks.

**Runtime config:** `maxDuration = 60`

## POST /api/embed/sessions

Create or resume an embed session for the `/embed/part` iframe flow.

**Request body:**
```json
{
  "mode": "new | existing",
  "parentOrigin": "string — required URL origin",
  "bubbleOrderId": "string | null — required when mode=existing, forbidden when mode=new",
  "guestToken": "string — optional token used to resume and rotate an existing embed session"
}
```

**Response (200):**
```json
{
  "embedSessionId": "string",
  "guestToken": "string",
  "mode": "new | existing",
  "bubbleOrderId": "string | null",
  "status": "session_created | session_resumed",
  "expiresAt": "ISO datetime",
  "acceptedFileTypes": [".step", ".stp", ".dwg", ".dxf", ".igs", ".iges", ".stl", ".x_t", ".sldprt"],
  "maxFileSizeBytes": 209715200
}
```

**Error (400/401/500):**
```json
{
  "error": "string",
  "details": "string | undefined"
}
```

**Notes:**
- Validates boundary inputs before session handling: `mode`, normalized `parentOrigin`, and `bubbleOrderId` rules by mode.
- If `guestToken` is provided, resumes only when token signature, expiry, mode, origin, and bubble order context match.
- Guest tokens are HMAC-SHA256 signed via `EMBED_SESSION_SECRET`; missing secret falls back to a local development secret with a warning.
- Session/token TTL uses `EMBED_GUEST_TOKEN_TTL_SECONDS` (default `86400s`, max `2592000s` / 30 days).
- Session persistence is async via `api/embed_helpers/session-store.ts`: in-memory `Map` plus Blob JSON durability (`embed-sessions/{embedSessionId}.json`) when `BLOB_READ_WRITE_TOKEN` is configured.
- Session records now include `currentPartId` to track the latest uploaded source part context.

**Runtime config:** `maxDuration = 60`

## GET /api/embed/sessions/{embedSessionId}

Read and refresh an embed session snapshot by dynamic route ID and guest token.

**Query params:**
```json
{
  "guestToken": "string — required",
  "guest_token": "string — optional alias for guestToken",
  "bubbleOrderId": "string — optional consistency check for mode=existing"
}
```

**Response (200):**
```json
{
  "embedSessionId": "string",
  "guestToken": "string",
  "mode": "new | existing",
  "bubbleOrderId": "string | null",
  "status": "session_resumed",
  "expiresAt": "ISO datetime",
  "acceptedFileTypes": [".step", ".stp", ".dwg", ".dxf", ".igs", ".iges", ".stl", ".x_t", ".sldprt"],
  "maxFileSizeBytes": 209715200,
  "currentPart": {
    "vercelPartId": "string",
    "sourceFileId": "string",
    "sourceFileName": "string",
    "sourceFileSizeBytes": 12345,
    "status": "uploaded"
  }
}
```

**Error (400/401/403/409/500):**
```json
{
  "error": "string",
  "details": "string | undefined"
}
```

**Notes:**
- Dynamic route ID is resolved from the request path's last segment.
- Requires a valid, non-expired guest token, then enforces token `embedSessionId` match against path `embedSessionId`.
- For `mode=existing`, optional query `bubbleOrderId` must match token payload when provided.
- Successful reads rotate guest token + expiry and persist refreshed state through async session storage (memory + optional Blob).
- Response includes `currentPart` details when session `currentPartId` resolves via `api/embed_helpers/part-store.ts`; otherwise `currentPart` is `null`.

**Runtime config:** `maxDuration = 60`

## POST /api/embed/sessions/{embedSessionId}/files

Upload a source file directly for an embed session and update session `currentPartId`.

**Auth contract:**
- Guest token is required and can be supplied by:
  1) `Authorization: Bearer <guestToken>` header,
  2) query `guestToken` or `guest_token`,
  3) multipart form field `guestToken` or `guest_token`.

**Request body (`multipart/form-data`):**
```json
{
  "file": "File — required"
}
```

**Response (200):**
```json
{
  "vercelPartId": "string",
  "sourceFileId": "string",
  "fileName": "string",
  "fileSizeBytes": 12345,
  "status": "uploaded"
}
```

**Error (400/401/403/404/409/413/500/503):**
```json
{
  "error": "string",
  "details": "string | undefined"
}
```

**Notes:**
- Route path must resolve as `/api/embed/sessions/{embedSessionId}/files`.
- Enforces guest-token signature, expiry, and token/session-id match.
- Enforces session-context match (`mode`, `parentOrigin`, `bubbleOrderId`) against token payload.
- Accepts only `DEFAULT_ACCEPTED_FILE_TYPES` and enforces `DEFAULT_MAX_FILE_SIZE_BYTES`.
- Returns `503 Upload storage unavailable` when `BLOB_READ_WRITE_TOKEN` is missing.
- On success, writes source file to Blob path `embed-source-files/{embedSessionId}/{vercelPartId}/{safeFileName}`.
- Persists part record to `api/embed_helpers/part-store.ts` and updates session `currentPartId` via async `updateEmbedSession`.

**Runtime config:** `maxDuration = 60`

## GET /api/viewer-source

Resolve URN to a cached/generated local SVF URL for URN-only viewer startup.

**Query params:**
```json
{
  "urn": "string — required",
  "access_token": "string — optional Autodesk viewer token for on-demand local cache generation",
  "accessToken": "string — optional camelCase alias for access_token"
}
```

**Token normalization contract:**
- Placeholder token query values (`undefined`, `null`, empty, whitespace-only) are treated as missing token input.
- On uncached URNs, placeholder token inputs preserve cache-miss behavior (`404 queued`) instead of entering
  Autodesk auth/generation branches.
- `401 unauthorized` is reserved for non-placeholder token values that fail Autodesk manifest authorization.

**Response (200):**
```json
{
  "success": true,
  "urn": "string",
  "mode": "local",
  "localModelUrl": "string",
  "bubbleUrl": "string",
  "storedAt": "ISO datetime",
  "source": "cache | generated"
}
```

**Response (202):** token-backed manifest is still translating/preparing local source.
```json
{
  "success": false,
  "urn": "string",
  "mode": "processing",
  "status": "processing",
  "viewerStatus": "queued | inprogress | null",
  "retryAfterMs": 4000,
  "hint": "Autodesk translation is still preparing the local viewer source."
}
```

**Response (404):**
```json
{
  "error": "No local viewer bubble is cached for this URN yet.",
  "status": "queued",
  "hint": "Provide access_token to allow on-demand local cache generation."
}
```

**Response (401):** token cannot access Autodesk manifest.
```json
{
  "error": "Autodesk access token is not authorized for this manifest.",
  "status": "unauthorized",
  "hint": "Request a fresh viewer link or poll conversion-status with Autodesk credentials to refresh the local cache.",
  "reason": "autodesk_manifest_unauthorized"
}
```

**Response (424):** viewer translation failed before local cache was available.
```json
{
  "error": "Viewer translation failed before a local model could be cached.",
  "status": "failed",
  "viewerStatus": "failed"
}
```

**Response (503):** Blob persistence unavailable.
```json
{
  "error": "BLOB_READ_WRITE_TOKEN is not configured. Local viewer source cannot be persisted.",
  "status": "unavailable"
}
```

**Error (400/500/502):**
```json
{ "error": "string" }
```

**Notes:**
- Backed by `getViewerCacheRecord` in `api/autodesk_helpers/viewer-cache.ts`.
- If no cache exists and `access_token`/`accessToken` is supplied, calls `ensureViewerBubbleInBlob(urn, accessToken)` to generate/persist local SVF assets on demand.
- `access_token` and `accessToken` are normalized before branching: empty, whitespace-only, `undefined`, and `null` are treated as missing token values.
- Token-backed in-progress translations return `202 processing`, not `404 queued`, so the viewer can keep polling while Autodesk prepares the SVF and Blob cache.
- Cache misses without `access_token`/`accessToken` remain `404` with a hint to provide a token; do not treat cache-only misses as processing.
- Unauthorized Autodesk manifest/token failures return `401` with reason `autodesk_manifest_unauthorized`; do not mask these as missing cache.
- Failed viewer translations return `424`.
- Production regression contract (2026-05-14): uncached URN with no token returns `404 queued`; uncached URN with `access_token=undefined` also returns `404 queued`; uncached URN with an invalid non-placeholder token returns `401 unauthorized`.
- Used by frontend URN-only flow in `src/pages/viewer/index.tsx`; token-backed lookup defaults to `300` attempts at `4000ms`, cache-only lookup defaults to `24` attempts at `5000ms`, and URL override attempts cap at `900`.
- Frontend polling includes cancellation checks before fetch and after delay to stop stale React StrictMode/remount loops.
- `localModelUrl` is canonical and `bubbleUrl` is returned as compatibility alias.
- Production proof (2026-05-14): real `phone-holder.STEP` URN manifest reached `success` with `output/1/phone-holder.svf`; `/api/viewer-source` returned `200 source=cache`, Blob `HEAD` returned `200 application/octet-stream`, and `/viewer?urn=...` rendered visible geometry with nonblank WebGL center pixel.

## GET /api/digifabster-price-tweak

Returns endpoint contract metadata for Bubble configuration.

**CORS behavior:**
- Response includes request-aware CORS headers.
- Allowed origins are resolved from request context (validated production call includes `https://app.entag.co`).

**Response (200):**
```json
{
  "success": true,
  "endpoint": "string",
  "targetEndpoint": "string | null",
  "configured": "boolean",
  "requiredFields": ["part_id", "version", "objectModelId", "price_config", "material", "printer"],
  "recommendedFields": ["objectModelId", "orderId", "sessionId", "quoteTarget", "fileUrl", "fileName"],
  "configFields": {
    "quantity": { "type": "integer", "nullable": true },
    "tightest_tolerance": { "type": "enum", "nullable": true, "values": ["ISO 2768 - Medium (Standard)", "ISO 2768 Fine - requires 2D drawings", "ISO 2768 Course"] },
    "inspection": { "type": "enum", "nullable": true, "values": ["CMM", "First Article Inspection Report (FAIR)", "Measurement report"] },
    "roughness": { "type": "enum", "nullable": true, "values": ["As Machined", "Standard (3.2 um Ra)", "Smooth (1.6um Ra)", "Fine (0.8um Ra)"] },
    "finish": { "type": "enum", "nullable": true, "values": ["Standard", "Clear Coating (Lacquer/Enamel)", "Tin Plating", "Gold Plating", "Galvanizing", "Bead Blasting", "Polishing", "Anodizing", "Electroless Nickel Plating", "Powder Coating"] }
  },
  "priceTweakerFields": {
    "object_model_id": { "source": "objectModelId", "type": "integer", "required": true },
    "price_config": { "source": "price_config|priceConfig|priceTweaker.price_config", "type": "object", "required": true },
    "material": { "source": "material|priceTweaker.material", "type": "object", "required": true, "requiredKeys": ["printer", "title"] },
    "printer": { "source": "printer|priceTweaker.printer", "type": "object", "required": true, "requiredKeys": ["technology", "title"] }
  }
}
```

## POST /api/digifabster-price-tweak

Bubble-facing endpoint to submit price-tweaking payloads to Digifabster.

**CORS behavior:**
- Response includes request-aware CORS headers for both success and validation/error responses.
- Allowed methods: `GET,POST,OPTIONS`.
- Allowed headers include `Content-Type`, `Authorization`, and `x-vercel-protection-bypass`.

**Request body:**
```json
{
  "part_id": "string — required",
  "version": "string — required",
  "objectModelId": "number — required",
  "price_config": "object — required (aliases: priceConfig, priceTweaker.price_config)",
  "material": "object — required (must include printer:number, title:string)",
  "printer": "object — required (must include technology:number, title:string)",
  "orderId": "number — optional",
  "sessionId": "string — optional",
  "quoteTarget": "step | dwg — optional",
  "fileUrl": "string — optional",
  "fileName": "string — optional",
  "quantity": "integer | null — optional",
  "tightest_tolerance": "ISO 2768 - Medium (Standard) | ISO 2768 Fine - requires 2D drawings | ISO 2768 Course | null — optional",
  "inspection": "CMM | First Article Inspection Report (FAIR) | Measurement report | null — optional",
  "roughness": "As Machined | Standard (3.2 um Ra) | Smooth (1.6um Ra) | Fine (0.8um Ra) | null — optional",
  "finish": "Standard | Clear Coating (Lacquer/Enamel) | Tin Plating | Gold Plating | Galvanizing | Bead Blasting | Polishing | Anodizing | Electroless Nickel Plating | Powder Coating | null — optional",
  "config": {
    "quantity": "integer | null",
    "tightest_tolerance": "string | null",
    "inspection": "string | null",
    "roughness": "string | null",
    "finish": "string | null"
  },
  "adjustments": "object | null — optional",
  "metadata": "object | null — optional"
}
```

**Notes:**
- Empty strings are normalized to `null`.
- `tightestTolerance` (camelCase) is accepted as alias for `tightest_tolerance`.
- Material lookup is strict and catalog-backed: matching uses exact normalized title equality (no loose `includes` or category heuristics).
- Route validates requested/mapped material against the full catalog aggregated from `/v2/machines_materials/`.
- If requested/mapped material is not found globally, route returns HTTP 400 with `details.requested`, `details.mapped`, and `details.available` (full catalog material list).
- Behavior target: generic labels (for example `Any aluminium`) are rejected with HTTP 400 and a catalog-backed `details.available` material list.
- If explicit `machineId` is provided and material is unavailable for that machine, route returns HTTP 400 with `details.requested`, `details.mapped`, `details.selectedMachineId`, `details.selectedMachineTitle`, and `details.availableForSelectedMachine`.
- If machine is not explicit and a global material match exists on another machine, route may switch to that machine and continue with the matched machine/material pair.
- Common micro-symbol variants (for example `µm`) are normalized internally.
- If `tightest_tolerance` text is provided but DigiFabster exposes zero tolerance options for the selected machine/material, request does not fail; route continues without tolerance override.
- Tolerance resolution order is deterministic: mapped exact DigiFabster title match first, then exact normalized input match, then tier fallback (`fine` / `standard` / `coarse`).
- Tolerance mappings intentionally target live DigiFabster labels exactly as returned (including vendor typos such as `ISO 2768-Stanard`, `ISO 28768-Fine (Require Drawings)`, `ISO 2768-Course`).
- Bubble terminology mapping schema is now `{ materials, tolerances, postproduction }`; separate `inspection`, `roughness`, and `finish` mapping tables were removed.
- Post-production mapping call sites (`inspection`, `roughness`, `finish`) now use `applyTerminologyMapping(value, "postproduction")` before ID resolution.
- Unresolved post-production labels are non-fatal; response includes `warnings.skippedPostproductionLabels` with unresolved labels and available catalog labels.
- Missing `DIGIFABSTER_PRICE_TWEAK_ENDPOINT` returns HTTP 500 with a configuration error payload.
- Outbound Digifabster calls exchange `DIGIFABSTER_API_KEY` (or backward-compatible `DIGIFABSTER_API_TOKEN`) at `DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT` (`/v2/obtain_s2s_token/` by default), then send `Authorization: Token ...` with the returned token.

**Response (200):**
```json
{
  "status": "success",
  "total_per_part_price": "number | null",
  "total_holes": "number",
  "warnings": {
    "skippedPostproductionLabels": {
      "unresolved": ["string"],
      "available": ["string"]
    }
  }
}
```

**Error (400/500):**
```json
{
  "error": "string",
  "hint": "string",
  "details": {
    "requested": "string",
    "mapped": "string",
    "available": ["string"],
    "selectedMachineId": "number",
    "selectedMachineTitle": "string | null",
    "availableForSelectedMachine": ["string"]
  }
}
```

## OPTIONS /api/digifabster-price-tweak

Preflight handler for browser cross-origin calls.

**Response (204):** no body, returns CORS headers derived from request origin.

## GET /api/bubble-trigger

Health check. Returns region string.

## POST /api/bubble-trigger

Trigger Bubble.io 3D preview workflow.

**Request body:**
```json
{
  "part_id": "string",
  "version": "string",
  "image": "string — image data",
  "urn": "string — Autodesk URN"
}
```

**Response (200):** Bubble.io workflow response (JSON).

**External call:** `POST https://entag-10502.bubbleapps.io/version-{version}/api/1.1/wf/create_3d_preview` with hardcoded Bearer token.

**Operational note (2026-05 backfill run):**
- A production route check returned `404 upstream` for the workflow path in one deployment context.
- Bulk URN/thumbnail remediation therefore used direct Bubble Data API PATCH on `orderpart/{id}` instead of relying on this workflow route.

---

## Bubble ↔ DigiFabster Terminology Mapping

Bubble and DigiFabster use different terminology for the same concepts. The `/api/digifabster-price-tweak` route applies automated translation via a mapping dictionary.

### Populated Mappings

Mapping schema (hardened):
- `materials`: only live catalog-backed DigiFabster material titles from active machines.
- `tolerances`: Bubble labels mapped to exact vendor titles returned by price_tweaker (including typos).
- `postproduction`: unified table used by `inspection`, `roughness`, and `finish` inputs.

Examples:
- `aluminium 5083` → `Aluminium 5083`
- `iso 2768 medium standard` → `ISO 2768-Stanard`
- `iso 2768 fine` → `ISO 28768-Fine (Require Drawings)`
- `fair` → `First Article Inspection Report (FAIR)`
- `standard 3.2 um ra` → `Standard (3.2um RA)`
- `powder coating` → `Powder Coating`

### How It Works

1. **Request time:** When Bubble sends a request with a field value, the route checks the mapping dictionary.
2. **Exact match:** If a match is found (after text normalization), the mapped DigiFabster value is used.
3. **Prefix match:** If no exact match, substring/keyword matching is attempted.
4. **Fallback behavior:**
  - For machine/material resolution: route attempts cross-catalog fallback (material label across machines) when explicit `machineId` is not supplied; unresolved material remains fatal with `400` and catalog diagnostics.
  - For tolerance text: resolution first tries mapped exact vendor title, then exact normalized input, then tier-based fallback; unresolved tolerance is non-fatal when the machine/material exposes zero tolerance options.
  - For post-production labels (`inspection`, `roughness`, `finish`): all are mapped via the shared `postproduction` table; unresolved labels are non-fatal and returned in `warnings.skippedPostproductionLabels`.

### Updating Mappings

Edit `api/digifabster-price-tweak.cts`, find the `BUBBLE_TO_DIGIFABSTER_MAPPING` constant (around line ~114), adjust entries as needed based on actual DigiFabster catalog values, then rebuild and redeploy: `pnpm build && npx vercel --prod --yes`.
