/**
 * Shared access to the DigiFabster widget-technologies catalog cached in R2
 * (config/widget-technologies.json). Used by /api/digifabster-technologies and
 * /api/digifabster-suitable-materials to avoid duplicating the cache key and
 * material lookups.
 */
import { getObjectText, writeJsonBlob } from "../embed_helpers/blob-storage";
import {
  getDigifabsterWidgetTechnologies,
  type DigifabsterWidgetTechnologies,
} from "./digifabster-sync";

export const WIDGET_TECHNOLOGIES_KEY = "config/widget-technologies.json";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const optStr = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const optInt = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : null;
};

const optNum = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Load the catalog: cached R2 copy, else live-fetch from DigiFabster + store. */
export const loadWidgetTechnologies = async (
  traceId?: string,
): Promise<{ catalog: DigifabsterWidgetTechnologies; source: "cache" | "live" }> => {
  const cached = await getObjectText(WIDGET_TECHNOLOGIES_KEY);
  if (cached) {
    try {
      return { catalog: JSON.parse(cached) as DigifabsterWidgetTechnologies, source: "cache" };
    } catch {
      // corrupt cache -> fall through to a live fetch
    }
  }
  const catalog = await getDigifabsterWidgetTechnologies(traceId);
  await writeJsonBlob(WIDGET_TECHNOLOGIES_KEY, catalog); // best-effort
  return { catalog, source: "live" };
};

/** One post-production option, slimmed to the fields a dropdown needs. */
export interface PostProductionOption {
  id: string | null;
  title: string | null;
  price: number | null;
  priceUnits: string | null;
  priceMultiplier: number | null;
  setupCost: number | null;
  productionDays: number | null;
}

/** post_production options grouped by `group_title` (== the UI sections). */
export interface PostProductionGroup {
  group: string;
  options: PostProductionOption[];
}

/** A material enriched with its technology context + option lists from the catalog. */
export interface EnrichedMaterial {
  id: number;
  title: string | null;
  technologyId: number | null;
  technologyTitle: string | null;
  /** Sheet Thickness options. */
  thicknesses: unknown[];
  /** Tightest Tolerance options. */
  tolerance: unknown[];
  leadTime: unknown[];
  /** Configurable fieldsets (e.g. "Finish"). */
  extraFieldsets: unknown[];
  /**
   * Post-production grouped by `group_title` — maps to UI sections like
   * "Surface Roughness" (Max roughness/Ra), "Finishing", "Inspection",
   * "Part Marking".
   */
  postProductionGroups: PostProductionGroup[];
}

const slimPostProduction = (raw: unknown): { groupTitle: string; option: PostProductionOption } => {
  const r = asRecord(raw) ?? {};
  return {
    groupTitle: optStr(r.group_title) ?? "",
    option: {
      id: optStr(r.id),
      title: optStr(r.title),
      price: optNum(r.price),
      priceUnits: optStr(r.price_units),
      priceMultiplier: optNum(r.price_multiplier),
      setupCost: optNum(r.setup_cost),
      productionDays: optNum(r.production_days),
    },
  };
};

/** Group a material's post_production options by `group_title`. */
const groupPostProduction = (list: unknown[]): PostProductionGroup[] => {
  const groups = new Map<string, PostProductionOption[]>();
  for (const item of list) {
    const { groupTitle, option } = slimPostProduction(item);
    const existing = groups.get(groupTitle);
    if (existing) existing.push(option);
    else groups.set(groupTitle, [option]);
  }
  return Array.from(groups.entries()).map(([group, options]) => ({ group, options }));
};

/** A consistent fallback for a material id not present in the catalog. */
export const emptyMaterial = (id: number): EnrichedMaterial => ({
  id,
  title: null,
  technologyId: null,
  technologyTitle: null,
  thicknesses: [],
  tolerance: [],
  leadTime: [],
  extraFieldsets: [],
  postProductionGroups: [],
});

/** Build a materialId -> EnrichedMaterial index from the catalog's technologies. */
export const buildMaterialIndex = (results: unknown[]): Map<number, EnrichedMaterial> => {
  const index = new Map<number, EnrichedMaterial>();
  for (const tech of results) {
    const t = asRecord(tech);
    if (!t) continue;
    const technologyId = optInt(t.id ?? t.tech_id);
    const technologyTitle = optStr(t.title);
    for (const mat of arr(t.materials)) {
      const m = asRecord(mat);
      if (!m) continue;
      const id = optInt(m.id);
      if (id === null || index.has(id)) continue;
      index.set(id, {
        id,
        title: optStr(m.title),
        technologyId,
        technologyTitle,
        thicknesses: arr(m.thicknesses),
        tolerance: arr(m.tolerance),
        leadTime: arr(m.lead_time),
        extraFieldsets: arr(m.extra_fieldsets),
        postProductionGroups: groupPostProduction(arr(m.post_production)),
      });
    }
  }
  return index;
};
