import { randomUUID } from "node:crypto";

import * as autodeskRoute from "../autodesk.cts";
import * as conversionStatusRoute from "../conversion-status.cts";
import * as digifabsterPriceTweakRoute from "../digifabster-price-tweak.cts";
import { getAutodeskAccountById, getAutodeskAccountForPart } from "./autodesk-account-pool";
import {
  getEmbedPart,
  saveEmbedPart,
  type EmbedPartDefaultsSnapshot,
  type EmbedPartRecord,
} from "./part-store";

const EMBED_PIPELINE_VERSION = "embed-v1";

type JsonObject = Record<string, unknown>;

type HandlerLike = (req: Request) => Promise<Response> | Response;

const resolveHandler = (moduleLike: unknown, method: "GET" | "POST") => {
  const record = moduleLike as { [key: string]: unknown; default?: { [key: string]: unknown } };
  const direct = record[method];
  if (typeof direct === "function") {
    return direct as HandlerLike;
  }

  const fallback = record.default?.[method];
  if (typeof fallback === "function") {
    return fallback as HandlerLike;
  }

  throw new Error(`Unable to resolve ${method} handler.`);
};

const autodeskPostHandler = resolveHandler(autodeskRoute, "POST");
const conversionStatusPostHandler = resolveHandler(conversionStatusRoute, "POST");
const digifabsterCatalogGetHandler = resolveHandler(digifabsterPriceTweakRoute, "GET");
const digifabsterPricePostHandler = resolveHandler(digifabsterPriceTweakRoute, "POST");

const invokeJson = async (
  handler: HandlerLike,
  request: Request
): Promise<{ response: Response; data: unknown }> => {
  const response = await handler(request);
  const rawText = await response.text();

  if (!rawText.trim()) {
    return { response, data: null };
  }

  try {
    return { response, data: JSON.parse(rawText) };
  } catch {
    return { response, data: { raw: rawText.slice(0, 2000) } };
  }
};

const asRecord = (value: unknown): JsonObject | null => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
};

const asNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const toFailureMessage = (payload: unknown, fallbackMessage: string) => {
  const record = asRecord(payload);
  if (!record) {
    return fallbackMessage;
  }

  const error = typeof record.error === "string" ? record.error : null;
  const details = typeof record.details === "string" ? record.details : null;

  if (error && details) {
    return `${error} ${details}`;
  }

  return error || fallbackMessage;
};

const pickFirstMachineMaterial = (machinesMaterials: unknown[]) => {
  for (const machineCandidate of machinesMaterials) {
    const machineRecord = asRecord(machineCandidate);
    if (!machineRecord) {
      continue;
    }

    const machineId = asNumber(machineRecord.id);
    const machineTitle = typeof machineRecord.title === "string" ? machineRecord.title : null;
    const materialsRaw = Array.isArray(machineRecord.materials) ? machineRecord.materials : [];

    for (const materialCandidate of materialsRaw) {
      const materialRecord = asRecord(materialCandidate);
      if (!materialRecord) {
        continue;
      }

      const materialId = asNumber(materialRecord.id);
      const materialTitle = typeof materialRecord.title === "string" ? materialRecord.title : null;
      if (!machineId || !materialId) {
        continue;
      }

      return {
        machine: { id: machineId, title: machineTitle },
        material: { id: materialId, title: materialTitle },
      };
    }
  }

  return null;
};

const isViewerReady = (part: EmbedPartRecord) => {
  return part.viewer?.status === "success" && Boolean(part.viewer.localModelUrl);
};

const getObjectModelId = (part: EmbedPartRecord) => {
  return part.quote?.upload?.objectModelId ?? null;
};

