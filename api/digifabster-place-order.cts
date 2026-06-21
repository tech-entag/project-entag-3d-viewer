/**
 * POST /api/digifabster-place-order
 *
 * Single Bubble-triggered endpoint that places a real purchase order with
 * DigiFabster (Entag buying from DigiFabster). It runs the full live sequence
 * in one call:
 *
 *   1. ADM      POST /v2/orders/users/{userId}/adm/            -> empty order (order_id)
 *   2. Purchase POST /v2/orders/{order_id}/purchases/          -> priced line item(s)
 *   3. Submit   POST /v2/orders/{order_id}/submit_initial_order/ -> invoice_id + hash
 *   4. Confirm  PATCH /v2/invoices/{invoice_id}/{hash}/         -> status "placed"
 *
 * This is NOT the customer-facing price source — that stays on
 * /api/digifabster-batch-price. This endpoint commits the order so Entag can
 * fulfil it; the returned price/invoice is informational.
 *
 * The client/user id AND the customer (name/surname/phone/email) are FIXED data
 * maintained in R2 at config/place-order.json (see place-order-config.ts) — they
 * are not sent by Bubble. `tolerance` and `thickness` are model-derived: fetched
 * per line item from DigiFabster's preselection. So from Bubble each line item
 * only needs `modelId`, `materialId`, `count`, and optional `lead_time` /
 * `extra_fieldsets` / `post_production` (lead_time falls back to the env default).
 *
 * Body:
 * {
 *   // one line item (top-level) OR many via "items":
 *   "modelId": 4392029, "materialId": 72335, "count": 1,
 *   "config": { "lead_time": "...", "extra_fieldsets": [...], "post_production": [] },
 *   "items": [ { "modelId": ..., "materialId": ..., "count": ..., "config": {...} } ],
 *   "confirm": true,                         // PATCH invoice -> placeStatus (default true)
 *   "locale": "en", "uploadJob": "<uuid>", "poNumber": "..."
 * }
 */
import {
  DigifabsterSyncError,
  createDigifabsterAdmOrder,
  createDigifabsterPurchase,
  getDigifabsterPreselection,
  submitDigifabsterInitialOrder,
  confirmDigifabsterInvoice,
  type DigifabsterOrderCustomer,
  type DigifabsterOrderStatus,
  type DigifabsterPurchaseResult,
} from "./autodesk_helpers/digifabster-sync";
import { getPlaceOrderConfig, type PlaceOrderConfig } from "./autodesk_helpers/place-order-config";

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
/*  Input resolution                                                  */
/* ------------------------------------------------------------------ */

const ORDER_STATUSES: ReadonlySet<string> = new Set([
  "created",
  "waiting_for_review",
  "placed",
  "firm_offer_sent",
  "initial",
]);

const validStatus = (value: string | null, fallback: string): string =>
  value && ORDER_STATUSES.has(value) ? value : fallback;

/**
 * Build the submit_initial_order customer from the R2 place-order config.
 * Bubble normally sends nothing here (it's fixed data) — per-request overrides
 * are accepted only for testing.
 */
const resolveCustomer = (
  body: Record<string, unknown>,
  placeConfig: PlaceOrderConfig,
): DigifabsterOrderCustomer => {
  const customerObj = asRecord(body.customer) ?? {};
  return {
    name: pickString(body.name, customerObj.name) ?? placeConfig.customer.name,
    surname: pickString(body.surname, customerObj.surname) ?? placeConfig.customer.surname,
    phone: pickString(body.phone, customerObj.phone) ?? placeConfig.customer.phone,
    email: pickString(body.email, customerObj.email) ?? placeConfig.customer.email,
    // Live flow submits as firm_offer_sent, then the invoice PATCH places it.
    status: validStatus(
      pickString(body.submitStatus, body.submit_status, customerObj.status),
      placeConfig.submitStatus,
    ) as DigifabsterOrderStatus,
  };
};

const firstLeadTimeId = (raw: string | null): string | null => {
  if (!raw) return null;
  const first = raw.split(",").map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
};

/** Extract a config UUID whether stored as a plain string or a `{ uuid }` object. */
const configUuid = (value: unknown): string | null => {
  const direct = pickString(value);
  if (direct) return direct;
  const record = asRecord(value);
  return record ? pickString(record.uuid) : null;
};

