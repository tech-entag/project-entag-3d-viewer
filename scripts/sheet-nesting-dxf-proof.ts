import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import DxfParser from "dxf-parser";

type JsonRecord = Record<string, unknown>;

const FIXTURE_PATH =
  process.env.NESTING_DXF_FIXTURE_PATH
  || path.resolve(process.cwd(), "public/test-fixtures/nesting-sample-plate.dxf");
const OUTPUT_JSON = path.resolve(process.cwd(), "live-local-nesting-proof-result.json");

const run = async () => {
  assert.ok(fs.existsSync(FIXTURE_PATH), `Missing DXF fixture at ${FIXTURE_PATH}`);

  const fixtureContent = fs.readFileSync(FIXTURE_PATH, "utf8");
  const nestingModule = await import("../api/sheet-nesting.cts");
  const routeExports = (nestingModule as unknown as { default?: JsonRecord }).default
    || (nestingModule as unknown as JsonRecord);
  const postHandler = routeExports.POST as unknown as (req: Request) => Promise<Response>;

  assert.equal(typeof postHandler, "function", "POST handler is not available in api/sheet-nesting.cts");

  const response = await postHandler(
    new Request("http://127.0.0.1/api/sheet-nesting", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dry_run: true,
        include_dxf_content: true,
        sync_digifabster: false,
        source_file_name: path.basename(FIXTURE_PATH),
        dxf_content: fixtureContent,
        quantity: 12,
        spacing: 5,
        sheet_width: 320,
        sheet_height: 220,
        allow_rotation: true,
        part_id: "sheet-nesting-proof-part",
        version: "sheet-nesting-proof-v1",
      }),
    }),
  );

  const bodyText = await response.text();
  const body = JSON.parse(bodyText) as JsonRecord;

  assert.equal(response.status, 200, `Expected 200 but received ${response.status}: ${bodyText}`);
  assert.equal(body.success, true, "Expected success=true from sheet-nesting route.");

  const nesting = (body.nesting as JsonRecord) || {};
  assert.equal(nesting.partsPlaced, 12, "Expected exactly 12 placements.");

  const output = (body.output as JsonRecord) || {};
  const nestedDxf = output.dxf;
  assert.equal(typeof nestedDxf, "string", "Expected nested DXF text in output.dxf.");

  const parser = new DxfParser();
  const parsed = parser.parseSync(nestedDxf as string) as { entities?: unknown[] } | null;
  const nestedEntityCount = Array.isArray(parsed?.entities) ? parsed!.entities!.length : 0;
  assert.ok(nestedEntityCount > 0, "Nested DXF should contain at least one entity.");

  const result = {
    status: "pass",
    fixturePath: FIXTURE_PATH,
    responseStatus: response.status,
    traceId: body.traceId,
    partsPlaced: nesting.partsPlaced,
    perSheetCapacity: nesting.perSheetCapacity,
    sheetCount: nesting.sheetCount,
    rotationDeg: nesting.rotationDeg,
    nestedEntityCount,
    outputBytes: output.bytes,
    warnings: body.warnings,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(result, null, 2));
  console.log("[sheet-nesting-proof] PASS", JSON.stringify(result));
};

run().catch((error) => {
  console.error("[sheet-nesting-proof] FAIL", error instanceof Error ? error.stack : error);
  process.exit(1);
});
