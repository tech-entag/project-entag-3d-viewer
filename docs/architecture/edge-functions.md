<!-- last-verified: 2026-04-09 -->

# Serverless Function Catalog

Platform: Vercel (via `vite-plugin-vercel` + `vite-plugin-api-routes`)

| Function | Path | Method | Auth | Purpose | Request Body | Response |
|---|---|---|---|---|---|---|
| `autodesk.cts` | `/api/autodesk` | POST | None (credentials in body) | Upload 3D file to Autodesk, classify format, start SVF-first translation, then optionally run bounded server-side follow-up polling to `/api/conversion-status` for Bubble `modelId` writeback diagnostics | `{url, part_id, version, client_id?, client_secret?, auto_modelid?/autoModelId?, dry_run?}` | `{success, urn, accessToken, viewer, quote, autoFollowup}` |
| `conversion-status.cts` | `/api/conversion-status` | POST | None (credentials in body) | Poll conversion, inherit status/progress from target output branch when graphics URN is nested, persist local viewer artifacts (root SVF + dependencies), auto-resolve STEP/DWG quote target when omitted, sync ready quote derivatives to Digifabster, optionally PATCH Bubble Data API `orderpart/{part_id}` with `modelId`, and fall back to native-source upload when quote target is unresolved but source URL is provided | `{urn, client_id, client_secret, quoteTarget?, part_id?, version?, source_url?/sourceUrl?, source_file_name?/sourceFileName?, bubble_data_api_base_url?/bubbleDataApiBaseUrl?, bubble_api_token?/bubbleApiToken?, bubble_orderpart_type?/bubbleOrderPartType?, bubble_modelid_field?/bubbleModelIdField?, dry_run?}` | `{success, viewer:{status,mode,localModelUrl,bubbleUrl,localError}, quote:{status,targetFormat,error,upload:{status,source,objectModelId,orderId,sessionId,reason},orderPartUpdate:{status,reason?,httpStatus?,error?},priceTweaking}}` |
| `viewer-source.cts` | `/api/viewer-source` | GET | None | Resolve URN to cached local bubble URL | Query: `urn` | `200:{success,mode:"local",localModelUrl,bubbleUrl}` / `404:{status:"queued"}` |
| `digifabster-price-tweak.cts` | `/api/digifabster-price-tweak` | GET | None | Return Bubble-facing contract for price-tweaking integration, including DigiFabster `price_tweaker` field mapping metadata | — | `{success,endpoint,targetEndpoint,configured,requiredFields,recommendedFields,configFields,priceTweakerFields}` |
| `digifabster-price-tweak.cts` | `/api/digifabster-price-tweak` | POST | None | Validate DigiFabster `price_tweaker` contract at route boundary, then forward payload to Digifabster endpoint using shared S2S auth headers | `{part_id, version, objectModelId, price_config, material, printer, orderId?, sessionId?, quoteTarget?, fileUrl?, fileName?, quantity?, tightest_tolerance?, tightestTolerance?, inspection?, roughness?, finish?, config?, adjustments?, metadata?}` | `200:{success,targetEndpoint,result} / 400:{error,details,required}` |
| `bubble-trigger.cts` | `/api/bubble-trigger` | GET | None | Health check | — | Region string |
| `bubble-trigger.cts` | `/api/bubble-trigger` | POST | None | Trigger Bubble.io 3D preview workflow | `{part_id, version, image, urn}` | Bubble.io response |

## External API Dependencies

| API | Base URL | Auth Method | Used In |
|---|---|---|---|
| Autodesk Authentication | `developer.api.autodesk.com/authentication/v2/token` | Basic (client_id:client_secret) | `autodesk_helpers/index.ts` |
| Autodesk OSS (Object Storage) | `developer.api.autodesk.com/oss/v2/buckets` | Bearer token | `autodesk_helpers/index.ts` |
| Autodesk Model Derivative | `developer.api.autodesk.com/modelderivative/v2/designdata/job` | Bearer token | `autodesk_helpers/index.ts` |
| Vercel Blob Storage | `blob.vercel-storage.com` | `BLOB_READ_WRITE_TOKEN` (server-side) | `autodesk_helpers/viewer-cache.ts` |
| Digifabster API | Explicit endpoint env vars (`DIGIFABSTER_UPLOAD_ENDPOINT`, `DIGIFABSTER_PRICE_TWEAK_ENDPOINT`) + token exchange endpoint (`DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT`) | Exchange `api_key` (`DIGIFABSTER_API_KEY`, fallback `DIGIFABSTER_API_TOKEN`) via `/v2/obtain_s2s_token/`, then send `Authorization: Token ...`; upload helper can retry with direct token auth on `401/403` and supports `/v2/upload_models/` upload-job + binary upload flow | `autodesk_helpers/digifabster-sync.ts`, `digifabster-price-tweak.cts` |
| Bubble.io Workflow | `entag-10502.bubbleapps.io/version-{v}/api/1.1/wf/create_3d_preview` | Hardcoded Bearer token | `bubble-trigger.cts` |

## Compatibility Notes

- DigiFabster upload handling supports both the classic `file_url` contract and the `/v2/upload_models/` contract that requires upload-job creation plus binary model upload.
- Upload requests intentionally avoid forcing `Content-Type: application/json` so `FormData` and binary model uploads preserve the correct multipart boundary.
- Sync-record Blob persistence is best-effort after a successful DigiFabster submission; Blob permission failures should not clear `quote.upload` success metadata.

## CORS Configuration

Defined in `vercel.json`: All `/api/*` routes return:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET,OPTIONS,PATCH,DELETE,POST,PUT`
- `Access-Control-Allow-Credentials: true`
