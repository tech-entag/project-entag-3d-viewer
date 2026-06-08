import {
  buildDigifabsterHeaders,
  buildPriceTweakerUrl,
  fetchDigifabsterJson,
  getPriceTweakerCache,
  putPriceTweakerCache,
  resolveDefaultTechnologySlug,
  resolvePriceTweakingEndpoint,
} from "./autodesk_helpers/digifabster-sync";

export const config = {
  maxDuration: 60,
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const buildCorsHeaders = (req?: Request): Record<string, string> => {
  const origin = req?.headers.get("origin")?.trim();

  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-vercel-protection-bypass",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
};

const json = (payload: unknown, status = 200, req?: Request) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...buildCorsHeaders(req),
    },
  });

const parseBody = async (req: Request) => {
  try {
    return await req.json();
  } catch {
    return null;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const positiveInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const firstNonEmptyString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const toSingleString = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) return value.trim();

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) return item.trim();
    }
  }

  return null;
};

const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    return value
      .split(/[|;]/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  return [];
};

const normalizeText = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u00B5\u03BC]/g, "u")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

const normalizeMaterialTitleForMatch = (value: string) =>
  normalizeText(value)
    .replace(/\bcopy\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

const looksLikeUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const isNoSelectionLabel = (label: string) => {
  const normalized = normalizeText(label);
  return normalized === "as machined" || normalized === "standard" || normalized === "none";
};

const asStringOptionField = (record: Record<string, unknown>, key: string): string | null => {
  const raw = record[key];
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim();
};

/* ------------------------------------------------------------------ */
/*  Bubble ↔ DigiFabster Terminology Mapping                          */
/*  Maps Bubble's field labels → exact DigiFabster catalog values.    */
/*  Keys are normalizeText(bubbleLabel). Values are EXACT DigiFabster */
/*  titles as returned by /v2/machines_materials/ and price_tweaker.  */
/*  ONLY values that exist in the live catalog belong here.           */
/* ------------------------------------------------------------------ */

interface TerminologyMappingType {
  materials: Record<string, string>;
  tolerances: Record<string, string>;
  postproduction: Record<string, string>;
}

const BUBBLE_TO_DIGIFABSTER_MAPPING: TerminologyMappingType = {
  /* ── Materials ──
     Exact titles from GET /v2/machines_materials/ across active machines:
       3-axis milling Cost Pricing (44270):
         St52 Cost, 42CrMo4 / 1.7225,
         Bohler K110 / 1.2379 / SVERKER, Bohler M201 / 1.2311 / P20,
         Bohler M238 / 1.2738 / 718, Bohler M303 / 1.2316mod,
         Bohler M300 / 1.2316, Bohler M310 / STAVAX / S136 / 1.2083,
         Bohler M314 / 1.2085 / RAMAX, Bohler M333 / SUPREME,
         Bohler W300 / 1.2343 / ORVAR / AISI H11, Bohler W302 / 1.2344 / AISI H13
       Sheet Metal (44577):
         Aluminium 1050, Aluminium 5083, Aluminium 5074,
         Aluminium 6061, Aluminium 6082, Aluminium 7075,
         SS201, SS304, SS304L, SS316, SS316L,
         St37 / S235JR / 1.0570
       Turning 2 (44590): same as 3-axis milling but with " copy" suffix
       Legacy inactive machine materials still present in catalog:
         St52, Hardened Tool Steel
  */
  materials: {
    // --- Aluminium (Sheet Metal) ---
    "aluminium 1050": "Aluminium 1050",
    "aluminium 5074": "Aluminium 5074",
    "aluminium 5083": "Aluminium 5083",
    "aluminium 6061": "Aluminium 6061",
    "aluminium 6082": "Aluminium 6082",
    "aluminium 7075": "Aluminium 7075",
    // --- Stainless steel (Sheet Metal) ---
    "ss201": "SS201",
    "ss304": "SS304",
    "ss304l": "SS304L",
    "ss316": "SS316",
    "ss316l": "SS316L",
    // --- Structural steel (Sheet Metal) ---
    "st37 s235jr 1.0570": "St37 / S235JR / 1.0570",
    // --- Steels (3-axis milling / Turning 2) ---
    "st52": "St52 Cost",
    "st52 cost": "St52 Cost",
    "st52 s355j2": "St52 Cost",
    "st52 legacy": "St52",
    "hardened tool steel": "Hardened Tool Steel",
    "42crmo4 1.7225": "42CrMo4 / 1.7225",
    // --- Bohler / tool steels (3-axis milling / Turning 2) ---
    "bohler k110 1.2379 sverker": "Bohler K110 / 1.2379 / SVERKER",
    "1.2379 bohler k110": "Bohler K110 / 1.2379 / SVERKER",
    "bohler m201 1.2311 p20": "Bohler M201 / 1.2311 / P20",
    "1.2311 bohler m201": "Bohler M201 / 1.2311 / P20",
    "bohler m238 1.2738 718": "Bohler M238 / 1.2738 / 718",
    "1.2738 bohler m238": "Bohler M238 / 1.2738 / 718",
    "bohler m303 1.2316mod": "Bohler M303 / 1.2316mod",
    "1.2316mod bohler m303": "Bohler M303 / 1.2316mod",
    "bohler m300 1.2316": "Bohler M300 / 1.2316",
    "1.2316 bohler m300": "Bohler M300 / 1.2316",
    "bohler m310 stavax s136 1.2083": "Bohler M310 / STAVAX / S136 / 1.2083",
    "1.2083 bohler m310 stavax": "Bohler M310 / STAVAX / S136 / 1.2083",
    "bohler m314 1.2085 ramax": "Bohler M314 / 1.2085 / RAMAX",
    "1.2085 bohler m314 ramax": "Bohler M314 / 1.2085 / RAMAX",
    "bohler m333 supreme": "Bohler M333 / SUPREME",
    "bohler w300 1.2343 orvar aisi h11": "Bohler W300 / 1.2343 / ORVAR / AISI H11",
    "1.2343 bohler w300 aisi h11": "Bohler W300 / 1.2343 / ORVAR / AISI H11",
    "bohler w302 1.2344 aisi h13": "Bohler W302 / 1.2344 / AISI H13",
    "1.2344 bohler w302 aisi h13": "Bohler W302 / 1.2344 / AISI H13",
  } as Record<string, string>,

  /* ── Tolerances ──
     Exact titles from price_tweaker response:
       3-axis milling: "ISO 2768-Stanard", "ISO 28768-Fine (Require Drawings)", "ISO 2768-Course"
       Turning 2:      "ISO 2768-Stanard", "ISO 2768-Fine(Requires Drawings)", "ISO 2768-Course"
       Sheet Metal:    (none)
     Note: DigiFabster has typos ("Stanard", "28768", "Course") — we map to these exact values.
  */
  tolerances: {
    // Bubble "ISO 2768 - Medium (Standard)" → DigiFabster "ISO 2768-Stanard"
    "iso 2768 medium standard": "ISO 2768-Stanard",
    "iso 2768 standard": "ISO 2768-Stanard",
    "medium standard": "ISO 2768-Stanard",
    // Bubble "Fine - requires 2D drawings" → DigiFabster fine variants
    "iso 2768 fine": "ISO 28768-Fine (Require Drawings)",
    "fine requires 2d drawings": "ISO 28768-Fine (Require Drawings)",
    "fine require drawings": "ISO 28768-Fine (Require Drawings)",
    // Bubble "Coarse" → DigiFabster "ISO 2768-Course"
    "iso 2768 coarse": "ISO 2768-Course",
    "iso 2768 course": "ISO 2768-Course",
    "coarse": "ISO 2768-Course",
    "course": "ISO 2768-Course",
  } as Record<string, string>,

  /* ── Post-production ──
     Exact titles from price_tweaker response across active machines:
       3-axis milling / Turning 2: Polishing, Measurement report,
         Electroless Nickel Plating, Galvanizing, Powder Coating,
         Bead Blasting, CMM, First Article Inspection Report (FAIR),
         Heat Treating, Standard (3.2um RA), Smooth (1.6um RA),
         Fine (0.8um RA), Testing, Grinding (Turning 2 only)
       Sheet Metal: Polishing, Grinding
  */
  postproduction: {
    // Inspection
    "cmm": "CMM",
    "first article inspection report fair": "First Article Inspection Report (FAIR)",
    "fair": "First Article Inspection Report (FAIR)",
    "measurement report": "Measurement report",
    // Roughness
    "standard 3.2 um ra": "Standard (3.2um RA)",
    "standard 3.2um ra": "Standard (3.2um RA)",
    "smooth 1.6 um ra": "Smooth (1.6um RA)",
    "smooth 1.6um ra": "Smooth (1.6um RA)",
    "fine 0.8 um ra": "Fine (0.8um RA)",
    "fine 0.8um ra": "Fine (0.8um RA)",
    // Finish / surface treatment
    "polishing": "Polishing",
    "grinding": "Grinding",
    "electroless nickel plating": "Electroless Nickel Plating",
    "galvanizing": "Galvanizing",
    "powder coating": "Powder Coating",
    "bead blasting": "Bead Blasting",
    "heat treating": "Heat Treating",
    "testing": "Testing",
  } as Record<string, string>,
};

/** Apply Bubble → DigiFabster terminology mapping */
const applyTerminologyMapping = (bubbleValue: string, mappingType: keyof TerminologyMappingType): string => {
  if (!bubbleValue) return bubbleValue;
  const normalized = normalizeText(bubbleValue);
  const mapping = BUBBLE_TO_DIGIFABSTER_MAPPING[mappingType] || {};

  // Exact match first (after normalization)
  for (const [bubbleKey, digifabsterValue] of Object.entries(mapping)) {
    if (normalizeText(bubbleKey) === normalized) {
      return digifabsterValue as string;
    }
  }

  // Prefix match (for partial matches)
  for (const [bubbleKey, digifabsterValue] of Object.entries(mapping)) {
    if (normalized.includes(normalizeText(bubbleKey)) || normalizeText(bubbleKey).includes(normalized)) {
      return digifabsterValue as string;
    }
  }

  // Fall back to original value if no mapping found
  return bubbleValue;
};

const resolveToleranceIdByText = (tolerances: unknown[], toleranceLabel: string): string | null => {
  const target = normalizeText(toleranceLabel);
  if (!target) return null;

  const records = tolerances
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));

  const getLabels = (record: Record<string, unknown>) =>
    [
      asStringOptionField(record, "name_for_user"),
      asStringOptionField(record, "display_name"),
      asStringOptionField(record, "name"),
    ].filter((v): v is string => Boolean(v));

  // 1. Try the mapping — it maps Bubble labels to exact DigiFabster tolerance titles
  const mappedTitle = applyTerminologyMapping(toleranceLabel, "tolerances");
  if (mappedTitle !== toleranceLabel) {
    const mappedNorm = normalizeText(mappedTitle);
    const byMapped = records.find((record) =>
      getLabels(record).some((label) => normalizeText(label) === mappedNorm)
    );
    if (typeof byMapped?.id === "string") return byMapped.id;
  }

  // 2. Try exact match of normalized input against tolerance labels
  const byExact = records.find((record) =>
    getLabels(record).some((label) => normalizeText(label) === target)
  );
  if (typeof byExact?.id === "string") return byExact.id;

  // 3. Tier-based fallback — detect tier from Bubble input and match best option
  const isFine = target.includes("fine") || target.includes("tight") || target.includes("require");
  const isCoarse = target.includes("course") || target.includes("coarse");
  const isStandard = !isFine && !isCoarse && (target.includes("standard") || target.includes("medium"));

  if (isFine) {
    const record = records.find((r) =>
      getLabels(r).some((l) => { const n = normalizeText(l); return n.includes("fine") || n.includes("tighter"); })
    );
    if (typeof record?.id === "string") return record.id;
  }

  if (isCoarse) {
    const record = records.find((r) =>
      getLabels(r).some((l) => { const n = normalizeText(l); return n.includes("course") || n.includes("coarse"); })
    );
    if (typeof record?.id === "string") return record.id;
  }

  if (isStandard) {
    const notTighter = records.find((r) =>
      getLabels(r).some((l) => {
        const n = normalizeText(l);
        return (n.includes("standard") || n.includes("stanard") || n.includes("medium")) && !n.includes("tighter");
      })
    );
    if (typeof notTighter?.id === "string") return notTighter.id;
  }

  return null;
};

