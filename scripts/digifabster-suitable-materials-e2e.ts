/**
 * Hermetic e2e for /api/digifabster-suitable-materials.
 *
 * Mocks DigiFabster (token + suitable_materials + widget-technologies) and drives
 * the REAL route. Verifies that suitable material ids are enriched with catalog
 * data (title / technology / option lists), that unknown ids are reported under
 * `unmatched`, and that a not-ready model returns 409.
 *
 * Run: pnpm tsx scripts/digifabster-suitable-materials-e2e.ts
 */
import assert from "node:assert/strict";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

const MODEL_ID = 4_392_029;
const MODEL_NOT_READY = 9_999_999;
const MAT_ALU = 72_335;
const MAT_SS = 72_460;
const MAT_UNKNOWN = 88_888; // suitable but absent from the catalog

const readJson = async (req: IncomingMessage): Promise<Json> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? (JSON.parse(raw) as Json) : {};
};

const sendJson = (res: ServerResponse, status: number, payload: Json) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
};

const material = (id: number, title: string): Json => ({
  id,
  title,
  thicknesses: [{ id: `thk-${id}`, thickness: 1.0, display_name: "1.0mm" }],
  tolerance: [{ id: `tol-${id}`, name_for_user: "ISO 2768-Standard", display_name: "-10.0mm...0.0mm" }],
  lead_time: [{ id: `lt-${id}`, days: 10 }],
  extra_fieldsets: [{ id: `ef-${id}`, title: "Finish", options: [{ id: `o-${id}`, option: "Matte/Matte" }] }],
  post_production: [
    { id: `ra1-${id}`, title: "Standard (3.2um RA)", price: 0, price_units: "per_cm_2", group_title: "Surface Roughness" },
    { id: `ra2-${id}`, title: "Smooth (1.6um RA)", price: 0, price_units: "per_cm_2", group_title: "Surface Roughness" },
    { id: `ins-${id}`, title: "CMM", price: 1000, price_units: "per_model", group_title: "Inspection" },
    { id: `fin-${id}`, title: "Powder Coating", price: 100, price_units: "per_cm_2", group_title: "Finishing" },
  ],
});

const startMockServer = async (): Promise<Server> => {
  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";

    if (method === "POST" && url === "/v2/obtain_s2s_token/") {
      sendJson(res, 200, { token: "mock-s2s-token" });
      return;
    }

    if (method === "POST" && url === "/v2/suitable_materials/") {
      const body = await readJson(req);
      const id = Array.isArray(body.models_ids) ? (body.models_ids as number[])[0] : 0;
      if (id === MODEL_NOT_READY) {
        sendJson(res, 200, { [String(id)]: { is_ready: false } });
        return;
      }
      sendJson(res, 200, {
        [String(id)]: { is_ready: true, suitable_materials: [MAT_ALU, MAT_SS, MAT_UNKNOWN] },
      });
      return;
    }

    if (method === "GET" && url === "/v2/users/widget-technologies/") {
      sendJson(res, 200, {
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 13,
            tech_id: 13,
            title: "CNC Sheetmetal",
            materials: [material(MAT_ALU, "Aluminium 1100"), material(MAT_SS, "Stainless Steel, SS304")],
          },
        ],
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
  const server = await startMockServer();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  process.env.DIGIFABSTER_UPLOAD_BASE_URL = base;
  process.env.DIGIFABSTER_TOKEN_EXCHANGE_ENDPOINT = `${base}/v2/obtain_s2s_token/`;
  process.env.DIGIFABSTER_API_KEY = "mock-api-key";
  delete process.env.DIGIFABSTER_UPLOAD_SHARED_SECRET;

  try {
    const route = await import("../api/digifabster-suitable-materials.cts");
    const POST = (route as unknown as { POST: (req: Request) => Promise<Response> }).POST;
    const GET = (route as unknown as { GET: (req: Request) => Promise<Response> }).GET;
    assert.equal(typeof POST, "function", "must export POST");
    assert.equal(typeof GET, "function", "must export GET");

    /* ---- POST: enriched suitable materials ---- */
    console.log("[suite] POST /api/digifabster-suitable-materials");
    const res = await POST(
      new Request(`${base}/api/digifabster-suitable-materials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: MODEL_ID }),
      }),
    );
    const data = (await res.json()) as Json;
    assert.equal(res.status, 200, `should 200 (got ${res.status}: ${JSON.stringify(data)})`);
    assert.equal(data.isReady, true, "model ready");
    assert.equal(data.count, 3, "three suitable materials");

    const materials = data.materials as Array<Json>;
    const alu = materials.find((m) => m.id === MAT_ALU) as Json;
    assert.ok(alu, "aluminium present");
    assert.equal(alu.title, "Aluminium 1100", "title enriched from catalog");
    assert.equal(alu.technologyTitle, "CNC Sheetmetal", "technology context enriched");
    assert.equal((alu.thicknesses as unknown[]).length, 1, "thickness options enriched");
    assert.equal((alu.tolerance as unknown[]).length, 1, "tolerance options enriched");
    assert.equal((alu.extraFieldsets as unknown[]).length, 1, "extra_fieldsets (Finish) enriched");

    // post_production grouped by group_title -> UI sections.
    const groups = alu.postProductionGroups as Array<Json>;
    const groupNames = groups.map((g) => g.group).sort();
    assert.deepEqual(groupNames, ["Finishing", "Inspection", "Surface Roughness"], "grouped by group_title");
    const ra = groups.find((g) => g.group === "Surface Roughness") as Json;
    assert.equal((ra.options as unknown[]).length, 2, "Surface Roughness (Ra) has 2 options");
    const inspection = groups.find((g) => g.group === "Inspection") as Json;
    const cmm = (inspection.options as Array<Json>)[0];
    assert.equal(cmm.title, "CMM", "inspection option title");
    assert.equal(cmm.price, 1000, "inspection option price surfaced");
    assert.equal(cmm.priceUnits, "per_model", "inspection option price units surfaced");

    const ss = materials.find((m) => m.id === MAT_SS) as Json;
    assert.equal(ss.title, "Stainless Steel, SS304", "second material enriched");

    // Unknown material id: present in suitable list but not the catalog.
    const unknown = materials.find((m) => m.id === MAT_UNKNOWN) as Json;
    assert.equal(unknown.title, null, "unmatched material has null title (consistent shape)");
    assert.deepEqual(data.unmatched, [MAT_UNKNOWN], "unmatched ids reported");

    /* ---- GET works too ---- */
    const resGet = await GET(
      new Request(`${base}/api/digifabster-suitable-materials?modelId=${MODEL_ID}`, { method: "GET" }),
    );
    assert.equal(resGet.status, 200, "GET should 200");

    /* ---- Not-ready model -> 409 ---- */
    console.log("[suite] not-ready model -> 409");
    const res2 = await POST(
      new Request(`${base}/api/digifabster-suitable-materials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: MODEL_NOT_READY }),
      }),
    );
    const data2 = (await res2.json()) as Json;
    assert.equal(res2.status, 409, "not-ready -> 409");
    assert.equal(data2.retryable, true, "marked retryable");

    console.log("[suite] PASS — suitable materials fetched + catalog-enriched");
  } finally {
    await stopServer(server);
  }
};

run().catch((error) => {
  console.error("\n[suite] FAIL —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
