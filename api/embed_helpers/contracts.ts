export const EMBED_EVENT_VERSION = "v1" as const;
export const EMBED_BUBBLE_SOURCE = "bubble.host" as const;
export const EMBED_VERCEL_SOURCE = "vercel.embed" as const;

export const EMBED_MODES = ["new", "existing"] as const;
export type EmbedMode = (typeof EMBED_MODES)[number];

export const EMBED_SESSION_STATUSES = ["session_created", "session_resumed"] as const;
export type EmbedSessionStatus = (typeof EMBED_SESSION_STATUSES)[number];

export const EMBED_STAGE_VALUES = [
  "upload_received",
  "autodesk_queued",
  "autodesk_processing",
  "viewer_caching",
  "viewer_ready",
  "digifabster_sync",
  "defaults_ready",
  "reprice_processing",
  "ready",
  "failed",
] as const;
export type EmbedStageValue = (typeof EMBED_STAGE_VALUES)[number];

export const EMBED_STAGE_STATUSES = ["queued", "inprogress", "success", "failed"] as const;
export type EmbedStageStatus = (typeof EMBED_STAGE_STATUSES)[number];

export const DEFAULT_ACCEPTED_FILE_TYPES = [
  ".step",
  ".stp",
  ".dwg",
  ".dxf",
  ".igs",
  ".iges",
  ".stl",
  ".x_t",
  ".sldprt",
] as const;

export const DEFAULT_MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;

export const isEmbedMode = (value: unknown): value is EmbedMode => {
  return typeof value === "string" && EMBED_MODES.includes(value as EmbedMode);
};

export const normalizeOptionalString = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const normalizeOrigin = (value: unknown) => {
  const candidate = normalizeOptionalString(value);
  if (!candidate) {
    return null;
  }

  try {
    const normalized = new URL(candidate).origin;
    return normalized === "null" ? null : normalized;
  } catch {
    return null;
  }
};
