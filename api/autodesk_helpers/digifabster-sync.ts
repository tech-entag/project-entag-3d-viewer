import { list, put } from "@vercel/blob";
import { extname, posix as pathPosix } from "node:path";

import {
  downloadDerivativeFile,
  findDerivativeByType,
  getDerivativeDownloadUrl,
  getManifest,
} from "./index";

type QuoteTarget = "step" | "dwg";
type SyncChannel = QuoteTarget | "native";

type SyncStatus = "skipped" | "submitted" | "cached";

interface DigifabsterUploadRecord {
  urn: string;
  quoteTarget: SyncChannel;
  partId: string;
  version: string;
  fileUrl: string;
  fileName: string;
  objectModelId: number | null;
  orderId: number | null;
  sessionId: string | null;
  status: string | null;
  syncedAt: string;
}

export interface QuoteUploadSyncResult {
  status: SyncStatus;
  objectModelId: number | null;
  orderId: number | null;
  sessionId: string | null;
  quoteStatus: string | null;
  source: "digifabster" | "cache" | "none";
  fileUrl?: string;
  fileName?: string;
  reason?: string;
}

interface DigifabsterUploadResponse {
  success?: boolean;
  code?: string;
  error?: string;
  detail?: string;
  details?: string;
  object_model_id?: number;
  order_id?: number;
  session_id?: string;
  status?: string;
  object_models?: Array<{ id?: number; status?: string }>;
}

interface SyncParams {
  urn: string;
  accessToken: string;
  quoteTarget: QuoteTarget;
  partId?: string;
  version?: string;
  traceId?: string;
}

interface NativeSyncParams {
  urn: string;
  sourceUrl: string;
  sourceFileName?: string;
  partId?: string;
  version?: string;
  traceId?: string;
}

const DEFAULT_BASE_URL = "https://digifabster.com";
const DEFAULT_UPLOAD_TIMEOUT_MS = 270_000;
const MAX_UPLOAD_RETRIES = 2;
const DEFAULT_TOKEN_EXCHANGE_ENDPOINT = `${DEFAULT_BASE_URL}/v2/obtain_s2s_token/`;
const DEFAULT_S2S_TOKEN_TTL_MS = 55 * 60 * 1000;

let cachedS2SToken: { token: string; expiresAt: number } | null = null;

