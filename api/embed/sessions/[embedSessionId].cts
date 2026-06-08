import { DEFAULT_ACCEPTED_FILE_TYPES, DEFAULT_MAX_FILE_SIZE_BYTES, normalizeOptionalString } from "../../embed_helpers/contracts";
import { getEmbedSession, saveEmbedSession, type EmbedSessionRecord } from "../../embed_helpers/session-store";
import { getEmbedPart } from "../../embed_helpers/part-store";
import { createGuestToken, getGuestTokenTtlMs, isGuestTokenExpired, verifyGuestToken } from "../../embed_helpers/session-token";

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
  return segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : null;
};

const buildResponse = async (session: EmbedSessionRecord) => {
  const currentPart = session.currentPartId
    ? await getEmbedPart(session.currentPartId)
    : null;

  return {
    embedSessionId: session.embedSessionId,
    guestToken: session.guestToken,
    mode: session.mode,
    bubbleOrderId: session.bubbleOrderId,
    status: "session_resumed",
    expiresAt: new Date(session.expiresAt).toISOString(),
    acceptedFileTypes: [...DEFAULT_ACCEPTED_FILE_TYPES],
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
    currentPart: currentPart
      ? {
        vercelPartId: currentPart.vercelPartId,
        sourceFileId: currentPart.sourceFileId,
        sourceFileName: currentPart.sourceFileName,
        sourceFileSizeBytes: currentPart.sourceFileSizeBytes,
        status: currentPart.status,
      }
      : null,
  };
};

export async function GET(req: Request) {
  try {
    const embedSessionId = getSessionIdFromPath(req);
    if (!embedSessionId) {
      return error(400, "Missing embedSessionId", "Expected embedSessionId in the request path.");
    }

    const url = new URL(req.url);
    const providedGuestToken = normalizeOptionalString(
      url.searchParams.get("guestToken") || url.searchParams.get("guest_token")
    );

    if (!providedGuestToken) {
      return error(401, "Missing guestToken", "guestToken is required to read embed session state.");
    }

    const parsedGuestToken = verifyGuestToken(providedGuestToken);
    if (!parsedGuestToken) {
      return error(401, "Invalid guestToken", "Token signature could not be verified.");
    }

    const now = Date.now();
    if (isGuestTokenExpired(parsedGuestToken, now)) {
      return error(401, "Expired guestToken", "Create or resume a session to receive a fresh token.");
    }

    if (parsedGuestToken.embedSessionId !== embedSessionId) {
      return error(403, "Session mismatch", "Provided guestToken does not match embedSessionId.");
    }

    const queryBubbleOrderId = normalizeOptionalString(url.searchParams.get("bubbleOrderId"));
    if (parsedGuestToken.mode === "existing" && queryBubbleOrderId && parsedGuestToken.bubbleOrderId !== queryBubbleOrderId) {
      return error(409, "bubbleOrderId mismatch", "Query bubbleOrderId does not match the session token.");
    }

    const ttlMs = getGuestTokenTtlMs();
    const refreshedTokenPayload = {
      embedSessionId: parsedGuestToken.embedSessionId,
      mode: parsedGuestToken.mode,
      parentOrigin: parsedGuestToken.parentOrigin,
      bubbleOrderId: parsedGuestToken.bubbleOrderId,
      issuedAt: now,
      expiresAt: now + ttlMs,
    };

    const existing = await getEmbedSession(embedSessionId);
    const refreshedSession = await saveEmbedSession({
      embedSessionId: parsedGuestToken.embedSessionId,
      mode: parsedGuestToken.mode,
      parentOrigin: parsedGuestToken.parentOrigin,
      bubbleOrderId: parsedGuestToken.bubbleOrderId,
      guestToken: createGuestToken(refreshedTokenPayload),
      createdAt: existing?.createdAt ?? parsedGuestToken.issuedAt,
      updatedAt: now,
      expiresAt: refreshedTokenPayload.expiresAt,
      currentPartId: existing?.currentPartId ?? null,
    });

    return json(await buildResponse(refreshedSession));
  } catch (sessionError) {
    console.error("[embed] Failed to read embed session", sessionError);
    return error(500, "Failed to read embed session");
  }
}