const resolvePostproductionIdsByText = (postproduction: unknown[], requestedLabels: string[]) => {
  const records = postproduction
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));

  const ids: string[] = [];
  const unresolved: string[] = [];

  for (const label of requestedLabels) {
    if (isNoSelectionLabel(label)) continue;

    const target = normalizeText(label);
    const byExact = records.find((record) => {
      const title = asStringOptionField(record, "title");
      return title ? normalizeText(title) === target : false;
    });

    const byLoose =
      byExact ??
      records.find((record) => {
        const title = asStringOptionField(record, "title");
        if (!title) return false;
        const normalizedTitle = normalizeText(title);
        return normalizedTitle.includes(target) || target.includes(normalizedTitle);
      });

    if (typeof byLoose?.id === "string") {
      ids.push(byLoose.id);
    } else {
      unresolved.push(label);
    }
  }

  return { ids: Array.from(new Set(ids)), unresolved };
};

const extractTotalPerPartPrice = (payload: unknown): number | null => {
  const root = asRecord(payload);
  if (!root) return null;

  const data = asRecord(root.data) ?? root;
  const prices = asRecord(data.prices);
  const total = prices?.total_per_part_price;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
};

const extractTotalHoles = (payload: unknown): number => {
  const root = asRecord(payload);
  if (!root) return 0;

  const data = asRecord(root.data) ?? root;
  const modelValues = asRecord(data.model_values);
  const features = Array.isArray(modelValues?.dfm_features_list) ? modelValues.dfm_features_list : [];

  return features.reduce((count, feature) => {
    const rec = asRecord(feature);
    if (!rec) return count;

    const type = typeof rec.type === "string" ? normalizeText(rec.type) : "";
    const properties = asRecord(rec.properties);
    const topology = typeof properties?.topology_type === "string" ? normalizeText(properties.topology_type) : "";

    if (type.includes("hole") || topology === "hole") return count + 1;
    return count;
  }, 0);
};

