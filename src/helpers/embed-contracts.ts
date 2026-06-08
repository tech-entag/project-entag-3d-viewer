export const EMBED_EVENT_VERSION = "v1" as const;
export const EMBED_BUBBLE_SOURCE = "bubble.host" as const;
export const EMBED_VERCEL_SOURCE = "vercel.embed" as const;

export const EMBED_MODES = ["new", "existing"] as const;
export type EmbedMode = (typeof EMBED_MODES)[number];

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
