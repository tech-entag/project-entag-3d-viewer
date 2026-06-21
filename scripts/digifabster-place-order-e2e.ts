/**
 * Hermetic e2e proof for the place-order flow (Entag buying from DigiFabster).
 *
 * Exercises the REAL route + library code (no live DigiFabster creds):
 *   POST /api/digifabster-place-order  -> the full live sequence:
 *     preselection (tolerance/thickness) -> adm -> purchases -> submit -> confirm
 *
 * A single mock HTTP server stands in for DigiFabster. The client id + customer
 * come from the R2 place-order config, which falls back to the built-in fixed
 * data (Omar / 435622) when R2 is absent — exactly the case in this test.
 *
 * Run: pnpm tsx scripts/digifabster-place-order-e2e.ts
 */
import assert from "node:assert/strict";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

const CLIENT_ID = 435622; // matches DEFAULT_PLACE_ORDER_CONFIG.clientId
const MODEL_ID = 4_392_029;
const MODEL_ID_NOT_READY = 9_999_999;
const MATERIAL_ID = 72_335;
const ORDER_ID = 390_190;
const PURCHASE_ID = 1_178_655;
const INVOICE_ID = "310352";
const INVOICE_HASH = "ef8a74e2b74929dcd69a5b422adbaa881d932f6f3bdaa84404da1e2e";

const TOLERANCE_UUID = "f40eb7ce-7b2b-4554-9349-5e35ebc9d3ad";
const THICKNESS_UUID = "767e7c2c-6868-43ce-bd4d-3d218c7df534";
const LEAD_TIME_UUID = "8fcabd8a-b22e-4b5e-9a7c-9e686cc00fcf";

// A real preselection config: thickness (model-derived) but NO tolerance —
// DigiFabster omits tolerance from preselection, so the route falls back to
// DIGIFABSTER_DEFAULT_TOLERANCE_ID. Also carries fields the route must NOT
// forward into the purchase (its own lead_time / execution).
const PRESELECTION_CONFIG: Json = {
  thickness: THICKNESS_UUID,
  lead_time: "preselection-lead-should-be-ignored",
  execution: [1],
};

interface Captured {
  tokenExchangeCalls: number;
  preselectionCalls: number;
  admCalls: number;
  purchaseBody: Json | null;
  submitBody: Json | null;
  invoicePatch: { url: string; body: Json } | null;
}

const readBuffer = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const readJson = async (req: IncomingMessage): Promise<Json> => {
  const raw = (await readBuffer(req)).toString("utf8");
  return raw.trim() ? (JSON.parse(raw) as Json) : {};
};

const sendJson = (res: ServerResponse, status: number, payload: Json | null) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(payload === null ? "" : JSON.stringify(payload));
};

const orderPayload = (): Json => ({
  id: ORDER_ID,
  currency: "usd",
  total_price: "431.04",
  product_count: 1,
  products: [
    {
      id: PURCHASE_ID,
      model_id: MODEL_ID,
      material_id: MATERIAL_ID,
      material_title: "Aluminium 1100",
      count: 1,
      naked_price: 431.04,
      price_per_part: 431.04,
      total_price: 431.04,
    },
  ],
});

