/**
 * Hermetic e2e proof for the upload -> thumbnail -> Bubble flow.
 *
 * Exercises the REAL library code (no live DigiFabster / Bubble creds):
 *   1. syncNativeSourceToDigifabster  -> POST /v2/upload_job/ then /v2/upload_models/
 *      (asserts the upload_job uuid is threaded through to the result)
 *   2. getDigifabsterModelThumbnail   -> GET  /v2/models/{id}/  (thumb_* URLs)
 *   3. updateBubbleOrderPartModelId   -> PATCH bubble orderpart with modelId + thumbnail
 *      in a single request (the seamless write wired into conversion-status).
 *
 * A single mock HTTP server stands in for both DigiFabster and the Bubble Data API.
 *
 * Run: pnpm tsx scripts/upload-thumbnail-bubble-e2e.ts
 */
import assert from "node:assert/strict";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

const OBJECT_MODEL_ID = 555_001;
const EXPECTED_JOB_ID = "11111111-2222-4333-8444-555555555555";
const THUMB_300 = "https://cdn.mock-digifabster.test/thumb_300.png";
const THUMB_120 = "https://cdn.mock-digifabster.test/thumb_120.png";
const THUMB = "https://cdn.mock-digifabster.test/thumb.png";

interface Captured {
  tokenExchangeCalls: number;
  uploadJobCalls: number;
  uploadModelsCalls: number;
  modelGetCalls: number;
  uploadModelsBodyHadJobId: boolean;
  bubblePatch: { url: string; body: Json } | null;
}

