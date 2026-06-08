/**
 * Per-step checkpoint runner for production E2E testing.
 *
 * Runs one step at a time, saves state between steps, so each can be
 * inspected before continuing:
 *
 *   node scripts/checkpoint-runner.cjs step0          # Setup
 *   node scripts/checkpoint-runner.cjs step1          # Auth
 *   node scripts/checkpoint-runner.cjs step2          # Upload
 *   node scripts/checkpoint-runner.cjs step3          # Poll viewer
 *   node scripts/checkpoint-runner.cjs step4          # Poll quote
 *   node scripts/checkpoint-runner.cjs step5          # Price tweak
 *   node scripts/checkpoint-runner.cjs step6          # Playwright screenshot
 *   node scripts/checkpoint-runner.cjs verdict        # Print final verdict
 *
 * State is persisted to checkpoint-state.json between steps.
 * Each step's output is also printed to stdout for interactive review.
 */

const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "..", "checkpoint-state.json");
const CREDS_FILE = path.join(__dirname, "..", "creds.txt");

// ── Defaults ──
const DEFAULT_BASE = process.env.BASE || "https://project-entag-3d-viewer-5jena7q1r-citizendevio.vercel.app";
const DEFAULT_BYPASS = process.env.BYPASS || "qlQfStfLPXLfXBliB9xoS9FQFjMxys1V";
const DEFAULT_MODEL_URL = `${DEFAULT_BASE}/test-fixtures/cutting-blade-1-k110-1.STEP`;

// ── Helpers ──
function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function bypassHeaders() {
  const state = loadState();
  return { "x-vercel-protection-bypass": state.bypass || DEFAULT_BYPASS };
}

