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
          { id: 44, title: "Sheet Metal" },
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
        results: [{ id: 99, title: "Turning" }],
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
    assert.deepEqual(results.map((r) => r.id), [12, 44, 99], "results in page order");
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

    console.log("[suite] PASS — catalog fetched, paginated, served (R2 store best-effort)");
  } finally {
    await stopServer(server);
  }
};

run().catch((error) => {
  console.error("\n[suite] FAIL —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
