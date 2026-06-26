/**
 * Hermetic e2e for /api/digifabster-part-data.
 *
 * Mocks DigiFabster (token + preselection + batch_price + model thumbnail) and
 * drives the REAL route. Verifies that one call returns the combined OrderPart
 * data — image + dims (from /v2/models/{id}/) and materialId + requestedPrice
 * (from the internally-reused batch-price route) — and writes nothing to Bubble.
 *
 * Run: pnpm tsx scripts/digifabster-part-data-e2e.ts
 */
import assert from "node:assert/strict";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

const MODEL_ID = 4_392_012;
const MATERIAL_ID = 72_460;
const LEAD_TIME = "8fcabd8a-b22e-4b5e-9a7c-9e686cc00fcf";

interface Captured {
  batchPriceCalls: number;
  bubbleCalls: number;
  modelFetchCalls: number;
}

/** Minimal in-memory R2 stub so we can exercise the field-toggle config. */
const fakeR2 = (configJson: unknown) => ({
  get: async (key: string) =>
    key === "config/part-data-fields.json"
      ? { text: async () => JSON.stringify(configJson), arrayBuffer: async () => new ArrayBuffer(0) }
      : null,
  put: async () => undefined,
  list: async () => ({ objects: [] as Array<{ key: string }> }),
  delete: async () => undefined,
});

const buildPriceInfo = (count: number, perItem: number): Json => ({
  naked_price: perItem * 0.8,
  startup_cost: 25,
  post_production_price: 0,
  priority_price: perItem * 0.2,
  count,
  subtotal: perItem * count,
  without_startup_cost: perItem * count - 25,
  tax: 0,
  tax_percent: 0,
  discount_percent: 0,
  discount_value: 0,
  total: perItem * count,
  price_per_item: perItem,
});

const sendJson = (res: ServerResponse, status: number, payload: Json | null) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(payload === null ? "" : JSON.stringify(payload));
};