export const resolveDigifabsterBaseUrl = () =>
  (process.env.DIGIFABSTER_UPLOAD_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

export const resolveDigifabsterUploadEndpoint = () => {
  const explicit = process.env.DIGIFABSTER_UPLOAD_ENDPOINT;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  return "";
};

export const resolvePriceTweakingEndpoint = () => {
  const explicit = process.env.DIGIFABSTER_PRICE_TWEAK_ENDPOINT;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  return "";
};

export const resolveDefaultTechnologySlug = () =>
  (process.env.DIGIFABSTER_DEFAULT_TECH_SLUG || "3-axis-milling").trim();

export const buildPriceTweakerUrl = (technologySlug: string) => {
  const base = resolveDigifabsterBaseUrl();
  return `${base}/v2/price_tweaker/${encodeURIComponent(technologySlug)}/`;
};

export const fetchDigifabsterJson = async (
  path: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: unknown }> => {
  const base = resolveDigifabsterBaseUrl();
  const url = `${base}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", ...headers },
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 2000) };
  }
  return { ok: res.ok, status: res.status, data };
};

const withTokenPrefix = (token: string) => (token.startsWith("Token ") ? token : `Token ${token}`);

const resolveDigifabsterApiKey = () => {
  const raw = process.env.DIGIFABSTER_API_KEY?.trim() || process.env.DIGIFABSTER_API_TOKEN?.trim() || "";
  return raw.replace(/^api_key\s*:\s*/i, "").trim();
};

const resolveDigifabsterDirectToken = () => {
  const raw = process.env.DIGIFABSTER_API_TOKEN?.trim() || process.env.DIGIFABSTER_API_KEY?.trim() || "";
  return raw.replace(/^api_key\s*:\s*/i, "").trim();
};

export const resolveDigifabsterTokenExchangeEndpoint = () => {
  const explicit = process.env.DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  return DEFAULT_TOKEN_EXCHANGE_ENDPOINT;
};

const obtainDigifabsterS2SToken = async () => {
  const now = Date.now();
  if (cachedS2SToken && cachedS2SToken.expiresAt > now) {
    return cachedS2SToken.token;
  }

  const apiKey = resolveDigifabsterApiKey();
  if (!apiKey) {
    throw new DigifabsterSyncError({
      message: "Missing DigiFabster API key for token exchange.",
      status: 500,
      code: "digifabster_api_key_missing",
      details: "Set DIGIFABSTER_API_KEY (or DIGIFABSTER_API_TOKEN for backward compatibility).",
      retryable: false,
    });
  }

  const exchangeEndpoint = resolveDigifabsterTokenExchangeEndpoint();
  const exchangeResponse = await fetch(exchangeEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
    }),
  });

  const exchangeText = await exchangeResponse.text();
  let exchangeData: { token?: string; detail?: string } = {};
  if (exchangeText.trim()) {
    try {
      exchangeData = JSON.parse(exchangeText) as { token?: string; detail?: string };
    } catch {
      exchangeData = { detail: exchangeText.slice(0, 2_000) };
    }
  }

  if (!exchangeResponse.ok || typeof exchangeData.token !== "string" || !exchangeData.token.trim()) {
    throw new DigifabsterSyncError({
      message: "Failed to obtain DigiFabster S2S token.",
      status: exchangeResponse.status || 502,
      code: "digifabster_s2s_token_exchange_failed",
      details: exchangeData.detail || "Token exchange endpoint did not return a usable token.",
      retryable: exchangeResponse.status >= 500,
    });
  }

  const ttlMs = parsePositiveInt(process.env.DIGIFABSTER_S2S_TOKEN_TTL_MS, DEFAULT_S2S_TOKEN_TTL_MS);
  cachedS2SToken = {
    token: exchangeData.token.trim(),
    expiresAt: now + ttlMs,
  };

  return cachedS2SToken.token;
};

export const buildDigifabsterHeaders = async (): Promise<Record<string, string>> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const token = await obtainDigifabsterS2SToken();
  headers.Authorization = withTokenPrefix(token);

  if (process.env.DIGIFABSTER_UPLOAD_SHARED_SECRET) {
    headers["X-Upload-Secret"] = process.env.DIGIFABSTER_UPLOAD_SHARED_SECRET;
  }

  return headers;
};

const buildDigifabsterDirectHeaders = (): Record<string, string> => {
  const token = resolveDigifabsterDirectToken();
  if (!token) {
    throw new DigifabsterSyncError({
      message: "Missing DigiFabster API token for direct upload auth.",
      status: 500,
      code: "digifabster_api_token_missing",
      details: "Set DIGIFABSTER_API_TOKEN for direct upload fallback.",
      retryable: false,
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: withTokenPrefix(token),
  };

  if (process.env.DIGIFABSTER_UPLOAD_SHARED_SECRET) {
    headers["X-Upload-Secret"] = process.env.DIGIFABSTER_UPLOAD_SHARED_SECRET;
  }

  return headers;
};

const getBlobToken = () => process.env.BLOB_READ_WRITE_TOKEN || "";

const hasBlobToken = () => Boolean(getBlobToken());

const toUrnKey = (urn: string) => Buffer.from(urn).toString("base64url");

const toSyncKey = (urn: string, quoteTarget: SyncChannel, partId: string, version: string) =>
  Buffer.from(`${urn}|${quoteTarget}|${partId}|${version}`).toString("base64url");

const syncRecordPath = (urn: string, quoteTarget: SyncChannel, partId: string, version: string) =>
  `digifabster-sync/${toSyncKey(urn, quoteTarget, partId, version)}.json`;

const derivativeBlobPath = (urn: string, quoteTarget: QuoteTarget, fileName: string) =>
  `quote-derivatives/${toUrnKey(urn)}/${quoteTarget}/${fileName}`;

/* ------------------------------------------------------------------ */
/*  Price-tweaker machine/material cache (Vercel Blob)                */
/* ------------------------------------------------------------------ */

const DEFAULT_PRICE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface PriceTweakerCacheRecord {
  technologySlug: string;
  machineId: number;
  materialId: number;
  machine: Record<string, unknown>;
  material: Record<string, unknown>;
  tolerances: unknown[];
  priorities: unknown[];
  postproduction: unknown[];
  storedAt: string;
}

const priceCacheKey = (techSlug: string, machineId: number, materialId: number) =>
  `price-tweaker-cache/${techSlug}_${machineId}_${materialId}.json`;

export const getPriceTweakerCache = async (
  techSlug: string,
  machineId: number,
  materialId: number,
): Promise<PriceTweakerCacheRecord | null> => {
  if (!hasBlobToken()) return null;

  const key = priceCacheKey(techSlug, machineId, materialId);
  try {
    const items = await list({ prefix: key, token: getBlobToken(), limit: 1 });
    const blob = items.blobs[0];
    if (!blob) return null;

    const res = await fetch(blob.url);
    if (!res.ok) return null;
    const record = (await res.json()) as PriceTweakerCacheRecord;

    const ttl = parsePositiveInt(process.env.PRICE_CACHE_TTL_MS, DEFAULT_PRICE_CACHE_TTL_MS);
    if (Date.now() - new Date(record.storedAt).getTime() > ttl) return null;

    return record;
  } catch {
    return null;
  }
};

export const putPriceTweakerCache = async (record: PriceTweakerCacheRecord): Promise<void> => {
  if (!hasBlobToken()) return;

  const key = priceCacheKey(record.technologySlug, record.machineId, record.materialId);
  try {
    await put(key, JSON.stringify(record), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      token: getBlobToken(),
    });
  } catch {
    /* cache write failure is non-fatal */
  }
};

/* ------------------------------------------------------------------ */

const wait = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
};

const deriveFileName = (derivativeUrn: string, quoteTarget: QuoteTarget) => {
  const cleanUrn = derivativeUrn.split("?")[0] || "";
  const fallback = `quote.${quoteTarget}`;

  const tail = cleanUrn.split("/").filter(Boolean).pop();
  if (!tail) {
    return fallback;
  }

  const extension = extname(tail).toLowerCase();
  if (extension === `.${quoteTarget}` || (quoteTarget === "step" && extension === ".stp")) {
    return tail;
  }

  const normalizedBase = tail.replace(/\.[^.]+$/, "");
  return `${normalizedBase}.${quoteTarget}`;
};

const quoteContentType = (quoteTarget: QuoteTarget) => {
  if (quoteTarget === "dwg") {
    return "image/vnd.dwg";
  }

  return "application/step";
};

const deriveFileNameFromSource = (sourceUrl: string) => {
  try {
    const parsed = new URL(sourceUrl);
    const tail = parsed.pathname.split("/").filter(Boolean).pop();
    if (!tail) {
      return "source-file";
    }

    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  } catch {
    return "source-file";
  }
};

const normalizeUploadFileName = (fileName: string) => {
  const normalized = pathPosix.basename(fileName.trim().replace(/\\/g, "/"));
  return normalized || "source-file";
};

const parseJsonResponse = async (response: Response) => {
  const text = await response.text();
  if (!text.trim()) {
    return {} as DigifabsterUploadResponse;
  }

  try {
    return JSON.parse(text) as DigifabsterUploadResponse;
  } catch {
    return {
      error: text.slice(0, 2_000),
    };
  }
};

const buildUploadModelsEndpoint = (endpoint: string) => {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.origin}/v2/upload_models/`;
  } catch {
    return `${resolveDigifabsterBaseUrl()}/v2/upload_models/`;
  }
};