const toTechSlugFromTitle = (title: string): string | null => {
  const normalized = normalizeText(title);
  if (!normalized) return null;

  if (normalized.includes("3 axis milling")) return "3-axis-milling";
  if (normalized.includes("4 axis milling")) return "4-axis-milling";
  if (normalized.includes("multi axis milling")) return "multi-axis-milling";
  if (normalized.includes("sheet metal")) return "cnc-sheetmetal";
  if (normalized.includes("tube cutting")) return "cnc-tube-cutting";
  if (normalized.includes("cnc cutter") || normalized.includes("laser cutting") || normalized.includes("waterjet")) return "cnc-cutter";
  if (normalized.includes("turning")) return "turning";
  if (normalized.includes("welding")) return "welding";
  if (normalized.includes("fdm")) return "fdm";
  if (normalized.includes("sla")) return "sla";
  if (normalized.includes("sls")) return "sls";
  if (normalized.includes("slm")) return "slm";
  if (normalized.includes("polyjet")) return "polyjet";
  if (normalized.includes("multijet")) return "multijet";
  if (normalized.includes("hp mjf") || normalized.includes("hp-mjf") || normalized.includes("mjf")) return "hp-mjf";
  if (normalized.includes("3dp") || normalized.includes("binder jet")) return "3dp";

  return null;
};

