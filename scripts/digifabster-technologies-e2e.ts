/**
 * Hermetic e2e for /api/digifabster-technologies.
 *
 * Mocks DigiFabster (token exchange + a 2-page widget-technologies catalog) and
 * drives the REAL route. R2 isn't available in node, so writeJsonBlob no-ops and
 * every read is a live fetch (source: "live"). Verifies pagination aggregation
 * and the GET ?refresh / POST paths.
 *
 * Run: pnpm tsx scripts/digifabster-technologies-e2e.ts
 */
import assert from "node:assert/strict";
import { createServer, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

interface Captured {
  tokenExchangeCalls: number;
  techCalls: number;
}

const sendJson = (res: ServerResponse, status: number, payload: Json | null) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(payload === null ? "" : JSON.stringify(payload));
};

const startMockServer = async (captured: Captured, baseRef: { base: string }): Promise<Server> => {
  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";

    if (method === "POST" && url === "/v2/obtain_s2s_token/") {
      captured.tokenExchangeCalls += 1;
      sendJson(res, 200, { token: "mock-s2s-token" });
      return;
    }

    // Page 1 -> points to page 2 via `next`; page 2 -> next null.
    if (method === "GET" && url === "/v2/users/widget-technologies/") {
      captured.techCalls += 1;
      sendJson(res, 200, {
        count: 3,
        next: `${baseRef.base}/v2/users/widget-technologies/?page=2`,
        previous: null,
        results: [
          { id: 12, title: "3-Axis Milling" },
          { id: 13, title: "CNC Sheetmetal" },
        ],
      });
      return;
    }
    if (method === "GET" && url === "/v2/users/widget-technologies/?page=2") {
      captured.techCalls += 1;
      sendJson(res, 200, {
        count: 3,
        next: null,
        previous: `${baseRef.base}/v2/users/widget-technologies/`,
        results: [{ id: 11, title: "Turning" }],
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
  const captured: Captured = { tokenExchangeCalls: 0, techCalls: 0 };
  const baseRef = { base: "" };
  const server = await startMockServer(captured, baseRef);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseRef.base = base;

  process.env.DIGIFABSTER_UPLOAD_BASE_URL = base;
  process.env.DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT = `${base}/v2/obtain_s2s_token/`;
  process.env.DIGIFABSTER_API_KEY = "mock-api-key";
  delete process.env.DIGIFABSTER_UPLOAD_SHARED_SECRET;

  try {
    const route = await import("../api/digifabster-technologies.cts");
    const GET = (route as unknown as { GET: (req: Request) => Promise<Response> }).GET;
    const POST = (route as unknown as { POST: (req: Request) => Promise<Response> }).POST;
    assert.equal(typeof GET, "function", "must export GET");
    assert.equal(typeof POST, "function", "must export POST");

    /* ---- GET: fetches live (no R2 cache) + aggregates pages ---- */
    console.log("[suite] GET /api/digifabster-technologies");
    const res = await GET(new Request(`${base}/api/digifabster-technologies`, { method: "GET" }));
    const data = (await res.json()) as Json;
    assert.equal(res.status, 200, `GET should 200 (got ${res.status}: ${JSON.stringify(data)})`);
    assert.equal(data.source, "live", "no cache -> live fetch");
    assert.equal(data.count, 3, "count from DigiFabster");
    const results = data.results as Array<Json>;
    assert.equal(results.length, 3, "both pages aggregated (2 + 1)");
    assert.deepEqual(results.map((r) => r.id), [12, 13, 11], "results in page order");
    assert.ok(typeof data.fetchedAt === "string" && data.fetchedAt, "fetchedAt timestamp present");
    assert.equal(captured.techCalls, 2, "followed `next` to fetch 2 pages");

    /* ---- POST: force refresh ---- */
    console.log("[suite] POST /api/digifabster-technologies (force refresh)");
    const techBefore = captured.techCalls;
    const res2 = await POST(new Request(`${base}/api/digifabster-technologies`, { method: "POST" }));
    const data2 = (await res2.json()) as Json;
    assert.equal(res2.status, 200, "POST should 200");
    assert.equal(data2.source, "live", "POST always live");
    assert.equal(data2.stored, "config/widget-technologies.json", "reports the R2 key it stores under");
    assert.equal((data2.results as Array<Json>).length, 3, "POST aggregates pages too");
    assert.equal(captured.techCalls, techBefore + 2, "POST re-fetched both pages");

    /* ---- GET ?tech= : single technology (lighter payload) ---- */
    console.log("[suite] GET ?tech=milling (single technology)");
    const res3 = await GET(new Request(`${base}/api/digifabster-technologies?tech=milling`, { method: "GET" }));
    const data3 = (await res3.json()) as Json;
    assert.equal(res3.status, 200, "tech filter should 200");
    assert.equal(data3.count, 1, "single technology -> count 1");
    assert.equal((data3.technology as Json)?.id, 12, "matched 3-Axis Milling by title substring");
    assert.equal(data3.results, undefined, "no full results array on a single-tech response");

    // Match by numeric id too.
    const res4 = await GET(new Request(`${base}/api/digifabster-technologies?tech=11`, { method: "GET" }));
    const data4 = (await res4.json()) as Json;
    assert.equal((data4.technology as Json)?.id, 11, "matched Turning by id");

    /* ---- GET ?tech= : no match -> 404 with available list ---- */
    const res5 = await GET(new Request(`${base}/api/digifabster-technologies?tech=nope`, { method: "GET" }));
    const data5 = (await res5.json()) as Json;
    assert.equal(res5.status, 404, "unknown tech -> 404");
    assert.equal((data5.available as Array<Json>).length, 3, "404 lists available technologies");

    /* ---- GET ?category= : Bubble groupings ---- */
    console.log("[suite] GET ?category=cnc-machining (milling + turning)");
    const resCnc = await GET(new Request(`${base}/api/digifabster-technologies?category=cnc-machining`, { method: "GET" }));
    const dataCnc = (await resCnc.json()) as Json;
    assert.equal(resCnc.status, 200, "category should 200");
    assert.equal(dataCnc.category, "cnc-machining", "echoes resolved category key");
    assert.equal(dataCnc.count, 2, "CNC Machining groups milling + turning");
    const cncIds = (dataCnc.technologies as Array<Json>).map((t) => t.id).sort();
    assert.deepEqual(cncIds, [11, 12], "CNC Machining = Turning(11) + Milling(12)");

    const resSm = await GET(new Request(`${base}/api/digifabster-technologies?category=sheet-metal`, { method: "GET" }));
    const dataSm = (await resSm.json()) as Json;
    assert.equal(dataSm.count, 1, "Sheet Metal = 1 technology");
    assert.equal((dataSm.technologies as Array<Json>)[0].id, 13, "Sheet Metal -> CNC Sheetmetal(13)");

    const resTube = await GET(new Request(`${base}/api/digifabster-technologies?category=tube`, { method: "GET" }));
    const dataTube = (await resTube.json()) as Json;
    assert.equal(resTube.status, 200, "tube category 200 even when empty");
    assert.equal(dataTube.count, 0, "Tube has no mapped technology yet");
    assert.ok(typeof dataTube.note === "string", "empty category carries a note");

    const resBad = await GET(new Request(`${base}/api/digifabster-technologies?category=nope`, { method: "GET" }));
    assert.equal(resBad.status, 404, "unknown category -> 404");

    console.log("[suite] PASS — catalog + single-tech filter + Bubble category grouping");
  } finally {
    await stopServer(server);
  }
};

run().catch((error) => {
  console.error("\n[suite] FAIL —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