/**
 * Build the per-line `config` object sent to /purchases/ from Bubble input,
 * EXCLUDING tolerance/thickness — those are model-derived and injected later
 * from the DigiFabster preselection. `lead_time` falls back to the env default.
 */
const buildLineConfig = (raw: unknown): Record<string, unknown> => {
  const config: Record<string, unknown> = { ...(asRecord(raw) ?? {}) };

  // tolerance + thickness come from the model (preselection), never from Bubble.
  delete config.tolerance;
  delete config.thickness;

  if (!pickString(config.lead_time)) {
    const lt = firstLeadTimeId(pickString(process.env.DIGIFABSTER_DEFAULT_LEAD_TIME_IDS));
    if (lt) config.lead_time = lt;
  }
  if (!Array.isArray(config.post_production)) {
    config.post_production = [];
  }

  return config;
};

interface ResolvedLineItem {
  modelId: number;
  materialId: number;
  count: number;
  config: Record<string, unknown>;
  fromShortIqt: boolean;
}

const resolveLineItem = (raw: Record<string, unknown>): ResolvedLineItem | { error: string; missing: string[] } => {
  const modelId = positiveInt(raw.modelId, raw.model_id, raw.objectModelId, raw.object_model_id);
  const materialId = positiveInt(raw.materialId, raw.material_id);
  const count = positiveInt(raw.count, raw.quantity) ?? 1;

  const missing: string[] = [];
  if (!modelId) missing.push("modelId");
  if (!materialId) missing.push("materialId");
  if (missing.length > 0) return { error: "Line item missing required fields.", missing };

  return {
    modelId: modelId as number,
    materialId: materialId as number,
    count,
    config: buildLineConfig(raw.config),
    fromShortIqt: raw.from_short_iqt === true || raw.fromShortIqt === true,
  };
};