const readBuffer = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const sendJson = (res: ServerResponse, status: number, payload: Json) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
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

    // --- DigiFabster: create upload job ---
    if (method === "POST" && url === "/v2/upload_job/") {
      captured.uploadJobCalls += 1;
      sendJson(res, 200, { id: EXPECTED_JOB_ID });
      return;
    }

    // --- DigiFabster: upload models (multipart form-data) ---
    if (method === "POST" && url === "/v2/upload_models/") {
      captured.uploadModelsCalls += 1;
      const body = (await readBuffer(req)).toString("utf8");
      // The multipart body should carry the upload_job_id field value.
      captured.uploadModelsBodyHadJobId = body.includes(EXPECTED_JOB_ID);
      sendJson(res, 200, {
        success: true,
        object_model_id: OBJECT_MODEL_ID,
        order_id: 99,
        session_id: "mock-session-1",
        status: "received",
      });
      return;
    }

    // --- DigiFabster: model details (thumbnail URLs + dimensions) ---
    if (method === "GET" && url === `/v2/models/${OBJECT_MODEL_ID}/`) {
      captured.modelGetCalls += 1;
      sendJson(res, 200, {
        id: OBJECT_MODEL_ID,
        thumb: THUMB,
        thumb_120x120: THUMB_120,
        thumb_300x300: THUMB_300,
        thumb_status: "done",
        units: "mm",
        volume: 12345.6,
        surface: 7890.1,
        size: { x: 120.5, y: 80, z: 15.2 },
      });
      return;
    }

    // --- Source file fetched by the upload step ---
    if (method === "GET" && url === "/source/test.step") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/step");
      res.end(Buffer.from("ISO-10303-21; mock step bytes", "utf8"));
      return;
    }

    // --- Bubble Data API: orderpart PATCH ---
    if (method === "PATCH" && url.startsWith("/api/1.1/obj/orderpart/")) {
      const raw = (await readBuffer(req)).toString("utf8");
      captured.bubblePatch = { url, body: raw.trim() ? (JSON.parse(raw) as Json) : {} };
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
    uploadJobCalls: 0,
    uploadModelsCalls: 0,
    modelGetCalls: 0,
    uploadModelsBodyHadJobId: false,
    bubblePatch: null,
  };

  const server = await startMockServer(captured);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Point the library at the mock server; keep the run hermetic.
  process.env.DIGIFABSTER_UPLOAD_BASE_URL = base;
  process.env.DIGIFABSTER_UPLOAD_ENDPOINT = `${base}/v2/upload_models/`;
  process.env.DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT = `${base}/v2/obtain_s2s_token/`;
  process.env.DIGIFABSTER_API_KEY = "mock-api-key";
  // Force the live upload path (no blob cache short-circuit) and no shared secret.
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.DIGIFABSTER_UPLOAD_SHARED_SECRET;

  try {
    const sync = await import("../api/autodesk_helpers/digifabster-sync");
    const conversion = await import("../api/conversion-status.cts");

    const conversionExports =
      (conversion as unknown as { default?: Json }).default || (conversion as unknown as Json);
    const updateBubbleOrderPartModelId = conversionExports.updateBubbleOrderPartModelId as (
      params: {
        baseUrl: string;
        token: string;
        thingType: string;
        partId: string;
        fieldName: string;
        modelId: number;
        thumbnailField?: string | null;
        thumbnailUrl?: string | null;
      },
    ) => Promise<{ ok: boolean; status: number; endpoint: string; payload: Json; responseData: unknown }>;

    assert.equal(typeof updateBubbleOrderPartModelId, "function", "conversion-status must export updateBubbleOrderPartModelId");

    /* ---- Step 1: upload (native source) ---- */
    console.log("[suite] Step 1/3: upload native source to DigiFabster (job -> models)");
    const upload = await sync.syncNativeSourceToDigifabster({
      urn: "mock-urn-001",
      sourceUrl: `${base}/source/test.step`,
      sourceFileName: "test.step",
      partId: "orderpart-abc",
      version: "v1",
      traceId: "upload-thumb-bubble-e2e",
    });

    assert.equal(upload.status, "submitted", "Upload should be submitted (not cached/skipped)");
    assert.equal(upload.objectModelId, OBJECT_MODEL_ID, "objectModelId should come from upload_models");
    assert.equal(upload.uploadJobId, EXPECTED_JOB_ID, "upload_job uuid should be threaded into the result");
    assert.equal(captured.uploadJobCalls, 1, "Exactly one upload_job call expected");
    assert.equal(captured.uploadModelsCalls, 1, "Exactly one upload_models call expected");
    assert.ok(captured.uploadModelsBodyHadJobId, "upload_models body must carry the upload_job_id");

    /* ---- Step 2: thumbnail ---- */
    console.log("[suite] Step 2/3: fetch model thumbnail");
    const thumbnail = await sync.getDigifabsterModelThumbnail(upload.objectModelId as number, "upload-thumb-bubble-e2e");

    assert.equal(captured.modelGetCalls, 1, "Exactly one model GET expected");
    assert.equal(thumbnail.thumb300x300, THUMB_300, "thumb_300x300 should be parsed");
    assert.equal(thumbnail.thumb120x120, THUMB_120, "thumb_120x120 should be parsed");
    assert.equal(thumbnail.thumbStatus, "done", "thumb_status should be parsed");
    // Dimensions (model `size` + units) come back from the same GET.
    assert.equal(thumbnail.sizeX, 120.5, "size.x should be parsed");
    assert.equal(thumbnail.sizeY, 80, "size.y should be parsed");
    assert.equal(thumbnail.sizeZ, 15.2, "size.z should be parsed");
    assert.equal(thumbnail.units, "mm", "units should be parsed");

    // conversion-status picks 300 -> 120 -> thumb.
    const thumbnailUrl = thumbnail.thumb300x300 || thumbnail.thumb120x120 || thumbnail.thumb;
    assert.equal(thumbnailUrl, THUMB_300, "Preferred thumbnail should be the 300x300 variant");

    /* ---- Step 3: Bubble write (modelId + thumbnail + dimensions in one PATCH) ---- */
    console.log("[suite] Step 3/3: write modelId + thumbnail + dimensions to Bubble in a single PATCH");
    const result = await updateBubbleOrderPartModelId({
      baseUrl: `${base}/api/1.1/obj`,
      token: "mock-bubble-token",
      thingType: "orderpart",
      partId: "orderpart-abc",
      fieldName: "modelId",
      modelId: upload.objectModelId as number,
      thumbnailField: "modelThumbnail",
      thumbnailUrl,
      extraFields: {
        dimX: thumbnail.sizeX,
        dimY: thumbnail.sizeY,
        dimZ: thumbnail.sizeZ,
        dimUnits: thumbnail.units,
      },
    });

    assert.equal(result.ok, true, "Bubble PATCH should succeed");
    assert.ok(captured.bubblePatch, "Bubble server should have captured a PATCH");
    assert.equal(captured.bubblePatch?.url, "/api/1.1/obj/orderpart/orderpart-abc", "PATCH should target the orderpart");
    assert.equal(captured.bubblePatch?.body.modelId, String(OBJECT_MODEL_ID), "PATCH must set modelId");
    assert.equal(captured.bubblePatch?.body.modelThumbnail, THUMB_300, "PATCH must set thumbnail in the same request");
    assert.equal(captured.bubblePatch?.body.dimX, 120.5, "PATCH must set dimX");
    assert.equal(captured.bubblePatch?.body.dimY, 80, "PATCH must set dimY");
    assert.equal(captured.bubblePatch?.body.dimZ, 15.2, "PATCH must set dimZ");
    assert.equal(captured.bubblePatch?.body.dimUnits, "mm", "PATCH must set dimUnits");

    console.log("\n[suite] PASS — upload -> thumbnail -> bubble flow verified");
    console.log(JSON.stringify({ upload, thumbnail, bubblePatch: captured.bubblePatch }, null, 2));
  } finally {
    await stopServer(server);
  }
};

run().catch((error) => {
  console.error("\n[suite] FAIL —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
