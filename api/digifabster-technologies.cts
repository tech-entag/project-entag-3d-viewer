/**
 * GET/POST /api/digifabster-technologies
 *
 * The DigiFabster "widget technologies" master config catalog
 * (GET /v2/users/widget-technologies/), persisted to R2 so it can be shared
 * between Bubble and Cloudflare without hitting DigiFabster on every read.
 *
 *   GET                -> full cached catalog from R2 (config/widget-technologies.json).
 *                         Fetches live + stores on a cache miss. ?refresh=true forces it.
 *   GET ?category=...  -> Bubble category grouping. cnc-machining = milling + turning;
 *                         sheet-metal = cnc sheetmetal; tube = (none yet).
 *   GET ?tech=...      -> ONE technology only. Matches by id / tech_id, title
 *                         substring ("milling"/"turning"/"sheetmetal"), or slug.
 *   POST               -> always fetches fresh from DigiFabster, stores to R2, returns it.
 *
 * Response (full):        { source, count, fetchedAt, results: [...] }
 * Response (?category=):  { source, fetchedAt, category, count, technologies: [...] }
 * Response (?tech=):      { source, fetchedAt, count: 1, tech, technology: {...} }
 *
 * Bubble reads the catalog via GET; Cloudflare routes can read the same R2
 * object directly (config/widget-technologies.json) to resolve config UUIDs.
 */
import {
  DigifabsterSyncError,
  getDigifabsterWidgetTechnologies,
  type DigifabsterWidgetTechnologies,
} from "./autodesk_helpers/digifabster-sync";
import { getObjectText, writeJsonBlob } from "./embed_helpers/blob-storage";

export const config = {
  maxDuration: 60,
};

export const WIDGET_TECHNOLOGIES_KEY = "config/widget-technologies.json";

/* ------------------------------------------------------------------ */
/*  HTTP helpers                                                      */
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
    headers: { "Content-Type": "application/json", ...buildCorsHeaders(req) },
  });

const isTruthyParam = (value: string | null): boolean =>
  value !== null && ["1", "true", "yes"].includes(value.trim().toLowerCase());

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Bubble's customer-facing categories -> the DigiFabster technologies they map
 * to (matched by title substring against the catalog). `aliases` lets Bubble
 * send any reasonable spelling; `techs` is the list of technology matchers.
 */
const CATEGORY_MAP: Array<{ key: string; aliases: string[]; techs: string[] }> = [
  { key: "cnc-machining", aliases: ["cnc-machining", "cnc machining", "cnc", "machining"], techs: ["milling", "turning"] },
  { key: "sheet-metal", aliases: ["sheet-metal", "sheet metal", "sheetmetal", "sheet-metal-fabrication"], techs: ["sheetmetal"] },
  { key: "tube", aliases: ["tube", "tube-fabrication", "tube fabrication"], techs: ["tube"] },
];

const resolveCategory = (query: string): { key: string; techs: string[] } | null => {
  const q = slugify(query);
  for (const cat of CATEGORY_MAP) {
    if (cat.key === q || cat.aliases.some((a) => slugify(a) === q)) {
      return { key: cat.key, techs: cat.techs };
    }
  }
  return null;
};

/** All technologies whose title contains the keyword (deduped by id). */
const findAllTechnologies = (results: unknown[], keywords: string[]): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const k = keyword.trim().toLowerCase();
    for (const entry of results) {
      const rec = asRecord(entry);
      if (!rec) continue;
      const title = typeof rec.title === "string" ? rec.title.toLowerCase() : "";
      const titleSlug = slugify(title);
      if (title.includes(k) || titleSlug.includes(k)) {
        const id = String(rec.id ?? rec.tech_id ?? rec.title ?? "");
        if (!seen.has(id)) {
          seen.add(id);
          out.push(rec);
        }
      }
    }
  }
  return out;
};

/**
 * Find one technology in the catalog by a flexible `tech` selector: numeric
 * id / tech_id, a case-insensitive title substring (e.g. "milling",
 * "sheetmetal", "turning"), or a slug.
 */
const findTechnology = (results: unknown[], query: string): Record<string, unknown> | null => {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const qSlug = slugify(query);
  for (const entry of results) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const id = String(rec.id ?? "");
    const techId = String(rec.tech_id ?? "");
    const title = typeof rec.title === "string" ? rec.title.toLowerCase() : "";
    const titleSlug = slugify(title);
    if ((id && id === q) || (techId && techId === q)) return rec;
    if (title && title.includes(q)) return rec;
    if (titleSlug && (titleSlug === qSlug || titleSlug.includes(qSlug))) return rec;
  }
  return null;
};

