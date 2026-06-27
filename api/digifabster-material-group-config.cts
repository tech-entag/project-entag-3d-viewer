/**
 * GET/PUT /api/digifabster-material-group-config
 *
 * Read/update the manual materialId -> group-label mapping that
 * /api/digifabster-part-data uses for the `materialGroup` field (stored in R2 at
 * config/material-groups.json). Backs the admin page at
 * /api/digifabster-part-data-admin.
 *
 *   GET  -> { groups: { "<materialId>": "<label>" } }
 *   PUT  -> body { groups: { "<materialId>": "<label>" } }  (POST also accepted)
 */
import {
  getMaterialGroupConfig,
  putMaterialGroupConfig,
  sanitizeMaterialGroupConfig,
} from "./autodesk_helpers/material-group-config";

export const config = {
  maxDuration: 30,
};

const buildCorsHeaders = (req?: Request): Record<string, string> => {
  const origin = req?.headers.get("origin")?.trim();
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
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

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: buildCorsHeaders(req) });
}

export async function GET(req: Request) {
  const cfg = await getMaterialGroupConfig();
  return json({ groups: cfg.groups }, 200, req);
}

const save = async (req: Request) => {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, req);
  }

  const cfg = sanitizeMaterialGroupConfig(body);
  const stored = await putMaterialGroupConfig(cfg);
  return json(
    {
      status: stored ? "saved" : "not_persisted",
      ...(stored ? {} : { warning: "R2 storage unavailable; change not persisted." }),
      groups: cfg.groups,
    },
    stored ? 200 : 503,
    req,
  );
};

export async function PUT(req: Request) {
  return save(req);
}

export async function POST(req: Request) {
  return save(req);
}