const toCatalogRows = (catalog: unknown[]): Record<string, unknown>[] =>
  catalog
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));

const pickMachineRow = (
  rows: Record<string, unknown>[],
  machineId: number | null,
  machineLabel: string | null,
): Record<string, unknown> | null => {
  if (machineId) {
    const byId = rows.find((row) => positiveInt(row.id) === machineId);
    if (byId) return byId;
  }

  if (!machineLabel) return null;

  const target = normalizeText(machineLabel);
  const byTitle = rows.find((row) => {
    const title = asStringOptionField(row, "title");
    return title ? normalizeText(title) === target : false;
  });
  if (byTitle) return byTitle;

  const byLoose = rows.find((row) => {
    const title = asStringOptionField(row, "title");
    if (!title) return false;
    const normalizedTitle = normalizeText(title);
    return normalizedTitle.includes(target) || target.includes(normalizedTitle);
  });
  if (byLoose) return byLoose;

  const cncRequested = target.includes("cnc") || target.includes("machining");
  const sheetRequested = target.includes("sheet");

  const byGroup = rows.find((row) => {
    const title = asStringOptionField(row, "title");
    if (!title) return false;
    const normalizedTitle = normalizeText(title);
    if (sheetRequested) return normalizedTitle.includes("sheet metal");
    if (cncRequested) return normalizedTitle.includes("3 axis milling") || normalizedTitle.includes("milling");
    return false;
  });
  if (byGroup) return byGroup;

  return null;
};

const findMaterialInMachineRow = (
  machineRow: Record<string, unknown> | null,
  requestedLabel: string,
): { materialId: number; materialTitle: string } | null => {
  if (!machineRow || !requestedLabel) return null;

  const target = normalizeText(requestedLabel);
  const targetVariant = normalizeMaterialTitleForMatch(requestedLabel);
  if (!target) return null;

  const materials = Array.isArray(machineRow.materials) ? machineRow.materials : [];
  for (const material of materials) {
    const row = asRecord(material);
    if (!row) continue;

    const title = asStringOptionField(row, "title");
    const id = positiveInt(row.id);
    if (!title || !id) continue;

    const normalizedTitle = normalizeText(title);
    if (normalizedTitle === target) {
      return { materialId: id, materialTitle: title };
    }

    const titleVariant = normalizeMaterialTitleForMatch(title);
    if (titleVariant && titleVariant === targetVariant) {
      return { materialId: id, materialTitle: title };
    }
  }

  // Loose fallback for legacy labels and mild formatting drift.
  for (const material of materials) {
    const row = asRecord(material);
    if (!row) continue;

    const title = asStringOptionField(row, "title");
    const id = positiveInt(row.id);
    if (!title || !id) continue;

    const titleVariant = normalizeMaterialTitleForMatch(title);
    if (!titleVariant || !targetVariant) continue;

    if (titleVariant.includes(targetVariant) || targetVariant.includes(titleVariant)) {
      return { materialId: id, materialTitle: title };
    }
  }

  return null;
};

const findMaterialAcrossCatalog = (
  rows: Record<string, unknown>[],
  requestedLabel: string,
): { machineRow: Record<string, unknown>; materialId: number; materialTitle: string } | null => {
  if (!requestedLabel) return null;

  for (const row of rows) {
    const matched = findMaterialInMachineRow(row, requestedLabel);
    if (matched) {
      return {
        machineRow: row,
        materialId: matched.materialId,
        materialTitle: matched.materialTitle,
      };
    }
  }

  return null;
};

