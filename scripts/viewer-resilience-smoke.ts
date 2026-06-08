import assert from "node:assert/strict";

type JsonRecord = Record<string, unknown>;

type RouteModule = {
  POST?: (req: Request) => Promise<Response>;
  default?: JsonRecord;
};

const parseJson = async (response: Response): Promise<JsonRecord> => {
  const text = await response.text();
  assert.ok(text.trim().length > 0, "Expected JSON response body.");
  return JSON.parse(text) as JsonRecord;
};

const loadPostHandler = async (modulePath: string): Promise<(req: Request) => Promise<Response>> => {
  const module = await import(modulePath);
  const exportsObj = ((module as unknown as RouteModule).default
    || (module as unknown as JsonRecord)) as JsonRecord;
  const post = exportsObj.POST as ((req: Request) => Promise<Response>) | undefined;

  assert.equal(typeof post, "function", `POST handler is missing in ${modulePath}`);
  return post;
};

const runAutodeskDryRunChecks = async (post: (req: Request) => Promise<Response>) => {
  const stepRes = await post(
    new Request("http://127.0.0.1/api/autodesk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry_run: true,
        url: "https://example.com/model.fbx",
        part_id: "viewer-smoke-step",
        version: "test",
      }),
    })
  );

  assert.equal(stepRes.status, 200, "Autodesk dry-run STEP check should return 200.");
  const stepJson = await parseJson(stepRes);
  const stepQuote = (stepJson.quote as JsonRecord) || {};
  assert.equal(stepQuote.targetFormat, "step", "FBX should queue STEP quote conversion.");
  assert.equal(stepQuote.status, "queued", "FBX should report queued quote conversion.");

  const dwgRes = await post(
    new Request("http://127.0.0.1/api/autodesk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry_run: true,
        url: "https://example.com/model.rvt",
        part_id: "viewer-smoke-dwg",
        version: "test",
      }),
    })
  );

  assert.equal(dwgRes.status, 200, "Autodesk dry-run DWG check should return 200.");
  const dwgJson = await parseJson(dwgRes);
  const dwgQuote = (dwgJson.quote as JsonRecord) || {};
  assert.equal(dwgQuote.targetFormat, "dwg", "RVT should queue DWG quote conversion.");
  assert.equal(dwgQuote.status, "queued", "RVT should report queued quote conversion.");
};

const runConversionDryRunChecks = async (post: (req: Request) => Promise<Response>) => {
  const res = await post(
    new Request("http://127.0.0.1/api/conversion-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry_run: true,
        quoteTarget: "step",
        viewer_status: "success",
        quote_status: "failed",
        quote_error: "STEP derivative generation failed.",
      }),
    })
  );

  assert.equal(res.status, 200, "Conversion-status dry-run should return 200.");
  const json = await parseJson(res);

  assert.equal(json.success, true, "Conversion-status should set success=true.");

  const viewer = (json.viewer as JsonRecord) || {};
  const quote = (json.quote as JsonRecord) || {};

  assert.equal(viewer.status, "success", "Viewer status should remain success.");
  assert.equal(viewer.priority, true, "Viewer should remain prioritized even when quote fails.");
  assert.equal(quote.status, "failed", "Quote should report failed status.");
  assert.match(String(quote.error || ""), /failed/i, "Quote error should mention failure.");
};

const main = async () => {
  const autodeskPost = await loadPostHandler("../api/autodesk.cts");
  const conversionPost = await loadPostHandler("../api/conversion-status.cts");

  await runAutodeskDryRunChecks(autodeskPost);
  await runConversionDryRunChecks(conversionPost);

  console.log("[viewer-resilience-smoke] PASS: Autodesk + conversion dry-run contracts verified.");
};

main().catch((error) => {
  console.error("[viewer-resilience-smoke] FAIL", error instanceof Error ? error.stack : error);
  process.exit(1);
});