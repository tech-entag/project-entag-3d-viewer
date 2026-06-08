import type { EmbedMode } from "./contracts";
import { hasBlobToken, readJsonBlob, writeJsonBlob } from "./blob-storage";

export interface EmbedSessionRecord {
  embedSessionId: string;
  mode: EmbedMode;
  parentOrigin: string;
  bubbleOrderId: string | null;
  guestToken: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  currentPartId?: string | null;
}

const embedSessions = new Map<string, EmbedSessionRecord>();

const sessionPath = (embedSessionId: string) => `embed-sessions/${embedSessionId}.json`;

const isValidSessionRecord = (value: unknown): value is EmbedSessionRecord => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<EmbedSessionRecord>;
  if (typeof record.embedSessionId !== "string" || !record.embedSessionId.trim()) {
    return false;
  }

  if (record.mode !== "new" && record.mode !== "existing") {
    return false;
  }

  if (typeof record.parentOrigin !== "string" || !record.parentOrigin.trim()) {
    return false;
  }

  if (record.bubbleOrderId !== null && typeof record.bubbleOrderId !== "string") {
    return false;
  }

  if (typeof record.guestToken !== "string" || !record.guestToken.trim()) {
    return false;
  }

  if (
    typeof record.createdAt !== "number"
    || typeof record.updatedAt !== "number"
    || typeof record.expiresAt !== "number"
  ) {
    return false;
  }

  return record.currentPartId === undefined
    || record.currentPartId === null
    || typeof record.currentPartId === "string";
};

const normalizeSessionRecord = (record: EmbedSessionRecord): EmbedSessionRecord => {
  return {
    ...record,
    currentPartId: record.currentPartId ?? null,
  };
};

export const saveEmbedSession = async (session: EmbedSessionRecord) => {
  const normalized = normalizeSessionRecord(session);
  embedSessions.set(normalized.embedSessionId, normalized);

  if (hasBlobToken()) {
    try {
      await writeJsonBlob(sessionPath(normalized.embedSessionId), normalized);
    } catch (storageError) {
      console.warn("[embed] Failed to persist embed session in Blob storage", storageError);
    }
  }

  return normalized;
};

export const getEmbedSession = async (embedSessionId: string) => {
  if (hasBlobToken()) {
    try {
      const stored = await readJsonBlob<unknown>(sessionPath(embedSessionId));
      if (isValidSessionRecord(stored)) {
        const normalized = normalizeSessionRecord(stored);
        embedSessions.set(embedSessionId, normalized);
        return normalized;
      }
    } catch (storageError) {
      console.warn("[embed] Failed to read embed session from Blob storage", storageError);
    }
  }

  return embedSessions.get(embedSessionId) ?? null;
};

export const updateEmbedSession = async (
  embedSessionId: string,
  apply: (session: EmbedSessionRecord) => EmbedSessionRecord
) => {
  const existing = await getEmbedSession(embedSessionId);
  if (!existing) {
    return null;
  }

  const next = apply(existing);
  return saveEmbedSession(next);
};