const resolveLineItems = (
  body: Record<string, unknown>,
): ResolvedLineItem[] | { error: string; missing: string[]; index?: number } => {
  const rawItems = Array.isArray(body.items) && body.items.length > 0 ? body.items : [body];
  const resolved: ResolvedLineItem[] = [];

  for (let i = 0; i < rawItems.length; i += 1) {
    const rec = asRecord(rawItems[i]);
    if (!rec) return { error: "Each item must be an object.", missing: [], index: i };
    const item = resolveLineItem(rec);
    if ("error" in item) return { ...item, index: i };
    resolved.push(item);
  }

  return resolved;
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

  const traceId = pickString(body.traceId, body.trace_id) || `place-order-${Date.now().toString(36)}`;

  /* ---- Resolve inputs ---- */
  // Client/user + customer are fixed data, maintained in R2 (config/place-order.json).
  const placeConfig = await getPlaceOrderConfig();
  const userId = placeConfig.clientId;

  const items = resolveLineItems(body);
  if ("error" in items) {
    return json(
      { error: items.error, missing: items.missing, ...(typeof items.index === "number" ? { itemIndex: items.index } : {}) },
      400,
      req,
    );
  }

  const customer = resolveCustomer(body, placeConfig);

  const locale = pickString(body.locale);
  const uploadJob = pickString(body.uploadJob, body.upload_job);
  const orderPayload = "payload" in body ? body.payload : undefined;
  const shouldConfirm = body.confirm !== false; // default true
  const placeStatus = pickString(body.placeStatus, body.place_status) || placeConfig.placeStatus;
  const poNumber = pickString(body.poNumber, body.po_number);

  /* ---- 1. Resolve model-derived config (tolerance + thickness) per item ---- */
  // Done BEFORE creating the order so a not-ready model doesn't leave a dangling
  // empty order in DigiFabster.
  const prepared: Array<{ item: ResolvedLineItem; config: Record<string, unknown> }> = [];
  for (const item of items) {
    try {
      const preselection = await getDigifabsterPreselection(item.modelId, traceId);
      const tolerance = configUuid(preselection.config?.tolerance);
      const thickness = configUuid(preselection.config?.thickness);
      const missing: string[] = [];
      if (!tolerance) missing.push("tolerance");
      if (!thickness) missing.push("thickness");
      if (!preselection.isReady || missing.length > 0) {
        return json(
          {
            error: "Model not ready or missing tolerance/thickness from DigiFabster preselection.",
            stage: "preselection",
            modelId: item.modelId,
            isReady: preselection.isReady,
            missing,
            retryable: true,
          },
          preselection.isReady ? 422 : 409,
          req,
        );
      }
      prepared.push({ item, config: { ...item.config, tolerance, thickness } });
    } catch (error) {
      return errorResponse(error, "preselection", req, { modelId: item.modelId });
    }
  }

  /* ---- 2. Create ADM order ---- */
  let order: Awaited<ReturnType<typeof createDigifabsterAdmOrder>>;
  try {
    order = await createDigifabsterAdmOrder({ userId, locale, uploadJob, payload: orderPayload, traceId });
  } catch (error) {
    return errorResponse(error, "adm_order_create", req);
  }

  /* ---- 3. Add line item(s) (purchases) ---- */
  const purchases: Array<{
    modelId: number;
    materialId: number;
    count: number;
    purchaseId: number | null;
    totalPrice: number | null;
    pricePerPart: number | null;
    materialTitle: string | null;
  }> = [];
  let lastPurchase: DigifabsterPurchaseResult | null = null;
  for (const { item, config: lineConfig } of prepared) {
    try {
      const purchase = await createDigifabsterPurchase({
        orderId: order.orderId,
        modelId: item.modelId,
        materialId: item.materialId,
        config: lineConfig,
        count: item.count,
        fromShortIqt: item.fromShortIqt,
        traceId,
      });
      lastPurchase = purchase;
      purchases.push({
        modelId: item.modelId,
        materialId: item.materialId,
        count: item.count,
        purchaseId: purchase.purchaseId,
        totalPrice: purchase.totalPrice,
        pricePerPart: purchase.pricePerPart,
        materialTitle: purchase.materialTitle,
      });
    } catch (error) {
      return errorResponse(error, "purchase_create", req, {
        orderId: order.orderId,
        modelId: item.modelId,
        purchasesCompleted: purchases.length,
      });
    }
  }

  /* ---- 4. Submit initial order ---- */
  let submit: Awaited<ReturnType<typeof submitDigifabsterInitialOrder>>;
  try {
    submit = await submitDigifabsterInitialOrder({ orderId: order.orderId, customer, traceId });
  } catch (error) {
    return errorResponse(error, "order_submit", req, { orderId: order.orderId });
  }

  /* ---- 5. Confirm invoice (place) ---- */
  let confirm: Awaited<ReturnType<typeof confirmDigifabsterInvoice>> | null = null;
  let confirmError: string | null = null;
  if (shouldConfirm && submit.invoiceId && submit.invoiceHash) {
    try {
      confirm = await confirmDigifabsterInvoice({
        invoiceId: submit.invoiceId,
        invoiceHash: submit.invoiceHash,
        status: placeStatus,
        poNumber,
        traceId,
      });
    } catch (error) {
      // Order is already submitted; surface the confirm failure without 5xx.
      confirmError = error instanceof Error ? error.message : "Invoice confirmation failed.";
    }
  }

  const finalStatus = confirm?.orderStatus || (shouldConfirm && !confirmError ? placeStatus : "submitted");

  return json(
    {
      status: "success",
      orderStatus: finalStatus,
      userId,
      orderId: order.orderId,
      orderTotalPrice: lastPurchase?.orderTotalPrice ?? null,
      purchases,
      submit: {
        payUrl: submit.payUrl,
        orderUrl: submit.orderUrl,
        invoiceId: submit.invoiceId,
        invoiceHash: submit.invoiceHash,
      },
      invoice: confirm
        ? {
            id: confirm.invoiceId,
            orderStatus: confirm.orderStatus,
            isPaid: confirm.isPaid,
            cost: confirm.cost,
          }
        : null,
      ...(confirmError ? { confirmWarning: confirmError } : {}),
      ...(shouldConfirm && submit.invoiceId && !submit.invoiceHash
        ? { confirmWarning: "submit_initial_order returned no invoice_hash; skipped confirm." }
        : {}),
    },
    200,
    req,
  );
}

const errorResponse = (
  error: unknown,
  stage: string,
  req: Request,
  extra: Record<string, unknown> = {},
) => {
  if (error instanceof DigifabsterSyncError) {
    return json(
      {
        error: error.message,
        stage,
        code: error.code,
        details: error.details,
        retryable: error.retryable,
        ...extra,
      },
      error.status >= 500 ? 502 : error.status,
      req,
    );
  }

  console.error(`digifabster-place-order ${stage} error:`, error);
  return json(
    { error: `Failed during ${stage}.`, details: error instanceof Error ? error.message : null, ...extra },
    500,
    req,
  );
};