const deriveLifecycleState = (part: EmbedPartRecord): EmbedPartRecord => {
  if (part.failure.code) {
    return {
      ...part,
      status: "failed",
      processingStage: "failed",
      processingStatus: "failed",
    };
  }

  const viewerReady = isViewerReady(part);
  const objectModelId = getObjectModelId(part);
  const defaultsReady = part.defaultsSnapshot?.status === "ready";

  if (viewerReady && (!objectModelId || defaultsReady)) {
    return {
      ...part,
      status: "ready",
      processingStage: "ready",
      processingStatus: "success",
    };
  }

  if (objectModelId) {
    return {
      ...part,
      status: "processing",
      processingStage: defaultsReady ? "defaults_ready" : "digifabster_sync",
      processingStatus: defaultsReady ? "success" : "inprogress",
    };
  }

  if (viewerReady) {
    return {
      ...part,
      status: "processing",
      processingStage: "viewer_ready",
      processingStatus: "success",
    };
  }

  if (part.viewer?.status === "failed") {
    return {
      ...part,
      status: "failed",
      processingStage: "failed",
      processingStatus: "failed",
      failure: {
        code: part.failure.code || "viewer_failed",
        message: part.failure.message || part.viewer.localError || "Viewer translation failed.",
      },
    };
  }

  if (part.autodesk.urn) {
    return {
      ...part,
      status: "processing",
      processingStage: "autodesk_processing",
      processingStatus: part.viewer?.status === "queued" ? "queued" : "inprogress",
    };
  }

  return {
    ...part,
    status: "uploaded",
    processingStage: "upload_received",
    processingStatus: "success",
  };
};

const inflightStart = new Map<string, Promise<EmbedPartRecord | null>>();
const inflightRefresh = new Map<string, Promise<EmbedPartRecord | null>>();
const inflightDefaults = new Map<string, Promise<EmbedPartRecord | null>>();

const runSingleFlight = async (
  store: Map<string, Promise<EmbedPartRecord | null>>,
  key: string,
  task: () => Promise<EmbedPartRecord | null>
) => {
  if (store.has(key)) {
    return store.get(key)!;
  }

  const promise = task().finally(() => {
    store.delete(key);
  });

  store.set(key, promise);
  return promise;
};

export const toEmbedPartStatePayload = (part: EmbedPartRecord) => {
  const objectModelId = getObjectModelId(part);

  return {
    vercelPartId: part.vercelPartId,
    status: part.status,
    processingStage: part.processingStage,
    processingStatus: part.processingStatus,
    source: {
      sourceFileId: part.sourceFileId,
      sourceFileName: part.sourceFileName,
      sourceFileSizeBytes: part.sourceFileSizeBytes,
      sourceFileUrl: part.sourceFileUrl,
    },
    autodesk: {
      accountId: part.autodesk.accountId,
      bucketKey: part.autodesk.bucketKey,
      objectKey: part.autodesk.objectKey,
      urn: part.autodesk.urn,
      lastSyncedAt: part.autodesk.lastSyncedAt,
    },
    viewer: part.viewer,
    quote: part.quote,
    digifabster: {
      objectModelId,
      orderId: part.quote?.upload?.orderId ?? null,
      sessionId: part.quote?.upload?.sessionId ?? null,
    },
    defaultsSnapshot: part.defaultsSnapshot,
    failure: part.failure,
    updatedAt: part.updatedAt,
    createdAt: part.createdAt,
  };
};

const markPartFailure = async (part: EmbedPartRecord, code: string, message: string) => {
  return saveEmbedPart(
    deriveLifecycleState({
      ...part,
      status: "failed",
      processingStage: "failed",
      processingStatus: "failed",
      failure: {
        code,
        message,
      },
      updatedAt: Date.now(),
    })
  );
};

