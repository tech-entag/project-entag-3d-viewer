import { normalizeOptionalString } from "./contracts";
import { getEmbedPart, type EmbedPartRecord } from "./part-store";
import { getEmbedSession, type EmbedSessionRecord } from "./session-store";
import { isGuestTokenExpired, verifyGuestToken, type GuestTokenPayload } from "./session-token";

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const error = (status: number, message: string, details?: string) => {
  return json({ error: message, ...(details ? { details } : {}) }, status);
};

export type GuestAuthFailure = {
  ok: false;
  response: Response;
};

export type GuestAuthSuccessForSession = {
  ok: true;
  tokenPayload: GuestTokenPayload;
  session: EmbedSessionRecord;
};

export type GuestAuthSuccessForPart = {
  ok: true;
  tokenPayload: GuestTokenPayload;
  session: EmbedSessionRecord;
  part: EmbedPartRecord;
};

export const resolveGuestTokenFromRequest = (req: Request) => {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = normalizeOptionalString(authHeader.slice(7));
    if (token) {
      return token;
    }
  }

  const url = new URL(req.url);
  return normalizeOptionalString(url.searchParams.get("guestToken") || url.searchParams.get("guest_token"));
};

export const ensureGuestTokenForSession = async (
  req: Request,
  embedSessionId: string
): Promise<GuestAuthFailure | GuestAuthSuccessForSession> => {
  const providedGuestToken = resolveGuestTokenFromRequest(req);
  if (!providedGuestToken) {
    return {
      ok: false,
      response: error(401, "Missing guestToken", "Provide guest token via Authorization Bearer or query parameter."),
    };
  }

  const parsedGuestToken = verifyGuestToken(providedGuestToken);
  if (!parsedGuestToken) {
    return {
      ok: false,
      response: error(401, "Invalid guestToken", "Token signature could not be verified."),
    };
  }

  if (isGuestTokenExpired(parsedGuestToken, Date.now())) {
    return {
      ok: false,
      response: error(401, "Expired guestToken", "Resume session to receive a fresh token."),
    };
  }

  if (parsedGuestToken.embedSessionId !== embedSessionId) {
    return {
      ok: false,
      response: error(403, "Session mismatch", "Provided guestToken does not match embedSessionId."),
    };
  }

  const session = await getEmbedSession(embedSessionId);
  if (!session) {
    return {
      ok: false,
      response: error(404, "Embed session not found", "Create or resume a session before requesting this resource."),
    };
  }

  if (
    session.mode !== parsedGuestToken.mode
    || session.parentOrigin !== parsedGuestToken.parentOrigin
    || session.bubbleOrderId !== parsedGuestToken.bubbleOrderId
  ) {
    return {
      ok: false,
      response: error(409, "Session token mismatch", "Session state no longer matches the provided guestToken context."),
    };
  }

  return {
    ok: true,
    tokenPayload: parsedGuestToken,
    session,
  };
};

export const ensureGuestTokenForPart = async (
  req: Request,
  vercelPartId: string
): Promise<GuestAuthFailure | GuestAuthSuccessForPart> => {
  const part = await getEmbedPart(vercelPartId);
  if (!part) {
    return {
      ok: false,
      response: error(404, "Part not found", "No part record exists for this vercelPartId."),
    };
  }

  const sessionResult = await ensureGuestTokenForSession(req, part.embedSessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  return {
    ok: true,
    tokenPayload: sessionResult.tokenPayload,
    session: sessionResult.session,
    part,
  };
};
