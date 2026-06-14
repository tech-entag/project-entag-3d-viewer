import {
  DigifabsterSyncError,
  createDigifabsterOrder,
  getDigifabsterModelThumbnail,
  submitDigifabsterInitialOrder,
  type DigifabsterModelThumbnail,
  type DigifabsterOrderCustomer,
  type DigifabsterOrderStatus,
} from "./autodesk_helpers/digifabster-sync";

export const config = {
  maxDuration: 60,
};

const DEFAULT_BUBBLE_DATA_API_BASE_URL = "https://app.entag.co/version-test/api/1.1/obj";

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

/** PATCH a Bubble thing with the model thumbnail URL (and optional order id). */
const updateBubbleOrderPartThumbnail = async (params: {
  baseUrl: string;
  token: string;
  thingType: string;
  partId: string;
  thumbnailField: string;
  thumbnailUrl: string;
  orderIdField?: string | null;
  orderId?: number | null;
}) => {
  const endpoint = `${params.baseUrl}/${encodeURIComponent(params.thingType)}/${encodeURIComponent(params.partId)}`;
  const payload: Record<string, unknown> = {
    [params.thumbnailField]: params.thumbnailUrl,
  };
  if (params.orderIdField && typeof params.orderId === "number" && Number.isFinite(params.orderId)) {
    payload[params.orderIdField] = String(params.orderId);
  }

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

const ORDER_STATUSES: ReadonlySet<string> = new Set([
  "created",
  "waiting_for_review",
  "placed",
  "firm_offer_sent",
  "initial",
]);

const resolveOrderStatus = (...values: unknown[]): DigifabsterOrderStatus => {
  const candidate = pickString(...values);
  if (candidate && ORDER_STATUSES.has(candidate)) return candidate as DigifabsterOrderStatus;
  return "created";
};

const resolveCustomer = (body: Record<string, unknown>): DigifabsterOrderCustomer | { error: string; missing: string[] } => {
  const customerObj = asRecord(body.customer) ?? {};

  const name = pickString(body.name, customerObj.name, process.env.DIGIFABSTER_ORDER_NAME);
  const surname = pickString(body.surname, customerObj.surname, process.env.DIGIFABSTER_ORDER_SURNAME);
  const phone = pickString(body.phone, customerObj.phone, process.env.DIGIFABSTER_ORDER_PHONE);
  const email = pickString(body.email, customerObj.email, process.env.DIGIFABSTER_ORDER_EMAIL);

  const missing: string[] = [];
  if (!name) missing.push("name");
  if (!surname) missing.push("surname");
  if (!phone) missing.push("phone");
  if (!email) missing.push("email");
  if (missing.length > 0) {
    return { error: "Missing required customer fields for order submission.", missing };
  }

  const customer: DigifabsterOrderCustomer = {
    name: name as string,
    surname: surname as string,
    phone: phone as string,
    email: email as string,
    status: resolveOrderStatus(body.status, customerObj.status, process.env.DIGIFABSTER_ORDER_STATUS),
  };

  const notes = pickString(body.notes, customerObj.notes);
  if (notes) customer.notes = notes;

  const billingName = pickString(customerObj.billing_name, (body as Record<string, unknown>).billing_name);
  if (billingName) customer.billing_name = billingName;
  const billingSurname = pickString(customerObj.billing_surname, (body as Record<string, unknown>).billing_surname);
  if (billingSurname) customer.billing_surname = billingSurname;
  const billingPhone = pickString(customerObj.billing_phone, (body as Record<string, unknown>).billing_phone);
  if (billingPhone) customer.billing_phone = billingPhone;
  const billingEmail = pickString(customerObj.billing_email, (body as Record<string, unknown>).billing_email);
  if (billingEmail) customer.billing_email = billingEmail;

  const deliveryAddress = asRecord(customerObj.delivery_address) ?? asRecord(body.delivery_address);
  if (deliveryAddress) customer.delivery_address = deliveryAddress;
  const companyAddress = asRecord(customerObj.customer_company_address) ?? asRecord(body.customer_company_address);
  if (companyAddress) customer.customer_company_address = companyAddress;
  const customFields = asRecord(customerObj.custom_fields) ?? asRecord(body.custom_fields);
  if (customFields) customer.custom_fields = customFields;

  if (typeof customerObj.disable_notification === "boolean") {
    customer.disable_notification = customerObj.disable_notification;
  } else if (typeof body.disable_notification === "boolean") {
    customer.disable_notification = body.disable_notification;
  }

  return customer;
};

const pickThumbnailUrl = (thumbnail: DigifabsterModelThumbnail): string | null =>
  thumbnail.thumb300x300 || thumbnail.thumb120x120 || thumbnail.thumb || null;

/** Best-effort extraction of an object_model_id from a created order payload. */
const extractModelIdFromOrder = (orderData: Record<string, unknown>): number | null => {
  const products = Array.isArray(orderData.products) ? orderData.products : [];
  for (const product of products) {
    const record = asRecord(product);
    if (!record) continue;
    const model = asRecord(record.model);
    const candidate =
      positiveInt(record.object_model_id) ??
      positiveInt(record.model_id) ??
      positiveInt(model?.id);
    if (candidate) return candidate;
  }
  return null;
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

  const traceId = pickString(body.traceId, body.trace_id) || `order-${Date.now().toString(36)}`;

  const uploadJob = pickString(body.uploadJob, body.upload_job);
  const explicitModelId = positiveInt(body.objectModelId, body.object_model_id);
  const locale = pickString(body.locale);
  const inhouseOwner = positiveInt(body.inhouseOwner, body.inhouse_owner);
  const orderPayload = "payload" in body ? body.payload : undefined;

  /* ---- 1. Create order ---- */
  let order: Awaited<ReturnType<typeof createDigifabsterOrder>>;
  try {
    order = await createDigifabsterOrder({
      uploadJob,
      locale,
      inhouseOwner,
      payload: orderPayload,
      traceId,
    });
  } catch (error) {
    return errorResponse(error, "order_create", req);
  }

  /* ---- 2. Submit initial order ---- */
  const customer = resolveCustomer(body);
  if ("error" in customer) {
    return json(
      {
        error: customer.error,
        missing: customer.missing,
        hint: "Provide customer.{name,surname,phone,email} in the body or set DIGIFABSTER_ORDER_* env vars.",
        orderId: order.orderId,
      },
      400,
      req,
    );
  }

  let submit: Awaited<ReturnType<typeof submitDigifabsterInitialOrder>>;
  try {
    submit = await submitDigifabsterInitialOrder({ orderId: order.orderId, customer, traceId });
  } catch (error) {
    return errorResponse(error, "order_submit", req, { orderId: order.orderId });
  }

  /* ---- 3. Get thumbnail ---- */
  const modelId = explicitModelId ?? extractModelIdFromOrder(order.data);
  let thumbnail: DigifabsterModelThumbnail | null = null;
  let thumbnailUrl: string | null = null;
  let thumbnailError: string | null = null;

  if (modelId) {
    try {
      thumbnail = await getDigifabsterModelThumbnail(modelId, traceId);
      thumbnailUrl = pickThumbnailUrl(thumbnail);
    } catch (error) {
      thumbnailError = error instanceof Error ? error.message : "Unknown thumbnail error";
    }
  } else {
    thumbnailError = "No object_model_id provided or resolvable from the order; skipped thumbnail fetch.";
  }

  /* ---- 4. Return thumbnail to Bubble ---- */
  const partId = pickString(body.part_id, body.partId);
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
    pickString(body.bubble_orderpart_type, body.bubbleOrderPartType, process.env.BUBBLE_ORDERPART_TYPE) || "orderpart";
  const bubbleThumbnailField =
    pickString(body.bubble_thumbnail_field, body.bubbleThumbnailField, process.env.BUBBLE_THUMBNAIL_FIELD) ||
    "image";
  const bubbleOrderIdField = pickString(
    body.bubble_orderid_field,
    body.bubbleOrderIdField,
    process.env.BUBBLE_ORDERID_FIELD,
  );

  let bubbleUpdate: Record<string, unknown> | null = null;
  if (thumbnailUrl && partId && bubbleToken) {
    const result = await updateBubbleOrderPartThumbnail({
      baseUrl: bubbleBaseUrl,
      token: bubbleToken,
      thingType: bubbleThingType,
      partId,
      thumbnailField: bubbleThumbnailField,
      thumbnailUrl,
      orderIdField: bubbleOrderIdField,
      orderId: order.orderId,
    });
    bubbleUpdate = {
      status: result.ok ? "updated" : "failed",
      httpStatus: result.status,
      endpoint: result.endpoint,
      field: bubbleThumbnailField,
      ...(result.ok ? {} : { responseData: result.responseData }),
    };
  } else {
    bubbleUpdate = {
      status: "skipped",
      reason: !thumbnailUrl
        ? "no_thumbnail_url"
        : !partId
          ? "missing_part_id"
          : "missing_bubble_token",
    };
  }

  return json(
    {
      status: "success",
      orderId: order.orderId,
      submit: {
        payUrl: submit.payUrl,
        orderUrl: submit.orderUrl,
        invoiceId: submit.invoiceId,
        invoiceHash: submit.invoiceHash,
      },
      thumbnail: thumbnail
        ? {
            modelId: thumbnail.modelId,
            url: thumbnailUrl,
            thumb: thumbnail.thumb,
            thumb_120x120: thumbnail.thumb120x120,
            thumb_300x300: thumbnail.thumb300x300,
            thumb_status: thumbnail.thumbStatus,
          }
        : null,
      ...(thumbnailError ? { thumbnailWarning: thumbnailError } : {}),
      bubble: bubbleUpdate,
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

  console.error(`digifabster-order ${stage} error:`, error);
  return json(
    { error: `Failed during ${stage}.`, details: error instanceof Error ? error.message : null, ...extra },
    500,
    req,
  );
};