const startMockServer = async (captured: Captured): Promise<Server> => {
  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";

    if (method === "POST" && url === "/v2/obtain_s2s_token/") {
      captured.tokenExchangeCalls += 1;
      sendJson(res, 200, { token: "mock-s2s-token" });
      return;
    }

    if (method === "POST" && url === "/v2/preselection/") {
      captured.preselectionCalls += 1;
      const body = await readJson(req);
      const ids = Array.isArray(body.models_ids) ? (body.models_ids as number[]) : [];
      const id = ids[0];
      if (id === MODEL_ID_NOT_READY) {
        sendJson(res, 200, { [String(id)]: { is_ready: false, material: null, config: null } });
        return;
      }
      sendJson(res, 200, {
        [String(id)]: { is_ready: true, material: MATERIAL_ID, config: PRESELECTION_CONFIG },
      });
      return;
    }

    if (method === "POST" && url === `/v2/orders/users/${CLIENT_ID}/adm/`) {
      captured.admCalls += 1;
      sendJson(res, 200, { id: ORDER_ID, currency: "usd", product_count: 0, products: [], total_price: "0.00" });
      return;
    }

    if (method === "POST" && url === `/v2/orders/${ORDER_ID}/purchases/`) {
      captured.purchaseBody = await readJson(req);
      sendJson(res, 200, { purchase_id: PURCHASE_ID, order: orderPayload() });
      return;
    }

    if (method === "POST" && url === `/v2/orders/${ORDER_ID}/submit_initial_order/`) {
      captured.submitBody = await readJson(req);
      sendJson(res, 200, {
        id: ORDER_ID,
        company_order_id: 12,
        pay_url: "https://app.digifabster.com/entag/invoice/310352/hash",
        order_url: "https://manage.digifabster.com/manage/quotes/390190",
        invoice_id: INVOICE_ID,
        invoice_hash: INVOICE_HASH,
      });
      return;
    }

    if (method === "PATCH" && url === `/v2/invoices/${INVOICE_ID}/${INVOICE_HASH}/`) {
      captured.invoicePatch = { url, body: await readJson(req) };
      sendJson(res, 200, {
        id: Number(INVOICE_ID),
        is_paid: false,
        cost: 431.04,
        order: { id: ORDER_ID, status: "placed", company_order_id: 12 },
      });
      return;
    }

    sendJson(res, 404, { error: "Not Found", method, url });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return server;
};

const stopServer = async (server: Server) =>
  new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