const buildUploadModelsJobUrl = (endpoint: string) => {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.origin}/v2/upload_job/`;
  } catch {
    return `${resolveDigifabsterBaseUrl()}/v2/upload_job/`;
  }
};

const normalizeUploadResponse = (dataInput: unknown): DigifabsterUploadResponse => {
  if (Array.isArray(dataInput)) {
    const first = dataInput[0];
    if (first && typeof first === "object") {
      return normalizeUploadResponse(first);
    }
    return {};
  }

  const data = (dataInput && typeof dataInput === "object" ? dataInput : {}) as DigifabsterUploadResponse;

  if (Number.isFinite(Number(data.object_model_id))) {
    return data;
  }

  const firstObjectModel = Array.isArray(data.object_models) ? data.object_models[0] : undefined;
  if (firstObjectModel && Number.isFinite(Number(firstObjectModel.id))) {
    return {
      ...data,
      object_model_id: Number(firstObjectModel.id),
      status: typeof data.status === "string" ? data.status : firstObjectModel.status,
      success: data.success ?? true,
    };
  }

  return data;
};

const fetchModelBlobFromUrl = async (fileUrl: string) => {
  const sourceResponse = await fetch(fileUrl);
  if (!sourceResponse.ok) {
    throw new DigifabsterSyncError({
      message: "Failed to download model source file for DigiFabster upload.",
      status: sourceResponse.status || 502,
      code: "digifabster_source_download_failed",
      details: `Source URL returned HTTP ${sourceResponse.status}.`,
      retryable: sourceResponse.status >= 500,
    });
  }

  const buffer = await sourceResponse.arrayBuffer();
  const type = sourceResponse.headers.get("content-type") || "application/octet-stream";
  return new Blob([buffer], { type });
};

const createUploadJob = async (
  endpoint: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<string> => {
  const jobUrl = buildUploadModelsJobUrl(endpoint);
  const response = await fetch(jobUrl, {
    method: "POST",
    headers,
    signal,
  });
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new DigifabsterSyncError({
      message: "Failed to create DigiFabster upload job.",
      status: response.status || 502,
      code: data.code || "digifabster_upload_job_failed",
      details: data.details || data.detail || data.error || null,
      retryable: response.status >= 500,
    });
  }

  const uploadJobRaw = (data as { id?: unknown; uj?: unknown; upload_job_id?: unknown }).id
    ?? (data as { id?: unknown; uj?: unknown; upload_job_id?: unknown }).uj
    ?? (data as { id?: unknown; uj?: unknown; upload_job_id?: unknown }).upload_job_id;
  const uploadJobId =
    typeof uploadJobRaw === "string"
      ? uploadJobRaw.trim()
      : Number.isFinite(Number(uploadJobRaw))
        ? String(uploadJobRaw)
        : "";

  if (!uploadJobId) {
    throw new DigifabsterSyncError({
      message: "DigiFabster upload job response missing id.",
      status: 502,
      code: "digifabster_upload_job_missing_id",
      details: null,
      retryable: false,
    });
  }

  return uploadJobId;
};

const traceTimeline = new Map<string, string[]>();

const logStep = (traceId: string | undefined, step: string, details: Record<string, unknown> = {}) => {
  const key = traceId || "n/a";
  const timeline = traceTimeline.get(key) || [];
  timeline.push(step);
  traceTimeline.set(key, timeline);

  const shouldEmit =
    step === "sync.completed" ||
    step === "sync.failed";

  if (!shouldEmit) {
    return;
  }

  console.log("[digifabster-sync]", {
    traceId: key,
    step,
    timeline,
    ...details,
  });
  traceTimeline.delete(key);
};

const getSyncRecord = async (
  urn: string,
  quoteTarget: SyncChannel,
  partId: string,
  version: string
): Promise<DigifabsterUploadRecord | null> => {
  if (!hasBlobToken()) {
    return null;
  }

  try {
    const token = getBlobToken();
    const pathname = syncRecordPath(urn, quoteTarget, partId, version);
    const result = await list({
      token,
      prefix: pathname,
      limit: 5,
    });

    const blob = result.blobs.find((item) => item.pathname === pathname);
    if (!blob) {
      return null;
    }

    const response = await fetch(blob.url, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as DigifabsterUploadRecord;
  } catch {
    return null;
  }
};

const saveSyncRecord = async (record: DigifabsterUploadRecord) => {
  if (!hasBlobToken()) {
    return;
  }

  try {
    const token = getBlobToken();
    await put(syncRecordPath(record.urn, record.quoteTarget, record.partId, record.version), JSON.stringify(record), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      token,
    });
  } catch {
    // Cache write failure should not block the live quote pipeline.
  }
};

class DigifabsterSyncError extends Error {
  status: number;
  code: string;
  details: string | null;
  retryable: boolean;

  constructor(params: { message: string; status?: number; code?: string; details?: string | null; retryable?: boolean }) {
    super(params.message);
    this.name = "DigifabsterSyncError";
    this.status = params.status ?? 502;
    this.code = params.code ?? "digifabster_upload_failed";
    this.details = params.details ?? null;
    this.retryable = params.retryable ?? false;
  }
}

const callDigifabsterUpload = async (
  fileUrl: string,
  fileName: string,
  partId: string,
  version: string,
  traceId?: string
): Promise<DigifabsterUploadResponse> => {
  const configuredEndpoint = resolveDigifabsterUploadEndpoint();
  if (!configuredEndpoint) {
    throw new DigifabsterSyncError({
      message: "Missing DIGIFABSTER_UPLOAD_ENDPOINT configuration.",
      status: 500,
      code: "digifabster_upload_endpoint_missing",
      details: "Set DIGIFABSTER_UPLOAD_ENDPOINT to the official DigiFabster upload endpoint.",
      retryable: false,
    });
  }

  // DigiFabster contract: create upload job first, then POST binary model(s) to upload_models.
  const endpoint = buildUploadModelsEndpoint(configuredEndpoint);

  const timeoutMs = parsePositiveInt(process.env.DIGIFABSTER_UPLOAD_TIMEOUT_MS, DEFAULT_UPLOAD_TIMEOUT_MS);

  logStep(traceId, "digifabster.upload.start", {
    endpoint,
    timeoutMs,
    maxRetries: MAX_UPLOAD_RETRIES,
    fileName,
    partId,
    version,
  });

  for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    const attemptNumber = attempt + 1;
    logStep(traceId, "digifabster.upload.attempt.start", {
      attempt: attemptNumber,
      totalAttempts: MAX_UPLOAD_RETRIES + 1,
      endpoint,
    });

    try {
      let usedAuthMode: "s2s" | "direct" = "s2s";
      const s2sHeaders = await buildDigifabsterHeaders();
      delete s2sHeaders["Content-Type"];
      const modelBlob = await fetchModelBlobFromUrl(fileUrl);

      const buildRequestBody = async (headers: Record<string, string>) => {
        const uploadJobId = await createUploadJob(endpoint, headers, controller.signal);
        const form = new FormData();
        form.set("upload_job_id", uploadJobId);
        if (modelBlob) {
          form.append("models", modelBlob, fileName);
        }
        return form;
      };

      let response = await fetch(endpoint, {
        method: "POST",
        headers: s2sHeaders,
        body: await buildRequestBody(s2sHeaders),
        signal: controller.signal,
      });

      let data = normalizeUploadResponse(await parseJsonResponse(response));

      if (
        (response.status === 401 || response.status === 403) &&
        resolveDigifabsterDirectToken() &&
        !process.env.DIGIFABSTER_DISABLE_DIRECT_TOKEN_FALLBACK
      ) {
        usedAuthMode = "direct";
        logStep(traceId, "digifabster.upload.auth_fallback", {
          attempt: attemptNumber,
          from: "s2s",
          to: "direct",
          status: response.status,
        });

        const directHeaders = buildDigifabsterDirectHeaders();
        delete directHeaders["Content-Type"];

        response = await fetch(endpoint, {
          method: "POST",
          headers: directHeaders,
          body: await buildRequestBody(directHeaders),
          signal: controller.signal,
        });
        data = normalizeUploadResponse(await parseJsonResponse(response));
      }

      logStep(traceId, "digifabster.upload.attempt.response", {
        attempt: attemptNumber,
        status: response.status,
        ok: response.ok,
        success: data.success !== false,
        code: data.code || null,
        authMode: usedAuthMode,
      });

      if (!response.ok || data.success === false) {
        const status = response.status || 502;
        const retryable = status >= 500 && attempt < MAX_UPLOAD_RETRIES;
        const detailPayload =
          data.details
          || data.detail
          || data.error
          || (Object.keys(data || {}).length > 0 ? JSON.stringify(data).slice(0, 2_000) : null);
        const error = new DigifabsterSyncError({
          message: "Digifabster upload endpoint returned an error.",
          status,
          code: data.code || "digifabster_upload_failed",
          details: detailPayload,
          retryable,
        });

        if (retryable) {
          logStep(traceId, "digifabster.upload.attempt.retry", {
            attempt: attemptNumber,
            reason: error.code,
            status,
          });
          await wait(1_000 * (2 ** attempt));
          continue;
        }

        logStep(traceId, "digifabster.upload.failed", {
          attempt: attemptNumber,
          reason: error.code,
          status,
          details: error.details,
        });
        throw error;
      }

      logStep(traceId, "digifabster.upload.success", {
        attempt: attemptNumber,
        objectModelId: data.object_model_id ?? null,
        orderId: data.order_id ?? null,
        sessionId: data.session_id ?? null,
      });

      return data;
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const retryable = attempt < MAX_UPLOAD_RETRIES;

      if (aborted) {
        const timeoutError = new DigifabsterSyncError({
          message: `Digifabster upload timed out after ${timeoutMs}ms.`,
          status: 504,
          code: "digifabster_upload_timeout",
          details: null,
          retryable,
        });

        if (retryable) {
          logStep(traceId, "digifabster.upload.attempt.retry", {
            attempt: attemptNumber,
            reason: timeoutError.code,
            status: timeoutError.status,
          });
          await wait(1_000 * (2 ** attempt));
          continue;
        }

        logStep(traceId, "digifabster.upload.failed", {
          attempt: attemptNumber,
          reason: timeoutError.code,
          status: timeoutError.status,
        });
        throw timeoutError;
      }

      if (error instanceof DigifabsterSyncError) {
        logStep(traceId, "digifabster.upload.failed", {
          attempt: attemptNumber,
          reason: error.code,
          status: error.status,
          details: error.details,
        });
        throw error;
      }

      if (!retryable) {
        logStep(traceId, "digifabster.upload.failed", {
          attempt: attemptNumber,
          reason: "digifabster_upload_network_error",
          details: error instanceof Error ? error.message : null,
        });
        throw new DigifabsterSyncError({
          message: "Failed to call Digifabster upload endpoint.",
          status: 502,
          code: "digifabster_upload_network_error",
          details: error instanceof Error ? error.message : null,
        });
      }

      logStep(traceId, "digifabster.upload.attempt.retry", {
        attempt: attemptNumber,
        reason: "digifabster_upload_network_error",
        details: error instanceof Error ? error.message : null,
      });
      await wait(1_000 * (2 ** attempt));
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw new DigifabsterSyncError({
    message: "Failed to call Digifabster upload endpoint.",
    status: 502,
    code: "digifabster_upload_failed",
    details: null,
  });
};

export const syncQuoteDerivativeToDigifabster = async (
  params: SyncParams
): Promise<QuoteUploadSyncResult> => {
  logStep(params.traceId, "sync.start", {
    urn: params.urn,
    quoteTarget: params.quoteTarget,
    hasPartId: typeof params.partId === "string" && params.partId.trim().length > 0,
    hasVersion: typeof params.version === "string" && params.version.trim().length > 0,
  });

  const partId = typeof params.partId === "string" ? params.partId.trim() : "";
  const version = typeof params.version === "string" ? params.version.trim() : "";

  if (!partId || !version) {
    logStep(params.traceId, "sync.skipped", { reason: "missing_part_or_version" });
    return {
      status: "skipped",
      objectModelId: null,
      orderId: null,
      sessionId: null,
      quoteStatus: null,
      source: "none",
      reason: "missing_part_or_version",
    };
  }

  try {

    logStep(params.traceId, "sync.cache.lookup.start", {
      urn: params.urn,
      quoteTarget: params.quoteTarget,
    });
    const cached = await getSyncRecord(params.urn, params.quoteTarget, partId, version);
    if (cached) {
      logStep(params.traceId, "sync.cache.lookup.hit", {
        objectModelId: cached.objectModelId,
        orderId: cached.orderId,
        sessionId: cached.sessionId,
      });
      return {
        status: "cached",
        objectModelId: cached.objectModelId,
        orderId: cached.orderId,
        sessionId: cached.sessionId,
        quoteStatus: cached.status,
        source: "cache",
        fileUrl: cached.fileUrl,
        fileName: cached.fileName,
      };
    }
    logStep(params.traceId, "sync.cache.lookup.miss");

    if (!hasBlobToken()) {
      throw new DigifabsterSyncError({
        message: "BLOB_READ_WRITE_TOKEN is required for quote derivative upload.",
        status: 500,
        code: "blob_unavailable",
        details: "Configure BLOB_READ_WRITE_TOKEN to enable quote derivative syncing.",
      });
    }

    logStep(params.traceId, "sync.manifest.fetch.start", { urn: params.urn });
    const manifest = await getManifest(params.urn, params.accessToken);
    logStep(params.traceId, "sync.manifest.fetch.success", {
      status: typeof manifest?.status === "string" ? manifest.status : "unknown",
      progress: typeof manifest?.progress === "string" ? manifest.progress : "unknown",
    });
    const derivative = findDerivativeByType(manifest, params.quoteTarget);

    if (!derivative) {
      throw new DigifabsterSyncError({
        message: `Quote derivative ${params.quoteTarget.toUpperCase()} is missing from manifest.`,
        status: 502,
        code: "quote_derivative_missing",
        details: "The quote target derivative was not found in Autodesk manifest.",
      });
    }

    logStep(params.traceId, "sync.derivative.resolved", {
      quoteTarget: params.quoteTarget,
      derivativeUrn: derivative.derivativeUrn,
      derivativeStatus: derivative.status,
      derivativeProgress: derivative.progress,
    });

    logStep(params.traceId, "sync.derivative.signed_url.start", {
      quoteTarget: params.quoteTarget,
    });

    let derivativeBytes: Uint8Array;
    try {
      const signed = await getDerivativeDownloadUrl(params.urn, derivative.derivativeUrn, params.accessToken);
      logStep(params.traceId, "sync.derivative.signed_url.success", {
        hasCookies: Object.keys(signed.cookies || {}).length > 0,
        size: signed.size,
      });

      if (signed.size === 0) {
        throw new DigifabsterSyncError({
          message: `Derivative conversion produced an empty file (0 bytes). The source format may not support ${params.quoteTarget.toUpperCase()} export.`,
          status: 422,
          code: "derivative_empty",
          details: `Autodesk reports the ${params.quoteTarget.toUpperCase()} derivative as complete, but the file is 0 bytes. This typically means the source format cannot be meaningfully converted to ${params.quoteTarget.toUpperCase()}.`,
        });
      }

      logStep(params.traceId, "sync.derivative.download.start");
      derivativeBytes = await downloadDerivativeFile(signed.url, signed.cookies);
      logStep(params.traceId, "sync.derivative.download.success", {
        bytes: derivativeBytes.length,
      });
    } catch (dlError: unknown) {
      const status = (dlError as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === 409) {
        throw new DigifabsterSyncError({
          message: `Derivative file not yet available for download (HTTP ${status}).`,
          status: 202,
          code: "derivative_download_pending",
          details: "The derivative appears in the manifest as complete, but the file is not yet available. Retry on next poll.",
          retryable: true,
        });
      }
      throw dlError;
    }

    const token = getBlobToken();
    const fileName = deriveFileName(derivative.derivativeUrn, params.quoteTarget);
    const normalizedFileName = pathPosix.basename(fileName);

    logStep(params.traceId, "sync.derivative.upload_blob.start", {
      pathname: derivativeBlobPath(params.urn, params.quoteTarget, normalizedFileName),
      fileName: normalizedFileName,
    });
    const uploaded = await put(derivativeBlobPath(params.urn, params.quoteTarget, normalizedFileName), Buffer.from(derivativeBytes), {
      access: "public",
      addRandomSuffix: false,
      contentType: quoteContentType(params.quoteTarget),
      token,
    });

    logStep(params.traceId, "sync.derivative.upload_blob.success", {
      fileUrl: uploaded.url,
      fileName: normalizedFileName,
    });

    const uploadResponse = await callDigifabsterUpload(uploaded.url, normalizedFileName, partId, version, params.traceId);

    const record: DigifabsterUploadRecord = {
      urn: params.urn,
      quoteTarget: params.quoteTarget,
      partId,
      version,
      fileUrl: uploaded.url,
      fileName: normalizedFileName,
      objectModelId: Number.isFinite(Number(uploadResponse.object_model_id))
        ? Number(uploadResponse.object_model_id)
        : null,
      orderId: Number.isFinite(Number(uploadResponse.order_id)) ? Number(uploadResponse.order_id) : null,
      sessionId: typeof uploadResponse.session_id === "string" ? uploadResponse.session_id : null,
      status: typeof uploadResponse.status === "string" ? uploadResponse.status : null,
      syncedAt: new Date().toISOString(),
    };

    await saveSyncRecord(record);

    logStep(params.traceId, "sync.completed", {
      status: "submitted",
      objectModelId: record.objectModelId,
      orderId: record.orderId,
      sessionId: record.sessionId,
      quoteStatus: record.status,
    });

    return {
      status: "submitted",
      objectModelId: record.objectModelId,
      orderId: record.orderId,
      sessionId: record.sessionId,
      quoteStatus: record.status,
      source: "digifabster",
      fileUrl: record.fileUrl,
      fileName: record.fileName,
    };
  } catch (error) {
    logStep(params.traceId, "sync.failed", {
      message: error instanceof Error ? error.message : "Unknown sync error",
      code: error instanceof DigifabsterSyncError ? error.code : "unknown",
      status: error instanceof DigifabsterSyncError ? error.status : 500,
      details: error instanceof DigifabsterSyncError ? error.details : null,
    });
    throw error;
  }
};

export const syncNativeSourceToDigifabster = async (
  params: NativeSyncParams,
): Promise<QuoteUploadSyncResult> => {
  logStep(params.traceId, "sync.start", {
    urn: params.urn,
    quoteTarget: "native",
    hasPartId: typeof params.partId === "string" && params.partId.trim().length > 0,
    hasVersion: typeof params.version === "string" && params.version.trim().length > 0,
    hasSourceUrl: typeof params.sourceUrl === "string" && params.sourceUrl.trim().length > 0,
  });

  const partId = typeof params.partId === "string" ? params.partId.trim() : "";
  const version = typeof params.version === "string" ? params.version.trim() : "";
  const sourceUrl = typeof params.sourceUrl === "string" ? params.sourceUrl.trim() : "";

  if (!partId || !version) {
    logStep(params.traceId, "sync.skipped", { reason: "missing_part_or_version" });
    return {
      status: "skipped",
      objectModelId: null,
      orderId: null,
      sessionId: null,
      quoteStatus: null,
      source: "none",
      reason: "missing_part_or_version",
    };
  }

  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    throw new DigifabsterSyncError({
      message: "Native source URL is missing or invalid.",
      status: 400,
      code: "native_source_url_invalid",
      details: "Provide sourceUrl/source_url when quote conversion is not required.",
      retryable: false,
    });
  }

  const fileName = normalizeUploadFileName(
    typeof params.sourceFileName === "string" && params.sourceFileName.trim()
      ? params.sourceFileName
      : deriveFileNameFromSource(sourceUrl),
  );

  try {
    logStep(params.traceId, "sync.cache.lookup.start", {
      urn: params.urn,
      quoteTarget: "native",
    });

    const cached = await getSyncRecord(params.urn, "native", partId, version);
    if (cached) {
      logStep(params.traceId, "sync.cache.lookup.hit", {
        objectModelId: cached.objectModelId,
        orderId: cached.orderId,
        sessionId: cached.sessionId,
      });

      return {
        status: "cached",
        objectModelId: cached.objectModelId,
        orderId: cached.orderId,
        sessionId: cached.sessionId,
        quoteStatus: cached.status,
        source: "cache",
        fileUrl: cached.fileUrl,
        fileName: cached.fileName,
      };
    }

    logStep(params.traceId, "sync.cache.lookup.miss", { quoteTarget: "native" });

    const uploadResponse = await callDigifabsterUpload(sourceUrl, fileName, partId, version, params.traceId);

    const record: DigifabsterUploadRecord = {
      urn: params.urn,
      quoteTarget: "native",
      partId,
      version,
      fileUrl: sourceUrl,
      fileName,
      objectModelId: Number.isFinite(Number(uploadResponse.object_model_id))
        ? Number(uploadResponse.object_model_id)
        : null,
      orderId: Number.isFinite(Number(uploadResponse.order_id)) ? Number(uploadResponse.order_id) : null,
      sessionId: typeof uploadResponse.session_id === "string" ? uploadResponse.session_id : null,
      status: typeof uploadResponse.status === "string" ? uploadResponse.status : null,
      syncedAt: new Date().toISOString(),
    };

    await saveSyncRecord(record);

    logStep(params.traceId, "sync.completed", {
      status: "submitted",
      quoteTarget: "native",
      objectModelId: record.objectModelId,
      orderId: record.orderId,
      sessionId: record.sessionId,
      quoteStatus: record.status,
    });

    return {
      status: "submitted",
      objectModelId: record.objectModelId,
      orderId: record.orderId,
      sessionId: record.sessionId,
      quoteStatus: record.status,
      source: "digifabster",
      fileUrl: record.fileUrl,
      fileName: record.fileName,
    };
  } catch (error) {
    logStep(params.traceId, "sync.failed", {
      message: error instanceof Error ? error.message : "Unknown sync error",
      code: error instanceof DigifabsterSyncError ? error.code : "unknown",
      status: error instanceof DigifabsterSyncError ? error.status : 500,
      details: error instanceof DigifabsterSyncError ? error.details : null,
    });
    throw error;
  }
};

export { DigifabsterSyncError };
