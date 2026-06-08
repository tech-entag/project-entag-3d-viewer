import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const routeModule = require("../api/digifabster-price-tweak.cts") as {
  POST: (req: Request) => Promise<Response>;
};
const { POST } = routeModule;

const LIVE_MATERIALS_ALL = [
  "St52 Cost",
  "42CrMo4 / 1.7225",
  "Bohler K110 / 1.2379 / SVERKER",
  "Bohler M201 / 1.2311 / P20",
  "Bohler M238 / 1.2738 / 718",
  "Bohler M303 / 1.2316mod",
  "Bohler M300 / 1.2316",
  "Bohler M310 / STAVAX / S136 / 1.2083",
  "Bohler M314 / 1.2085 / RAMAX",
  "Bohler M333 / SUPREME",
  "Bohler W300 / 1.2343 / ORVAR / AISI H11",
  "Bohler W302 / 1.2344 / AISI H13",
  "SS304",
  "SS316",
  "St52",
  "Aluminium 1050",
  "Aluminium 5083",
  "Aluminium 5074",
  "Aluminium 6061",
  "Aluminium 6082",
  "Aluminium 7075",
  "SS201",
  "SS304L",
  "SS316L",
  "St37 / S235JR / 1.0570",
  "Hardened Tool Steel",
  "St52 Cost copy",
  "42CrMo4 / 1.7225 copy",
  "Bohler K110 / 1.2379 / SVERKER copy",
  "Bohler M201 / 1.2311 / P20 copy",
  "Bohler M238 / 1.2738 / 718 copy",
  "Bohler M303 / 1.2316mod copy",
  "Bohler M300 / 1.2316 copy",
  "Bohler M310 / STAVAX / S136 / 1.2083 copy",
  "Bohler M314 / 1.2085 / RAMAX copy",
  "Bohler M333 / SUPREME copy",
  "Bohler W300 / 1.2343 / ORVAR / AISI H11 copy",
  "Bohler W302 / 1.2344 / AISI H13 copy",
];

const LIVE_MATERIALS_ACTIVE = LIVE_MATERIALS_ALL.filter(
  (title) => title !== "St52" && title !== "Hardened Tool Steel",
);

const normalizeText = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u00B5\u03BC]/g, "u")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