const listAllCatalogMaterials = (rows: Record<string, unknown>[]): string[] => {
  const set = new Set<string>();

  for (const row of rows) {
    const materials = Array.isArray(row.materials) ? row.materials : [];
    for (const material of materials) {
      const materialRow = asRecord(material);
      if (!materialRow) continue;
      const title = asStringOptionField(materialRow, "title");
      if (!title) continue;
      set.add(title);
    }
  }

  return Array.from(set).sort((a, b) => a.localeCompare(b));
};

const pickMaterialId = (
  machineRow: Record<string, unknown> | null,
  materialId: number | null,
  materialLabel: string | null,
): number | null => {
  if (materialId) return materialId;
  if (!machineRow || !materialLabel) return null;

  // Apply Bubble → DigiFabster terminology mapping
  const mappedLabel = applyTerminologyMapping(materialLabel, "materials");
  const byMapped = findMaterialInMachineRow(machineRow, mappedLabel);
  if (byMapped) return byMapped.materialId;

  // Fallback: caller may already send DigiFabster's exact material title.
  const byRaw = findMaterialInMachineRow(machineRow, materialLabel);
  return byRaw?.materialId ?? null;
};

const inferTechnologySlugFromCatalog = (
  catalog: unknown[],
  machineId: number,
  materialId: number | null,
): string | null => {
  const rows = catalog
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));

  const machineRow = rows.find((row) => {
    const id = positiveInt(row.id);
    if (id !== machineId) return false;

    if (!materialId) return true;
    const materials = Array.isArray(row.materials) ? row.materials : [];
    return materials.some((m) => positiveInt(asRecord(m)?.id) === materialId);
  });

  if (!machineRow) return null;
  const title = typeof machineRow.title === "string" ? machineRow.title : "";
  return toTechSlugFromTitle(title);
};

/** Fields from a GET machine/material response that must NOT appear
 *  in the price_tweaker POST body (they cause 500 server errors). */
const MACHINE_STRIP = new Set(["id", "active", "printer_preset"]);
const MATERIAL_STRIP = new Set([
  "id", "active", "image", "printer_name", "material_preset",
  "vendors", "programming_cost_recurring",
]);

const stripKeys = (obj: Record<string, unknown>, keys: Set<string>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.has(k)) out[k] = v;
  }
  return out;
};

/* ------------------------------------------------------------------ */
/*  GET — discovery / catalog                                         */
/* ------------------------------------------------------------------ */

export async function GET(_req: Request) {
  try {
    const headers = await buildDigifabsterHeaders();
    const { ok, status, data } = await fetchDigifabsterJson("/v2/machines_materials/", headers);

    if (!ok) {
      return json({ success: false, error: "Failed to fetch machines_materials catalog", upstream: { status, data } }, 502, _req);
    }

    return json({
      success: true,
      defaultTechnologySlug: resolveDefaultTechnologySlug(),
      bubbleStaticPayloadTemplate: {
        objectModelId: 0,
        machineId: 0,
        materialId: 0,
        count: 1,
        tightest_tolerance: null,
        inspection: null,
        roughness: null,
        finish: null,
      },
      machinesMaterials: data,
    }, 200, _req);
  } catch (error) {
    console.error("GET digifabster-price-tweak error:", error);
    return json({ error: "Failed to fetch catalog" }, 500, _req);
  }
}

export async function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(req),
  });
}

/* ------------------------------------------------------------------ */
/*  POST — price_tweaker flow                                         */
/* ------------------------------------------------------------------ */