const startMockServer = async (captured: Captured): Promise<Server> => {
  const server = createServer(async (req: IncomingMessage, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";

    if (method === "POST" && url === "/v2/obtain_s2s_token/") {
      sendJson(res, 200, { token: "mock-s2s-token" });
      return;
    }

    // Material auto-pick (no R2 pricing config in node -> batch-price preselects).
    if (method === "POST" && url === "/v2/preselection/") {
      sendJson(res, 200, {
        [String(MODEL_ID)]: { is_ready: true, material: MATERIAL_ID, config: { thickness: "thk-1" } },
      });
      return;
    }

    if (method === "POST" && url === "/v2/batch_price/material/") {
      captured.batchPriceCalls += 1;
      sendJson(res, 200, {
        prices: [
          {
            priority_id: LEAD_TIME,
            priority_name_for_user: "Standard",
            priority_prices: [{ quantity: 1, price_info: buildPriceInfo(1, 55) }],
          },
        ],
        analysing_errors: [],
        warnings: [],
        batch_capacity: 4,
      });
      return;
    }

    // Model thumbnail + bounding-box dims.
    if (method === "GET" && url === `/v2/models/${MODEL_ID}/`) {
      captured.modelFetchCalls += 1;
      sendJson(res, 200, {
        id: MODEL_ID,
        thumb: "https://cdn/thumb.png",
        thumb_120x120: "https://cdn/thumb120.png",
        thumb_300x300: "https://cdn/thumb300.png",
        thumb_status: "success",
        units: "mm",
        size: { x: 122.67, y: 16.0, z: null },
        volume: null,
        surface: 1836.18,
      });
      return;
    }

    // Any Bubble Data API call would be a failure for a read-only endpoint.
    if (url.includes("/api/1.1/obj/")) {
      captured.bubbleCalls += 1;
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
  const captured: Captured = { batchPriceCalls: 0, bubbleCalls: 0, modelFetchCalls: 0 };
  const server = await startMockServer(captured);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  process.env.DIGIFABSTER_UPLOAD_BASE_URL = base;
  process.env.DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT = `${base}/v2/obtain_s2s_token/`;
  process.env.DIGIFABSTER_API_KEY = "mock-api-key";
  process.env.DIGIFABSTER_DEFAULT_LEAD_TIME_IDS = LEAD_TIME;
  process.env.DIGIFABSTER_BATCH_PRICE_INTERVAL_MS = "10";
  delete process.env.DIGIFABSTER_UPLOAD_SHARED_SECRET;

  try {
    const route = await import("../api/digifabster-part-data.cts");
    const GET = (route as unknown as { GET: (req: Request) => Promise<Response> }).GET;
    assert.equal(typeof GET, "function", "must export GET");

    console.log("[suite] GET /api/digifabster-part-data");
    const res = await GET(
      new Request(`${base}/api/digifabster-part-data?objectModelId=${MODEL_ID}&part_id=op-1&priceMultiplier=1.54`, {
        method: "GET",
      }),
    );
    const data = (await res.json()) as Json;
    assert.equal(res.status, 200, `should 200 (got ${res.status}: ${JSON.stringify(data)})`);

    // thumbnail + dims
    assert.equal(data.modelId, MODEL_ID, "modelId echoed");
    assert.equal(data.partId, "op-1", "partId echoed");
    assert.equal(data.image, "https://cdn/thumb300.png", "image = best thumbnail");
    assert.equal(data.dimX, 122.67, "dimX from model size");
    assert.equal(data.dimY, 16.0, "dimY from model size");
    assert.equal(data.dimZ, null, "dimZ null");
    assert.equal(data.dimUnits, "mm", "dimUnits from model");

    // material + price (reused from batch-price; multiplier applied)
    assert.equal(data.materialId, MATERIAL_ID, "materialId resolved (preselection)");
    assert.equal(data.materialSource, "preselection", "materialSource surfaced");
    assert.equal(data.requestedPrice, 84.7, "requestedPrice = 55 * 1.54");
    assert.equal(data.priceStatus, "priced", "priceStatus surfaced");
    assert.equal(data.shouldRetry, false, "shouldRetry false when priced");
    assert.equal(data.ready, true, "ready = image + dims + price present");

    // read-only: nothing written to Bubble
    assert.equal(captured.bubbleCalls, 0, "endpoint must not write to Bubble");
    assert.ok(captured.batchPriceCalls >= 1, "price computed via batch-price");
    assert.ok(captured.modelFetchCalls >= 1, "thumbnail fetched when fields enabled");

    /* ---- Field toggles: disable thumbnail/dims -> omitted + upstream skipped ---- */
    console.log("[suite] GET with thumbnail fields disabled (config)");
    (globalThis as { __ENTAG_R2__?: unknown }).__ENTAG_R2__ = fakeR2({
      fields: {
        image: false, thumbnails: false, dimX: false, dimY: false, dimZ: false, dimUnits: false,
        ready: false,
        // All other model-derived fields off too, so nothing needs the /v2/models/ call.
        volume: false, surface: false, sheetTopSurfaceArea: false, perimeter: false,
        punchesCount: false, shells: false, sizeZForSheet: false, cncComplexity: false,
        cncComplexityLevel: false, cncFeatures: false, dfmFeatures: false, fileViewerUrl: false,
        fileOriginalUrl: false, fileStlOriginalUrl: false, fileStlRepairedUrl: false,
        geometryType: false, technologies: false, filesize: false, title: false, dateCreated: false,
        materialId: true, materialSource: true, requestedPrice: true, priceStatus: true, shouldRetry: true,
      },
    });
    const modelsBefore = captured.modelFetchCalls;
    const res2 = await GET(
      new Request(`${base}/api/digifabster-part-data?objectModelId=${MODEL_ID}&priceMultiplier=1.54`, { method: "GET" }),
    );
    const data2 = (await res2.json()) as Json;
    assert.equal(res2.status, 200, "should 200");
    // disabled fields omitted entirely
    assert.equal("image" in data2, false, "image omitted when disabled");
    assert.equal("dimX" in data2, false, "dimX omitted when disabled");
    assert.equal("ready" in data2, false, "ready omitted when disabled");
    // enabled price fields still present
    assert.equal(data2.requestedPrice, 84.7, "price field kept");
    assert.equal(data2.materialId, MATERIAL_ID, "materialId kept");
    assert.equal(data2.modelId, MODEL_ID, "modelId always present");
    // upstream model fetch skipped since no thumbnail/dim field needs it
    assert.equal(captured.modelFetchCalls, modelsBefore, "model fetch skipped when thumbnail fields off");
    delete (globalThis as { __ENTAG_R2__?: unknown }).__ENTAG_R2__;

    console.log("[suite] PASS — combined part data + field toggles (omit + skip upstream)");
  } finally {
    await stopServer(server);
  }
};

run().catch((error) => {
  console.error("\n[suite] FAIL —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