const normalizeMaterialTitleForMatch = (value: string) =>
  normalizeText(value)
    .replace(/\bcopy\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

const parseMappedMaterialValues = (): string[] => {
  const routePath = new URL("../api/digifabster-price-tweak.cts", import.meta.url);
  const source = readFileSync(routePath, "utf8");
  const blockMatch = source.match(/materials\s*:\s*\{([\s\S]*?)\}\s*as\s*Record<string,\s*string>/m);
  if (!blockMatch) {
    throw new Error("Could not locate materials mapping block");
  }

  const block = blockMatch[1];
  const pairRegex = /"([^"]+)"\s*:\s*"([^"]+)"/g;
  const mappedValues = new Set<string>();

  let match: RegExpExecArray | null = null;
  while ((match = pairRegex.exec(block)) !== null) {
    mappedValues.add(match[2]);
  }

  return Array.from(mappedValues).sort((a, b) => a.localeCompare(b));
};

const verifyCoverageAgainstCatalogSnapshot = () => {
  const mappedValues = parseMappedMaterialValues();
  const mappedNormalized = new Set(mappedValues.map(normalizeMaterialTitleForMatch));

  const missingAllNormalized = LIVE_MATERIALS_ALL.filter(
    (title) => !mappedNormalized.has(normalizeMaterialTitleForMatch(title)),
  );

  const missingActiveNormalized = LIVE_MATERIALS_ACTIVE.filter(
    (title) => !mappedNormalized.has(normalizeMaterialTitleForMatch(title)),
  );

  assert.equal(
    missingAllNormalized.length,
    0,
    `Catalog snapshot has unmapped materials after normalization: ${missingAllNormalized.join(", ")}`,
  );

  assert.equal(
    missingActiveNormalized.length,
    0,
    `Active catalog snapshot has unmapped materials: ${missingActiveNormalized.join(", ")}`,
  );

  return {
    mappedUniqueValues: mappedValues.length,
    allCatalogMaterials: LIVE_MATERIALS_ALL.length,
    activeCatalogMaterials: LIVE_MATERIALS_ACTIVE.length,
  };
};

const makeJsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const runTurningCopyResolutionIntegrationCheck = async () => {
  const calls: string[] = [];
  const originalFetch = global.fetch;

  process.env.DIGIFABSTER_API_KEY = process.env.DIGIFABSTER_API_KEY || "test-key";
  delete process.env.DIGIFABSTER_PRICE_TWEAK_ENDPOINT;

  const machineCatalog = [
    {
      id: 44590,
      title: "Turning 2",
      active: true,
      materials: [
        { id: 72403, title: "42CrMo4 / 1.7225 copy", active: true },
        { id: 72402, title: "St52 Cost copy", active: true },
      ],
    },
    {
      id: 44270,
      title: "3-axis milling Cost Pricing",
      active: true,
      materials: [{ id: 72324, title: "42CrMo4 / 1.7225", active: true }],
    },
  ];

  try {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      calls.push(`${method} ${url}`);

      if (url.includes("/v2/obtain_s2s_token/")) {
        return makeJsonResponse({ token: "mock-s2s-token" });
      }

      if (url.includes("/v2/machines_materials/")) {
        return makeJsonResponse(machineCatalog);
      }

      if (url.includes("/v2/machines/turning/44590/")) {
        return makeJsonResponse({
          id: 44590,
          title: "Turning 2",
          tolerances: [{ id: "tol-standard", name: "ISO 2768-Stanard" }],
          priorities: [{ id: "lead-normal", name: "Normal" }],
          materials: machineCatalog[0].materials,
        });
      }

      if (url.includes("/v2/materials/turning/72403/")) {
        return makeJsonResponse({
          id: 72403,
          title: "42CrMo4 / 1.7225 copy",
          postproduction: [{ id: "pp-polish", title: "Polishing" }],
        });
      }

      if (url.includes("/v2/price_tweaker/turning/")) {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");

        assert.equal(body?.material?.title, "42CrMo4 / 1.7225 copy");
        assert.equal(body?.printer?.title, "Turning 2");

        return makeJsonResponse({
          data: {
            prices: { total_per_part_price: 123.45 },
            model_values: {
              dfm_features_list: [{ type: "hole", properties: { topology_type: "hole" } }],
            },
          },
        });
      }

      throw new Error(`Unhandled fetch in test: ${method} ${url}`);
    }) as typeof fetch;

    const req = new Request("http://127.0.0.1/api/digifabster-price-tweak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectModelId: 4287635,
        machineId: 44590,
        materialName: "42CrMo4 / 1.7225",
        count: 1,
      }),
    });

    const response = await POST(req);
    const payload = await response.json() as { status?: string; total_per_part_price?: number; total_holes?: number; error?: string };

    assert.equal(response.status, 200, payload.error || "Expected HTTP 200 from POST");
    assert.equal(payload.status, "success");
    assert.equal(payload.total_per_part_price, 123.45);
    assert.equal(payload.total_holes, 1);
    assert(
      calls.some((entry) => entry.includes("/v2/materials/turning/72403/")),
      "Expected resolved material request to target Turning 2 copy material id",
    );

    return { callsCount: calls.length };
  } finally {
    global.fetch = originalFetch;
  }
};

const main = async () => {
  const coverage = verifyCoverageAgainstCatalogSnapshot();
  const integration = await runTurningCopyResolutionIntegrationCheck();

  console.log("Material mapping verification passed.");
  console.log(JSON.stringify({ coverage, integration }, null, 2));
};

main().catch((error) => {
  console.error("Material mapping verification failed:", error);
  process.exit(1);
});