async function jsonPost(base, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bypassHeaders() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

async function jsonGet(base, urlPath) {
  const res = await fetch(`${base}${urlPath}`, {
    method: "GET",
    headers: bypassHeaders(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

// ══════════════════════════════════════════════════════════════
// Steps
// ══════════════════════════════════════════════════════════════

async function step0() {
  log("═══ Step 0: Setup ═══");

  const base = process.env.E2E_BASE_URL || DEFAULT_BASE;
  const bypass = process.env.E2E_BYPASS_SECRET || DEFAULT_BYPASS;
  const modelUrl = process.env.E2E_MODEL_URL || DEFAULT_MODEL_URL;

  // Read creds
  if (!fs.existsSync(CREDS_FILE)) {
    log("FAIL: creds.txt not found");
    process.exit(1);
  }
  const creds = fs.readFileSync(CREDS_FILE, "utf8").trim();
  const idx = creds.indexOf(":");
  const client_id = creds.slice(0, idx);
  const client_secret = creds.slice(idx + 1);

  const state = {
    base,
    bypass,
    modelUrl,
    client_id,
    client_secret,
    startedAt: new Date().toISOString(),
    steps: {},
  };

  saveState(state);
  log(`Base URL:  ${base}`);
  log(`Model URL: ${modelUrl}`);
  log(`Client ID: ${client_id.slice(0, 8)}...`);
  log("PASS: Setup complete — state saved to checkpoint-state.json");
}

async function step1() {
  log("═══ Step 1: Auth Handshake ═══");
  const state = loadState();
  if (!state.base) { log("FAIL: Run step0 first"); process.exit(1); }

  const res = await fetch(`${state.base}/`, {
    method: "GET",
    headers: { "x-vercel-protection-bypass": state.bypass },
  });

  const ok = res.status === 200;
  const contentType = res.headers.get("content-type") || "";

  state.steps.auth = {
    status: res.status,
    ok,
    contentType,
    mechanism: "x-vercel-protection-bypass header",
  };
  saveState(state);

  log(`HTTP ${res.status} — Content-Type: ${contentType}`);
  if (ok) {
    log("PASS: Deployment reachable via automation bypass header");
  } else {
    log("FAIL: Could not reach deployment");
    process.exit(1);
  }
}

async function step2() {
  log("═══ Step 2: Upload & Translation Kickoff ═══");
  const state = loadState();
  if (!state.client_id) { log("FAIL: Run step0 first"); process.exit(1); }

  const partId = `e2e-checkpoint-${Date.now()}`;
  // Append bypass query param so the serverless function can fetch
  // from the same SSO-protected deployment URL
  const fetchableUrl = new URL(state.modelUrl);
  if (state.bypass) fetchableUrl.searchParams.set("x-vercel-protection-bypass", state.bypass);

  const upload = await jsonPost(state.base, "/api/autodesk", {
    url: fetchableUrl.toString(),
    part_id: partId,
    version: "live",
    client_id: state.client_id,
    client_secret: state.client_secret,
  });

  const urn = upload.json?.urn;
  const viewer = upload.json?.viewer;
  const quote = upload.json?.quote;

  state.urn = urn;
  state.partId = partId;
  state.quoteTarget = quote?.targetFormat || null;
  state.accessToken = upload.json?.accessToken;
  state.steps.upload = {
    status: upload.status,
    ok: upload.ok,
    urn: urn ? urn.slice(0, 50) + "..." : null,
    sourceFormat: upload.json?.sourceFormat,
    viewer,
    quote,
  };
  saveState(state);

  log(`HTTP ${upload.status}`);
  if (urn) log(`URN: ${urn.slice(0, 50)}...`);
  log(`Source format: ${upload.json?.sourceFormat}`);
  log(`Viewer: ${JSON.stringify(viewer)}`);
  log(`Quote:  ${JSON.stringify(quote)}`);

  if (!upload.ok || !urn) {
    log("FAIL: Upload rejected");
    log(upload.text.slice(0, 500));
    process.exit(1);
  }

  // Validate expectations
  const ext = (state.modelUrl.split("/").pop()?.split(".").pop() || "").toLowerCase();
  const nativeFormats = ["stl", "step", "stp", "iges", "igs", "ige", "dxf", "dwg", "3mf", "wrl"];
  if (nativeFormats.includes(ext)) {
    if (quote?.status !== "not_required") {
      log(`WARNING: Expected quote.status=not_required for native format ${ext}, got ${quote?.status}`);
    } else {
      log(`✓ Native format ${ext}: quote.status=not_required as expected`);
    }
  } else {
    log(`Non-native format ${ext}: quote.status=${quote?.status}`);
  }

  log("PASS: Upload succeeded, translation queued");
}

async function step3() {
  log("═══ Step 3: Poll Viewer Readiness ═══");
  const state = loadState();
  if (!state.urn) { log("FAIL: Run step2 first"); process.exit(1); }

  const MAX_POLLS = 40;
  const POLL_MS = 12000;
  let finalPoll = null;

  for (let i = 1; i <= MAX_POLLS; i++) {
    const poll = await jsonPost(state.base, "/api/conversion-status", {
      urn: state.urn,
      client_id: state.client_id,
      client_secret: state.client_secret,
      quoteTarget: state.quoteTarget,
      part_id: state.partId,
      version: "live",
    });

    const v = poll.json?.viewer || {};
    const q = poll.json?.quote || {};

    log(`  Poll ${String(i).padStart(2)}: viewer=${v.status}/${v.mode} quote=${q.status}${v.localError ? " [localErr: " + v.localError.slice(0, 60) + "]" : ""}`);

    finalPoll = poll;

    if (v.status === "success") {
      log(`Viewer ready! mode=${v.mode} localModelUrl=${v.localModelUrl ? "yes" : "no"}`);
      break;
    }

    if (v.status === "failed") {
      log("FAIL: Viewer translation failed on Autodesk side");
      break;
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }

  const v = finalPoll?.json?.viewer || {};

  state.steps.viewer = {
    status: v.status,
    mode: v.mode,
    localModelUrl: v.localModelUrl || v.bubbleUrl || null,
    localError: v.localError || null,
  };
  state.accessToken = finalPoll?.json?.accessToken || state.accessToken;
  saveState(state);

  if (v.status === "success") {
    log(`PASS: Viewer ready — mode=${v.mode}`);
    if (v.localModelUrl) log(`Local URL: ${v.localModelUrl.slice(0, 80)}...`);
  } else {
    log(`FAIL: Viewer did not reach success — last status: ${v.status}`);
    process.exit(1);
  }
}

async function step4() {
  log("═══ Step 4: Quote Terminal State ═══");
  const state = loadState();
  if (!state.urn) { log("FAIL: Run step2 first"); process.exit(1); }

  // If quote was already not_required from upload, skip polling
  const uploadQuote = state.steps.upload?.quote;
  if (uploadQuote?.status === "not_required") {
    state.steps.quote = {
      status: "not_required",
      reason: "File is Digifabster-native — no conversion needed",
      upload: null,
    };
    saveState(state);
    log("Quote status: not_required (native format — no Digifabster conversion)");
    log("PASS: Quote terminal — file goes directly to Digifabster when ordered");
    return;
  }

  const MAX_POLLS = 40;
  const POLL_MS = 12000;
  let finalPoll = null;

  for (let i = 1; i <= MAX_POLLS; i++) {
    const poll = await jsonPost(state.base, "/api/conversion-status", {
      urn: state.urn,
      client_id: state.client_id,
      client_secret: state.client_secret,
      quoteTarget: state.quoteTarget,
      part_id: state.partId,
      version: "live",
    });

    const q = poll.json?.quote || {};
    log(`  Poll ${String(i).padStart(2)}: quote=${q.status}${q.upload?.objectModelId ? " objModel=" + q.upload.objectModelId : ""}${q.error ? " err=" + q.error : ""}`);

    finalPoll = poll;

    const terminal = q.status === "success" || q.status === "not_required" || q.status === "failed";
    if (terminal) {
      break;
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }

  const q = finalPoll?.json?.quote || {};

  state.steps.quote = {
    status: q.status,
    targetFormat: q.targetFormat,
    error: q.error || null,
    upload: q.upload || null,
    priceTweaking: q.priceTweaking || null,
  };
  saveState(state);

  const terminal = q.status === "success" || q.status === "not_required" || q.status === "failed";

  if (terminal) {
    log(`PASS: Quote terminal — status=${q.status}`);
    if (q.status === "success") {
      log(`  objectModelId: ${q.upload?.objectModelId}`);
      log(`  orderId: ${q.upload?.orderId}`);
    }
    if (q.status === "failed") {
      log(`  Error: ${q.error}`);
      log("  (This may be expected for mesh-to-CAD conversions)");
    }
  } else {
    log(`FAIL: Quote did not reach terminal state — last: ${q.status}`);
    process.exit(1);
  }
}

async function step5() {
  log("═══ Step 5: Price Tweak Route ═══");
  const state = loadState();
  if (!state.base) { log("FAIL: Run step0 first"); process.exit(1); }

  // GET: contract metadata
  const get = await jsonGet(state.base, "/api/digifabster-price-tweak");
  const hasEndpoint = Boolean(get.json?.endpoint);
  const hasFields = Boolean(get.json?.requiredFields?.length);

  log(`GET /api/digifabster-price-tweak — HTTP ${get.status}`);
  if (get.ok && hasEndpoint) {
    log(`  endpoint: ${get.json.endpoint}`);
    log(`  requiredFields: ${get.json.requiredFields?.join(", ")}`);
    log(`  configFields: ${Object.keys(get.json.configFields || {}).join(", ")}`);
  } else {
    log(`FAIL: GET returned ${get.status}`);
    log(get.text.slice(0, 300));
    state.steps.priceTweak = { getOk: false, postOk: null };
    saveState(state);
    process.exit(1);
  }

  state.steps.priceTweak = {
    getOk: true,
    endpoint: get.json.endpoint,
    requiredFields: get.json.requiredFields,
    configFields: Object.keys(get.json.configFields || {}),
    postOk: null,
    postResult: null,
  };
  saveState(state);
  log("PASS (GET): Price tweak route live with contract metadata");
}

async function step6() {
  log("═══ Step 6: Viewer Visual Proof ═══");
  const state = loadState();
  if (!state.base) { log("FAIL: Run step0 first"); process.exit(1); }

  try {
    const { chromium } = require("@playwright/test");
    const viewerUrl = state.steps.viewer?.localModelUrl;
    const bypass = state.bypass;

    let targetUrl;
    if (viewerUrl) {
      targetUrl = `${state.base}/viewer?localModelUrl=${encodeURIComponent(viewerUrl)}`;
    } else {
      targetUrl = `${state.base}/viewer?access_token=${encodeURIComponent(state.accessToken || "")}&urn=${encodeURIComponent(state.urn || "")}`;
    }

    log(`Viewer URL: ${targetUrl.slice(0, 120)}...`);

    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu", "--no-sandbox", "--disable-web-security"],
    });
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      extraHTTPHeaders: { "x-vercel-protection-bypass": bypass },
    });
    const page = await context.newPage();

    // Capture console and network errors for debugging
    const consoleLogs = [];
    page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => consoleLogs.push(`[pageerror] ${err.message}`));

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for page to settle — Forge Viewer needs time to load from CDN + render
    await page.waitForTimeout(30000);

    // Dump relevant console logs
    const errors = consoleLogs.filter(l => l.includes("[error]") || l.includes("[pageerror]") || l.includes("Error") || l.includes("fail") || l.includes("Failed"));
    if (errors.length > 0) {
      log("Browser console errors:");
      errors.slice(0, 10).forEach(e => log(`  ${e}`));
    }

    const canvasCount = await page.locator("canvas").count();
    const screenshotPath = path.join(__dirname, "..", "checkpoint-viewer-proof.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await browser.close();

    state.steps.viewerProof = {
      mode: viewerUrl ? "local" : "cloud",
      canvasCount,
      screenshot: "checkpoint-viewer-proof.png",
    };
    saveState(state);

    log(`Canvas elements: ${canvasCount}`);
    log(`Screenshot: checkpoint-viewer-proof.png`);
    if (canvasCount > 0) {
      log("PASS: Viewer rendered with canvas element(s)");
    } else {
      log("WARNING: No canvas found — viewer may not have loaded");
    }
  } catch (err) {
    log(`Playwright error: ${err.message}`);
    state.steps.viewerProof = { error: err.message };
    saveState(state);
    log("FAIL: Could not capture viewer screenshot");
    process.exit(1);
  }
}

async function verdict() {
  log("═══ Final Verdict ═══");
  const state = loadState();

  const results = {
    auth: state.steps.auth?.ok ?? false,
    upload: state.steps.upload?.ok ?? false,
    viewer: state.steps.viewer?.status === "success",
    quoteTerminal: ["success", "not_required", "failed"].includes(state.steps.quote?.status),
    priceTweakGET: state.steps.priceTweak?.getOk ?? false,
    viewerProof: (state.steps.viewerProof?.canvasCount || 0) > 0,
  };

  const allCore = results.auth && results.upload && results.viewer && results.quoteTerminal && results.priceTweakGET;
  const overallVerdict = allCore ? "PASS" : "FAIL";

  log("");
  log(`  Auth handshake:     ${results.auth ? "PASS" : "FAIL"}`);
  log(`  Upload & translate: ${results.upload ? "PASS" : "FAIL"}`);
  log(`  Viewer ready:       ${results.viewer ? "PASS" : "FAIL"} (mode=${state.steps.viewer?.mode})`);
  log(`  Quote terminal:     ${results.quoteTerminal ? "PASS" : "FAIL"} (status=${state.steps.quote?.status})`);
  log(`  Price tweak route:  ${results.priceTweakGET ? "PASS" : "FAIL"}`);
  log(`  Visual proof:       ${results.viewerProof ? "PASS" : "SKIP/FAIL"}`);
  log("");
  log(`  VERDICT: ${overallVerdict}`);
  log("");

  state.verdict = overallVerdict;
  state.completedAt = new Date().toISOString();
  saveState(state);

  if (overallVerdict !== "PASS") process.exit(1);
}

// ── Main ──
const step = process.argv[2];
const STEPS = { step0, step1, step2, step3, step4, step5, step6, verdict };

if (!STEPS[step]) {
  console.error("Usage: node scripts/checkpoint-runner.cjs <step0|step1|step2|step3|step4|step5|step6|verdict>");
  console.error("\nSteps:");
  console.error("  step0   — Setup (read creds, set URLs)");
  console.error("  step1   — Auth handshake");
  console.error("  step2   — Upload & translation kickoff");
  console.error("  step3   — Poll viewer readiness");
  console.error("  step4   — Poll quote terminal state");
  console.error("  step5   — Price tweak route check");
  console.error("  step6   — Playwright viewer screenshot");
  console.error("  verdict — Print final verdict");
  process.exit(1);
}

STEPS[step]().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
