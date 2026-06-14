import { fetchAccessToken, findDerivativeByType, getManifest } from "./autodesk_helpers";
import {
  DigifabsterSyncError,
  getDigifabsterModelThumbnail,
  resolvePriceTweakingEndpoint,
  syncNativeSourceToDigifabster,
  syncQuoteDerivativeToDigifabster,
} from "./autodesk_helpers/digifabster-sync";
import { shouldSkipAutodeskTranslationForSource } from "./autodesk_helpers/format-map";
import { ensureViewerBubbleInBlob } from "./autodesk_helpers/viewer-cache";

export const config = {
  maxDuration: 60,
};

const createTraceId = () => `conversion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const DEFAULT_BUBBLE_DATA_API_BASE_URL = "https://app.entag.co/version-test/api/1.1/obj";

const traceTimeline = new Map<string, string[]>();

const logStep = (traceId: string, step: string, details: Record<string, unknown> = {}) => {
  const timeline = traceTimeline.get(traceId) || [];
  timeline.push(step);
  traceTimeline.set(traceId, timeline);

  const shouldEmit =
    step === "request.completed" ||
    step === "request.failed" ||
    step === "request.validation_failed" ||
    step === "dry_run.completed" ||
    step === "quote.sync.failed";

  if (!shouldEmit) {
    return;
  }

  console.log("[conversion-status]", { traceId, step, timeline, ...details });
  traceTimeline.delete(traceId);
};

type NormalizedStatus = "queued" | "inprogress" | "success" | "failed";
type QuoteTarget = "step" | "dwg";

const toQuoteTarget = (value: unknown): QuoteTarget | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.toLowerCase();
  if (normalized === "step" || normalized === "dwg") {
    return normalized;
  }

  return null;
};

const pickAutoQuoteTarget = (manifest: Parameters<typeof findDerivativeByType>[0]): QuoteTarget | null => {
  const priorities = ["success", "inprogress", "queued", "failed"] as const;
  const statuses = {
    step: (() => {
      const derivative = findDerivativeByType(manifest, "step");
      return derivative ? normalizeStatus(derivative.status, derivative.progress) : null;
    })(),
    dwg: (() => {
      const derivative = findDerivativeByType(manifest, "dwg");
      return derivative ? normalizeStatus(derivative.status, derivative.progress) : null;
    })(),
  };

  for (const priority of priorities) {
    if (statuses.step === priority) {
      return "step";
    }

    if (statuses.dwg === priority) {
      return "dwg";
    }
  }

  return null;
};

const normalizeStatus = (status: string | undefined, progress: string | undefined): NormalizedStatus => {
  const normalizedStatus = (status || "").toLowerCase();
  const normalizedProgress = (progress || "").toLowerCase();

  if (normalizedStatus === "success" || normalizedStatus === "complete" || normalizedProgress === "complete") {
    return "success";
  }

  if (normalizedStatus === "failed" || normalizedStatus === "timeout") {
    return "failed";
  }

  if (
    normalizedStatus === "inprogress" ||
    normalizedStatus === "pending" ||
    normalizedStatus === "created" ||
    normalizedProgress.includes("%")
  ) {
    return "inprogress";
  }

  return "queued";
};

const pickString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
};

const fileNameFromSourceUrl = (sourceUrl: string | null) => {
  if (!sourceUrl) {
    return null;
  }

  try {
    const parsed = new URL(sourceUrl);
    const tail = parsed.pathname.split("/").filter(Boolean).pop();
    if (!tail) {
      return null;
    }

    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  } catch {
    return null;
  }
};

const normalizeBubbleDataApiBaseUrl = (raw: string | null) => {
  if (!raw || !raw.trim()) {
    return DEFAULT_BUBBLE_DATA_API_BASE_URL;
  }

  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.includes("/api/1.1/obj")) {
    return trimmed;
  }

  if (trimmed.includes("/version-")) {
    return `${trimmed}/api/1.1/obj`;
  }

  return `${trimmed}/version-test/api/1.1/obj`;
};

const pickBubbleDataApiToken = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
};

const buildBubbleDataApiHeaders = (token: string) => {
  const normalizedToken = token.replace(/^Bearer\s+/i, "").trim();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${normalizedToken}`,
  };
};