export const kickoffPartProcessing = async (
  vercelPartId: string,
  requestOrigin: string,
  options?: { force?: boolean }
) => {
  return runSingleFlight(inflightStart, vercelPartId, async () => {
    const part = await getEmbedPart(vercelPartId);
    if (!part) {
      return null;
    }

    if (!options?.force && part.autodesk.urn) {
      return refreshPartProcessing(vercelPartId, requestOrigin);
    }

    if (!part.sourceFileUrl) {
      return markPartFailure(part, "missing_source_file_url", "Part source file URL is missing.");
    }

    const account = part.autodesk.accountId
      ? getAutodeskAccountById(part.autodesk.accountId)
      : getAutodeskAccountForPart(part.vercelPartId);

    if (!account) {
      return markPartFailure(
        part,
        "missing_autodesk_account_pool",
        "Autodesk account pool is not configured. Set AUTODESK_ACCOUNT_POOL_JSON or AUTODESK_CLIENT_ID/AUTODESK_CLIENT_SECRET."
      );
    }

    const queuedPart = await saveEmbedPart({
      ...part,
      status: "processing",
      processingStage: "autodesk_queued",
      processingStatus: "queued",
      autodesk: {
        ...part.autodesk,
        accountId: account.accountId,
      },
      failure: {
        code: null,
        message: null,
      },
      updatedAt: Date.now(),
    });

    const autodeskRequest = new Request(`${requestOrigin}/api/autodesk`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: part.sourceFileUrl,
        part_id: part.vercelPartId,
        version: EMBED_PIPELINE_VERSION,
        client_id: account.clientId,
        client_secret: account.clientSecret,
        auto_modelid: false,
      }),
    });

    const { response, data } = await invokeJson(autodeskPostHandler, autodeskRequest);
    if (!response.ok) {
      return markPartFailure(
        queuedPart,
        "autodesk_start_failed",
        toFailureMessage(data, "Failed to start Autodesk processing.")
      );
    }

    const payload = asRecord(data);
    if (!payload || payload.success !== true || typeof payload.urn !== "string") {
      return markPartFailure(
        queuedPart,
        "autodesk_invalid_response",
        "Autodesk start response did not include a valid URN."
      );
    }

    const nextPart = await saveEmbedPart(
      deriveLifecycleState({
        ...queuedPart,
        status: "processing",
        processingStage: "autodesk_processing",
        processingStatus: "inprogress",
        autodesk: {
          ...queuedPart.autodesk,
          accountId: account.accountId,
          bucketKey: typeof payload.bucketKey === "string" ? payload.bucketKey : null,
          objectKey: typeof payload.objectKey === "string" ? payload.objectKey : null,
          urn: payload.urn,
          lastSyncedAt: Date.now(),
        },
        viewer: {
          status: "queued",
          mode: "cloud",
          localModelUrl: null,
          localError: null,
          urn: payload.urn,
        },
        quote: {
          status: "queued",
          targetFormat: (typeof payload.quote === "object" && payload.quote && typeof (payload.quote as JsonObject).targetFormat === "string")
            ? (((payload.quote as JsonObject).targetFormat as string).toLowerCase() as "step" | "dwg")
            : null,
          error: null,
          upload: null,
        },
        updatedAt: Date.now(),
      })
    );

    return refreshPartProcessing(nextPart.vercelPartId, requestOrigin);
  });
};

