/**
 * GET/PUT /api/digifabster-part-data-config
 *
 * Read/update which fields /api/digifabster-part-data returns (stored in R2 at
 * config/part-data-fields.json). Backs the admin page at
 * /api/digifabster-part-data-admin.
 *
 *   GET  -> { fields: {<field>: bool}, available: [<field>...] }
 *   PUT  -> body { fields: {<field>: bool} }  (POST also accepted) -> saved config
 */
import {
  PART_DATA_FIELDS,
  getPartDataConfig,
  putPartDataConfig,
  sanitizePartDataConfig,
} from "./autodesk_helpers/part-data-config";

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
  const cfg = await getPartDataConfig();
  return json({ fields: cfg.fields, available: PART_DATA_FIELDS }, 200, req);
}

const save = async (req: Request) => {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, req);
  }

  const cfg = sanitizePartDataConfig(body);
  const stored = await putPartDataConfig(cfg);
  return json(
    {
      status: stored ? "saved" : "not_persisted",
      ...(stored ? {} : { warning: "R2 storage unavailable; change not persisted." }),
      fields: cfg.fields,
      available: PART_DATA_FIELDS,
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
