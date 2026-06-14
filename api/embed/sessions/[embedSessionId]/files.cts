import { randomUUID } from "node:crypto";

import {
  DEFAULT_ACCEPTED_FILE_TYPES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
} from "../../../embed_helpers/contracts";
import { saveEmbedPart } from "../../../embed_helpers/part-store";
import { hasStorage, putObject } from "../../../embed_helpers/blob-storage";
import { updateEmbedSession } from "../../../embed_helpers/session-store";
import { ensureGuestTokenForSession } from "../../../embed_helpers/request-auth";

export const config = {
  maxDuration: 60,
};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const error = (status: number, message: string, details?: string) =>
  json({ error: message, ...(details ? { details } : {}) }, status);

const getSessionIdFromPath = (req: Request) => {
  const pathname = new URL(req.url).pathname;
  const segments = pathname.split("/").filter(Boolean);
  const sessionsIndex = segments.lastIndexOf("sessions");

  if (sessionsIndex < 0) {
    return null;
  }

  const embedSessionId = segments[sessionsIndex + 1];
  const filesSegment = segments[sessionsIndex + 2];
  if (!embedSessionId || filesSegment !== "files") {
    return null;
  }

  return decodeURIComponent(embedSessionId);
};

const getExtension = (fileName: string) => {
  const parts = fileName.toLowerCase().split(".");
  if (parts.length < 2) {
    return null;
  }

  return `.${parts.pop()}`;
};

const sanitizeFileName = (fileName: string) => {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "upload.step";
  }

  const sanitized = trimmed
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);

  return sanitized || "upload.step";
};

export async function POST(req: Request) {
  try {
    const embedSessionId = getSessionIdFromPath(req);
    if (!embedSessionId) {
      return error(400, "Missing embedSessionId", "Expected /api/embed/sessions/{embedSessionId}/files route.");
    }

    const sessionAuth = await ensureGuestTokenForSession(req, embedSessionId);
    if (!sessionAuth.ok) {
      return sessionAuth.response;
    }

    const formData = await req.formData();
    const now = Date.now();

    const fileCandidate = formData.get("file");
    if (!(fileCandidate instanceof File)) {
      return error(400, "Missing file", "Expected multipart form field 'file'.");
    }

    const extension = getExtension(fileCandidate.name || "");
    if (!extension || !DEFAULT_ACCEPTED_FILE_TYPES.includes(extension as (typeof DEFAULT_ACCEPTED_FILE_TYPES)[number])) {
      return error(
        400,
        "Unsupported file type",
        `Allowed file extensions: ${DEFAULT_ACCEPTED_FILE_TYPES.join(", ")}.`
      );
    }

    if (fileCandidate.size <= 0) {
      return error(400, "Empty file", "Uploaded file must not be empty.");
    }

    if (fileCandidate.size > DEFAULT_MAX_FILE_SIZE_BYTES) {
      return error(
        413,
        "File too large",
        `Maximum allowed size is ${DEFAULT_MAX_FILE_SIZE_BYTES} bytes.`
      );
    }

    if (!hasStorage()) {
      return error(503, "Upload storage unavailable", "An R2 bucket binding is required for direct file uploads.");
    }

    const vercelPartId = randomUUID();
    const sourceFileId = randomUUID();
    const safeFileName = sanitizeFileName(fileCandidate.name || "upload.step");
    const storagePath = `embed-source-files/${embedSessionId}/${vercelPartId}/${safeFileName}`;

    const uploaded = await putObject(
      storagePath,
      fileCandidate,
      fileCandidate.type || "application/octet-stream",
    );

    await saveEmbedPart({
      vercelPartId,
      embedSessionId,
      sourceFileId,
      sourceFileName: safeFileName,
      sourceFileSizeBytes: fileCandidate.size,
      sourceFilePath: storagePath,
      sourceFileUrl: uploaded.url,
      status: "uploaded",
      processingStage: "upload_received",
      processingStatus: "success",
      autodesk: {
        accountId: null,
        bucketKey: null,
        objectKey: null,
        urn: null,
        lastSyncedAt: null,
      },
      viewer: null,
      quote: null,
      defaultsSnapshot: null,
      failure: {
        code: null,
        message: null,
      },
      createdAt: now,
      updatedAt: now,
    });

    await updateEmbedSession(embedSessionId, (existingSession) => ({
      ...existingSession,
      currentPartId: vercelPartId,
      updatedAt: now,
    }));

    return json({
      vercelPartId,
      sourceFileId,
      fileName: safeFileName,
      fileSizeBytes: fileCandidate.size,
      status: "uploaded",
    });
  } catch (uploadError) {
    console.error("[embed] Failed to upload source file", uploadError);
    return error(500, "Failed to upload source file");
  }
}
