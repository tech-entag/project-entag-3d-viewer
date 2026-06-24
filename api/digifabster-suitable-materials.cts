/**
 * GET/POST /api/digifabster-suitable-materials
 *
 * Returns the materials DigiFabster considers valid for a model
 * (POST /v2/suitable_materials/), ENRICHED with each material's catalog data
 * resolved from the cached widget-technologies catalog — shaped to match the
 * Bubble quote form (Process / Material / Sheet Thickness / Tolerance / Finish /
 * Max roughness / Inspection / Part Marking).
 *
 *   GET  ?modelId=4392029
 *   POST { "modelId": 4392029 }   (also: objectModelId / model_id)
 *
 * Response:
 *   {
 *     modelId, isReady, source, count,
 *     materials: [ {
 *       id, title, technologyId, technologyTitle,
 *       thicknesses[],            // Sheet Thickness
 *       tolerance[],              // Tightest Tolerance
 *       leadTime[],
 *       extraFieldsets[],         // Finish (and other fieldsets)
 *       postProductionGroups: [   // grouped by group_title == UI section
 *         { group: "Surface Roughness", options: [...] },  // Max roughness / Ra
 *         { group: "Finishing",         options: [...] },  // Finish add-ons
 *         { group: "Inspection",        options: [...] },  // CMM / FAIR / ...
 *       ],
 *     } ],
 *     unmatched: [ ids not found in the catalog ]   // only if any
 *   }
 *
 * If the model isn't analysed yet -> 409 (retryable).
 */
import {
  DigifabsterSyncError,
  getDigifabsterSuitableMaterials,
} from "./autodesk_helpers/digifabster-sync";
import {
  buildMaterialIndex,
  emptyMaterial,
  loadWidgetTechnologies,
} from "./autodesk_helpers/widget-technologies-store";

export const config = {
  maxDuration: 60,
};

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

const parseBody = async (req: Request): Promise<Record<string, unknown>> => {
  try {
    const data = await req.json();
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const positiveInt = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
};

/* ------------------------------------------------------------------ */
/*  Core                                                              */
/* ------------------------------------------------------------------ */

const handle = async (modelId: number | null, req: Request) => {
  if (!modelId) {
    return json(
      { error: "Missing modelId.", hint: "Pass modelId (GET query or POST body)." },
      400,
      req,
    );
  }

  const traceId = `suitable-${modelId}-${Date.now().toString(36)}`;

  try {
    const suitable = await getDigifabsterSuitableMaterials(modelId, traceId);

    if (!suitable.isReady) {
      return json(
        {
          error: "Model not analysed yet (suitable_materials is_ready=false).",
          modelId,
          isReady: false,
          retryable: true,
        },
        409,
        req,
      );
    }

    const { catalog, source } = await loadWidgetTechnologies(traceId);
    const index = buildMaterialIndex(Array.isArray(catalog.results) ? catalog.results : []);

    const materials = suitable.materials.map((id) => index.get(id) ?? emptyMaterial(id));
    const unmatched = suitable.materials.filter((id) => !index.has(id));

    return json(
      {
        modelId,
        isReady: true,
        source,
        count: materials.length,
        materials,
        ...(unmatched.length > 0 ? { unmatched } : {}),
      },
      200,
      req,
    );
  } catch (error) {
    if (error instanceof DigifabsterSyncError) {
      return json(
        { error: error.message, code: error.code, details: error.details, retryable: error.retryable, modelId },
        error.status >= 500 ? 502 : error.status,
        req,
      );
    }
    console.error("digifabster-suitable-materials error:", error);
    return json(
      { error: "Failed to fetch suitable materials.", details: error instanceof Error ? error.message : null, modelId },
      500,
      req,
    );
  }
};

/* ------------------------------------------------------------------ */
/*  Handlers                                                          */
/* ------------------------------------------------------------------ */

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: buildCorsHeaders(req) });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const modelId = positiveInt(
    url.searchParams.get("modelId"),
    url.searchParams.get("model_id"),
    url.searchParams.get("objectModelId"),
    url.searchParams.get("object_model_id"),
  );
  return handle(modelId, req);
}

export async function POST(req: Request) {
  const body = await parseBody(req);
  const modelId = positiveInt(body.modelId, body.model_id, body.objectModelId, body.object_model_id);
  return handle(modelId, req);
}
