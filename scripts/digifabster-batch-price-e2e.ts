/**
 * Hermetic e2e proof for the batch-price flow (after upload of job + model).
 *
 * Exercises the REAL route + library code (no live DigiFabster creds):
 *   1. POST /api/digifabster-batch-price (the route handler) with a body that
 *      mirrors what Bubble sends: objectModelId + materialId + leadTime + count.
 *   2. The route -> getDigifabsterBatchPrice -> POST /v2/batch_price/material/.
 *
 * The mock DigiFabster returns `202` (still analysing) on the first call and
 * `200` with the price matrix on the second, proving the helper's poll loop.
 *
 * A single mock HTTP server stands in for DigiFabster (token exchange + batch
 * price). Run: pnpm tsx scripts/digifabster-batch-price-e2e.ts
 */
import assert from "node:assert/strict";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

const MODEL_ID = 4_384_010;
const MATERIAL_ID = 777;
const LEAD_TIME_A = "11111111-1111-4111-8111-111111111111";
const LEAD_TIME_B = "22222222-2222-4222-8222-222222222222";

interface Captured {
  tokenExchangeCalls: number;
  batchPriceCalls: number;
  preselectionCalls: number;
  lastBatchPriceBody: Json | null;
  bubblePatches: Array<{ url: string; body: Json }>;
}

// Mirrors a real preselection config: a required field (thickness) plus fields
// batch_price rejects (execution / lead_time). The route must forward thickness
// but strip the disallowed keys.
const PRESELECTION_CONFIG: Json = { thickness: 3, execution: [1], lead_time: "x" };

const readBuffer = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const sendJson = (res: ServerResponse, status: number, payload: Json | null) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(payload === null ? "" : JSON.stringify(payload));
};

const buildPriceInfo = (count: number, perItem: number): Json => {
  const subtotal = perItem * count;
  return {
    naked_price: perItem * 0.8,
    startup_cost: 25,
    post_production_price: 0,
    priority_price: perItem * 0.2,
    count,
    subtotal,
    without_startup_cost: subtotal - 25,
    tax: subtotal * 0.1,
    tax_percent: 10,
    discount_percent: 0,
    discount_value: 0,
    total: subtotal + subtotal * 0.1,
    price_per_item: perItem,
  };
};

