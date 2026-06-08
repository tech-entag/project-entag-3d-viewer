import { randomUUID } from "node:crypto";

import {
  DEFAULT_ACCEPTED_FILE_TYPES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  isEmbedMode,
  normalizeOptionalString,
  normalizeOrigin,
  type EmbedMode,
  type EmbedSessionStatus,
} from "../../embed_helpers/contracts";
import { saveEmbedSession, getEmbedSession, type EmbedSessionRecord } from "../../embed_helpers/session-store";
import {
  createGuestToken,
  getGuestTokenTtlMs,
  isGuestTokenExpired,
  verifyGuestToken,
  type GuestTokenPayload,
} from "../../embed_helpers/session-token";

export const config = {
  maxDuration: 60,
};

interface CreateEmbedSessionRequest {
  mode?: unknown;
  parentOrigin?: unknown;
  bubbleOrderId?: unknown;
  guestToken?: unknown;
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const error = (status: number, message: string, details?: string) =>
  json({ error: message, ...(details ? { details } : {}) }, status);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const buildSessionResponse = (
  session: EmbedSessionRecord,
  status: EmbedSessionStatus
) => {
  return {
    embedSessionId: session.embedSessionId,
    guestToken: session.guestToken,
    mode: session.mode,
    bubbleOrderId: session.bubbleOrderId,
    status,
    expiresAt: new Date(session.expiresAt).toISOString(),
    acceptedFileTypes: [...DEFAULT_ACCEPTED_FILE_TYPES],
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
  };
};

const createSessionPayload = (
  payload: Omit<GuestTokenPayload, "issuedAt" | "expiresAt">,
  now: number,
  ttlMs: number
) => {
  return {
    ...payload,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
};

const resumeSessionFromGuestToken = async (
  guestToken: string,
  expectedMode: EmbedMode,
  expectedParentOrigin: string,
  expectedBubbleOrderId: string | null,
  now: number,
  ttlMs: number
): Promise<EmbedSessionRecord | null> => {
  const parsedToken = verifyGuestToken(guestToken);
  if (!parsedToken) {
    return null;
  }

  if (isGuestTokenExpired(parsedToken, now)) {
    return null;
  }

  if (parsedToken.mode !== expectedMode) {
    return null;
  }

  if (parsedToken.parentOrigin !== expectedParentOrigin) {
    return null;
  }

  if (expectedMode === "existing" && parsedToken.bubbleOrderId !== expectedBubbleOrderId) {
    return null;
  }

  if (expectedMode === "new" && parsedToken.bubbleOrderId) {
    return null;
  }

  const payload = createSessionPayload(
    {
      embedSessionId: parsedToken.embedSessionId,
      mode: parsedToken.mode,
      parentOrigin: parsedToken.parentOrigin,
      bubbleOrderId: parsedToken.bubbleOrderId,
    },
    now,
    ttlMs
  );

  const refreshedToken = createGuestToken(payload);
  const existing = await getEmbedSession(parsedToken.embedSessionId);

  return saveEmbedSession({
    embedSessionId: payload.embedSessionId,
    mode: payload.mode,
    parentOrigin: payload.parentOrigin,
    bubbleOrderId: payload.bubbleOrderId,
    guestToken: refreshedToken,
    createdAt: existing?.createdAt ?? payload.issuedAt,
    updatedAt: now,
    expiresAt: payload.expiresAt,
    currentPartId: existing?.currentPartId ?? null,
  });
};

export async function POST(req: Request) {
  try {
    const rawBody = await req.json();
    if (!isRecord(rawBody)) {
      return error(400, "Invalid request body", "Expected a JSON object payload.");
    }

    const body = rawBody as CreateEmbedSessionRequest;
    const mode = body.mode;
    if (!isEmbedMode(mode)) {
      return error(400, "Invalid mode", "Expected mode to be either 'new' or 'existing'.");
    }

    const parentOrigin = normalizeOrigin(body.parentOrigin);
    if (!parentOrigin) {
      return error(400, "Invalid parentOrigin", "Expected parentOrigin to be a valid URL origin.");
    }

    const bubbleOrderId = normalizeOptionalString(body.bubbleOrderId);
    if (mode === "existing" && !bubbleOrderId) {
      return error(400, "Missing bubbleOrderId", "mode='existing' requires bubbleOrderId.");
    }

    if (mode === "new" && bubbleOrderId) {
      return error(400, "Invalid bubbleOrderId", "mode='new' cannot include bubbleOrderId.");
    }

    const now = Date.now();
    const ttlMs = getGuestTokenTtlMs();
    const providedGuestToken = normalizeOptionalString(body.guestToken);

    if (providedGuestToken) {
      const resumedSession = await resumeSessionFromGuestToken(
        providedGuestToken,
        mode,
        parentOrigin,
        bubbleOrderId,
        now,
        ttlMs
      );

      if (!resumedSession) {
        return error(401, "Invalid guestToken", "Token is invalid, expired, or mismatched for this request.");
      }

      return json(buildSessionResponse(resumedSession, "session_resumed"));
    }

    const payload = createSessionPayload(
      {
        embedSessionId: randomUUID(),
        mode,
        parentOrigin,
        bubbleOrderId,
      },
      now,
      ttlMs
    );

    const guestToken = createGuestToken(payload);
    const createdSession = await saveEmbedSession({
      embedSessionId: payload.embedSessionId,
      mode: payload.mode,
      parentOrigin: payload.parentOrigin,
      bubbleOrderId: payload.bubbleOrderId,
      guestToken,
      createdAt: payload.issuedAt,
      updatedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      currentPartId: null,
    });

    return json(buildSessionResponse(createdSession, "session_created"));
  } catch (requestError) {
    console.error("[embed] Failed to create embed session", requestError);
    return error(500, "Failed to create embed session");
  }
}
