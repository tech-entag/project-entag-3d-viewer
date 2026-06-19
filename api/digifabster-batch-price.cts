import {
  DigifabsterSyncError,
  getDigifabsterBatchPrice,
  getDigifabsterPreselection,
  type DigifabsterBatchPriceResult,
} from "./autodesk_helpers/digifabster-sync";

export const config = {
  maxDuration: 60,
};

// Default Bubble Data API base. NOTE: switch `version-test` -> `version-live`
// for production (or set BUBBLE_DATA_API_BASE_URL / pass it in the body).
const DEFAULT_BUBBLE_DATA_API_BASE_URL = "https://app.entag.co/version-test/api/1.1/obj";

// The price writes to the Bubble `order` thing, field `[price]manufacturingCost`.
const DEFAULT_BUBBLE_PRICE_TYPE = "order";
const DEFAULT_BUBBLE_COST_FIELD = "[price]manufacturingCost";

// Standard delivery lead-time priority (UUID seen across live DigiFabster calls).
// Used when neither the body nor DIGIFABSTER_DEFAULT_LEAD_TIME_IDS supplies one.
const DEFAULT_LEAD_TIME_IDS = "0e24c89a-7abd-4450-b383-b94afe676a82";

// Keys the preselection config carries that batch_price/material rejects
// ("This field is not allowed here."). Stripped before the price call.
const DISALLOWED_CONFIG_KEYS = ["execution", "lead_time"];

/* ------------------------------------------------------------------ */
/*  HTTP helpers                                                      */
/* ------------------------------------------------------------------ */