export async function POST(req: Request) {
  try {
    const body = await parseBody(req);
    if (!body) return json({ error: "Invalid JSON body" }, 400, req);

    const {
      objectModelId, object_model_id,
      machineId, machine_id,
      materialId, material_id,
      technologySlug, technology_slug,
      machine,
      machineName, machine_name,
      materialName, material_name,
      count,
      is_non_recurring_cost_included,
      toleranceIndex, tolerance_index,
      priorityIndex, priority_index,
      priceConfig, price_config,
      /* backward-compat: caller may send full objects */
      material: rawMaterial,
      printer: rawPrinter,
      tightestTolerance,
      tightest_tolerance,
      inspection,
      roughness,
      finish,
      postProduction,
      post_production,
      /* cache control */
      skipCache,
    } = body as Record<string, unknown>;

    /* ---- Resolve IDs ---- */
    const modelId = positiveInt(objectModelId) ?? positiveInt(object_model_id);
    let machId = positiveInt(machineId) ?? positiveInt(machine_id);
    let matId = positiveInt(materialId) ?? positiveInt(material_id);

    const machineLabel =
      firstNonEmptyString(machine, machineName, machine_name, rawPrinter);

    const materialLabel =
      firstNonEmptyString(materialName, material_name, rawMaterial);

    const explicitTechSlug =
      (typeof technologySlug === "string" && technologySlug.trim()) ||
      (typeof technology_slug === "string" && technology_slug.trim()) ||
      "";

    let techSlug = explicitTechSlug || resolveDefaultTechnologySlug();

    if (!modelId) {
      return json({
        error: "Missing required field: objectModelId (positive integer)",
        hint: "Provide the DigiFabster object model ID from a previous upload.",
      }, 400, req);
    }

    const headers = await buildDigifabsterHeaders();

    const explicitMachineId = positiveInt(machineId) ?? positiveInt(machine_id);

    if (!explicitTechSlug || !machId || !matId || machineLabel || materialLabel) {
      const machineCatalog = await fetchDigifabsterJson("/v2/machines_materials/", headers);
      if (machineCatalog.ok && Array.isArray(machineCatalog.data)) {
        const catalogRows = toCatalogRows(machineCatalog.data);
        let resolvedMachineRow = pickMachineRow(catalogRows, machId, machineLabel);

        if (!machId) {
          machId = positiveInt(resolvedMachineRow?.id);
        }

        if (!matId && materialLabel) {
          const mappedMaterialLabel = applyTerminologyMapping(materialLabel, "materials");
          const byMapped = findMaterialAcrossCatalog(catalogRows, mappedMaterialLabel);
          const byRaw = normalizeText(mappedMaterialLabel) === normalizeText(materialLabel)
            ? null
            : findMaterialAcrossCatalog(catalogRows, materialLabel);
          const globalMaterialMatch = byMapped ?? byRaw;

          if (!globalMaterialMatch) {
            return json({
              error: "Requested material is not available in DigiFabster catalog.",
              details: {
                requested: materialLabel,
                mapped: mappedMaterialLabel,
                available: listAllCatalogMaterials(catalogRows),
              },
            }, 400, req);
          }

          const inResolvedMachine = pickMaterialId(resolvedMachineRow, null, materialLabel);
          if (inResolvedMachine) {
            matId = inResolvedMachine;
          } else if (explicitMachineId) {
            const availableForMachine = Array.isArray(resolvedMachineRow?.materials)
              ? resolvedMachineRow.materials
                  .map((item) => asRecord(item))
                  .filter((item): item is Record<string, unknown> => Boolean(item))
                  .map((item) => asStringOptionField(item, "title"))
                  .filter((title): title is string => Boolean(title))
              : [];

            return json({
              error: "Requested material is not available for the selected machine.",
              details: {
                requested: materialLabel,
                mapped: mappedMaterialLabel,
                selectedMachineId: machId,
                selectedMachineTitle: resolvedMachineRow ? asStringOptionField(resolvedMachineRow, "title") : null,
                availableForSelectedMachine: availableForMachine,
              },
            }, 400, req);
          } else {
            resolvedMachineRow = globalMaterialMatch.machineRow;
            machId = positiveInt(globalMaterialMatch.machineRow.id);
            matId = globalMaterialMatch.materialId;
          }
        }

        const inferred = machId ? inferTechnologySlugFromCatalog(catalogRows, machId, matId) : null;
        if (inferred && !explicitTechSlug) {
          techSlug = inferred;
        }
      }
    }
    let fromCache = false;

    /* ---- Try cache first (if IDs provided, no full objects, no skipCache) ---- */
    let machineData: Record<string, unknown> | null = asRecord(rawPrinter);
    let materialData: Record<string, unknown> | null = asRecord(rawMaterial);
    let tolerances: unknown[] = [];
    let priorities: unknown[] = [];
    let postproduction: unknown[] = [];

    if (!machineData && !materialData && machId && matId && !skipCache) {
      const cached = await getPriceTweakerCache(techSlug, machId, matId);
      if (cached) {
        machineData = cached.machine;
        materialData = cached.material;
        tolerances = cached.tolerances;
        priorities = cached.priorities;
        postproduction = cached.postproduction;
        fromCache = true;
      }
    }

    /* ---- Resolve machine (printer) — fetch on cache miss ---- */
    let rawMachineForMeta: Record<string, unknown> | null = null;
    if (!machineData && machId) {
      const res = await fetchDigifabsterJson(
        `/v2/machines/${encodeURIComponent(techSlug)}/${machId}/`,
        headers,
      );
      if (!res.ok) {
        return json({
          error: `Failed to fetch machine ${machId}`,
          upstream: { status: res.status, data: res.data },
        }, 502, req);
      }
      rawMachineForMeta = asRecord(res.data);
      machineData = rawMachineForMeta;
    }
    if (!machineData) {
      return json({
        error: "Missing machineId (or a full printer object)",
        hint: "Provide machineId to auto-fetch, or pass full printer object.",
      }, 400, req);
    }

    /* ---- Resolve material — fetch on cache miss ---- */
    let rawMaterialForMeta: Record<string, unknown> | null = null;
    if (!materialData && matId) {
      const res = await fetchDigifabsterJson(
        `/v2/materials/${encodeURIComponent(techSlug)}/${matId}/`,
        headers,
      );
      if (!res.ok) {
        return json({
          error: `Failed to fetch material ${matId}`,
          upstream: { status: res.status, data: res.data },
        }, 502, req);
      }
      rawMaterialForMeta = asRecord(res.data);
      materialData = rawMaterialForMeta;
    }
    if (!materialData) {
      const availableMaterials = Array.isArray(machineData.materials)
        ? machineData.materials
            .map((item) => asRecord(item))
            .filter((item): item is Record<string, unknown> => Boolean(item))
            .map((item) => asStringOptionField(item, "title"))
            .filter((title): title is string => Boolean(title))
        : [];

      return json({
        error: "Missing materialId (or a full material object)",
        hint: "Provide materialId to auto-fetch, or pass full material object.",
        details: {
          requestedMaterial: materialLabel,
          resolvedMachineId: machId,
          resolvedMachineTitle: asStringOptionField(machineData, "title"),
          availableMaterials,
        },
      }, 400, req);
    }

    /* ---- Strip read-only fields ---- */
    const cleanMachine = fromCache ? machineData : stripKeys(machineData, MACHINE_STRIP);
    const cleanMaterial = fromCache ? materialData : stripKeys(materialData, MATERIAL_STRIP);

    /* ---- Extract metadata from raw objects (only if freshly fetched) ---- */
    if (!fromCache) {
      tolerances = Array.isArray(machineData.tolerances) ? machineData.tolerances : [];
      priorities = Array.isArray(machineData.priorities) ? machineData.priorities : [];
      postproduction = Array.isArray(materialData.postproduction) ? materialData.postproduction : [];
    }

    /* ---- Persist to cache (background, non-blocking) ---- */
    if (!fromCache && machId && matId) {
      putPriceTweakerCache({
        technologySlug: techSlug,
        machineId: machId,
        materialId: matId,
        machine: stripKeys(machineData, MACHINE_STRIP),
        material: stripKeys(materialData, MATERIAL_STRIP),
        tolerances,
        priorities,
        postproduction,
        storedAt: new Date().toISOString(),
      }).catch(() => {/* non-fatal */});
    }

    /* ---- Build price_config ---- */
    const tolIdx = positiveInt(toleranceIndex ?? tolerance_index) ?? 0;
    const priIdx = positiveInt(priorityIndex ?? priority_index) ?? 0;

    const callerPriceConfig = asRecord(priceConfig) ?? asRecord(price_config);
    const configObject = asRecord((body as Record<string, unknown>).config);

    const toleranceLabel = firstNonEmptyString(
      callerPriceConfig?.tightest_tolerance,
      callerPriceConfig?.tightestTolerance,
      tightest_tolerance,
      tightestTolerance,
      configObject?.tightest_tolerance,
      configObject?.tightestTolerance,
    );

    // Apply Bubble → DigiFabster terminology mapping for tolerance
    // Use the raw Bubble label directly — terminology mapping converts descriptive words to abbreviations
    // (e.g. "Medium (Standard)" → "ISO 2768-m") which strips the tier-detection keywords resolveToleranceIdByText needs.
    const toleranceIdFromText = toleranceLabel ? resolveToleranceIdByText(tolerances, toleranceLabel) : null;
    const availableToleranceLabels = tolerances.map((t: unknown) => {
      const rec = (asRecord(t) || {}) as Record<string, unknown>;
      return rec.name_for_user ?? rec.display_name ?? rec.name;
    }).filter(Boolean);

    // Some DigiFabster machine/material combinations have no tolerance options exposed.
    // In that case, keep going without forcing a tolerance ID from text.
    if (toleranceLabel && !toleranceIdFromText && availableToleranceLabels.length > 0) {
      return json({
        error: "Failed to resolve tightest tolerance from text.",
        details: {
          requested: toleranceLabel,
          available: availableToleranceLabels,
        },
      }, 400, req);
    }

    const explicitPostproductionIds = [
      ...toStringArray(callerPriceConfig?.selected_postproduction),
      ...toStringArray(callerPriceConfig?.post_production).filter(looksLikeUuid),
      ...toStringArray(callerPriceConfig?.postproduction).filter(looksLikeUuid),
    ];

    const inspectionValue =
      toSingleString(inspection) ??
      toSingleString(configObject?.inspection) ??
      toSingleString(callerPriceConfig?.inspection);

    const roughnessValue =
      toSingleString(roughness) ??
      toSingleString(configObject?.roughness) ??
      toSingleString(callerPriceConfig?.roughness);

    const finishValue =
      toSingleString(finish) ??
      toSingleString(configObject?.finish) ??
      toSingleString(callerPriceConfig?.finish);

    // Apply Bubble → DigiFabster terminology mappings for postproduction fields
    const mappedInspectionValue = inspectionValue ? applyTerminologyMapping(inspectionValue, "postproduction") : null;
    const mappedRoughnessValue = roughnessValue ? applyTerminologyMapping(roughnessValue, "postproduction") : null;
    const mappedFinishValue = finishValue ? applyTerminologyMapping(finishValue, "postproduction") : null;

    const postProductionValue =
      toSingleString(postProduction) ??
      toSingleString(post_production) ??
      toSingleString(configObject?.post_production) ??
      toSingleString(configObject?.postProduction) ??
      toSingleString(callerPriceConfig?.post_production) ??
      toSingleString(callerPriceConfig?.postproduction);

    if (finishValue && looksLikeUuid(finishValue)) {
      explicitPostproductionIds.push(finishValue);
    }

    if (postProductionValue && looksLikeUuid(postProductionValue)) {
      explicitPostproductionIds.push(postProductionValue);
    }

    const postproductionLabels = [mappedInspectionValue, mappedRoughnessValue]
      .concat(
        mappedFinishValue && !looksLikeUuid(mappedFinishValue) ? [mappedFinishValue] : [],
        postProductionValue && !looksLikeUuid(postProductionValue) ? [postProductionValue] : [],
      )
      .filter((v): v is string => Boolean(v));

    const { ids: mappedPostproductionIds, unresolved: unresolvedPostproduction } = resolvePostproductionIdsByText(
      postproduction,
      postproductionLabels,
    );

    const postproductionResolutionWarning = unresolvedPostproduction.length > 0
      ? {
          unresolved: unresolvedPostproduction,
          available: postproduction.map((pp: unknown) => {
            const rec = (asRecord(pp) || {}) as Record<string, unknown>;
            return rec.title;
          }).filter(Boolean),
        }
      : null;

    const finalSelectedPostproductionIds = Array.from(new Set([...explicitPostproductionIds, ...mappedPostproductionIds]));

    const resolvedTolerance =
      callerPriceConfig?.tolerance ??
      toleranceIdFromText ??
      (tolerances[tolIdx] as Record<string, unknown>)?.id ??
      (tolerances[0] as Record<string, unknown>)?.id ??
      null;

    const resolvedLeadTime =
      callerPriceConfig?.lead_time ??
      (priorities[priIdx] as Record<string, unknown>)?.id ??
      (priorities[0] as Record<string, unknown>)?.id ??
      null;

    const finalPriceConfig = {
      is_non_recurring_cost_included: callerPriceConfig?.is_non_recurring_cost_included ?? is_non_recurring_cost_included ?? true,
      count: positiveInt(callerPriceConfig?.count) ?? positiveInt(count) ?? 1,
      ...(resolvedTolerance ? { tolerance: resolvedTolerance } : {}),
      ...(resolvedLeadTime ? { lead_time: resolvedLeadTime } : {}),
      ...(callerPriceConfig ? Object.fromEntries(
        Object.entries(callerPriceConfig).filter(([k]) => ![
          "tolerance",
          "lead_time",
          "is_non_recurring_cost_included",
          "count",
          "selected_postproduction",
          "post_production",
          "postproduction",
          "tightest_tolerance",
          "tightestTolerance",
          "inspection",
          "roughness",
          "finish",
        ].includes(k))
      ) : {}),
      ...(finalSelectedPostproductionIds.length > 0
        ? { selected_postproduction: finalSelectedPostproductionIds }
        : {}),
    };

    /* ---- Build payload ---- */
    const payload = {
      price_config: finalPriceConfig,
      object_model_id: modelId,
      printer: cleanMachine,
      material: cleanMaterial,
    };

    /* ---- Resolve endpoint ---- */
    const explicitEndpoint = resolvePriceTweakingEndpoint();
    const endpoint = explicitEndpoint || buildPriceTweakerUrl(techSlug);

    /* ---- Call price_tweaker ---- */
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let data: unknown = null;
    if (responseText.trim()) {
      try {
        data = JSON.parse(responseText);
      } catch {
        data = { raw: responseText.slice(0, 2000) };
      }
    }

    if (!response.ok) {
      return json({
        error: "price_tweaker request failed",
        targetEndpoint: endpoint,
        upstreamStatus: response.status,
        details: data,
      }, response.status >= 500 ? 502 : response.status, req);
    }

    return json({
      status: "success",
      total_per_part_price: extractTotalPerPartPrice(data),
      total_holes: extractTotalHoles(data),
      ...(postproductionResolutionWarning
        ? {
            warnings: {
              skippedPostproductionLabels: postproductionResolutionWarning,
            },
          }
        : {}),
    }, 200, req);
  } catch (error) {
    console.error("POST digifabster-price-tweak error:", error);
    return json({ error: "Failed to process price tweaking request" }, 500, req);
  }
}
