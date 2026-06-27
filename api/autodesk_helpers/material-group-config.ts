/**
 * Manual materialId -> group-label mapping, stored in R2 at
 * config/material-groups.json so it's editable from the admin page without a
 * redeploy.
 *
 * The "group" (e.g. "Steel", "Aluminium", "Tool Steel") is the widget's
 * material-family heading. DigiFabster's widget-technologies catalog does NOT
 * carry it (that endpoint only has the technology title + the material grade
 * title), so the family is maintained here by hand and looked up by materialId
 * in /api/digifabster-part-data.
 */
import { getObjectText, hasStorage, writeJsonBlob } from "../embed_helpers/blob-storage";

export const MATERIAL_GROUP_CONFIG_KEY = "config/material-groups.json";

export interface MaterialGroupConfig {
  /** materialId (as a string key) -> group label. */
  groups: Record<string, string>;
}

export const defaultMaterialGroupConfig = (): MaterialGroupConfig => ({ groups: {} });

/** Coerce arbitrary input into a sanitized { groups: { "<id>": "<label>" } }. */
export const sanitizeMaterialGroupConfig = (raw: unknown): MaterialGroupConfig => {
  const groupsRaw =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? ((raw as { groups?: unknown }).groups ?? raw)
      : {};
  const groups: Record<string, string> = {};
  if (groupsRaw && typeof groupsRaw === "object" && !Array.isArray(groupsRaw)) {
    for (const [key, value] of Object.entries(groupsRaw as Record<string, unknown>)) {
      // Keys must be positive-integer material ids; labels non-empty strings.
      const id = Number(key);
      if (!Number.isInteger(id) || id <= 0) continue;
      if (typeof value === "string" && value.trim()) groups[String(id)] = value.trim();
    }
  }
  return { groups };
};

/** Read the mapping from R2; defaults to an empty map. */
export const getMaterialGroupConfig = async (): Promise<MaterialGroupConfig> => {
  try {
    const text = await getObjectText(MATERIAL_GROUP_CONFIG_KEY);
    if (!text) return defaultMaterialGroupConfig();
    return sanitizeMaterialGroupConfig(JSON.parse(text));
  } catch {
    return defaultMaterialGroupConfig();
  }
};

/** Persist the mapping. Returns true if it was stored (R2 present). */
export const putMaterialGroupConfig = async (config: MaterialGroupConfig): Promise<boolean> => {
  if (!hasStorage()) return false;
  await writeJsonBlob(MATERIAL_GROUP_CONFIG_KEY, config);
  return true;
};

/** Look up a material's group label (null when unmapped). */
export const lookupMaterialGroup = (config: MaterialGroupConfig, materialId: number): string | null =>
  config.groups[String(materialId)] ?? null;
