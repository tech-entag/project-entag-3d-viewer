import { extname, posix as pathPosix } from "node:path";

import { getObjectText, hasStorage, putObject } from "../embed_helpers/blob-storage";

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
  uploadJobId: string | null;
  objectModelId: number | null;
  orderId: number | null;
  sessionId: string | null;
  status: string | null;
  syncedAt: string;
}

export interface QuoteUploadSyncResult {
  status: SyncStatus;
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
  if (!hasStorage()) return null;

  const key = priceCacheKey(techSlug, machineId, materialId);
  try {
    const text = await getObjectText(key);
    if (text === null) return null;
    const record = JSON.parse(text) as PriceTweakerCacheRecord;

    const ttl = parsePositiveInt(process.env.PRICE_CACHE_TTL_MS, DEFAULT_PRICE_CACHE_TTL_MS);
    if (Date.now() - new Date(record.storedAt).getTime() > ttl) return null;

    return record;
  } catch {
    return null;
  }
};

export const putPriceTweakerCache = async (record: PriceTweakerCacheRecord): Promise<void> => {
  if (!hasStorage()) return;

  const key = priceCacheKey(record.technologySlug, record.machineId, record.materialId);
  try {
    await putObject(key, JSON.stringify(record), "application/json");
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
  if (!hasStorage()) {
    return null;
  }

  try {
    const pathname = syncRecordPath(urn, quoteTarget, partId, version);
    const text = await getObjectText(pathname);
    if (text === null) {
      return null;
    }

    return JSON.parse(text) as DigifabsterUploadRecord;
  } catch {
    return null;
  }
};

const saveSyncRecord = async (record: DigifabsterUploadRecord) => {
  if (!hasStorage()) {
    return;
  }

  try {
    await putObject(
      syncRecordPath(record.urn, record.quoteTarget, record.partId, record.version),
      JSON.stringify(record),
      "application/json",
    );
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
): Promise<{ uploadResponse: DigifabsterUploadResponse; uploadJobId: string | null }> => {
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
      let capturedUploadJobId: string | null = null;
      const s2sHeaders = await buildDigifabsterHeaders();
      delete s2sHeaders["Content-Type"];
      const modelBlob = await fetchModelBlobFromUrl(fileUrl);

      const buildRequestBody = async (headers: Record<string, string>) => {
        const uploadJobId = await createUploadJob(endpoint, headers, controller.signal);
        capturedUploadJobId = uploadJobId;
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
        uploadJobId: capturedUploadJobId,
        objectModelId: data.object_model_id ?? null,
        orderId: data.order_id ?? null,
        sessionId: data.session_id ?? null,
      });

      return { uploadResponse: data, uploadJobId: capturedUploadJobId };
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
      uploadJobId: null,
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
        uploadJobId: cached.uploadJobId,
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

    if (!hasStorage()) {
      throw new DigifabsterSyncError({
        message: "Object storage (R2) is required for quote derivative upload.",
        status: 500,
        code: "storage_unavailable",
        details: "Bind an R2 bucket (and set R2_PUBLIC_BASE_URL) to enable quote derivative syncing.",
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

    const fileName = deriveFileName(derivative.derivativeUrn, params.quoteTarget);
    const normalizedFileName = pathPosix.basename(fileName);

    logStep(params.traceId, "sync.derivative.upload_blob.start", {
      pathname: derivativeBlobPath(params.urn, params.quoteTarget, normalizedFileName),
      fileName: normalizedFileName,
    });
    const uploaded = await putObject(
      derivativeBlobPath(params.urn, params.quoteTarget, normalizedFileName),
      Buffer.from(derivativeBytes),
      quoteContentType(params.quoteTarget),
    );

    logStep(params.traceId, "sync.derivative.upload_blob.success", {
      fileUrl: uploaded.url,
      fileName: normalizedFileName,
    });

    const { uploadResponse, uploadJobId } = await callDigifabsterUpload(uploaded.url, normalizedFileName, partId, version, params.traceId);

    const record: DigifabsterUploadRecord = {
      urn: params.urn,
      quoteTarget: params.quoteTarget,
      partId,
      version,
      fileUrl: uploaded.url,
      fileName: normalizedFileName,
      uploadJobId,
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
      uploadJobId: record.uploadJobId,
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
      uploadJobId: null,
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
        uploadJobId: cached.uploadJobId,
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

    const { uploadResponse, uploadJobId } = await callDigifabsterUpload(sourceUrl, fileName, partId, version, params.traceId);

    const record: DigifabsterUploadRecord = {
      urn: params.urn,
      quoteTarget: "native",
      partId,
      version,
      fileUrl: sourceUrl,
      fileName,
      uploadJobId,
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
      uploadJobId: record.uploadJobId,
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

/* ------------------------------------------------------------------ */
/*  Order creation + model thumbnail                                  */
/* ------------------------------------------------------------------ */

export type DigifabsterOrderStatus =
  | "created"
  | "waiting_for_review"
  | "placed"
  | "firm_offer_sent"
  | "initial";

export interface DigifabsterOrderCustomer {
  name: string;
  surname: string;
  phone: string;
  email: string;
  status?: DigifabsterOrderStatus;
  notes?: string;
  billing_name?: string;
  billing_surname?: string;
  billing_phone?: string;
  billing_email?: string;
  custom_fields?: Record<string, unknown>;
  delivery_address?: Record<string, unknown>;
  customer_company_address?: Record<string, unknown>;
  disable_notification?: boolean;
}

export interface CreateDigifabsterOrderResult {
  orderId: number;
  data: Record<string, unknown>;
}

export interface SubmitDigifabsterOrderResult {
  orderId: number;
  payUrl: string | null;
  orderUrl: string | null;
  invoiceId: string | null;
  invoiceHash: string | null;
  data: Record<string, unknown>;
}

export interface DigifabsterModelThumbnail {
  modelId: number;
  thumb: string | null;
  thumb120x120: string | null;
  thumb300x300: string | null;
  thumbStatus: string | null;
  /** Bounding-box dimensions from the model `size` object (nullable). */
  sizeX: number | null;
  sizeY: number | null;
  sizeZ: number | null;
  /** Measurement unit for the dimensions/volume: "mm" | "cm" | "in". */
  units: string | null;
  volume: number | null;
  surface: number | null;
}

const asResponseRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const optionalNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * POST /v2/orders/ — create an initial (draft) order, optionally linked to an
 * upload job. Returns the new order id plus the raw initial-order payload.
 */
export const createDigifabsterOrder = async (params: {
  uploadJob?: string | null;
  locale?: string | null;
  inhouseOwner?: number | null;
  payload?: unknown;
  traceId?: string;
}): Promise<CreateDigifabsterOrderResult> => {
  const headers = await buildDigifabsterHeaders();
  const base = resolveDigifabsterBaseUrl();

  const body: Record<string, unknown> = {};
  if (params.uploadJob && params.uploadJob.trim()) body.upload_job = params.uploadJob.trim();
  if (params.locale && params.locale.trim()) body.locale = params.locale.trim();
  if (typeof params.inhouseOwner === "number" && Number.isFinite(params.inhouseOwner)) {
    body.inhouse_owner = params.inhouseOwner;
  }
  if (params.payload !== undefined) body.payload = params.payload;

  logStep(params.traceId, "order.create.start", { hasUploadJob: Boolean(body.upload_job) });

  const response = await fetch(`${base}/v2/orders/`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = asResponseRecord(await parseJsonResponse(response));

  if (!response.ok) {
    logStep(params.traceId, "order.create.failed", { status: response.status });
    throw new DigifabsterSyncError({
      message: "DigiFabster order creation failed.",
      status: response.status || 502,
      code: "digifabster_order_create_failed",
      details:
        (typeof data.detail === "string" && data.detail) ||
        (Object.keys(data).length > 0 ? JSON.stringify(data).slice(0, 2_000) : null),
      retryable: response.status >= 500,
    });
  }

  const orderId = Number(data.id);
  if (!Number.isFinite(orderId)) {
    throw new DigifabsterSyncError({
      message: "DigiFabster order creation response missing id.",
      status: 502,
      code: "digifabster_order_create_missing_id",
      details: null,
      retryable: false,
    });
  }

  logStep(params.traceId, "order.create.success", { orderId });
  return { orderId, data };
};

/**
 * POST /v2/orders/{id}/submit_initial_order/ — finalize a draft order with the
 * required customer details. Returns pay/order URLs and invoice identifiers.
 */
export const submitDigifabsterInitialOrder = async (params: {
  orderId: number;
  customer: DigifabsterOrderCustomer;
  traceId?: string;
}): Promise<SubmitDigifabsterOrderResult> => {
  const { orderId, customer } = params;

  for (const field of ["name", "surname", "phone", "email"] as const) {
    if (!customer[field] || !String(customer[field]).trim()) {
      throw new DigifabsterSyncError({
        message: `Missing required customer field "${field}" for order submission.`,
        status: 400,
        code: "digifabster_order_customer_field_missing",
        details: `submit_initial_order requires name, surname, phone, and email.`,
        retryable: false,
      });
    }
  }

  const headers = await buildDigifabsterHeaders();
  const base = resolveDigifabsterBaseUrl();

  const body: Record<string, unknown> = {
    name: customer.name,
    surname: customer.surname,
    phone: customer.phone,
    email: customer.email,
    status: customer.status || "created",
  };
  if (customer.notes) body.notes = customer.notes;
  if (customer.billing_name) body.billing_name = customer.billing_name;
  if (customer.billing_surname) body.billing_surname = customer.billing_surname;
  if (customer.billing_phone) body.billing_phone = customer.billing_phone;
  if (customer.billing_email) body.billing_email = customer.billing_email;
  if (customer.custom_fields) body.custom_fields = customer.custom_fields;
  if (customer.delivery_address) body.delivery_address = customer.delivery_address;
  if (customer.customer_company_address) body.customer_company_address = customer.customer_company_address;
  if (typeof customer.disable_notification === "boolean") body.disable_notification = customer.disable_notification;

  logStep(params.traceId, "order.submit.start", { orderId, status: body.status });

  const response = await fetch(`${base}/v2/orders/${encodeURIComponent(String(orderId))}/submit_initial_order/`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = asResponseRecord(await parseJsonResponse(response));

  if (!response.ok) {
    logStep(params.traceId, "order.submit.failed", { orderId, status: response.status });
    throw new DigifabsterSyncError({
      message: "DigiFabster order submission failed.",
      status: response.status || 502,
      code: "digifabster_order_submit_failed",
      details:
        (typeof data.detail === "string" && data.detail) ||
        (Object.keys(data).length > 0 ? JSON.stringify(data).slice(0, 2_000) : null),
      retryable: response.status >= 500,
    });
  }

  logStep(params.traceId, "order.submit.success", { orderId });
  return {
    orderId: Number.isFinite(Number(data.id)) ? Number(data.id) : orderId,
    payUrl: optionalString(data.pay_url),
    orderUrl: optionalString(data.order_url),
    invoiceId: optionalString(data.invoice_id),
    invoiceHash: optionalString(data.invoice_hash),
    data,
  };
};

/* ------------------------------------------------------------------ */
/*  Place-order flow: ADM order -> purchases -> submit -> confirm     */
/*  (Entag purchasing from DigiFabster — distinct from batch_price.)  */
/* ------------------------------------------------------------------ */

const parseDecimal = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

export interface CreateDigifabsterAdmOrderResult {
  orderId: number;
  data: Record<string, unknown>;
}

/**
 * POST /v2/orders/users/{userId}/adm/ — create an empty (cart) order bound to a
 * DigiFabster client/user. This is the IQT "create order" step; line items are
 * added afterwards via createDigifabsterPurchase.
 */
export const createDigifabsterAdmOrder = async (params: {
  userId: number;
  locale?: string | null;
  uploadJob?: string | null;
  inhouseOwner?: number | null;
  payload?: unknown;
  traceId?: string;
}): Promise<CreateDigifabsterAdmOrderResult> => {
  const headers = await buildDigifabsterHeaders();
  const base = resolveDigifabsterBaseUrl();

  const body: Record<string, unknown> = {};
  if (params.locale && params.locale.trim()) body.locale = params.locale.trim();
  if (params.uploadJob && params.uploadJob.trim()) body.upload_job = params.uploadJob.trim();
  if (typeof params.inhouseOwner === "number" && Number.isFinite(params.inhouseOwner)) {
    body.inhouse_owner = params.inhouseOwner;
  }
  if (params.payload !== undefined) body.payload = params.payload;

  logStep(params.traceId, "adm_order.create.start", { userId: params.userId });

  const response = await fetch(
    `${base}/v2/orders/users/${encodeURIComponent(String(params.userId))}/adm/`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const data = asResponseRecord(await parseJsonResponse(response));

  if (!response.ok) {
    logStep(params.traceId, "adm_order.create.failed", { userId: params.userId, status: response.status });
    throw new DigifabsterSyncError({
      message: "DigiFabster ADM order creation failed.",
      status: response.status || 502,
      code: "digifabster_adm_order_create_failed",
      details:
        (typeof data.detail === "string" && data.detail) ||
        (Object.keys(data).length > 0 ? JSON.stringify(data).slice(0, 2_000) : null),
      retryable: response.status >= 500,
    });
  }

  const orderId = Number(data.id);
  if (!Number.isFinite(orderId)) {
    throw new DigifabsterSyncError({
      message: "DigiFabster ADM order response missing id.",
      status: 502,
      code: "digifabster_adm_order_missing_id",
      details: null,
      retryable: false,
    });
  }

  logStep(params.traceId, "adm_order.create.success", { userId: params.userId, orderId });
  return { orderId, data };
};

export interface DigifabsterPurchaseResult {
  purchaseId: number | null;
  totalPrice: number | null;
  pricePerPart: number | null;
  materialTitle: string | null;
  orderTotalPrice: number | null;
  data: Record<string, unknown>;
}

/**
 * POST /v2/orders/{orderId}/purchases/ — add a priced line item to an order.
 * The `config` object is sent as-is (tolerance/thickness/lead_time as single
 * UUID strings, plus extra_fieldsets/post_production), matching the live widget
 * body. Returns the authoritative committed price for the line.
 */
export const createDigifabsterPurchase = async (params: {
  orderId: number;
  modelId: number;
  materialId: number;
  config: Record<string, unknown>;
  count: number;
  fromShortIqt?: boolean;
  traceId?: string;
}): Promise<DigifabsterPurchaseResult> => {
  const headers = await buildDigifabsterHeaders();
  const base = resolveDigifabsterBaseUrl();

  const body: Record<string, unknown> = {
    config: params.config,
    material_id: params.materialId,
    model_id: params.modelId,
    count: params.count,
    from_short_iqt: params.fromShortIqt ?? false,
  };

  logStep(params.traceId, "purchase.create.start", {
    orderId: params.orderId,
    modelId: params.modelId,
    materialId: params.materialId,
    count: params.count,
  });

  const response = await fetch(
    `${base}/v2/orders/${encodeURIComponent(String(params.orderId))}/purchases/`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const data = asResponseRecord(await parseJsonResponse(response));

  if (!response.ok) {
    logStep(params.traceId, "purchase.create.failed", { orderId: params.orderId, status: response.status });
    throw new DigifabsterSyncError({
      message: "DigiFabster purchase creation failed.",
      status: response.status || 502,
      code: "digifabster_purchase_create_failed",
      details:
        (typeof data.detail === "string" && data.detail) ||
        (Object.keys(data).length > 0 ? JSON.stringify(data).slice(0, 2_000) : null),
      retryable: response.status >= 500,
    });
  }

  const purchaseId = optionalNumber(data.purchase_id);
  const order = asResponseRecord(data.order);
  const products = Array.isArray(order.products) ? order.products : [];
  const matched =
    products.find((p) => optionalNumber(asResponseRecord(p).id) === purchaseId) ??
    products[products.length - 1];
  const lineRecord = asResponseRecord(matched);

  logStep(params.traceId, "purchase.create.success", {
    orderId: params.orderId,
    purchaseId,
    totalPrice: parseDecimal(lineRecord.total_price),
  });

  return {
    purchaseId,
    // DigiFabster serializes money as either numbers or decimal strings — parse both.
    totalPrice: parseDecimal(lineRecord.total_price),
    pricePerPart: parseDecimal(lineRecord.price_per_part),
    materialTitle: optionalString(lineRecord.material_title),
    orderTotalPrice: parseDecimal(order.total_price),
    data,
  };
};

export interface ConfirmDigifabsterInvoiceResult {
  invoiceId: number | null;
  orderStatus: string | null;
  isPaid: boolean | null;
  cost: number | null;
  data: Record<string, unknown>;
}

/**
 * PATCH /v2/invoices/{invoiceId}/{hash}/ — confirm/place an order's invoice.
 * This endpoint is hash-protected (no S2S token in the spec: `security: - {}`),
 * so we deliberately omit the auth header to match the live widget call.
 * Default status "placed".
 */
export const confirmDigifabsterInvoice = async (params: {
  invoiceId: string | number;
  invoiceHash: string;
  status?: string;
  poNumber?: string | null;
  traceId?: string;
}): Promise<ConfirmDigifabsterInvoiceResult> => {
  const base = resolveDigifabsterBaseUrl();
  const status = params.status?.trim() || "placed";

  const body: Record<string, unknown> = { status };
  if (params.poNumber && params.poNumber.trim()) body.po_number = params.poNumber.trim();

  logStep(params.traceId, "invoice.confirm.start", { invoiceId: params.invoiceId, status });

  const response = await fetch(
    `${base}/v2/invoices/${encodeURIComponent(String(params.invoiceId))}/${encodeURIComponent(params.invoiceHash)}/`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const data = asResponseRecord(await parseJsonResponse(response));

  if (!response.ok) {
    logStep(params.traceId, "invoice.confirm.failed", { invoiceId: params.invoiceId, status: response.status });
    throw new DigifabsterSyncError({
      message: "DigiFabster invoice confirmation failed.",
      status: response.status || 502,
      code: "digifabster_invoice_confirm_failed",
      details:
        (typeof data.detail === "string" && data.detail) ||
        (Object.keys(data).length > 0 ? JSON.stringify(data).slice(0, 2_000) : null),
      retryable: response.status >= 500,
    });
  }

  const order = asResponseRecord(data.order);
  logStep(params.traceId, "invoice.confirm.success", { invoiceId: params.invoiceId });

  return {
    invoiceId: optionalNumber(data.id),
    orderStatus: optionalString(order.status),
    isPaid: typeof data.is_paid === "boolean" ? data.is_paid : null,
    // cost can arrive as a number or a decimal string depending on the endpoint.
    cost: parseDecimal(data.cost),
    data,
  };
};

/**
 * GET /v2/models/{id}/ — fetch a model's generated thumbnails (URLs) by the
 * object_model_id returned from an upload.
 */
export const getDigifabsterModelThumbnail = async (
  modelId: number,
  traceId?: string,
): Promise<DigifabsterModelThumbnail> => {
  const headers = await buildDigifabsterHeaders();
  logStep(traceId, "model.thumbnail.start", { modelId });

  const { ok, status, data } = await fetchDigifabsterJson(
    `/v2/models/${encodeURIComponent(String(modelId))}/`,
    headers,
  );

  if (!ok) {
    logStep(traceId, "model.thumbnail.failed", { modelId, status });
    throw new DigifabsterSyncError({
      message: `Failed to fetch DigiFabster model ${modelId}.`,
      status: status || 502,
      code: "digifabster_model_fetch_failed",
      details: typeof data === "object" ? JSON.stringify(data).slice(0, 2_000) : null,
      retryable: status >= 500,
    });
  }

  const record = asResponseRecord(data);
  const size = asResponseRecord(record.size);
  logStep(traceId, "model.thumbnail.success", {
    modelId,
    thumbStatus: optionalString(record.thumb_status),
    hasDimensions: optionalNumber(size.x) !== null,
  });

  return {
    modelId,
    thumb: optionalString(record.thumb),
    thumb120x120: optionalString(record.thumb_120x120),
    thumb300x300: optionalString(record.thumb_300x300),
    thumbStatus: optionalString(record.thumb_status),
    sizeX: optionalNumber(size.x),
    sizeY: optionalNumber(size.y),
    sizeZ: optionalNumber(size.z),
    units: optionalString(record.units),
    volume: optionalNumber(record.volume),
    surface: optionalNumber(record.surface),
  };
};

/* ------------------------------------------------------------------ */
/*  Batch price (POST /v2/batch_price/material/)                       */
/* ------------------------------------------------------------------ */

/** Money breakdown for a single (priority × quantity) cell. Mirrors PriceInfo. */
export interface DigifabsterBatchPriceInfo {
  nakedPrice: number;
  startupCost: number;
  postProductionPrice: number;
  priorityPrice: number;
  count: number;
  subtotal: number;
  withoutStartupCost: number;
  tax: number;
  taxPercent: number;
  discountPercent: number;
  discountValue: number;
  total: number;
  pricePerItem: number;
}

export interface DigifabsterBatchPriceItem {
  quantity: number;
  priceInfo: DigifabsterBatchPriceInfo;
}

/** One lead-time priority, with a price row per requested quantity. */
export interface DigifabsterBatchPriceForPriority {
  priorityId: string;
  priorityName: string;
  prices: DigifabsterBatchPriceItem[];
}

export interface DigifabsterBatchPriceResult {
  /** "priced" once DigiFabster returns 200; "analysing" while it still returns 202. */
  status: "priced" | "analysing";
  prices: DigifabsterBatchPriceForPriority[];
  analysingErrors: Array<{ code: string; text: string | null }>;
  warnings: Array<{ code: string; text: string | null }>;
  batchCapacity: number | null;
  raw: unknown;
}

const parseBatchPriceInfo = (value: unknown): DigifabsterBatchPriceInfo => {
  const info = asResponseRecord(value);
  const num = (v: unknown) => optionalNumber(v) ?? 0;
  return {
    nakedPrice: num(info.naked_price),
    startupCost: num(info.startup_cost),
    postProductionPrice: num(info.post_production_price),
    priorityPrice: num(info.priority_price),
    count: num(info.count),
    subtotal: num(info.subtotal),
    withoutStartupCost: num(info.without_startup_cost),
    tax: num(info.tax),
    taxPercent: num(info.tax_percent),
    discountPercent: num(info.discount_percent),
    discountValue: num(info.discount_value),
    total: num(info.total),
    pricePerItem: num(info.price_per_item),
  };
};

const parseAnalyzingErrors = (value: unknown): Array<{ code: string; text: string | null }> =>
  (Array.isArray(value) ? value : []).map((entry) => {
    const record = asResponseRecord(entry);
    return { code: optionalString(record.code) ?? "", text: optionalString(record.text) };
  });

const parseBatchPriceResponse = (data: unknown): DigifabsterBatchPriceResult => {
  const record = asResponseRecord(data);
  const prices: DigifabsterBatchPriceForPriority[] = (Array.isArray(record.prices) ? record.prices : []).map(
    (item) => {
      const priority = asResponseRecord(item);
      const rows = Array.isArray(priority.priority_prices) ? priority.priority_prices : [];
      return {
        priorityId: optionalString(priority.priority_id) ?? "",
        priorityName: optionalString(priority.priority_name_for_user) ?? "",
        prices: rows.map((row) => {
          const cell = asResponseRecord(row);
          return {
            quantity: optionalNumber(cell.quantity) ?? 0,
            priceInfo: parseBatchPriceInfo(cell.price_info),
          };
        }),
      };
    },
  );

  return {
    status: "priced",
    prices,
    analysingErrors: parseAnalyzingErrors(record.analysing_errors),
    warnings: parseAnalyzingErrors(record.warnings),
    batchCapacity: optionalNumber(record.batch_capacity),
    raw: data,
  };
};

/* ------------------------------------------------------------------ */
/*  Preselection (POST /v2/preselection/) — DigiFabster auto-picks the  */
/*  default material + config for an analysed model.                    */
/* ------------------------------------------------------------------ */

export interface DigifabsterPreselection {
  /** True once DigiFabster has finished analysing the geometry. */
  isReady: boolean;
  /** The auto-picked material id (null until ready / if none). */
  material: number | null;
  /** The default per-material config to feed straight into batch price. */
  config: Record<string, unknown> | null;
}

/**
 * Ask DigiFabster which material it auto-selects for a model (the same
 * `preselection/` call its own frontend makes). Also doubles as the
 * analysis-ready gate via `isReady`.
 */
export const getDigifabsterPreselection = async (
  modelId: number,
  traceId?: string,
): Promise<DigifabsterPreselection> => {
  const headers = await buildDigifabsterHeaders();
  const url = `${resolveDigifabsterBaseUrl()}/v2/preselection/`;

  logStep(traceId, "preselection.start", { modelId });

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ models_ids: [modelId] }),
  });

  const text = await response.text();
  let data: unknown = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 2_000) };
    }
  }

  if (!response.ok) {
    logStep(traceId, "preselection.failed", { modelId, status: response.status });
    throw new DigifabsterSyncError({
      message: `DigiFabster preselection failed for model ${modelId}.`,
      status: response.status || 502,
      code: "digifabster_preselection_failed",
      details: typeof data === "object" ? JSON.stringify(data).slice(0, 2_000) : null,
      retryable: response.status >= 500,
    });
  }

  // Response shape: { "<modelId>": { is_ready, material, config } }
  const record = asResponseRecord(data);
  const entry = asResponseRecord(record[String(modelId)]);
  const config = asResponseRecord(entry.config);

  const result: DigifabsterPreselection = {
    isReady: entry.is_ready === true,
    material: optionalNumber(entry.material),
    config: Object.keys(config).length > 0 ? config : null,
  };

  logStep(traceId, "preselection.success", {
    modelId,
    isReady: result.isReady,
    material: result.material,
    hasConfig: result.config !== null,
  });

  return result;
};

/**
 * Bulk-price an uploaded model across a set of quantities × lead-time priorities.
 *
 * DigiFabster returns `202` (no body) while it is still analysing the model and
 * `200` with the price matrix once ready, so this polls a bounded number of
 * times (DIGIFABSTER_BATCH_PRICE_ATTEMPTS / _INTERVAL_MS). If it is still
 * analysing when attempts run out, it resolves with status "analysing" rather
 * than throwing, so the caller can retry later.
 */
export const getDigifabsterBatchPrice = async (params: {
  modelId: number;
  materialId: number;
  count: number[];
  leadTime: string[];
  config?: Record<string, unknown>;
  traceId?: string;
  /** Override the internal poll attempt count (e.g. 1 for a single fast call). */
  maxAttempts?: number;
}): Promise<DigifabsterBatchPriceResult> => {
  const headers = await buildDigifabsterHeaders();
  const url = `${resolveDigifabsterBaseUrl()}/v2/batch_price/material/`;

  const body: Record<string, unknown> = {
    model_id: params.modelId,
    material_id: params.materialId,
    count: params.count,
    lead_time: params.leadTime,
  };
  if (params.config && Object.keys(params.config).length > 0) {
    body.config = params.config;
  }

  const maxAttempts =
    params.maxAttempts && params.maxAttempts > 0
      ? Math.floor(params.maxAttempts)
      : parsePositiveInt(process.env.DIGIFABSTER_BATCH_PRICE_ATTEMPTS, 5);
  const intervalMs = parsePositiveInt(process.env.DIGIFABSTER_BATCH_PRICE_INTERVAL_MS, 3000);

  logStep(params.traceId, "batch_price.start", {
    modelId: params.modelId,
    materialId: params.materialId,
    count: params.count,
    leadTime: params.leadTime,
    maxAttempts,
  });

  let lastData: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let data: unknown = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 2_000) };
      }
    }
    lastData = data;

    if (response.status === 202) {
      logStep(params.traceId, "batch_price.analysing", { modelId: params.modelId, attempt });
      if (attempt < maxAttempts) {
        await wait(intervalMs);
        continue;
      }
      return {
        status: "analysing",
        prices: [],
        analysingErrors: [],
        warnings: [],
        batchCapacity: null,
        raw: data,
      };
    }

    if (!response.ok) {
      logStep(params.traceId, "batch_price.failed", { modelId: params.modelId, status: response.status });
      throw new DigifabsterSyncError({
        message: `DigiFabster batch price request failed for model ${params.modelId}.`,
        status: response.status || 502,
        code: "digifabster_batch_price_failed",
        details: typeof data === "object" ? JSON.stringify(data).slice(0, 2_000) : null,
        retryable: response.status >= 500,
      });
    }

    const parsed = parseBatchPriceResponse(data);

    // DigiFabster computes the price matrix asynchronously: it can return 200
    // with an empty `prices` array (and no errors) while still working. Treat
    // that like the 202 case and keep polling until prices appear.
    if (parsed.prices.length === 0 && parsed.analysingErrors.length === 0 && attempt < maxAttempts) {
      logStep(params.traceId, "batch_price.empty.retry", { modelId: params.modelId, attempt });
      await wait(intervalMs);
      continue;
    }

    logStep(params.traceId, "batch_price.success", {
      modelId: params.modelId,
      priorities: parsed.prices.length,
      analysingErrors: parsed.analysingErrors.length,
    });
    return parsed.prices.length === 0 ? { ...parsed, status: "analysing" } : parsed;
  }

  return {
    status: "analysing",
    prices: [],
    analysingErrors: [],
    warnings: [],
    batchCapacity: null,
    raw: lastData,
  };
};

export { DigifabsterSyncError };