const run = async () => {
  const captured: Captured = {
    tokenExchangeCalls: 0,
    preselectionCalls: 0,
    admCalls: 0,
    purchaseBody: null,
    submitBody: null,
    invoicePatch: null,
  };

  const server = await startMockServer(captured);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  process.env.DIGIFABSTER_UPLOAD_BASE_URL = base;
  process.env.DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT = `${base}/v2/obtain_s2s_token/`;
  process.env.DIGIFABSTER_API_KEY = "mock-api-key";
  process.env.DIGIFABSTER_DEFAULT_LEAD_TIME_IDS = LEAD_TIME_UUID;
  process.env.DIGIFABSTER_DEFAULT_TOLERANCE_ID = TOLERANCE_UUID;
  delete process.env.DIGIFABSTER_UPLOAD_SHARED_SECRET;
  delete process.env.DIGIFABSTER_DEFAULT_CLIENT_ID; // exercise the R2/default fallback

  try {
    const route = await import("../api/digifabster-place-order.cts");
    const POST = (route as unknown as { POST: (req: Request) => Promise<Response> }).POST;
    assert.equal(typeof POST, "function", "digifabster-place-order must export POST");

    /* ---- Scenario 1: full happy path (Bubble sends only the part) ---- */
    console.log("[suite] POST /api/digifabster-place-order (modelId + materialId + count only)");
    const req = new Request(`${base}/api/digifabster-place-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: MODEL_ID, materialId: MATERIAL_ID, count: 1, traceId: "place-order-e2e" }),
    });

    const res = await POST(req);
    const data = (await res.json()) as Json;
    assert.equal(res.status, 200, `route should return 200 (got ${res.status}: ${JSON.stringify(data)})`);

    /* ---- The full sequence fired in order ---- */
    assert.equal(captured.preselectionCalls, 1, "preselection called once (tolerance/thickness)");
    assert.equal(captured.admCalls, 1, "adm order created once");
    assert.ok(captured.purchaseBody, "purchase created");
    assert.ok(captured.submitBody, "order submitted");
    assert.ok(captured.invoicePatch, "invoice confirmed (placed)");

    /* ---- The purchase body matches the live contract ---- */
    const purchase = captured.purchaseBody as Json;
    assert.equal(purchase.model_id, MODEL_ID, "purchase model_id");
    assert.equal(purchase.material_id, MATERIAL_ID, "purchase material_id (from Bubble)");
    assert.equal(purchase.count, 1, "purchase count (scalar)");
    assert.equal(purchase.from_short_iqt, false, "from_short_iqt default false");
    const sentConfig = purchase.config as Json;
    // thickness from the model (preselection); tolerance from the configured
    // default (preselection omits it).
    assert.equal(sentConfig.thickness, THICKNESS_UUID, "thickness from model preselection");
    assert.equal(sentConfig.tolerance, TOLERANCE_UUID, "tolerance from DIGIFABSTER_DEFAULT_TOLERANCE_ID");
    // lead_time falls back to the env default; preselection's own lead_time is ignored.
    assert.equal(sentConfig.lead_time, LEAD_TIME_UUID, "lead_time from env default");
    assert.notEqual(sentConfig.lead_time, "preselection-lead-should-be-ignored", "preselection lead_time not used");
    assert.deepEqual(sentConfig.post_production, [], "post_production defaults to []");

    /* ---- The submit used the FIXED customer from config (Omar) ---- */
    const submit = captured.submitBody as Json;
    assert.equal(submit.name, "Omar", "fixed customer name from config");
    assert.equal(submit.surname, "Hawary", "fixed customer surname from config");
    assert.equal(submit.email, "omar@entag.co", "fixed customer email from config");
    assert.equal(submit.status, "firm_offer_sent", "submit status from config");

    /* ---- The confirm placed the order ---- */
    assert.equal((captured.invoicePatch as { body: Json }).body.status, "placed", "invoice PATCH status placed");

    /* ---- The response surfaced everything Bubble needs ---- */
    assert.equal(data.status, "success", "response status success");
    assert.equal(data.orderStatus, "placed", "final order status placed");
    assert.equal(data.userId, CLIENT_ID, "fixed client id used");
    assert.equal(data.orderId, ORDER_ID, "digifabster order id");
    assert.equal(data.orderTotalPrice, 431.04, "order total price");
    const purchasesOut = data.purchases as Array<Json>;
    assert.equal(purchasesOut.length, 1, "one purchase line");
    assert.equal(purchasesOut[0].totalPrice, 431.04, "line total price");
    assert.equal(purchasesOut[0].materialTitle, "Aluminium 1100", "line material title");
    const submitOut = data.submit as Json;
    assert.equal(submitOut.invoiceId, INVOICE_ID, "invoice id returned");
    assert.equal(submitOut.invoiceHash, INVOICE_HASH, "invoice hash returned");
    const invoiceOut = data.invoice as Json;
    assert.equal(invoiceOut.orderStatus, "placed", "invoice order status placed");
    assert.equal(invoiceOut.cost, 431.04, "invoice cost");

    console.log("[suite] Scenario 1 PASS — preselection -> adm -> purchase -> submit -> confirm(placed)");
    console.log(JSON.stringify({ orderId: data.orderId, orderStatus: data.orderStatus, purchases: data.purchases }, null, 2));

    /* ---- Scenario 2: not-ready model -> 409, NO order created ---- */
    console.log("\n[suite] Scenario 2: model not analysed yet -> 409, no dangling order");
    const admBefore = captured.admCalls;
    const req2 = new Request(`${base}/api/digifabster-place-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: MODEL_ID_NOT_READY, materialId: MATERIAL_ID, count: 1 }),
    });
    const res2 = await POST(req2);
    const data2 = (await res2.json()) as Json;
    assert.equal(res2.status, 409, "not-ready model returns 409");
    assert.equal(data2.stage, "preselection", "failure stage is preselection");
    assert.equal(data2.retryable, true, "marked retryable");
    assert.equal(captured.admCalls, admBefore, "no ADM order created when model not ready");

    console.log("[suite] Scenario 2 PASS — readiness gate blocks before order creation");
    console.log("\n[suite] PASS — all scenarios");
  } finally {
    await stopServer(server);
  }
};

run().catch((error) => {
  console.error("\n[suite] FAIL —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