const techLabels = (results: unknown[]): Array<{ id: unknown; title: unknown }> =>
  results.map((r) => {
    const rec = asRecord(r) ?? {};
    return { id: rec.id, title: rec.title };
  });

/** Fetch fresh from DigiFabster, persist to R2 (best-effort), and return it. */
const refreshAndStore = async (traceId: string): Promise<DigifabsterWidgetTechnologies> => {
  const catalog = await getDigifabsterWidgetTechnologies(traceId);
  await writeJsonBlob(WIDGET_TECHNOLOGIES_KEY, catalog); // best-effort; no-op without R2
  return catalog;
};

/* ------------------------------------------------------------------ */
/*  Handlers                                                          */
/* ------------------------------------------------------------------ */

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: buildCorsHeaders(req) });
}

export async function POST(req: Request) {
  const traceId = `widget-tech-${Date.now().toString(36)}`;
  try {
    const catalog = await refreshAndStore(traceId);
    return json({ source: "live", stored: WIDGET_TECHNOLOGIES_KEY, ...catalog }, 200, req);
  } catch (error) {
    return errorResponse(error, req);
  }
}

export async function GET(req: Request) {
  const traceId = `widget-tech-${Date.now().toString(36)}`;
  const url = new URL(req.url);
  const forceRefresh = isTruthyParam(url.searchParams.get("refresh"));
  // Bubble category grouping (cnc-machining | sheet-metal | tube).
  const category = url.searchParams.get("category") ?? url.searchParams.get("group");
  // Optional single-technology selector to lighten the response.
  const tech =
    url.searchParams.get("tech") ??
    url.searchParams.get("technology") ??
    url.searchParams.get("techId") ??
    url.searchParams.get("tech_id");

  try {
    // Resolve the catalog: cached R2 copy unless ?refresh, else live + store.
    let source: "cache" | "live" = "live";
    let catalog: DigifabsterWidgetTechnologies | null = null;

    if (!forceRefresh) {
      const cached = await getObjectText(WIDGET_TECHNOLOGIES_KEY);
      if (cached) {
        try {
          catalog = JSON.parse(cached) as DigifabsterWidgetTechnologies;
          source = "cache";
        } catch {
          catalog = null; // corrupt cache -> live refresh below
        }
      }
    }
    if (!catalog) {
      catalog = await refreshAndStore(traceId);
      source = "live";
    }

    const results = Array.isArray(catalog.results) ? catalog.results : [];

    // Bubble category -> grouped technologies (e.g. CNC Machining = milling + turning).
    if (category && category.trim()) {
      const resolved = resolveCategory(category);
      if (!resolved) {
        return json(
          { error: "Unknown category.", category, available: CATEGORY_MAP.map((c) => c.key) },
          404,
          req,
        );
      }
      const technologies = findAllTechnologies(results, resolved.techs);
      return json(
        {
          source,
          fetchedAt: catalog.fetchedAt,
          category: resolved.key,
          count: technologies.length,
          technologies,
          // Surfaced so Bubble can show "not available yet" (e.g. Tube Fabrication).
          ...(technologies.length === 0 ? { note: "No DigiFabster technology mapped to this category yet." } : {}),
        },
        200,
        req,
      );
    }

    // Single-technology request -> return just that one (lighter payload).
    if (tech && tech.trim()) {
      const technology = findTechnology(results, tech);
      if (!technology) {
        return json({ error: "Technology not found.", tech, available: techLabels(results) }, 404, req);
      }
      return json({ source, fetchedAt: catalog.fetchedAt, count: 1, tech, technology }, 200, req);
    }

    // Full catalog (backward compatible).
    return json({ source, count: catalog.count, fetchedAt: catalog.fetchedAt, results }, 200, req);
  } catch (error) {
    return errorResponse(error, req);
  }
}

const errorResponse = (error: unknown, req: Request) => {
  if (error instanceof DigifabsterSyncError) {
    return json(
      {
        error: error.message,
        code: error.code,
        details: error.details,
        retryable: error.retryable,
      },
      error.status >= 500 ? 502 : error.status,
      req,
    );
  }

  console.error("digifabster-technologies error:", error);
  return json(
    { error: "Failed to fetch widget technologies.", details: error instanceof Error ? error.message : null },
    500,
    req,
  );
};
