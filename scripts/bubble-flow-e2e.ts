import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = Record<string, JsonValue>;

const STEP_FIXTURE_PATH =
  process.env.STEP_FIXTURE_PATH ||
  path.resolve(process.cwd(), "cutting-blade-1-k110-1.STEP");
const MOCK_PRICE_TWEAKER_PORT = Number(process.env.MOCK_PRICE_TWEAKER_PORT || 7788);
const MOCK_PRICE_TWEAKER_ENDPOINT = `http://127.0.0.1:${MOCK_PRICE_TWEAKER_PORT}/mock/price-tweaking`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseJsonResponse = async (response: Response): Promise<JsonObject> => {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  return JSON.parse(text) as JsonObject;
};

const readJsonBody = async (req: IncomingMessage): Promise<JsonObject> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const bodyText = Buffer.concat(chunks).toString("utf8");
  if (!bodyText.trim()) {
    return {};
  }

  return JSON.parse(bodyText) as JsonObject;
};

const sendJson = (res: ServerResponse, statusCode: number, payload: JsonObject) => {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
};

const startMockPriceTweakerServer = async (calls: JsonObject[]) => {
  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/mock/price-tweaking") {
      const payload = await readJsonBody(req);
      calls.push(payload);
      sendJson(res, 200, {
        success: true,
        object_model_id: 90210,
        order_id: 712,
        session_id: "mock-session-001",
        status: "accepted",
      });
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(MOCK_PRICE_TWEAKER_PORT, "127.0.0.1", () => resolve());
  });

  return server;
};

const stopServer = async (server: Server) => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};

const run = async () => {
  assert.ok(fs.existsSync(STEP_FIXTURE_PATH), `Missing STEP fixture at ${STEP_FIXTURE_PATH}`);

  const calls: JsonObject[] = [];
  const mockServer = await startMockPriceTweakerServer(calls);

  process.env.DIGIFABSTER_PRICE_TWEAK_ENDPOINT = MOCK_PRICE_TWEAKER_ENDPOINT;

  try {
    const autodeskModule = await import("../api/autodesk.cts");
    const conversionModule = await import("../api/conversion-status.cts");
    const priceTweakerModule = await import("../api/digifabster-price-tweak.cts");

    const autodeskExports = (autodeskModule as unknown as { default?: JsonObject })
      .default || (autodeskModule as unknown as JsonObject);
    const conversionExports = (conversionModule as unknown as { default?: JsonObject })
      .default || (conversionModule as unknown as JsonObject);
    const priceTweakerExports = (priceTweakerModule as unknown as { default?: JsonObject })
      .default || (priceTweakerModule as unknown as JsonObject);

    const autodeskPost = autodeskExports.POST as unknown as (req: Request) => Promise<Response>;
    const conversionPost = conversionExports.POST as unknown as (req: Request) => Promise<Response>;
    const priceTweakerGet = priceTweakerExports.GET as unknown as (req: Request) => Promise<Response>;
    const priceTweakerPost = priceTweakerExports.POST as unknown as (req: Request) => Promise<Response>;

    const fixtureUrl = pathToFileURL(STEP_FIXTURE_PATH).href;

    console.log("[suite] Step 1/4: Simulate Bubble upload via /api/autodesk (dry_run)");
    const uploadResponse = await autodeskPost(
      new Request("http://127.0.0.1/api/autodesk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dry_run: true,
          url: fixtureUrl,
          part_id: "bubble-step-test-part",
          version: "bubble-step-test",
        }),
      })
    );

    assert.equal(uploadResponse.status, 200, "Upload dry-run should return 200");
    const uploadJson = await parseJsonResponse(uploadResponse);
    assert.equal(uploadJson.success, true, "Upload response should be successful");
    assert.ok(String(uploadJson.urn).startsWith("dryrun:"), "Upload should return dryrun URN");
    assert.equal(uploadJson.sourceFormat, "step", "Fixture must classify as STEP");
    assert.equal((uploadJson.quote as JsonObject).status, "not_required", "STEP should skip quote conversion");

    console.log("[suite] Step 2/4: Poll /api/conversion-status until viewer is available");
    const viewerProgress = ["queued", "inprogress", "success"] as const;
    let finalViewerStatus = "queued";

    for (const viewerStatus of viewerProgress) {
      const statusResponse = await conversionPost(
        new Request("http://127.0.0.1/api/conversion-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dry_run: true,
            viewer_status: viewerStatus,
            quote_status: "not_required",
          }),
        })
      );

      assert.equal(statusResponse.status, 200, "Status dry-run should return 200");
      const statusJson = await parseJsonResponse(statusResponse);
      finalViewerStatus = String((statusJson.viewer as JsonObject).status || "queued");

      assert.equal(finalViewerStatus, viewerStatus, "Viewer status progression mismatch");
      assert.equal((statusJson.quote as JsonObject).status, "not_required", "Quote status should remain not_required");
      await sleep(100);
    }

    assert.equal(finalViewerStatus, "success", "Viewer should reach success state");

    console.log("[suite] Step 3/4: Read price-tweaker contract");
    const contractResponse = await priceTweakerGet(
      new Request("http://127.0.0.1/api/digifabster-price-tweak", {
        method: "GET",
      })
    );

    assert.equal(contractResponse.status, 200, "Price tweaker contract should return 200");
    const contractJson = await parseJsonResponse(contractResponse);
    const requiredFields = contractJson.requiredFields as JsonValue[];
    assert.ok(Array.isArray(requiredFields), "Contract requiredFields must be an array");
    assert.ok(requiredFields.includes("part_id"), "Contract must require part_id");
    assert.ok(requiredFields.includes("version"), "Contract must require version");

    console.log("[suite] Step 4/4: Post mocked price-tweaker request and verify normalized payload");
    const tweakResponse = await priceTweakerPost(
      new Request("http://127.0.0.1/api/digifabster-price-tweak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          part_id: "bubble-step-test-part",
          version: "bubble-step-test",
          quoteTarget: "step",
          fileUrl: fixtureUrl,
          fileName: "cutting-blade-1-k110-1.STEP",
          quantity: 25,
          tightestTolerance: "ISO 2768 Fine - requires 2D drawings",
          roughness: "Standard (3.2 µm Ra)",
          finish: "Standard",
          metadata: {
            source: "bubble-flow-suite",
            fixturePath: STEP_FIXTURE_PATH,
          },
        }),
      })
    );

    assert.equal(tweakResponse.status, 200, "Price tweaker forward call should return 200");
    const tweakJson = await parseJsonResponse(tweakResponse);
    assert.equal(tweakJson.success, true, "Price tweaker response should be successful");
    assert.ok(
      String(tweakJson.targetEndpoint).includes("/mock/price-tweaking"),
      "Price tweaker target should point to mock endpoint"
    );

    assert.equal(calls.length, 1, "Exactly one mocked price tweak call should be captured");
    const firstCall = calls[0];
    assert.equal(firstCall.part_id, "bubble-step-test-part");
    assert.equal(firstCall.version, "bubble-step-test");
    assert.equal(firstCall.source, "entag-3d-viewer");
    assert.equal((firstCall.config as JsonObject).tightest_tolerance, "ISO 2768 Fine - requires 2D drawings");
    assert.equal((firstCall.config as JsonObject).roughness, "Standard (3.2 um Ra)");
    assert.equal(firstCall.quote_target, "step");

    console.log("[suite] PASS: Bubble upload simulation, viewer-ready polling, and mocked price-tweaker flow validated.");
  } finally {
    await stopServer(mockServer);
  }
};

run().catch((error) => {
  console.error("[suite] FAIL:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
