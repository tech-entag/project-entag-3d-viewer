/**
 * Which fields /api/digifabster-part-data includes in its response, stored in R2
 * at config/part-data-fields.json so it's editable from the admin page without a
 * redeploy. `modelId` (and echoed `partId`) are always included; everything else
 * is toggleable.
 */
import { getObjectText, hasStorage, writeJsonBlob } from "../embed_helpers/blob-storage";

export const PART_DATA_CONFIG_KEY = "config/part-data-fields.json";

/** Toggleable response fields, in display order. */
export const PART_DATA_FIELDS = [
  "image",
  "thumbnails",
  "dimX",
  "dimY",
  "dimZ",
  "dimUnits",
  "materialId",
  "materialSource",
  "requestedPrice",
  "priceStatus",
  "shouldRetry",
  "ready",
] as const;

export type PartDataField = (typeof PART_DATA_FIELDS)[number];

export interface PartDataConfig {
  fields: Record<PartDataField, boolean>;
}

const allEnabled = (): Record<PartDataField, boolean> =>
  Object.fromEntries(PART_DATA_FIELDS.map((f) => [f, true])) as Record<PartDataField, boolean>;

export const defaultPartDataConfig = (): PartDataConfig => ({ fields: allEnabled() });

/** Read the field-toggle config from R2; defaults to all fields enabled. */
export const getPartDataConfig = async (): Promise<PartDataConfig> => {
  try {
    const text = await getObjectText(PART_DATA_CONFIG_KEY);
    if (!text) return defaultPartDataConfig();
    const parsed = JSON.parse(text) as { fields?: Record<string, unknown> };
    const fields = allEnabled();
    if (parsed.fields && typeof parsed.fields === "object") {
      for (const f of PART_DATA_FIELDS) {
        if (typeof parsed.fields[f] === "boolean") fields[f] = parsed.fields[f] as boolean;
      }
    }
    return { fields };
  } catch {
    return defaultPartDataConfig();
  }
};

/** Persist the field-toggle config. Returns true if it was stored (R2 present). */
export const putPartDataConfig = async (config: PartDataConfig): Promise<boolean> => {
  if (!hasStorage()) return false;
  await writeJsonBlob(PART_DATA_CONFIG_KEY, config);
  return true;
};

/** Coerce arbitrary input into a sanitized config (known fields only). */
export const sanitizePartDataConfig = (raw: unknown): PartDataConfig => {
  const fields = allEnabled();
  const fieldsRaw =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? ((raw as { fields?: unknown }).fields ?? raw)
      : {};
  if (fieldsRaw && typeof fieldsRaw === "object") {
    const rec = fieldsRaw as Record<string, unknown>;
    for (const f of PART_DATA_FIELDS) {
      if (typeof rec[f] === "boolean") fields[f] = rec[f] as boolean;
    }
  }
  return { fields };
};
