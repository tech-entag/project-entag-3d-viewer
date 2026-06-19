import { createBucket, fetchAccessToken, finalizeUpload, obtainSignedUrl, startTranslation, uploadFile } from "./autodesk_helpers";
import { DigifabsterSyncError, syncNativeSourceToDigifabster } from "./autodesk_helpers/digifabster-sync";
import { fetchFileAndConvert } from "./autodesk_helpers/download";
import { classifySourceFormat, shouldSkipAutodeskTranslationForFormat } from "./autodesk_helpers/format-map";

export const config = {
  maxDuration: 60,
};

const createTraceId = () => `autodesk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const AUTO_FOLLOWUP_ATTEMPTS = Math.max(1, Number(process.env.AUTO_MODELID_ATTEMPTS || 5));
const AUTO_FOLLOWUP_INTERVAL_MS = Math.max(0, Number(process.env.AUTO_MODELID_INTERVAL_MS || 5000));
// Once the model is analysed (thumbnail/dims written), also fetch the DigiFabster
// batch price and write it to Bubble — so one /api/autodesk call returns
// image + dims + price. Disable with AUTO_BATCH_PRICE=false.
const AUTO_BATCH_PRICE_ENABLED = process.env.AUTO_BATCH_PRICE !== "false";

const traceTimeline = new Map<string, string[]>();

const logStep = (traceId: string, step: string, details: Record<string, unknown> = {}) => {
  const timeline = traceTimeline.get(traceId) || [];
  timeline.push(step);
  traceTimeline.set(traceId, timeline);

  const shouldEmit =
    step === "request.completed" ||
    step === "request.failed" ||
    step === "request.validation_failed" ||
    step === "dry_run.completed";

  if (!shouldEmit) {
    return;
  }

  console.log("[autodesk]", { traceId, step, timeline, ...details });
  traceTimeline.delete(traceId);
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createNative2dUrn = (params: {
  partId: string;
  version: string;
  sourceUrl: string;
  extension: string;
}) => {
  const fingerprint = Buffer.from(`${params.partId}|${params.version}|${params.sourceUrl}`)
    .toString("base64url")
    .slice(0, 56);

  const extension = params.extension || "source";
  return `native2d:${extension}:${fingerprint}`;
};

const createNative2dThumbnailDataUrl = (fileName: string, extension: string) => {
  const extensionLabel = extension ? extension.toUpperCase() : "2D";
  const fileLabel = fileName.replace(/[<>&"']/g, "_").slice(0, 40) || "2D Source";
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">',
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">',
    '<stop offset="0%" stop-color="#eaf4ee"/><stop offset="100%" stop-color="#d7ebe0"/>',
    '</linearGradient></defs>',
    '<rect width="400" height="400" fill="url(#bg)"/>',
    '<rect x="24" y="24" width="352" height="352" rx="16" fill="#ffffff" stroke="#9bc4ad" stroke-width="4"/>',
    `<text x="40" y="96" fill="#1f5b3c" font-size="44" font-family="Arial, sans-serif" font-weight="700">${extensionLabel}</text>`,
    '<line x1="40" y1="120" x2="360" y2="120" stroke="#9bc4ad" stroke-width="3"/>',
    '<path d="M64 272 L130 210 L188 246 L250 182 L336 260" fill="none" stroke="#2f8f56" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>',
    `<text x="40" y="336" fill="#4f6f5d" font-size="20" font-family="Arial, sans-serif">${fileLabel}</text>`,
    '</svg>',
  ].join("");

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};

/**
 * Best-effort: once the model is analysed, get the DigiFabster batch price and
 * write it to Bubble. Material is auto-picked by DigiFabster (preselection),
 * lead-time comes from DIGIFABSTER_DEFAULT_LEAD_TIME_IDS, and the cost is PATCHed
 * onto the same orderpart that just received the thumbnail/dims. Never throws —
 * a price failure must not undo the thumbnail/dims write that already succeeded.
 */
const runAutoBatchPrice = async (params: {
  requestOrigin: string;
  objectModelId: number;
  partId: string;
  version: string;
  traceId: string;
  orderId: string | null;
}) => {
  const endpoint = `${params.requestOrigin}/api/digifabster-batch-price`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectModelId: params.objectModelId,
        // Cost is PATCHed onto the Bubble `order` thing (route defaults handle
        // thing type `order` + field `[price]manufacturingCost`). Without an
        // orderId the route still returns the price but skips the Bubble write.
        ...(params.orderId ? { orderId: params.orderId } : {}),
        part_id: params.partId,
        version: params.version,
        traceId: `${params.traceId}-price`,
      }),
    });

    const text = await response.text();
    let data: any = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 2000) };
      }
    }

    return {
      status: data?.bubble?.status || data?.status || "unknown",
      httpStatus: response.status,
      materialSource: data?.request?.materialSource ?? null,
      selectedPrice: data?.selectedPrice ?? null,
      bubble: data?.bubble ?? null,
      ...(response.ok ? {} : { error: data?.error ?? null }),
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown batch price error",
    };
  }
};

const runAutoBubbleWriteback = async (params: {
  requestOrigin: string;
  urn: string;
  traceId: string;
  clientId: string;
  clientSecret: string;
  partId: string;
  version: string;
  sourceUrl: string;
  sourceFileName: string;
  quoteTarget: "step" | "dwg" | null;
  orderId: string | null;
}) => {
  const endpoint = `${params.requestOrigin}/api/conversion-status`;
  let lastSnapshot: Record<string, unknown> | null = null;
  let cachedViewerToken: string | null = null;

  for (let attempt = 1; attempt <= AUTO_FOLLOWUP_ATTEMPTS; attempt += 1) {
    const payload = {
      urn: params.urn,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      ...(cachedViewerToken ? { access_token: cachedViewerToken } : {}),
      part_id: params.partId,
      version: params.version,
      source_url: params.sourceUrl,
      source_file_name: params.sourceFileName,
      traceId: `${params.traceId}-auto-${attempt}`,
      ...(params.quoteTarget ? { quoteTarget: params.quoteTarget } : {}),
    };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const text = await response.text();
      let data: any = null;
      if (text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text.slice(0, 2000) };
        }
      }

      const quote = data?.quote || null;
      const viewer = data?.viewer || null;
      const orderPartUpdate = quote?.orderPartUpdate || null;
      const viewerAccessToken = typeof viewer?.accessToken === "string" && viewer.accessToken.trim()
        ? viewer.accessToken.trim()
        : null;
      if (viewerAccessToken) {
        cachedViewerToken = viewerAccessToken;
      }
      const dimensionsWritten = Boolean(orderPartUpdate?.dimensions);
      const thumbnailWritten = Boolean(orderPartUpdate?.thumbnailUrl);
      const hasUpload = Boolean(quote?.upload?.objectModelId);

      lastSnapshot = {
        attempt,
        httpStatus: response.status,
        viewerStatus: viewer?.status || null,
        viewerMode: viewer?.mode || null,
        hasViewerLocalModelUrl: Boolean(viewer?.localModelUrl),
        hasViewerAccessToken: Boolean(viewerAccessToken),
        quoteStatus: quote?.status || null,
        uploadStatus: quote?.upload?.status || null,
        objectModelId: quote?.upload?.objectModelId || null,
        orderPartUpdateStatus: orderPartUpdate?.status || null,
        orderPartUpdateReason: orderPartUpdate?.reason || null,
        dimensionsWritten,
        thumbnailWritten,
      };

      if (orderPartUpdate?.status === "failed" || quote?.status === "failed") {
        return {
          status: "failed",
          attempts: attempt,
          endpoint,
          last: lastSnapshot,
        };
      }

      // DigiFabster uploads the model immediately, but computes the thumbnail +
      // bounding-box dimensions asynchronously. Keep polling until they have
      // actually been written to Bubble — not just the modelId — so a single
      // /api/autodesk call returns with image + dimX/dimY/dimZ already set.
      const modelComplete =
        orderPartUpdate?.status === "updated" && (dimensionsWritten || thumbnailWritten);
      if (modelComplete) {
        const objectModelId = quote?.upload?.objectModelId;
        const price =
          AUTO_BATCH_PRICE_ENABLED && typeof objectModelId === "number"
            ? await runAutoBatchPrice({
                requestOrigin: params.requestOrigin,
                objectModelId,
                partId: params.partId,
                version: params.version,
                traceId: params.traceId,
                orderId: params.orderId,
              })
            : { status: "disabled" };

        return {
          status: "updated",
          attempts: attempt,
          endpoint,
          last: lastSnapshot,
          price,
        };
      }

      const viewerReady =
        viewer?.status === "success" &&
        viewer?.mode === "local" &&
        typeof viewer?.localModelUrl === "string" &&
        viewer.localModelUrl.trim().length > 0;

      // Viewer-only flows (no DigiFabster upload) complete on viewer readiness.
      if (!hasUpload && viewerReady) {
        return {
          status: "updated",
          attempts: attempt,
          endpoint,
          last: lastSnapshot,
        };
      }
    } catch (error) {
      lastSnapshot = {
        attempt,
        error: error instanceof Error ? error.message : "Unknown conversion follow-up error",
      };
    }

    if (attempt < AUTO_FOLLOWUP_ATTEMPTS && AUTO_FOLLOWUP_INTERVAL_MS > 0) {
      await delay(AUTO_FOLLOWUP_INTERVAL_MS);
    }
  }

  return {
    status: "timeout",
    attempts: AUTO_FOLLOWUP_ATTEMPTS,
    endpoint,
    last: lastSnapshot,
  };
};

export async function POST(req: Request) {
  let traceId = createTraceId();

  try {
    const requestOrigin = new URL(req.url).origin;
    const body = await req.json();
    const { url, part_id, version, client_id, client_secret, dry_run, auto_modelid, autoModelId } = body;
    // Bubble `order` thing id — the auto batch-price PATCHes `[price]manufacturingCost`
    // onto it. Optional; when absent the price is computed but not written back.
    const bubbleOrderId =
      [body?.order_id, body?.orderId, body?.bubble_order_id, body?.bubbleOrderId].find(
        (v) => typeof v === "string" && v.trim(),
      ) || null;
    if (typeof body?.traceId === "string" && body.traceId.trim()) {
      traceId = body.traceId.trim();
    }

    logStep(traceId, "request.received", {
      dry_run: dry_run === true,
      hasUrl: Boolean(url),
      hasPartId: Boolean(part_id),
      hasVersion: Boolean(version),
      hasClientId: Boolean(client_id),
      hasClientSecret: Boolean(client_secret),
    });

    if (!url || !part_id || !version) {
      logStep(traceId, "request.validation_failed", { reason: "missing_required_parameters" });
      return new Response(JSON.stringify({ error: "Missing required parameters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (dry_run === true) {
      const classification = classifySourceFormat(url as string);
      const quoteStatus = classification.quote.required ? "queued" : "not_required";
      const quoteError = classification.quote.mode === "none"
        ? "Quote conversion skipped because source format is outside the short supported scope."
        : null;

      logStep(traceId, "dry_run.completed", {
        sourceFormat: classification.extension,
        quoteStatus,
        quoteTarget: classification.quote.targetFormat,
      });

      return new Response(
        JSON.stringify({
          success: true,
          traceId,
          urn: `dryrun:${Date.now()}`,
          accessToken: "dry-run-token",
          bucketKey: "dry-run-bucket",
          objectKey: "dry-run-object",
          sourceFormat: classification.extension,
          viewer: {
            status: "queued",
            priority: true,
          },
          quote: {
            status: quoteStatus,
            targetFormat: classification.quote.targetFormat,
            reason: classification.quote.reason,
            error: quoteError,
          },
          planRef: "/memories/session/plan.md",
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (!client_id || !client_secret) {
      logStep(traceId, "request.validation_failed", { reason: "missing_client_credentials" });
      return new Response(JSON.stringify({ error: "Missing required parameters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    logStep(traceId, "source.download.start", { sourceUrl: url });
    const file = await fetchFileAndConvert(url as string);
    logStep(traceId, "source.download.success", {
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
    });

    const sourceFileName = typeof file.name === "string" && file.name.trim() ? file.name.trim() : "source-model";
    const classification = classifySourceFormat(sourceFileName);
    const skipAutodeskTranslation = shouldSkipAutodeskTranslationForFormat(classification.extension);

    if (skipAutodeskTranslation) {
      const nativeUrn = createNative2dUrn({
        partId: String(part_id),
        version: String(version),
        sourceUrl: String(url),
        extension: classification.extension,
      });

      let quoteStatus: "queued" | "inprogress" | "success" | "failed" = "queued";
      let quoteError: string | null = null;
      let quoteUpload: Awaited<ReturnType<typeof syncNativeSourceToDigifabster>> | null = null;

      try {
        quoteUpload = await syncNativeSourceToDigifabster({
          urn: nativeUrn,
          sourceUrl: String(url),
          sourceFileName,
          partId: String(part_id),
          version: String(version),
          traceId,
        });

        quoteStatus = quoteUpload.status === "submitted" || quoteUpload.status === "cached"
          ? "success"
          : "inprogress";
      } catch (syncError) {
        if (syncError instanceof DigifabsterSyncError) {
          quoteStatus = syncError.retryable ? "inprogress" : "failed";
          quoteError = syncError.details || syncError.message;
        } else {
          quoteStatus = "failed";
          quoteError = syncError instanceof Error ? syncError.message : "Native DigiFabster sync failed.";
        }
      }

      const autoModelIdEnabled = auto_modelid !== false && autoModelId !== false;
      const autoFollowup = autoModelIdEnabled
        ? await runAutoBubbleWriteback({
            requestOrigin,
            urn: nativeUrn,
            traceId,
            clientId: client_id,
            clientSecret: client_secret,
            partId: part_id,
            version,
            sourceUrl: url,
            sourceFileName,
            quoteTarget: null,
            orderId: bubbleOrderId,
          })
        : {
            status: "disabled",
            reason: "auto_modelid_false",
          };

      const thumbnailDataUrl = createNative2dThumbnailDataUrl(sourceFileName, classification.extension);

      const autoPrice = (autoFollowup as { price?: Record<string, any> } | null)?.price ?? null;
      logStep(traceId, "request.completed", {
        urn: nativeUrn,
        sourceFormat: classification.extension,
        viewerStatus: "success",
        quoteStatus,
        quoteTarget: null,
        directNativeSync: true,
        autoFollowupStatus: autoFollowup?.status || null,
        priceStatus: autoPrice?.status ?? null,
        priceBubbleStatus: autoPrice?.bubble?.status ?? null,
        priceSelectedCost: autoPrice?.selectedPrice?.cost ?? null,
        priceMaterialSource: autoPrice?.materialSource ?? null,
        priceError: autoPrice?.error ?? null,
      });

      return new Response(JSON.stringify({
        success: true,
        traceId,
        urn: nativeUrn,
        accessToken: null,
        bucketKey: null,
        objectKey: null,
        sourceFormat: classification.extension,
        sourceUrl: url,
        sourceFileName,
        viewer: {
          status: "success",
          priority: true,
          mode: "thumbnail",
          thumbnailDataUrl,
        },
        quote: {
          status: quoteStatus,
          targetFormat: null,
          reason: "2D/native source bypassed Autodesk translation and synced directly to DigiFabster.",
          error: quoteError,
          upload: quoteUpload,
          sourceUrl: url,
          sourceFileName,
        },
        thumbnailDataUrl,
        autoFollowup,
        planRef: "/memories/session/plan.md",
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    logStep(traceId, "auth.fetch_access_token.start");
    const accessToken = await fetchAccessToken(client_id, client_secret);
    logStep(traceId, "auth.fetch_access_token.success", { tokenLength: accessToken.length });

    logStep(traceId, "oss.create_bucket.start");
    const bucket = await createBucket(accessToken);
    logStep(traceId, "oss.create_bucket.success", { bucket });

    logStep(traceId, "oss.obtain_signed_url.start", { bucket, fileName: file.name });
    const signedUrl = await obtainSignedUrl(bucket, accessToken, file);
    logStep(traceId, "oss.obtain_signed_url.success", { uploadUrlCount: signedUrl.urls.length });

    logStep(traceId, "oss.upload_file.start", { bucket, fileName: file.name });
    await uploadFile(signedUrl.urls[0], file);
    logStep(traceId, "oss.upload_file.success", { bucket, fileName: file.name });

    logStep(traceId, "oss.finalize_upload.start", { bucket, uploadKey: signedUrl.uploadKey });
    const finalizingUploadResponse = await finalizeUpload(
      bucket, signedUrl.uploadKey, accessToken, file
    );
    logStep(traceId, "oss.finalize_upload.success", {
      objectKey: finalizingUploadResponse.objectKey,
    });

    const encodedFileURN = btoa(finalizingUploadResponse.objectId);
    const fileObjectKey = finalizingUploadResponse.objectKey;

    const extraFormats = classification.quote.required && classification.quote.targetFormat
      ? [{ type: classification.quote.targetFormat }]
      : [];

    logStep(traceId, "translation.start", {
      objectKey: fileObjectKey,
      sourceFormat: classification.extension,
      extraFormats: extraFormats.map((format) => format.type),
    });

    const translationResponse = await startTranslation(
      encodedFileURN,
      fileObjectKey,
      accessToken,
      extraFormats
    );

    const urn = translationResponse.urn;
    logStep(traceId, "translation.started", {
      urn,
      quoteTarget: classification.quote.targetFormat,
      quoteMode: classification.quote.mode,
    });

    const quoteStatus = classification.quote.required ? "queued" : "not_required";
    const quoteError = classification.quote.mode === "none"
      ? "Quote conversion skipped because source format is outside the short supported scope."
      : null;

    const autoModelIdEnabled = auto_modelid !== false && autoModelId !== false;
    const autoFollowup = autoModelIdEnabled
      ? await runAutoBubbleWriteback({
          requestOrigin,
          urn,
          traceId,
          clientId: client_id,
          clientSecret: client_secret,
          partId: part_id,
          version,
          sourceUrl: url,
          sourceFileName,
          quoteTarget: classification.quote.targetFormat,
          orderId: bubbleOrderId,
        })
      : {
          status: "disabled",
          reason: "auto_modelid_false",
        };

    logStep(traceId, "request.completed", {
      urn,
      viewerStatus: "queued",
      quoteStatus,
      quoteTarget: classification.quote.targetFormat,
      autoFollowupStatus: autoFollowup?.status || null,
    });

    return new Response(JSON.stringify({
      success: true,
      traceId,
      urn,
      accessToken,
      bucketKey: bucket,
      objectKey: fileObjectKey,
      sourceFormat: classification.extension,
      viewer: {
        status: "queued",
        priority: true,
      },
      quote: {
        status: quoteStatus,
        targetFormat: classification.quote.targetFormat,
        reason: classification.quote.reason,
        error: quoteError,
      },
      autoFollowup,
      planRef: "/memories/session/plan.md",
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    logStep(traceId, "request.failed", {
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    return new Response(JSON.stringify({ error: "Process failed", traceId }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}