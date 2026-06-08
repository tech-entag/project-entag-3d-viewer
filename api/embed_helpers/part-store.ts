import { readJsonBlob, writeJsonBlob } from "./blob-storage";
import type { EmbedStageStatus, EmbedStageValue } from "./contracts";

export type EmbedPartStatus = "uploaded" | "processing" | "ready" | "failed";

export interface EmbedPartViewerState {
  status: "queued" | "inprogress" | "success" | "failed";
  mode?: "local" | "cloud";
  localModelUrl?: string | null;
  localError?: string | null;
  urn?: string | null;
}

export interface EmbedPartQuoteState {
  status: "not_required" | "queued" | "inprogress" | "success" | "failed";
  targetFormat?: "step" | "dwg" | null;
  error?: string | null;
  upload?: {
    status: "skipped" | "submitted" | "cached";
    objectModelId: number | null;
    orderId: number | null;
    sessionId: string | null;
    quoteStatus: string | null;
    source: "digifabster" | "cache" | "none";
    reason?: string;
  } | null;
}

export interface EmbedPartDefaultsSnapshot {
  snapshotId: string;
  createdAt: number;
  status: "ready" | "pending" | "failed";
  defaults: {
    machine: { id: number | null; title: string | null };
    material: { id: number | null; title: string | null };
    tolerance: string | null;
    postproduction: string[];
    quantity: number;
    leadTime: string | null;
    technologySlug: string | null;
  };
  pricing: {
    currency: string;
    unitPrice: number | null;
    setupPrice: number | null;
    totalPrice: number | null;
    leadTimeDays: number | null;
  };
  warnings: string[];
}

export interface EmbedPartRecord {
  vercelPartId: string;
  embedSessionId: string;
  sourceFileId: string;
  sourceFileName: string;
  sourceFileSizeBytes: number;
  sourceFilePath: string | null;
  sourceFileUrl: string | null;
  status: EmbedPartStatus;
  processingStage: EmbedStageValue;
  processingStatus: EmbedStageStatus;
  autodesk: {
    accountId: string | null;
    bucketKey: string | null;
    objectKey: string | null;
    urn: string | null;
    lastSyncedAt: number | null;
  };
  viewer: EmbedPartViewerState | null;
  quote: EmbedPartQuoteState | null;
  defaultsSnapshot: EmbedPartDefaultsSnapshot | null;
  failure: {
    code: string | null;
    message: string | null;
  };
  createdAt: number;
  updatedAt: number;
}

const embedParts = new Map<string, EmbedPartRecord>();

const partPath = (vercelPartId: string) => `embed-parts/${vercelPartId}.json`;

const isValidPartRecord = (value: unknown): value is EmbedPartRecord => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<EmbedPartRecord>;
  if (typeof record.vercelPartId !== "string" || !record.vercelPartId.trim()) {
    return false;
  }

  if (typeof record.embedSessionId !== "string" || !record.embedSessionId.trim()) {
    return false;
  }

  if (typeof record.sourceFileId !== "string" || !record.sourceFileId.trim()) {
    return false;
  }

  if (typeof record.sourceFileName !== "string" || !record.sourceFileName.trim()) {
    return false;
  }

  if (typeof record.sourceFileSizeBytes !== "number") {
    return false;
  }

  if (record.sourceFilePath !== null && typeof record.sourceFilePath !== "string") {
    return false;
  }

  if (record.sourceFileUrl !== null && typeof record.sourceFileUrl !== "string") {
    return false;
  }

  if (
    record.status !== "uploaded"
    && record.status !== "processing"
    && record.status !== "ready"
    && record.status !== "failed"
  ) {
    return false;
  }

  return typeof record.createdAt === "number" && typeof record.updatedAt === "number";
};

const normalizePartRecord = (record: EmbedPartRecord): EmbedPartRecord => {
  return {
    ...record,
    sourceFilePath: record.sourceFilePath ?? null,
    sourceFileUrl: record.sourceFileUrl ?? null,
    processingStage: record.processingStage || "upload_received",
    processingStatus: record.processingStatus || (record.status === "failed" ? "failed" : "queued"),
    autodesk: {
      accountId: record.autodesk?.accountId ?? null,
      bucketKey: record.autodesk?.bucketKey ?? null,
      objectKey: record.autodesk?.objectKey ?? null,
      urn: record.autodesk?.urn ?? null,
      lastSyncedAt: record.autodesk?.lastSyncedAt ?? null,
    },
    viewer: record.viewer ?? null,
    quote: record.quote ?? null,
    defaultsSnapshot: record.defaultsSnapshot ?? null,
    failure: {
      code: record.failure?.code ?? null,
      message: record.failure?.message ?? null,
    },
  };
};

export const saveEmbedPart = async (part: EmbedPartRecord) => {
  const normalized = normalizePartRecord(part);
  embedParts.set(normalized.vercelPartId, normalized);

  try {
    await writeJsonBlob(partPath(normalized.vercelPartId), normalized);
  } catch (storageError) {
    console.warn("[embed] Failed to persist embed part record", storageError);
  }

  return normalized;
};

export const getEmbedPart = async (vercelPartId: string) => {
  try {
    const stored = await readJsonBlob<unknown>(partPath(vercelPartId));
    if (isValidPartRecord(stored)) {
      const normalized = normalizePartRecord(stored);
      embedParts.set(vercelPartId, normalized);
      return normalized;
    }
  } catch (storageError) {
    console.warn("[embed] Failed to read embed part record", storageError);
  }

  return embedParts.get(vercelPartId) ?? null;
};

export const updateEmbedPart = async (
  vercelPartId: string,
  apply: (part: EmbedPartRecord) => EmbedPartRecord
) => {
  const existing = await getEmbedPart(vercelPartId);
  if (!existing) {
    return null;
  }

  const next = apply(existing);
  return saveEmbedPart(next);
};
