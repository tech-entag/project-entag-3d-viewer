import { createHmac, timingSafeEqual } from "node:crypto";

import type { EmbedMode } from "./contracts";

const TOKEN_SECRET_ENV_KEY = "EMBED_SESSION_SECRET";
const DEFAULT_GUEST_TOKEN_TTL_SECONDS = 60 * 60 * 24;
const MAX_GUEST_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

let warnedMissingSecret = false;

export interface GuestTokenPayload {
  embedSessionId: string;
  mode: EmbedMode;
  parentOrigin: string;
  bubbleOrderId: string | null;
  issuedAt: number;
  expiresAt: number;
}

const resolveTokenSecret = () => {
  const configuredSecret = process.env[TOKEN_SECRET_ENV_KEY]?.trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  if (!warnedMissingSecret) {
    console.warn(
      "[embed] EMBED_SESSION_SECRET is not configured; using insecure fallback secret for local development."
    );
    warnedMissingSecret = true;
  }

  return "embed-session-dev-fallback-secret";
};

const getSignature = (content: string) => {
  return createHmac("sha256", resolveTokenSecret()).update(content).digest("base64url");
};

const looksLikeSameSignature = (received: string, expected: string) => {
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, expectedBuffer);
};

const isValidPayload = (payload: unknown): payload is GuestTokenPayload => {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const parsed = payload as Partial<GuestTokenPayload>;
  if (typeof parsed.embedSessionId !== "string" || !parsed.embedSessionId.trim()) {
    return false;
  }

  if (parsed.mode !== "new" && parsed.mode !== "existing") {
    return false;
  }

  if (typeof parsed.parentOrigin !== "string" || !parsed.parentOrigin.trim()) {
    return false;
  }

  if (parsed.bubbleOrderId !== null && typeof parsed.bubbleOrderId !== "string") {
    return false;
  }

  return typeof parsed.issuedAt === "number" && typeof parsed.expiresAt === "number";
};

export const getGuestTokenTtlMs = () => {
  const configuredSeconds = Number(process.env.EMBED_GUEST_TOKEN_TTL_SECONDS ?? DEFAULT_GUEST_TOKEN_TTL_SECONDS);
  const normalizedSeconds = Number.isFinite(configuredSeconds) && configuredSeconds > 0
    ? Math.min(Math.floor(configuredSeconds), MAX_GUEST_TOKEN_TTL_SECONDS)
    : DEFAULT_GUEST_TOKEN_TTL_SECONDS;

  return normalizedSeconds * 1000;
};

export const isGuestTokenExpired = (payload: GuestTokenPayload, now = Date.now()) => {
  return payload.expiresAt <= now;
};

export const createGuestToken = (payload: GuestTokenPayload) => {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = getSignature(encodedPayload);
  return `${encodedPayload}.${signature}`;
};

export const verifyGuestToken = (token: string) => {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    return null;
  }

  const [encodedPayload, receivedSignature] = trimmedToken.split(".");
  if (!encodedPayload || !receivedSignature) {
    return null;
  }

  const expectedSignature = getSignature(encodedPayload);
  if (!looksLikeSameSignature(receivedSignature, expectedSignature)) {
    return null;
  }

  try {
    const parsedPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    return isValidPayload(parsedPayload) ? parsedPayload : null;
  } catch {
    return null;
  }
};