const startMockServer = async (captured: Captured): Promise<Server> => {
  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";

    // --- DigiFabster: S2S token exchange ---
    if (method === "POST" && url === "/v2/obtain_s2s_token/") {
      captured.tokenExchangeCalls += 1;
      sendJson(res, 200, { token: "mock-s2s-token" });
      return;
    }

    // --- DigiFabster: preselection (auto-pick material + config) ---
    if (method === "POST" && url === "/v2/preselection/") {
      captured.preselectionCalls += 1;
      sendJson(res, 200, {
        [String(MODEL_ID)]: { is_ready: true, material: MATERIAL_ID, config: PRESELECTION_CONFIG },
      });
      return;
    }

    // --- DigiFabster: bulk material price ---
    if (method === "POST" && url === "/v2/batch_price/material/") {
      captured.batchPriceCalls += 1;
      const raw = (await readBuffer(req)).toString("utf8");
      captured.lastBatchPriceBody = raw.trim() ? (JSON.parse(raw) as Json) : {};

      // First call: still analysing (202, no body). Then: priced (200).
      if (captured.batchPriceCalls === 1) {
        sendJson(res, 202, null);
        return;
      }

      const count = Array.isArray(captured.lastBatchPriceBody.count)
        ? (captured.lastBatchPriceBody.count as number[])
        : [1];
      sendJson(res, 200, {
        prices: [
          {
            priority_id: LEAD_TIME_A,
            priority_name_for_user: "Standard",
            priority_prices: count.map((q) => ({ quantity: q, price_info: buildPriceInfo(q, 50) })),
          },
          {
            priority_id: LEAD_TIME_B,
            priority_name_for_user: "Express",
            priority_prices: count.map((q) => ({ quantity: q, price_info: buildPriceInfo(q, 80) })),
          },
        ],
        analysing_errors: [],
        warnings: [],
        correct_object_model: null,
        batch_capacity: 4,
      });
      return;
    }

    // --- Bubble Data API: OrderPart PATCH (requestedPrice) ---
    if (method === "PATCH" && url.startsWith("/api/1.1/obj/OrderPart/")) {
      const raw = (await readBuffer(req)).toString("utf8");
      captured.bubblePatches.push({ url, body: raw.trim() ? (JSON.parse(raw) as Json) : {} });
      sendJson(res, 200, { status: "success" });
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
    batchPriceCalls: 0,
    preselectionCalls: 0,
    lastBatchPriceBody: null,
    bubblePatches: [],
  };

  const server = await startMockServer(captured);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Point the library at the mock server; keep the run hermetic & fast.
  process.env.DIGIFABSTER_UPLOAD_BASE_URL = base;
  process.env.DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT = `${base}/v2/obtain_s2s_token/`;
  process.env.DIGIFABSTER_API_KEY = "mock-api-key";
  process.env.DIGIFABSTER_BATCH_PRICE_ATTEMPTS = "5";
  process.env.DIGIFABSTER_BATCH_PRICE_INTERVAL_MS = "10"; // tiny poll for the test
  delete process.env.DIGIFABSTER_UPLOAD_SHARED_SECRET;

  try {
    const route = await import("../api/digifabster-batch-price.cts");
    const POST = (route as unknown as { POST: (req: Request) => Promise<Response> }).POST;
    assert.equal(typeof POST, "function", "digifabster-batch-price must export POST");

    /* ---- Call the route exactly as Bubble would ---- */
    console.log("[suite] POST /api/digifabster-batch-price (objectModelId + materialId + leadTime + count)");
    const req = new Request(`${base}/api/digifabster-batch-price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectModelId: MODEL_ID,
        materialId: MATERIAL_ID,
        leadTime: [LEAD_TIME_A, LEAD_TIME_B],
        count: [1, 5, 10],
        traceId: "batch-price-e2e",
        // Bubble write target (thing type `OrderPart`, field `requestedPrice`).
        part_id: "orderpart-xyz",
        bubbleApiToken: "mock-bubble-token",
        bubbleDataApiBaseUrl: `${base}/api/1.1/obj`,
        // Editable price multiplier (R2 config in prod; body override here).
        priceMultiplier: 1.54,
      }),
    });

    const res = await POST(req);
    assert.equal(res.status, 200, "route should return 200");
    const data = (await res.json()) as Json;

    /* ---- The poll loop: 202 then 200 ---- */
    assert.equal(captured.batchPriceCalls, 2, "should poll once (202) then succeed (200)");
    assert.equal(data.status, "priced", "final status should be priced");
    assert.equal(data.materialId, MATERIAL_ID, "materialId surfaced at top level");
    assert.equal(data.materialSource, "request", "materialSource surfaced at top level");

    /* ---- The upstream body carried the right fields ---- */
    const sent = captured.lastBatchPriceBody as Json;
    assert.equal(sent.model_id, MODEL_ID, "upstream model_id");
    assert.equal(sent.material_id, MATERIAL_ID, "upstream material_id");
    assert.deepEqual(sent.count, [1, 5, 10], "upstream count array");
    assert.deepEqual(sent.lead_time, [LEAD_TIME_A, LEAD_TIME_B], "upstream lead_time array");

    /* ---- The parsed price matrix ---- */
    const prices = data.prices as Array<Json>;
    assert.equal(prices.length, 2, "two priorities priced");
    const standard = prices.find((p) => p.priorityId === LEAD_TIME_A) as Json;
    assert.ok(standard, "standard priority present");
    const standardRows = standard.prices as Array<Json>;
    assert.equal(standardRows.length, 3, "three quantity rows (1,5,10)");
    const qty10 = standardRows.find((r) => r.quantity === 10) as Json;
    const info = qty10.priceInfo as Json;
    assert.equal(info.pricePerItem, 50, "price_per_item mapped");
    assert.equal(info.count, 10, "count mapped");
    assert.equal(data.batchCapacity, 4, "batch_capacity mapped");

    /* ---- The selected price written to Bubble ---- */
    const selectedPrice = data.selectedPrice as Json;
    assert.ok(selectedPrice, "a price should be selected for the Bubble write");
    // First lead-time priority (LEAD_TIME_A) + first requested quantity (1) -> total 55.
    assert.equal(selectedPrice.priorityId, LEAD_TIME_A, "selected the first lead-time priority");
    assert.equal(selectedPrice.quantity, 1, "selected the first requested quantity");
    assert.equal(selectedPrice.field, "total", "default money field is total");
    // Multiplier applied: base total 55 * 1.54 = 84.7.
    assert.equal(selectedPrice.baseCost, 55, "base cost = total for qty 1 @ Standard");
    assert.equal(selectedPrice.multiplier, 1.54, "multiplier echoed");
    assert.equal(selectedPrice.cost, 84.7, "final cost = base * multiplier");

    const bubble = data.bubble as Json;
    assert.equal(bubble.status, "updated", "Bubble write should succeed");
    assert.equal(bubble.field, "requestedPrice", "writes the requestedPrice field");
    // Price and materialId are written as SEPARATE PATCHes (a bad material
    // field must not block the price), so there are two captured PATCHes.
    assert.equal(captured.bubblePatches.length, 2, "two separate PATCHes (price + materialId)");
    const pricePatch = captured.bubblePatches.find((p) => "requestedPrice" in p.body);
    const materialPatch = captured.bubblePatches.find((p) => "materialId" in p.body);
    assert.ok(pricePatch, "a PATCH writes requestedPrice");
    assert.equal(pricePatch?.url, "/api/1.1/obj/OrderPart/orderpart-xyz", "price PATCH targets the OrderPart thing");
    assert.equal(pricePatch?.body.requestedPrice, 84.7, "price PATCH sets multiplied requestedPrice");
    assert.ok(materialPatch, "a separate PATCH writes materialId");
    assert.equal(materialPatch?.body.materialId, MATERIAL_ID, "material PATCH writes materialId");
    assert.equal((bubble.materialWrite as Json)?.field, "materialId", "Bubble write reports the materialId field");
    assert.equal((bubble.materialWrite as Json)?.status, "updated", "materialId write succeeded");

    console.log("\n[suite] Scenario 1 PASS — batch-price (202 -> 200, matrix parsed, price -> Bubble)");
    console.log(JSON.stringify({ selectedPrice: data.selectedPrice, bubble: data.bubble }, null, 2));

    /* ---- Scenario 2: material auto-resolved via preselection (no materialId) ---- */
    console.log("\n[suite] Scenario 2: omit materialId -> DigiFabster preselection auto-pick");
    const req2 = new Request(`${base}/api/digifabster-batch-price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectModelId: MODEL_ID,
        leadTime: [LEAD_TIME_A],
        count: [1],
        tolerance: "tol-standard-id",
        traceId: "batch-price-e2e-preselect",
      }),
    });
    const res2 = await POST(req2);
    assert.equal(res2.status, 200, "scenario 2 should return 200");
    const data2 = (await res2.json()) as Json;

    assert.ok(captured.preselectionCalls >= 1, "preselection should be called when materialId omitted");
    const request2 = data2.request as Json;
    assert.equal(request2.materialSource, "preselection", "material resolved via preselection");
    assert.equal(request2.materialId, MATERIAL_ID, "material id comes from preselection");
    // Preselection config is forwarded (thickness kept) but batch_price-rejected
    // keys (execution/lead_time) are stripped, and tolerance is injected.
    const sentConfig = (captured.lastBatchPriceBody as Json).config as Json;
    assert.deepEqual(
      sentConfig,
      { thickness: 3, tolerance: "tol-standard-id" },
      "forwards preselection config minus disallowed keys, plus tolerance",
    );
    assert.equal(sentConfig.execution, undefined, "disallowed `execution` is stripped");
    assert.equal(sentConfig.lead_time, undefined, "disallowed `lead_time` is stripped");
    assert.equal(data2.status, "priced", "scenario 2 priced");

    console.log("[suite] Scenario 2 PASS — preselection auto-material verified");
    console.log("\n[suite] PASS — all scenarios");
  } finally {
    await stopServer(server);
  }
};

run().catch((error) => {
  console.error("\n[suite] FAIL —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