export const updateBubbleOrderPartModelId = async (params: {
  baseUrl: string;
  token: string;
  thingType: string;
  partId: string;
  fieldName: string;
  modelId: number;
  thumbnailField?: string | null;
  thumbnailUrl?: string | null;
  extraFields?: Record<string, unknown> | null;
}) => {
  const endpoint = `${params.baseUrl}/${encodeURIComponent(params.thingType)}/${encodeURIComponent(params.partId)}`;
  const payload: Record<string, unknown> = {
    [params.fieldName]: String(params.modelId),
  };
  if (params.thumbnailField && params.thumbnailUrl) {
    payload[params.thumbnailField] = params.thumbnailUrl;
  }
  if (params.extraFields) {
    for (const [key, value] of Object.entries(params.extraFields)) {
      if (value !== null && value !== undefined) payload[key] = value;
    }
  }

  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: buildBubbleDataApiHeaders(params.token),
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseData: unknown = null;
  if (responseText.trim()) {
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText.slice(0, 2_000);
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    endpoint,
    payload,
    responseData,
  };
};

export async function POST(req: Request) {
  let traceId = createTraceId();

  try {
    const requestOrigin = new URL(req.url).origin;
    const bubblePriceTweakingEndpoint = `${requestOrigin}/api/digifabster-price-tweak`;
    const body = await req.json();
    const {
      urn,
      access_token,
      accessToken,
      client_id,
      client_secret,
      quoteTarget,
      part_id,
      version,
      dry_run,
      viewer_status,
      quote_status,
      quote_error,
      source_url,
      sourceUrl,
      source_file_name,
      sourceFileName,
      bubble_data_api_base_url,
      bubbleDataApiBaseUrl,
      bubble_api_token,
      bubbleApiToken,
      bubble_orderpart_type,
      bubbleOrderPartType,
      bubble_modelid_field,
      bubbleModelIdField,
      bubble_thumbnail_field,
      bubbleThumbnailField,
    } = body;
    if (typeof body?.traceId === "string" && body.traceId.trim()) {
      traceId = body.traceId.trim();
    }

    logStep(traceId, "request.received", {
      urn,
      requestedQuoteTarget: quoteTarget,
      hasPartId: typeof part_id === "string" && part_id.trim().length > 0,
      hasVersion: typeof version === "string" && version.trim().length > 0,
      dry_run: dry_run === true,
    });

    if (dry_run === true) {
      const viewerStatus =
        viewer_status === "queued" ||
        viewer_status === "inprogress" ||
        viewer_status === "success" ||
        viewer_status === "failed"
          ? viewer_status
          : "success";

      const quoteStatus =
        quote_status === "not_required" ||
        quote_status === "queued" ||
        quote_status === "inprogress" ||
        quote_status === "success" ||
        quote_status === "failed"
          ? quote_status
          : "not_required";

      logStep(traceId, "dry_run.completed", {
        viewerStatus,
        quoteStatus,
        quoteTarget,
      });

      return new Response(
        JSON.stringify({
          success: viewerStatus !== "failed",
          traceId,
          viewer: {
            status: viewerStatus,
            priority: true,
          },
          quote: {
            status: quoteStatus,
            targetFormat: typeof quoteTarget === "string" ? quoteTarget.toLowerCase() : null,
            error: typeof quote_error === "string" ? quote_error : null,
          },
        }),
        {
          status: viewerStatus === "failed" ? 500 : 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const requestedQuoteTarget = toQuoteTarget(quoteTarget);
    const nativeSourceUrl = pickString(source_url, sourceUrl);
    const nativeSourceFileName = pickString(
      source_file_name,
      sourceFileName,
      fileNameFromSourceUrl(nativeSourceUrl),
    );
    const nativeFastPath =
      !requestedQuoteTarget &&
      Boolean(nativeSourceUrl) &&
      (typeof urn === "string" && urn.startsWith("native2d:")
        ? true
        : Boolean(nativeSourceFileName && shouldSkipAutodeskTranslationForSource(nativeSourceFileName)));

    if (!urn || (!nativeFastPath && (!client_id || !client_secret))) {
      logStep(traceId, "request.validation_failed", { reason: "missing_required_parameters" });
      return new Response(JSON.stringify({ error: "Missing required parameters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const providedAccessToken = pickString(access_token, accessToken);
    let viewerAccessToken: string | null = providedAccessToken;
    let viewerStatus: NormalizedStatus = "queued";
    let viewerSourceMode: "local" | "cloud" | "thumbnail" = nativeFastPath ? "thumbnail" : "cloud";
    let viewerLocalModelUrl: string | null = null;
    let viewerLocalError: string | null = null;
    let manifest: any = null;

    if (nativeFastPath) {
      viewerStatus = "success";
      logStep(traceId, "viewer.status.native_fast_path", {
        urn,
        hasNativeSourceUrl: Boolean(nativeSourceUrl),
        hasNativeSourceFileName: Boolean(nativeSourceFileName),
      });
    } else {
      if (!viewerAccessToken) {
        logStep(traceId, "autodesk.fetch_access_token.start", { urn });
        viewerAccessToken = await fetchAccessToken(client_id, client_secret);
        logStep(traceId, "autodesk.fetch_access_token.success", { tokenLength: viewerAccessToken.length });
      } else {
        logStep(traceId, "autodesk.fetch_access_token.reused", { urn, tokenLength: viewerAccessToken.length });
      }

      logStep(traceId, "autodesk.manifest.fetch.start", { urn });
      manifest = await getManifest(urn, viewerAccessToken);
      logStep(traceId, "autodesk.manifest.fetch.success", {
        manifestStatus: typeof manifest?.status === "string" ? manifest.status : "unknown",
        manifestProgress: typeof manifest?.progress === "string" ? manifest.progress : "unknown",
      });

      const viewerDerivative = findDerivativeByType(manifest, "svf") || findDerivativeByType(manifest, "svf2");
      viewerStatus = viewerDerivative
        ? normalizeStatus(viewerDerivative.status, viewerDerivative.progress)
        : normalizeStatus(manifest?.status, manifest?.progress);

      logStep(traceId, "viewer.status.resolved", {
        viewerStatus,
        derivativeType: viewerDerivative ? (viewerDerivative.derivativeUrn.includes("svf2") ? "svf2" : "svf") : "manifest",
        derivativeStatus: viewerDerivative?.status,
        derivativeProgress: viewerDerivative?.progress,
      });

      if (viewerStatus === "success") {
        try {
          logStep(traceId, "viewer.local_cache.persist.start", { urn });
          const persisted = await ensureViewerBubbleInBlob(urn, viewerAccessToken);
          viewerLocalModelUrl = persisted.localModelUrl;
          viewerSourceMode = viewerLocalModelUrl ? "local" : "cloud";
          logStep(traceId, "viewer.local_cache.persist.success", {
            mode: viewerSourceMode,
            hasLocalModelUrl: Boolean(viewerLocalModelUrl),
            persistenceStatus: persisted.status,
          });

          if (persisted.status === "blob_unavailable") {
            viewerLocalError = "Object storage (R2) is not configured. Local URN playback is unavailable.";
            logStep(traceId, "viewer.local_cache.persist.blob_unavailable");
          }
        } catch (persistError) {
          console.error("Failed to persist local viewer bubble:", persistError);
          const persistErrorMessage =
            persistError instanceof Error ? persistError.message : "Unknown persistence error.";
          viewerLocalError = `Failed to persist local viewer bubble. ${persistErrorMessage}`;
          logStep(traceId, "viewer.local_cache.persist.failed", {
            message: persistErrorMessage,
          });
        }
      }
    }

    const quoteTargetNormalized = nativeFastPath ? null : requestedQuoteTarget || pickAutoQuoteTarget(manifest);
    logStep(traceId, "quote.target.resolved", {
      requestedQuoteTarget,
      resolvedQuoteTarget: quoteTargetNormalized,
      mode: nativeFastPath ? "native" : requestedQuoteTarget ? "caller" : "auto",
      hasNativeSourceUrl: Boolean(nativeSourceUrl),
    });

    let quoteStatus: NormalizedStatus | "not_required" = "not_required";
    let quoteError: string | null = null;
    let quoteOrderPartUpdate:
      | {
          status: "updated" | "skipped" | "failed";
          orderPartId?: string;
          endpoint?: string;
          modelId?: number;
          thingType?: string;
          fieldName?: string;
          reason?: string;
          httpStatus?: number;
          error?: string;
          response?: unknown;
        }
      | null = null;
    let quoteUpload:
      | {
          status: "skipped" | "submitted" | "cached";
          uploadJobId: string | null;
          objectModelId: number | null;
          orderId: number | null;
          sessionId: string | null;
          quoteStatus: string | null;
          source: "digifabster" | "cache" | "none";
          fileUrl?: string;
          fileName?: string;
          reason?: string;
        }
      | null = null;

    if (!quoteTargetNormalized) {
      logStep(traceId, "quote.target.unresolved", {
        requestedQuoteTarget,
        hasPartId: typeof part_id === "string" && part_id.trim().length > 0,
        hasVersion: typeof version === "string" && version.trim().length > 0,
        hasNativeSourceUrl: Boolean(nativeSourceUrl),
      });

      if (!nativeSourceUrl) {
        quoteError =
          "Quote target could not be resolved from manifest yet. Pass quoteTarget from /api/autodesk response (quote.targetFormat) when polling, or provide sourceUrl/source_url for native upload sync.";
      }
    }

    if (quoteTargetNormalized) {
      const quoteDerivative = findDerivativeByType(manifest, quoteTargetNormalized);

      if (!quoteDerivative) {
        const manifestStatus = normalizeStatus(manifest?.status, manifest?.progress);
        if ((manifest?.status || "").toLowerCase() === "failed") {
          quoteStatus = "failed";
          quoteError = `Quote derivative ${quoteTargetNormalized.toUpperCase()} was not generated.`;
        } else if (manifestStatus === "success") {
          quoteStatus = "failed";
          quoteError = `Quote derivative ${quoteTargetNormalized.toUpperCase()} was not found in manifest after translation completed.`;
        } else {
          quoteStatus = "queued";
        }
      } else {
        quoteStatus = normalizeStatus(quoteDerivative.status, quoteDerivative.progress);
        if (quoteStatus === "failed") {
          quoteError = `Quote derivative ${quoteTargetNormalized.toUpperCase()} translation failed.`;
        }
      }

      logStep(traceId, "quote.status.resolved", {
        quoteTarget: quoteTargetNormalized,
        quoteStatus,
        quoteDerivativeStatus: quoteDerivative?.status,
        quoteDerivativeProgress: quoteDerivative?.progress,
        quoteError,
      });

      if (quoteStatus === "success") {
        if (!viewerAccessToken) {
          quoteStatus = "failed";
          quoteError = "Viewer access token unavailable for quote derivative sync.";
          logStep(traceId, "quote.sync.skipped", {
            quoteTarget: quoteTargetNormalized,
            quoteStatus,
            reason: "missing_viewer_access_token",
            quoteError,
          });
        } else {
        try {
          logStep(traceId, "quote.sync.start", {
            quoteTarget: quoteTargetNormalized,
            part_id,
            version,
          });
          quoteUpload = await syncQuoteDerivativeToDigifabster({
            urn,
            accessToken: viewerAccessToken,
            quoteTarget: quoteTargetNormalized,
            partId: typeof part_id === "string" ? part_id : undefined,
            version: typeof version === "string" ? version : undefined,
            traceId,
          });

          logStep(traceId, "quote.sync.success", {
            quoteTarget: quoteTargetNormalized,
            uploadStatus: quoteUpload.status,
            source: quoteUpload.source,
            objectModelId: quoteUpload.objectModelId,
            orderId: quoteUpload.orderId,
            sessionId: quoteUpload.sessionId,
          });

          if (quoteUpload.objectModelId) {
            console.log("Digifabster upload synced", {
              traceId,
              urn,
              quoteTarget: quoteTargetNormalized,
              part_id,
              version,
              object_model_id: quoteUpload.objectModelId,
              source: quoteUpload.source,
            });
          }
        } catch (error) {
          if (error instanceof DigifabsterSyncError) {
            logStep(traceId, "quote.sync.failed", {
              urn,
              quoteTarget: quoteTargetNormalized,
              part_id,
              version,
              code: error.code,
              details: error.details,
              status: error.status,
              retryable: error.retryable,
            });

            if (error.retryable) {
              quoteStatus = "inprogress";
              quoteError = null;
            } else {
              quoteStatus = "failed";
              quoteError = error.details || error.message;
            }
          } else {
            logStep(traceId, "quote.sync.failed", {
              quoteTarget: quoteTargetNormalized,
              message: error instanceof Error ? error.message : "Unknown quote sync error",
            });
            quoteStatus = "failed";
            quoteError = `Quote sync failed: ${error instanceof Error ? error.message : "Unknown error"}`;
          }
        }
        }
      }

      if (quoteStatus !== "success") {
        logStep(traceId, "quote.sync.skipped", {
          quoteTarget: quoteTargetNormalized,
          quoteStatus,
          reason: quoteStatus === "queued" ? "quote_not_ready" : "quote_not_available",
          quoteError,
        });
      }
    }

    if (!quoteTargetNormalized && nativeSourceUrl) {
      try {
        logStep(traceId, "quote.native_sync.start", {
          part_id,
          version,
          hasSourceFileName: Boolean(nativeSourceFileName),
        });

        quoteUpload = await syncNativeSourceToDigifabster({
          urn,
          sourceUrl: nativeSourceUrl,
          sourceFileName: nativeSourceFileName || undefined,
          partId: typeof part_id === "string" ? part_id : undefined,
          version: typeof version === "string" ? version : undefined,
          traceId,
        });

        logStep(traceId, "quote.native_sync.success", {
          uploadStatus: quoteUpload.status,
          source: quoteUpload.source,
          objectModelId: quoteUpload.objectModelId,
          orderId: quoteUpload.orderId,
          sessionId: quoteUpload.sessionId,
        });

        if (quoteUpload.status === "submitted" || quoteUpload.status === "cached") {
          quoteStatus = "success";
          quoteError = null;
        }
      } catch (error) {
        if (error instanceof DigifabsterSyncError) {
          logStep(traceId, "quote.native_sync.failed", {
            urn,
            part_id,
            version,
            code: error.code,
            details: error.details,
            status: error.status,
            retryable: error.retryable,
          });

          if (error.retryable) {
            quoteStatus = "inprogress";
            quoteError = null;
          } else {
            quoteStatus = "failed";
            quoteError = error.details || error.message;
          }
        } else {
          logStep(traceId, "quote.native_sync.failed", {
            message: error instanceof Error ? error.message : "Unknown native quote sync error",
          });
          quoteStatus = "failed";
          quoteError = `Native quote sync failed: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
      }
    }

    const partIdForUpdate = typeof part_id === "string" ? part_id.trim() : "";
    const bubbleToken = pickBubbleDataApiToken(
      bubble_api_token,
      bubbleApiToken,
      process.env.BUBBLE_DATA_API_TOKEN,
      process.env.BUBBLE_API_TOKEN,
      process.env.BUBBLE_DATA_API_BEARER_TOKEN,
    );
    const bubbleThingType =
      pickString(bubble_orderpart_type, bubbleOrderPartType, process.env.BUBBLE_ORDERPART_TYPE) || "orderpart";
    const bubbleModelField =
      pickString(bubble_modelid_field, bubbleModelIdField, process.env.BUBBLE_MODELID_FIELD) || "modelId";
    const bubbleThumbnailFieldResolved =
      pickString(bubble_thumbnail_field, bubbleThumbnailField, process.env.BUBBLE_THUMBNAIL_FIELD) || "image";
    // Bubble field names for the model bounding-box dimensions (from DigiFabster `size`).
    const bubbleDimXField = pickString(process.env.BUBBLE_DIM_X_FIELD) || "dimX";
    const bubbleDimYField = pickString(process.env.BUBBLE_DIM_Y_FIELD) || "dimY";
    const bubbleDimZField = pickString(process.env.BUBBLE_DIM_Z_FIELD) || "dimZ";
    const bubbleDimUnitsField = pickString(process.env.BUBBLE_DIM_UNITS_FIELD) || "dimUnits";
    const bubbleDataApiBaseUrlResolved = normalizeBubbleDataApiBaseUrl(
      pickString(bubble_data_api_base_url, bubbleDataApiBaseUrl, process.env.BUBBLE_DATA_API_BASE_URL),
    );

    if (quoteUpload?.objectModelId && partIdForUpdate) {
      if (!bubbleToken) {
        quoteOrderPartUpdate = {
          status: "failed",
          reason: "missing_bubble_data_api_token",
          orderPartId: partIdForUpdate,
          modelId: quoteUpload.objectModelId,
          thingType: bubbleThingType,
          fieldName: bubbleModelField,
          endpoint: `${bubbleDataApiBaseUrlResolved}/${bubbleThingType}/${partIdForUpdate}`,
          error:
            "Missing Bubble Data API token. Provide bubble_api_token in request body or configure BUBBLE_DATA_API_TOKEN.",
        };
        quoteStatus = "failed";
        quoteError = "Bubble OrderPart update failed: missing Bubble Data API token.";
        logStep(traceId, "bubble.orderpart.update.failed", {
          reason: "missing_bubble_data_api_token",
          orderPartId: partIdForUpdate,
          modelId: quoteUpload.objectModelId,
        });
      } else {
        try {
          // Best-effort model fetch — thumbnail + bounding-box dimensions ride along
          // in the same Bubble PATCH. A pending/unavailable thumbnail never blocks the write.
          let thumbnailUrl: string | null = null;
          let dimensionFields: Record<string, unknown> | null = null;
          try {
            const model = await getDigifabsterModelThumbnail(quoteUpload.objectModelId, traceId);
            thumbnailUrl = model.thumb300x300 || model.thumb120x120 || model.thumb;
            const dims: Record<string, unknown> = {};
            if (model.sizeX !== null) dims[bubbleDimXField] = model.sizeX;
            if (model.sizeY !== null) dims[bubbleDimYField] = model.sizeY;
            if (model.sizeZ !== null) dims[bubbleDimZField] = model.sizeZ;
            // `units` is returned early (static); the bounding box is computed
            // asynchronously. Only treat dimensions as "written" once at least one
            // numeric size is present — otherwise the follow-up loop would stop
            // early on units alone, before x/y/z exist.
            const hasNumericDimension = Object.keys(dims).length > 0;
            if (hasNumericDimension && model.units !== null) dims[bubbleDimUnitsField] = model.units;
            if (hasNumericDimension) dimensionFields = dims;
          } catch (thumbnailError) {
            logStep(traceId, "bubble.orderpart.thumbnail.skipped", {
              orderPartId: partIdForUpdate,
              modelId: quoteUpload.objectModelId,
              message: thumbnailError instanceof Error ? thumbnailError.message : "Unknown thumbnail error",
            });
          }

          const updateResult = await updateBubbleOrderPartModelId({
            baseUrl: bubbleDataApiBaseUrlResolved,
            token: bubbleToken,
            thingType: bubbleThingType,
            partId: partIdForUpdate,
            extraFields: dimensionFields,
            fieldName: bubbleModelField,
            modelId: quoteUpload.objectModelId,
            thumbnailField: thumbnailUrl ? bubbleThumbnailFieldResolved : null,
            thumbnailUrl,
          });

          if (!updateResult.ok) {
            quoteOrderPartUpdate = {
              status: "failed",
              endpoint: updateResult.endpoint,
              orderPartId: partIdForUpdate,
              modelId: quoteUpload.objectModelId,
              thingType: bubbleThingType,
              fieldName: bubbleModelField,
              httpStatus: updateResult.status,
              response: updateResult.responseData,
              error: "Bubble Data API rejected OrderPart update.",
            };
            quoteStatus = "failed";
            quoteError = `Bubble OrderPart update failed (HTTP ${updateResult.status}).`;
            logStep(traceId, "bubble.orderpart.update.failed", {
              reason: "bubble_data_api_non_2xx",
              httpStatus: updateResult.status,
              orderPartId: partIdForUpdate,
              modelId: quoteUpload.objectModelId,
            });
          } else {
            quoteOrderPartUpdate = {
              status: "updated",
              endpoint: updateResult.endpoint,
              orderPartId: partIdForUpdate,
              modelId: quoteUpload.objectModelId,
              thingType: bubbleThingType,
              fieldName: bubbleModelField,
              httpStatus: updateResult.status,
              response: updateResult.responseData,
              ...(thumbnailUrl
                ? { thumbnailField: bubbleThumbnailFieldResolved, thumbnailUrl }
                : {}),
              ...(dimensionFields ? { dimensions: dimensionFields } : {}),
            };
            logStep(traceId, "bubble.orderpart.update.success", {
              endpoint: updateResult.endpoint,
              orderPartId: partIdForUpdate,
              modelId: quoteUpload.objectModelId,
              thumbnailWritten: Boolean(thumbnailUrl),
              dimensionsWritten: Boolean(dimensionFields),
              httpStatus: updateResult.status,
            });
          }
        } catch (bubbleUpdateError) {
          const bubbleMessage =
            bubbleUpdateError instanceof Error ? bubbleUpdateError.message : "Unknown Bubble update error";
          quoteOrderPartUpdate = {
            status: "failed",
            endpoint: `${bubbleDataApiBaseUrlResolved}/${bubbleThingType}/${partIdForUpdate}`,
            orderPartId: partIdForUpdate,
            modelId: quoteUpload.objectModelId,
            thingType: bubbleThingType,
            fieldName: bubbleModelField,
            error: bubbleMessage,
          };
          quoteStatus = "failed";
          quoteError = `Bubble OrderPart update failed: ${bubbleMessage}`;
          logStep(traceId, "bubble.orderpart.update.failed", {
            reason: "bubble_data_api_request_error",
            orderPartId: partIdForUpdate,
            modelId: quoteUpload.objectModelId,
            message: bubbleMessage,
          });
        }
      }
    } else {
      const skippedReason = !quoteUpload?.objectModelId ? "missing_object_model_id" : "missing_part_id";
      quoteOrderPartUpdate = {
        status: "skipped",
        orderPartId: partIdForUpdate || undefined,
        modelId: quoteUpload?.objectModelId || undefined,
        thingType: bubbleThingType,
        fieldName: bubbleModelField,
        reason: skippedReason,
      };
      logStep(traceId, "bubble.orderpart.update.skipped", {
        reason: skippedReason,
        orderPartId: partIdForUpdate || null,
        modelId: quoteUpload?.objectModelId || null,
      });
    }

    const viewerFailed = viewerStatus === "failed";

    logStep(traceId, "request.completed", {
      urn,
      viewerStatus,
      viewerMode: viewerSourceMode,
      quoteStatus,
      quoteTarget: quoteTargetNormalized,
      quoteError,
      quoteUploadStatus: quoteUpload?.status || null,
      httpStatus: viewerFailed ? 500 : 200,
    });

    return new Response(
      JSON.stringify({
        success: !viewerFailed,
        traceId,
        viewer: {
          status: viewerStatus,
          priority: true,
          mode: viewerSourceMode,
          localModelUrl: viewerLocalModelUrl,
          bubbleUrl: viewerLocalModelUrl,
          localError: viewerLocalError,
          accessToken: viewerAccessToken,
        },
        quote: {
          status: quoteStatus,
          targetFormat: quoteTargetNormalized,
          error: quoteError,
          upload: quoteUpload,
          orderPartUpdate: quoteOrderPartUpdate,
          priceTweaking: {
            endpoint: bubblePriceTweakingEndpoint,
            digifabsterEndpoint: resolvePriceTweakingEndpoint(),
            payload: quoteUpload
              ? {
                  uploadJob: quoteUpload.uploadJobId,
                  objectModelId: quoteUpload.objectModelId,
                  orderId: quoteUpload.orderId,
                  sessionId: quoteUpload.sessionId,
                  part_id,
                  version,
                  quoteTarget: quoteTargetNormalized,
                  fileUrl: quoteUpload.fileUrl,
                  fileName: quoteUpload.fileName,
                }
              : null,
          },
        },
      }),
      {
        status: viewerFailed ? 500 : 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    logStep(traceId, "request.failed", {
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
    return new Response(JSON.stringify({ error: "Failed to get conversion status", traceId }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