const buildCorsHeaders = (req?: Request): Record<string, string> => {
  const origin = req?.headers.get("origin")?.trim();
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
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

const parseBody = async (req: Request): Promise<Record<string, unknown> | null> => {
  try {
    const data = await req.json();
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/* ------------------------------------------------------------------ */
/*  Bubble Data API                                                   */
/* ------------------------------------------------------------------ */

const normalizeBubbleDataApiBaseUrl = (raw: string | null): string => {
  if (!raw || !raw.trim()) return DEFAULT_BUBBLE_DATA_API_BASE_URL;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.includes("/api/1.1/obj")) return trimmed;
  if (trimmed.includes("/version-")) return `${trimmed}/api/1.1/obj`;
  return `${trimmed}/version-test/api/1.1/obj`;
};

const buildBubbleDataApiHeaders = (token: string) => {
  const normalizedToken = token.replace(/^Bearer\s+/i, "").trim();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${normalizedToken}`,
  };
};

/** PATCH a Bubble thing with the manufacturing cost from batch_price. */
const updateBubbleManufacturingCost = async (params: {
  baseUrl: string;
  token: string;
  thingType: string;
  thingId: string;
  field: string;
  cost: number;
}) => {
  const endpoint = `${params.baseUrl}/${encodeURIComponent(params.thingType)}/${encodeURIComponent(params.thingId)}`;
  const payload: Record<string, unknown> = { [params.field]: params.cost };

  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: buildBubbleDataApiHeaders(params.token),
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseData: unknown = null;
  if (responseText.trim()) {
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText.slice(0, 2_000);
    }
  }

  return { ok: response.ok, status: response.status, endpoint, payload, responseData };
};

/* ------------------------------------------------------------------ */
/*  Input resolution (request body + env fallback)                    */
/* ------------------------------------------------------------------ */

/** Coerce a value into a deduped list of positive ints (max `limit`). */
const toIntList = (value: unknown, limit: number): number[] => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : value === null || value === undefined
        ? []
        : [value];
  const out: number[] = [];
  for (const entry of raw) {
    const n = positiveInt(entry);
    if (n !== null && !out.includes(n)) out.push(n);
    if (out.length >= limit) break;
  }
  return out;
};

/** Coerce a value into a deduped list of non-empty strings (max `limit`). */
const toStringList = (value: unknown, limit: number): string[] => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : value === null || value === undefined
        ? []
        : [value];
  const out: string[] = [];
  for (const entry of raw) {
    const s = pickString(entry);
    if (s !== null && !out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
};

/* ------------------------------------------------------------------ */
/*  Handlers                                                          */
/* ------------------------------------------------------------------ */

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: buildCorsHeaders(req) });
}

export async function POST(req: Request) {
  const body = await parseBody(req);
  if (!body) return json({ error: "Invalid JSON body" }, 400, req);

  const traceId = pickString(body.traceId, body.trace_id) || `batch-price-${Date.now().toString(36)}`;

  /* ---- model_id: from the upload step ---- */
  const modelId = positiveInt(body.objectModelId, body.object_model_id, body.modelId, body.model_id);
  if (!modelId) {
    return json(
      {
        error: "Missing object_model_id.",
        hint: "Pass objectModelId (from the upload step) in the body.",
      },
      400,
      req,
    );
  }

  /* ---- material_id: body / env, else DigiFabster preselection (auto-pick) ---- */
  let materialId = positiveInt(body.materialId, body.material_id, process.env.DIGIFABSTER_DEFAULT_MATERIAL_ID);
  let preselectionConfig: Record<string, unknown> | null = null;
  let materialSource: "request" | "preselection" = "request";
  if (!materialId) {
    try {
      const preselection = await getDigifabsterPreselection(modelId, traceId);
      materialId = preselection.material;
      preselectionConfig = preselection.config;
      materialSource = "preselection";
      if (!materialId) {
        return json(
          {
            error: "Could not auto-resolve a material for this model.",
            hint: preselection.isReady
              ? "DigiFabster preselection returned no material. Pass materialId or set DIGIFABSTER_DEFAULT_MATERIAL_ID."
              : "Model not analysed yet (preselection is_ready=false). Retry shortly, or pass materialId.",
            isReady: preselection.isReady,
            traceId,
          },
          422,
          req,
        );
      }
    } catch (error) {
      if (error instanceof DigifabsterSyncError) {
        return json(
          { error: error.message, code: error.code, details: error.details, retryable: error.retryable, traceId },
          error.status >= 500 ? 502 : error.status,
          req,
        );
      }
      console.error("digifabster-batch-price preselection error:", error);
      return json(
        { error: "Failed to resolve material via preselection.", details: error instanceof Error ? error.message : null, traceId },
        500,
        req,
      );
    }
  }

  /* ---- lead_time: priority UUIDs (max 3); body, else env, else built-in default ---- */
  const leadTime = toStringList(
    body.leadTime ?? body.lead_time ?? process.env.DIGIFABSTER_DEFAULT_LEAD_TIME_IDS ?? DEFAULT_LEAD_TIME_IDS,
    3,
  );
  if (leadTime.length === 0) {
    return json(
      {
        error: "Missing lead_time priorities.",
        hint: "Pass leadTime (array of priority UUIDs, max 3) in the body or set DIGIFABSTER_DEFAULT_LEAD_TIME_IDS.",
      },
      400,
      req,
    );
  }

  /* ---- count: quantities (max 10), from request, fallback [1] ---- */
  const count = toIntList(body.count ?? body.counts ?? body.quantities, 10);
  const quantities = count.length > 0 ? count : [1];

  /* ---- config: preselection config (carries required fields like `thickness`)
   * with batch_price-rejected keys stripped, then env/body overrides + tolerance.
   * The preselection config also contains `execution`/`lead_time`, which
   * batch_price rejects ("not allowed here") — so those are removed. */
  const envDefaultConfig = (() => {
    const raw = process.env.DIGIFABSTER_DEFAULT_CONFIG;
    if (!raw || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  })();
  const mergedConfig: Record<string, unknown> = {
    ...(preselectionConfig ?? {}),
    ...(envDefaultConfig ?? {}),
    ...(asRecord(body.config) ?? {}),
  };
  // batch_price rejects these keys that the preselection config carries.
  for (const key of DISALLOWED_CONFIG_KEYS) delete mergedConfig[key];
  // DigiFabster batch_price requires `config.tolerance` (a tolerance id) — the
  // preselection config doesn't include it.
  const toleranceId = pickString(body.tolerance, body.tolerance_id, process.env.DIGIFABSTER_DEFAULT_TOLERANCE_ID);
  if (toleranceId && mergedConfig.tolerance === undefined) {
    mergedConfig.tolerance = toleranceId;
  }
  const config = Object.keys(mergedConfig).length > 0 ? mergedConfig : undefined;

  let result: DigifabsterBatchPriceResult;
  try {
    result = await getDigifabsterBatchPrice({
      modelId,
      materialId,
      count: quantities,
      leadTime,
      config,
      traceId,
    });
  } catch (error) {
    if (error instanceof DigifabsterSyncError) {
      return json(
        {
          error: error.message,
          code: error.code,
          details: error.details,
          retryable: error.retryable,
          traceId,
        },
        error.status >= 500 ? 502 : error.status,
        req,
      );
    }
    console.error("digifabster-batch-price error:", error);
    return json(
      { error: "Failed to fetch batch price.", details: error instanceof Error ? error.message : null, traceId },
      500,
      req,
    );
  }

  /* ---- Select the single price to write to Bubble ---- */
  // Which money field off price_info (camelCase): total | pricePerItem | subtotal | ...
  const priceField = pickString(body.priceField, body.price_field, process.env.DIGIFABSTER_BATCH_PRICE_FIELD) || "total";
  // Default to the first lead-time priority and the first requested quantity.
  const selectedPriority =
    result.prices.find((p) => p.priorityId === leadTime[0]) ?? result.prices[0] ?? null;
  const selectedRow =
    selectedPriority?.prices.find((r) => r.quantity === quantities[0]) ?? selectedPriority?.prices[0] ?? null;
  const selectedCostRaw = selectedRow
    ? (selectedRow.priceInfo as unknown as Record<string, number>)[priceField]
    : undefined;
  const selectedCost = typeof selectedCostRaw === "number" && Number.isFinite(selectedCostRaw) ? selectedCostRaw : null;

  const selectedPrice =
    selectedPriority && selectedRow && selectedCost !== null
      ? {
          priorityId: selectedPriority.priorityId,
          priorityName: selectedPriority.priorityName,
          quantity: selectedRow.quantity,
          field: priceField,
          cost: selectedCost,
        }
      : null;

  /* ---- PATCH the price back to Bubble (field literally `[price]manufacturingCost`) ---- */
  const bubbleToken = pickString(
    body.bubble_api_token,
    body.bubbleApiToken,
    process.env.BUBBLE_DATA_API_TOKEN,
    process.env.BUBBLE_API_TOKEN,
    process.env.BUBBLE_DATA_API_BEARER_TOKEN,
  );
  const bubbleBaseUrl = normalizeBubbleDataApiBaseUrl(
    pickString(body.bubble_data_api_base_url, body.bubbleDataApiBaseUrl, process.env.BUBBLE_DATA_API_BASE_URL),
  );
  const bubbleThingType =
    pickString(body.bubble_price_type, body.bubblePriceType, process.env.BUBBLE_PRICE_TYPE) || DEFAULT_BUBBLE_PRICE_TYPE;
  const bubbleCostField =
    pickString(body.bubble_manufacturing_cost_field, body.bubbleManufacturingCostField, process.env.BUBBLE_MANUFACTURING_COST_FIELD) ||
    DEFAULT_BUBBLE_COST_FIELD;
  const priceId = pickString(
    body.priceId,
    body.price_id,
    body.bubblePriceId,
    body.bubble_price_id,
    body.orderId,
    body.order_id,
    body.bubbleOrderId,
    body.bubble_order_id,
  );

  let bubbleUpdate: Record<string, unknown>;
  if (selectedPrice && priceId && bubbleToken) {
    const update = await updateBubbleManufacturingCost({
      baseUrl: bubbleBaseUrl,
      token: bubbleToken,
      thingType: bubbleThingType,
      thingId: priceId,
      field: bubbleCostField,
      cost: selectedPrice.cost,
    });
    bubbleUpdate = {
      status: update.ok ? "updated" : "failed",
      httpStatus: update.status,
      endpoint: update.endpoint,
      field: bubbleCostField,
      cost: selectedPrice.cost,
      ...(update.ok ? {} : { responseData: update.responseData }),
    };
  } else {
    bubbleUpdate = {
      status: "skipped",
      reason: !selectedPrice
        ? result.status === "analysing"
          ? "still_analysing"
          : "no_price_available"
        : !priceId
          ? "missing_price_id"
          : "missing_bubble_token",
    };
  }

  return json(
    {
      status: result.status,
      traceId,
      request: { modelId, materialId, materialSource, count: quantities, leadTime },
      selectedPrice,
      prices: result.prices,
      analysingErrors: result.analysingErrors,
      warnings: result.warnings,
      batchCapacity: result.batchCapacity,
      bubble: bubbleUpdate,
      // Surface the raw DigiFabster response when no prices came back, so an
      // empty matrix can be diagnosed (stale model vs async compute vs shape).
      ...(result.prices.length === 0 ? { debugRawResponse: result.raw, sentConfig: config ?? null } : {}),
    },
    200,
    req,
  );
}
