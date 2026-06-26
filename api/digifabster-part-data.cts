/**
 * GET/POST /api/digifabster-part-data
 *
 * Read-only aggregation of everything we'd normally PATCH onto a Bubble
 * OrderPart, returned in ONE response so Bubble can fetch + assign the fields
 * itself (this endpoint never writes to Bubble).
 *
 * Combines:
 *   - thumbnail + bounding-box dims  (GET /v2/models/{id}/)
 *   - price + material               (reuses /api/digifabster-batch-price,
 *                                      called internally WITHOUT a Bubble token,
 *                                      so material pinning / multiplier / lead_time
 *                                      all behave identically and nothing is written)
 *
 *   GET  ?objectModelId=4392012[&part_id=...&materialId=...&leadTime=a,b&count=1,5&attempts=1]
 *   POST { "objectModelId": 4392012, ... }
 *
 * Response:
 *   {
 *     modelId, partId?,
 *     image, thumbnails: { thumb, thumb120x120, thumb300x300, status },
 *     dimX, dimY, dimZ, dimUnits,
 *     materialId, materialSource,
 *     requestedPrice, priceStatus, shouldRetry,
 *     ready            // image + dims + price all present
 *   }
 */
import {
  getDigifabsterModelThumbnail,
  type DigifabsterModelThumbnail,
} from "./autodesk_helpers/digifabster-sync";
import { POST as batchPricePOST } from "./digifabster-batch-price.cts";
import { getPartDataConfig, type PartDataField } from "./autodesk_helpers/part-data-config";

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

const pickString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const positiveInt = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
};

const positiveFloat = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/* ------------------------------------------------------------------ */
/*  Core                                                              */
/* ------------------------------------------------------------------ */

interface PartDataInput {
  modelId: number | null;
  partId: string | null;
  materialId: number | null;
  leadTime: string | null;
  count: string | null;
  priceMultiplier: number | null;
  attempts: number | null;
}

const handle = async (input: PartDataInput, req: Request) => {
  if (!input.modelId) {
    return json(
      { error: "Missing objectModelId.", hint: "Pass objectModelId (GET query or POST body)." },
      400,
      req,
    );
  }

  const traceId = `part-data-${input.modelId}-${Date.now().toString(36)}`;

  // Which fields are enabled (admin-managed in R2). Disabled fields are omitted
  // AND their upstream call is skipped when nothing else needs it.
  const { fields } = await getPartDataConfig();
  const on = (f: PartDataField) => fields[f] === true;

  const THUMB_FIELDS: PartDataField[] = ["image", "thumbnails", "dimX", "dimY", "dimZ", "dimUnits"];
  const PRICE_FIELDS: PartDataField[] = ["materialId", "materialSource", "requestedPrice", "priceStatus", "shouldRetry"];
  // `ready` derives from both, so it forces both upstream calls when enabled.
  const needsThumb = on("ready") || THUMB_FIELDS.some(on);
  const needsPrice = on("ready") || PRICE_FIELDS.some(on);

  // Price: reuse the batch-price route. No Bubble token is passed, so it computes
  // price + materialId (pinned config / multiplier / lead_time all intact) and
  // skips the Bubble write entirely.
  const pricePromise: Promise<Record<string, unknown>> = needsPrice
    ? (() => {
        const priceBody: Record<string, unknown> = {
          objectModelId: input.modelId,
          attempts: input.attempts ?? 1, // single fast attempt; caller polls
          traceId,
        };
        if (input.partId) priceBody.part_id = input.partId;
        if (input.materialId) priceBody.materialId = input.materialId;
        if (input.leadTime) priceBody.leadTime = input.leadTime;
        if (input.count) priceBody.count = input.count;
        if (input.priceMultiplier) priceBody.priceMultiplier = input.priceMultiplier;
        return batchPricePOST(
          new Request("https://internal/api/digifabster-batch-price", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(priceBody),
          }),
        )
          .then((res) => res.json() as Promise<Record<string, unknown>>)
          .catch(() => ({}));
      })()
    : Promise.resolve({});

  // Thumbnail + dims — best-effort; a pending thumbnail never fails the call.
  const thumbPromise: Promise<DigifabsterModelThumbnail | null> = needsThumb
    ? getDigifabsterModelThumbnail(input.modelId, traceId).catch(() => null)
    : Promise.resolve(null);

  const [priceRaw, thumb] = await Promise.all([pricePromise, thumbPromise]);
  const price = asRecord(priceRaw);
  const selected = asRecord(price.selectedPrice);

  const image = thumb ? thumb.thumb300x300 || thumb.thumb120x120 || thumb.thumb : null;
  const requestedPrice = typeof selected.cost === "number" ? selected.cost : null;
  const shouldRetry = typeof price.shouldRetry === "boolean" ? price.shouldRetry : null;
  const ready = Boolean(image) && requestedPrice !== null && shouldRetry === false;

  // Full payload, then drop disabled fields. modelId/partId always included.
  const full: Record<string, unknown> = {
    modelId: input.modelId,
    ...(input.partId ? { partId: input.partId } : {}),
    image,
    thumbnails: thumb
      ? {
          thumb: thumb.thumb,
          thumb120x120: thumb.thumb120x120,
          thumb300x300: thumb.thumb300x300,
          status: thumb.thumbStatus,
        }
      : null,
    dimX: thumb?.sizeX ?? null,
    dimY: thumb?.sizeY ?? null,
    dimZ: thumb?.sizeZ ?? null,
    dimUnits: thumb?.units ?? null,
    materialId: price.materialId ?? null,
    materialSource: price.materialSource ?? null,
    requestedPrice,
    priceStatus: price.status ?? null,
    shouldRetry,
    ready,
  };

  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) {
    if (key === "modelId" || key === "partId") {
      payload[key] = value;
    } else if (on(key as PartDataField)) {
      payload[key] = value;
    }
  }

  return json(payload, 200, req);
};

/* ------------------------------------------------------------------ */
/*  Handlers                                                          */
/* ------------------------------------------------------------------ */

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: buildCorsHeaders(req) });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams;
  return handle(
    {
      modelId: positiveInt(q.get("objectModelId"), q.get("object_model_id"), q.get("modelId"), q.get("model_id")),
      partId: pickString(q.get("part_id"), q.get("partId")),
      materialId: positiveInt(q.get("materialId"), q.get("material_id")),
      leadTime: pickString(q.get("leadTime"), q.get("lead_time")),
      count: pickString(q.get("count")),
      priceMultiplier: positiveFloat(q.get("priceMultiplier")),
      attempts: positiveInt(q.get("attempts")),
    },
    req,
  );
}

export async function POST(req: Request) {
  const body = await parseBody(req);
  return handle(
    {
      modelId: positiveInt(body.objectModelId, body.object_model_id, body.modelId, body.model_id),
      partId: pickString(body.part_id, body.partId),
      materialId: positiveInt(body.materialId, body.material_id),
      leadTime: pickString(body.leadTime, body.lead_time),
      count: pickString(body.count),
      priceMultiplier: typeof body.priceMultiplier === "number" ? body.priceMultiplier : null,
      attempts: positiveInt(body.attempts),
    },
    req,
  );
}
