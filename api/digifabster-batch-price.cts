import {
  DigifabsterSyncError,
  getDigifabsterBatchPrice,
  getDigifabsterPreselection,
  type DigifabsterBatchPriceResult,
} from "./autodesk_helpers/digifabster-sync";
import { getPricingConfig } from "./autodesk_helpers/pricing-config";
import { resolveBubbleVersionSegment } from "./autodesk_helpers/bubble-version";

export const config = {
  maxDuration: 60,
};

// Bubble workflow webhook. Once a price is ready we POST { part_id } here and
// Bubble fetches the part data itself (we no longer PATCH the OrderPart). The
// version segment (version-test / version-live) is chosen per-request from the
// `version` field. Override the whole URL via BUBBLE_WEBHOOK_URL / body.
const BUBBLE_WEBHOOK_HOST = "https://entag-10502.bubbleapps.io";
const BUBBLE_WEBHOOK_WORKFLOW = "wh_orderpart_trigger";

// Delivery lead-time priority used by live batch_price/material calls that
// return prices. Used when neither the body nor DIGIFABSTER_DEFAULT_LEAD_TIME_IDS
// supplies one. (A wrong/foreign priority id yields an empty price matrix with
// no error, so this must match the machine the priced material lives on.)
const DEFAULT_LEAD_TIME_IDS = "8fcabd8a-b22e-4b5e-9a7c-9e686cc00fcf";

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

const positiveFloat = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/* ------------------------------------------------------------------ */
/*  Bubble workflow webhook                                           */
/* ------------------------------------------------------------------ */

/** POST { part_id } to the Bubble workflow webhook so Bubble fetches the part
 *  data itself. An optional bearer token is sent when one is configured (the
 *  webhook can be public or token-protected). */
const triggerBubbleWebhook = async (params: {
  url: string;
  token: string | null;
  partId: string;
}) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (params.token) headers.Authorization = `Bearer ${params.token.replace(/^Bearer\s+/i, "").trim()}`;

  const payload = { part_id: params.partId };

  const response = await fetch(params.url, {
    method: "POST",
    headers,
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

  return { ok: response.ok, status: response.status, endpoint: params.url, payload, responseData };
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

  // Editable pricing defaults from R2 (config/pricing.json): multiplier, plus
  // optional materialId / count / config to match the live batch_price body.
  const pricingConfig = await getPricingConfig();

  /* ---- material_id: body / R2 config / env, else DigiFabster preselection ---- */
  let materialId = positiveInt(
    body.materialId,
    body.material_id,
    pricingConfig.materialId,
    process.env.DIGIFABSTER_DEFAULT_MATERIAL_ID,
  );
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

  /* ---- count: quantities (max 10); body, else R2 config, else [1] ---- */
  const count = toIntList(body.count ?? body.counts ?? body.quantities ?? pricingConfig.count, 10);
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
    ...(pricingConfig.config ?? {}),
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

  // Optional per-call poll override (the cron scheduler passes attempts=1 so each
  // call returns fast and the scheduler provides the retry cadence).
  const attemptsOverride = positiveInt(body.attempts, body.maxAttempts) ?? undefined;

  let result: DigifabsterBatchPriceResult;
  try {
    result = await getDigifabsterBatchPrice({
      modelId,
      materialId,
      count: quantities,
      leadTime,
      config,
      traceId,
      maxAttempts: attemptsOverride,
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
  const baseCost = typeof selectedCostRaw === "number" && Number.isFinite(selectedCostRaw) ? selectedCostRaw : null;

  // Apply the editable price multiplier (R2 config/pricing.json; body override
  // for testing). The multiplied value is what's written to Bubble.
  const multiplierOverride = positiveFloat(body.priceMultiplier, body.price_multiplier);
  const priceMultiplier = multiplierOverride ?? pricingConfig.priceMultiplier;
  const finalCost = baseCost !== null ? Math.round(baseCost * priceMultiplier * 100) / 100 : null;

  const selectedPrice =
    selectedPriority && selectedRow && finalCost !== null
      ? {
          priorityId: selectedPriority.priorityId,
          priorityName: selectedPriority.priorityName,
          quantity: selectedRow.quantity,
          field: priceField,
          baseCost,
          multiplier: priceMultiplier,
          cost: finalCost,
        }
      : null;

  /* ---- Trigger the Bubble webhook (Bubble then fetches the part data) ---- */
  // We no longer PATCH the OrderPart. Once a price is ready we POST { part_id }
  // to a Bubble workflow webhook and Bubble pulls the data itself
  // (e.g. via /api/digifabster-part-data). Optional bearer token if protected.
  // Explicit URL (body/env) wins; otherwise build it from the requested version.
  const bubbleVersionSegment = resolveBubbleVersionSegment(
    pickString(body.version, body.bubbleVersion, body.bubble_version),
  );
  const bubbleWebhookUrl =
    pickString(body.bubbleWebhookUrl, body.bubble_webhook_url, process.env.BUBBLE_WEBHOOK_URL) ||
    `${BUBBLE_WEBHOOK_HOST}/${bubbleVersionSegment}/api/1.1/wf/${BUBBLE_WEBHOOK_WORKFLOW}`;
  const bubbleToken = pickString(
    body.bubble_api_token,
    body.bubbleApiToken,
    process.env.BUBBLE_WEBHOOK_TOKEN,
    process.env.BUBBLE_DATA_API_TOKEN,
    process.env.BUBBLE_API_TOKEN,
    process.env.BUBBLE_DATA_API_BEARER_TOKEN,
  );
  // The OrderPart's Bubble id — what the webhook carries so Bubble can locate
  // the thing to update.
  const partId = pickString(body.part_id, body.partId, body.priceId, body.price_id);

  // Read-only callers (e.g. /api/digifabster-part-data reusing this route) pass
  // bubbleWebhook:false so the trigger never fires for a pure data fetch.
  const webhookEnabled = body.bubbleWebhook !== false && body.bubble_webhook !== false;

  let bubbleUpdate: Record<string, unknown>;
  if (webhookEnabled && selectedPrice && partId) {
    const triggered = await triggerBubbleWebhook({
      url: bubbleWebhookUrl,
      token: bubbleToken,
      partId,
    });
    bubbleUpdate = {
      status: triggered.ok ? "triggered" : "failed",
      httpStatus: triggered.status,
      endpoint: triggered.endpoint,
      payload: triggered.payload,
      ...(triggered.ok ? {} : { responseData: triggered.responseData }),
    };
  } else {
    bubbleUpdate = {
      status: "skipped",
      reason: !webhookEnabled
        ? "webhook_disabled"
        : !selectedPrice
          ? result.status === "analysing"
            ? "still_analysing"
            : "no_price_available"
          : "missing_part_id",
    };
  }

  return json(
    {
      status: result.status,
      // DigiFabster prices asynchronously: when no prices are back yet, the
      // caller (Bubble) should reschedule this call until shouldRetry is false.
      shouldRetry: result.prices.length === 0,
      traceId,
      // Top-level for easy Bubble mapping (e.g. to feed place-order). Also kept
      // under `request` for backward compatibility.
      materialId,
      materialSource,
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
