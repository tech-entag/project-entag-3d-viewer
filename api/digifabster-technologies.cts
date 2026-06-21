/**
 * GET/POST /api/digifabster-technologies
 *
 * The DigiFabster "widget technologies" master config catalog
 * (GET /v2/users/widget-technologies/), persisted to R2 so it can be shared
 * between Bubble and Cloudflare without hitting DigiFabster on every read.
 *
 *   GET   -> returns the cached catalog from R2 (config/widget-technologies.json).
 *            If nothing is cached yet, fetches it live, stores it, and returns it.
 *            ?refresh=true forces a fresh fetch + re-store.
 *   POST  -> always fetches fresh from DigiFabster, stores to R2, returns it.
 *
 * Response: { source: "cache" | "live", count, fetchedAt, results: [...] }
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

  try {
    if (!forceRefresh) {
      const cached = await getObjectText(WIDGET_TECHNOLOGIES_KEY);
      if (cached) {
        try {
          return json({ source: "cache", ...(JSON.parse(cached) as object) }, 200, req);
        } catch {
          // Corrupt cache — fall through to a live refresh.
        }
      }
    }

    const catalog = await refreshAndStore(traceId);
    return json({ source: "live", ...catalog }, 200, req);
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