export const refreshPartProcessing = async (vercelPartId: string, requestOrigin: string) => {
  return runSingleFlight(inflightRefresh, vercelPartId, async () => {
    const part = await getEmbedPart(vercelPartId);
    if (!part) {
      return null;
    }

    if (!part.autodesk.urn) {
      return deriveLifecycleState(part);
    }

    const account = part.autodesk.accountId
      ? getAutodeskAccountById(part.autodesk.accountId)
      : getAutodeskAccountForPart(part.vercelPartId);
    if (!account) {
      return markPartFailure(part, "missing_autodesk_account", "Assigned Autodesk account credentials are unavailable.");
    }

    const conversionRequest = new Request(`${requestOrigin}/api/conversion-status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        urn: part.autodesk.urn,
        client_id: account.clientId,
        client_secret: account.clientSecret,
        part_id: part.vercelPartId,
        version: EMBED_PIPELINE_VERSION,
        source_url: part.sourceFileUrl,
        source_file_name: part.sourceFileName,
      }),
    });

    const { response, data } = await invokeJson(conversionStatusPostHandler, conversionRequest);
    const payload = asRecord(data);
    if (!payload) {
      return markPartFailure(part, "conversion_status_invalid", "Failed to parse conversion status response payload.");
    }

    const viewerPayload = asRecord(payload.viewer);
    const quotePayload = asRecord(payload.quote);

    const nextPart = await saveEmbedPart(
      deriveLifecycleState({
        ...part,
        status: "processing",
        autodesk: {
          ...part.autodesk,
          accountId: account.accountId,
          lastSyncedAt: Date.now(),
        },
        viewer: {
          status: (viewerPayload?.status as "queued" | "inprogress" | "success" | "failed") || "queued",
          mode: (viewerPayload?.mode as "local" | "cloud" | undefined) || "cloud",
          localModelUrl: typeof viewerPayload?.localModelUrl === "string" ? viewerPayload.localModelUrl : null,
          localError: typeof viewerPayload?.localError === "string" ? viewerPayload.localError : null,
          urn: part.autodesk.urn,
        },
        quote: {
          status: (quotePayload?.status as "not_required" | "queued" | "inprogress" | "success" | "failed") || "not_required",
          targetFormat: (quotePayload?.targetFormat as "step" | "dwg" | null) || null,
          error: typeof quotePayload?.error === "string" ? quotePayload.error : null,
          upload: (() => {
            const uploadPayload = asRecord(quotePayload?.upload);
            if (!uploadPayload) {
              return null;
            }

            return {
              status: (uploadPayload.status as "skipped" | "submitted" | "cached") || "skipped",
              objectModelId: asNumber(uploadPayload.objectModelId),
              orderId: asNumber(uploadPayload.orderId),
              sessionId: typeof uploadPayload.sessionId === "string" ? uploadPayload.sessionId : null,
              quoteStatus: typeof uploadPayload.quoteStatus === "string" ? uploadPayload.quoteStatus : null,
              source: (uploadPayload.source as "digifabster" | "cache" | "none") || "none",
              reason: typeof uploadPayload.reason === "string" ? uploadPayload.reason : undefined,
            };
          })(),
        },
        failure:
          response.ok
            ? { code: null, message: null }
            : {
              code: "conversion_status_failed",
              message: toFailureMessage(data, "Failed to refresh conversion status."),
            },
        updatedAt: Date.now(),
      })
    );

    if (nextPart.quote?.upload?.objectModelId) {
      return ensurePartDefaultsSnapshot(nextPart.vercelPartId, requestOrigin);
    }

    return nextPart;
  });
};

export const ensurePartDefaultsSnapshot = async (vercelPartId: string, requestOrigin: string) => {
  return runSingleFlight(inflightDefaults, vercelPartId, async () => {
    const part = await getEmbedPart(vercelPartId);
    if (!part) {
      return null;
    }

    const objectModelId = getObjectModelId(part);
    if (!objectModelId) {
      return deriveLifecycleState(part);
    }

    if (part.defaultsSnapshot?.status === "ready") {
      return deriveLifecycleState(part);
    }

    const defaultsRequest = new Request(`${requestOrigin}/api/digifabster-price-tweak`, {
      method: "GET",
    });

    const { response: catalogResponse, data: catalogDataRaw } = await invokeJson(
      digifabsterCatalogGetHandler,
      defaultsRequest
    );

    const warnings: string[] = [];
    if (!catalogResponse.ok) {
      warnings.push(toFailureMessage(catalogDataRaw, "Failed to fetch DigiFabster catalog."));
    }

    const catalogData = asRecord(catalogDataRaw);
    const machinesMaterials = Array.isArray(catalogData?.machinesMaterials)
      ? catalogData.machinesMaterials
      : [];
    const firstPair = pickFirstMachineMaterial(machinesMaterials);

    let pricing = {
      currency: "USD",
      unitPrice: null as number | null,
      setupPrice: null as number | null,
      totalPrice: null as number | null,
      leadTimeDays: null as number | null,
    };

    if (!firstPair) {
      warnings.push("No machine/material pair available in DigiFabster catalog response.");
    }

    if (firstPair) {
      const priceRequest = new Request(`${requestOrigin}/api/digifabster-price-tweak`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          objectModelId,
          machineId: firstPair.machine.id,
          materialId: firstPair.material.id,
          count: 1,
        }),
      });

      const { response: priceResponse, data: priceDataRaw } = await invokeJson(digifabsterPricePostHandler, priceRequest);
      const priceData = asRecord(priceDataRaw);

      if (priceResponse.ok && priceData?.status === "success") {
        pricing = {
          currency: "USD",
          unitPrice: asNumber(priceData.total_per_part_price),
          setupPrice: null,
          totalPrice: asNumber(priceData.total_per_part_price),
          leadTimeDays: null,
        };
      } else {
        warnings.push(toFailureMessage(priceDataRaw, "Failed to fetch initial DigiFabster pricing."));
      }
    }

    const snapshot: EmbedPartDefaultsSnapshot = {
      snapshotId: randomUUID(),
      createdAt: Date.now(),
      status: warnings.length === 0 ? "ready" : "pending",
      defaults: {
        machine: firstPair ? firstPair.machine : { id: null, title: null },
        material: firstPair ? firstPair.material : { id: null, title: null },
        tolerance: null,
        postproduction: [],
        quantity: 1,
        leadTime: null,
        technologySlug:
          typeof catalogData?.defaultTechnologySlug === "string"
            ? catalogData.defaultTechnologySlug
            : null,
      },
      pricing,
      warnings,
    };

    const nextPart = await saveEmbedPart(
      deriveLifecycleState({
        ...part,
        defaultsSnapshot: snapshot,
        updatedAt: Date.now(),
      })
    );

    return nextPart;
  });
};

export const repriceEmbedPart = async (
  vercelPartId: string,
  requestOrigin: string,
  payload: Record<string, unknown>
) => {
  const part = await getEmbedPart(vercelPartId);
  if (!part) {
    return {
      ok: false,
      status: 404,
      error: "Part not found",
    } as const;
  }

  const objectModelId = getObjectModelId(part);
  if (!objectModelId) {
    return {
      ok: false,
      status: 409,
      error: "Part is not linked to a DigiFabster object model yet.",
    } as const;
  }

  const defaults = part.defaultsSnapshot?.defaults;
  const machineId = asNumber(payload.machineId) ?? defaults?.machine.id ?? null;
  const materialId = asNumber(payload.materialId) ?? defaults?.material.id ?? null;
  const quantity = asNumber(payload.quantity) ?? defaults?.quantity ?? 1;

  const requestBody: Record<string, unknown> = {
    objectModelId,
    machineId,
    materialId,
    count: quantity,
  };

  if (payload.toleranceId) {
    requestBody.tightest_tolerance = payload.toleranceId;
  }

  if (Array.isArray(payload.postproductionIds) && payload.postproductionIds.length > 0) {
    requestBody.post_production = payload.postproductionIds;
  }

  const request = new Request(`${requestOrigin}/api/digifabster-price-tweak`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const { response, data } = await invokeJson(digifabsterPricePostHandler, request);
  const parsed = asRecord(data);
  if (!response.ok || parsed?.status !== "success") {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: toFailureMessage(data, "Failed to repricing the part."),
      details: data,
    } as const;
  }

  const updatedPart = await saveEmbedPart(
    deriveLifecycleState({
      ...part,
      processingStage: "reprice_processing",
      processingStatus: "inprogress",
      defaultsSnapshot: {
        snapshotId: part.defaultsSnapshot?.snapshotId || randomUUID(),
        createdAt: Date.now(),
        status: "ready",
        defaults: {
          machine: {
            id: machineId,
            title: part.defaultsSnapshot?.defaults.machine.title ?? null,
          },
          material: {
            id: materialId,
            title: part.defaultsSnapshot?.defaults.material.title ?? null,
          },
          tolerance: typeof payload.toleranceId === "string" ? payload.toleranceId : part.defaultsSnapshot?.defaults.tolerance ?? null,
          postproduction: Array.isArray(payload.postproductionIds)
            ? payload.postproductionIds.filter((item): item is string => typeof item === "string")
            : part.defaultsSnapshot?.defaults.postproduction ?? [],
          quantity,
          leadTime: part.defaultsSnapshot?.defaults.leadTime ?? null,
          technologySlug: part.defaultsSnapshot?.defaults.technologySlug ?? null,
        },
        pricing: {
          currency: "USD",
          unitPrice: asNumber(parsed.total_per_part_price),
          setupPrice: null,
          totalPrice: asNumber(parsed.total_per_part_price),
          leadTimeDays: null,
        },
        warnings: [],
      },
      updatedAt: Date.now(),
    })
  );

  const readyPart = await saveEmbedPart(
    deriveLifecycleState({
      ...updatedPart,
      processingStage: "ready",
      processingStatus: "success",
      updatedAt: Date.now(),
    })
  );

  return {
    ok: true,
    status: 200,
    part: readyPart,
    pricing: readyPart.defaultsSnapshot?.pricing ?? null,
    selectedConfig: readyPart.defaultsSnapshot?.defaults ?? null,
    warnings: readyPart.defaultsSnapshot?.warnings ?? [],
  } as const;
};

