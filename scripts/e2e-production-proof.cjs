/**
 * E2E Production Proof — tests the full conversion pipeline:
 *   1. Upload model → /api/autodesk
 *   2. Poll /api/conversion-status until viewer=success + quote=success
 *   3. Verify viewer mode (local or cloud) and quote upload IDs
 *   4. Call /api/digifabster-price-tweak with GET to verify route exists
 *   5. Capture Playwright screenshot of the viewer
 *
 * Usage:
 *   node scripts/e2e-production-proof.cjs <base-url> <share-token> [model-url] [max-polls] [poll-ms]
 *
 * Defaults to strict quote validation: PASS requires a fresh DigiFabster submission
 * (quote.upload.status=submitted and quote.upload.source=digifabster).
 * Set REQUIRE_FRESH_UPLOAD=0 to run viewer-only compatibility checks.
 *
 * Writes output to: e2e-production-proof-result.json
 */

const fs = require("fs");
const path = require("path");

const BASE = process.argv[2];
const SHARE = process.argv[3];
const MODEL_URL = process.argv[4] || "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/fbx/Samba%20Dancing.fbx";
const MAX_POLLS = Number(process.argv[5] || 60);
const POLL_MS = Number(process.argv[6] || 15000);
const REQUIRE_FRESH_UPLOAD = process.env.REQUIRE_FRESH_UPLOAD !== "0";

if (!BASE || !SHARE) {
  console.error("Usage: node scripts/e2e-production-proof.cjs <base-url> <share-token> [model-url] [max-polls] [poll-ms]");
  process.exit(1);
}

const RESULT_FILE = path.join(__dirname, "..", "e2e-production-proof-result.json");

function shareUrl(urlPath) {
  const sep = urlPath.includes("?") ? "&" : "?";
  return `${BASE}${urlPath}${sep}_vercel_share=${SHARE}`;
}

let AUTH_COOKIE = "";

async function jsonPost(urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(AUTH_COOKIE ? { cookie: AUTH_COOKIE } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

async function jsonGet(urlPath) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: "GET",
    headers: AUTH_COOKIE ? { cookie: AUTH_COOKIE } : {},
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

function save(output) {
  fs.writeFileSync(RESULT_FILE, JSON.stringify(output, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function inferFileNameFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const tail = parsed.pathname.split("/").filter(Boolean).pop();
    if (!tail) {
      return null;
    }

    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  } catch {
    return null;
  }
}

(async () => {
  const creds = fs.readFileSync(path.join(__dirname, "..", "creds.txt"), "utf8").trim();
  const idx = creds.indexOf(":");
  const client_id = creds.slice(0, idx);
  const client_secret = creds.slice(idx + 1);

  // Acquire auth cookie by visiting share URL
  log("Acquiring auth cookie via share URL...");
  const init = await fetch(shareUrl("/"), { method: "GET", redirect: "manual" });
  const setCookies = init.headers.getSetCookie ? init.headers.getSetCookie() : [];
  AUTH_COOKIE = setCookies.map(c => c.split(";")[0]).join("; ");
  if (!AUTH_COOKIE) {
    // Fallback: parse from single set-cookie header
    const sc = init.headers.get("set-cookie") || "";
    AUTH_COOKIE = sc.split(";")[0] || "";
  }
  log(`Auth cookie acquired: ${AUTH_COOKIE ? AUTH_COOKIE.slice(0, 60) + "..." : "NONE"}`);
  if (!AUTH_COOKIE) {
    console.error("FATAL: Could not acquire Vercel auth cookie from share URL.");
    process.exit(1);
  }

  const output = {
    startedAt: new Date().toISOString(),
    base: BASE,
    modelUrl: MODEL_URL,
    maxPolls: MAX_POLLS,
    pollMs: POLL_MS,
    upload: null,
    polls: [],
    acceptance: {
      viewerSuccess: false,
      quoteTerminal: false,
      quoteSuccess: false,
      quoteFreshUpload: false,
      uploadIdsPresent: false,
      priceTweakRouteOk: false,
    },
    tweak: null,
    viewerProof: null,
    completedAt: null,
    verdict: "PENDING",
  };

  // ── Step 1: Upload ──
  log("Step 1: Uploading model...");
  const partId = `e2e-prod-${Date.now()}`;
  const upload = await jsonPost("/api/autodesk", {
    url: MODEL_URL,
    part_id: partId,
    version: "live",
    client_id,
    client_secret,
  });
  output.upload = { status: upload.status, ok: upload.ok, urn: upload.json?.urn, quote: upload.json?.quote };

  if (!upload.ok || !upload.json?.urn) {
    output.verdict = "FAIL_UPLOAD";
    save(output);
    log(`FAIL: Upload returned ${upload.status}`);
    console.error(upload.text.slice(0, 500));
    process.exit(1);
  }
  const urn = upload.json.urn;
  const quoteTarget = upload.json?.quote?.targetFormat || null;
  const sourceUrl = upload.json?.sourceUrl || upload.json?.quote?.sourceUrl || MODEL_URL;
  const sourceFileName = upload.json?.sourceFileName || upload.json?.quote?.sourceFileName || inferFileNameFromUrl(sourceUrl);
  log(`Upload OK. URN: ${urn.slice(0, 40)}... quoteTarget: ${quoteTarget}`);

  // ── Step 2: Poll conversion-status ──
  log(`Step 2: Polling conversion-status (max ${MAX_POLLS} × ${POLL_MS / 1000}s = ${MAX_POLLS * POLL_MS / 1000}s)...`);
  let finalPoll = null;
  let converged = false;

  for (let i = 1; i <= MAX_POLLS; i++) {
    const statusPayload = {
      urn,
      client_id,
      client_secret,
      part_id: partId,
      version: "live",
      sourceUrl,
      sourceFileName,
    };

    if (quoteTarget) {
      statusPayload.quoteTarget = quoteTarget;
    }

    const poll = await jsonPost("/api/conversion-status", statusPayload);

    const v = poll.json?.viewer || {};
    const q = poll.json?.quote || {};
    const row = {
      poll: i,
      http: poll.status,
      viewerStatus: v.status,
      viewerMode: v.mode,
      hasLocalUrl: Boolean(v.localModelUrl || v.bubbleUrl),
      localError: v.localError || null,
      quoteStatus: q.status,
      quoteError: q.error || null,
      uploadStatus: q.upload?.status || null,
      uploadSource: q.upload?.source || null,
      objectModelId: q.upload?.objectModelId || null,
      orderId: q.upload?.orderId || null,
    };
    output.polls.push(row);

    const statusLine = `  Poll ${String(i).padStart(2)} [${poll.status}]: viewer=${v.status}/${v.mode} quote=${q.status}${q.upload?.status ? ` upload=${q.upload.status}/${q.upload?.source || "unknown"}` : ""}${q.upload?.objectModelId ? ` objModel=${q.upload.objectModelId}` : ""}${v.localError ? ` [localErr]` : ""}`;
    log(statusLine);

    finalPoll = poll;

    // Check convergence: viewer succeeded AND quote reached terminal state
    const viewerDone = v.status === "success";
    const quoteDone = q.status === "success" || q.status === "not_required" || q.status === "failed";
    const idsPresent = q.status === "success" && q.upload && Number.isFinite(q.upload.objectModelId) && Number.isFinite(q.upload.orderId);
    const freshUploadReady =
      idsPresent &&
      q.upload?.status === "submitted" &&
      q.upload?.source === "digifabster";

    if (viewerDone && quoteDone && (q.status !== "success" || (REQUIRE_FRESH_UPLOAD ? freshUploadReady : idsPresent))) {
      converged = true;
      break;
    }

    // Early exit on hard failures
    if (v.status === "failed") {
      log("FAIL: Viewer translation failed.");
      break;
    }

    // Quote "failed" is a terminal state (e.g. derivative_empty for mesh→CAD formats)
    if (q.status === "failed" && viewerDone) {
      log(`Quote failed (terminal): ${q.error || "unknown"}`);
      converged = true;
      break;
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }

  const fv = finalPoll?.json?.viewer || {};
  const fq = finalPoll?.json?.quote || {};

  output.acceptance.viewerSuccess = fv.status === "success";
  output.acceptance.quoteSuccess = fq.status === "success" && fq.upload?.objectModelId != null;
  output.acceptance.quoteTerminal = fq.status === "success" || fq.status === "not_required" || fq.status === "failed";
  output.acceptance.uploadIdsPresent = Number.isFinite(fq.upload?.objectModelId) && Number.isFinite(fq.upload?.orderId);
  output.acceptance.quoteFreshUpload =
    fq.status === "success" &&
    fq.upload?.status === "submitted" &&
    fq.upload?.source === "digifabster" &&
    output.acceptance.uploadIdsPresent;

  if (!converged) {
    output.verdict = "FAIL_TIMEOUT";
    output.lastPoll = output.polls[output.polls.length - 1];
    save(output);
    log(`FAIL: Did not converge after ${MAX_POLLS} polls. Last: viewer=${fv.status}/${fv.mode} quote=${fq.status}`);
    process.exit(1);
  }

  log(`Converged! viewer=${fv.status}/${fv.mode} quote=${fq.status} objModel=${fq.upload?.objectModelId} order=${fq.upload?.orderId}`);

  // ── Step 3: Price tweak route check ──
  log("Step 3: Checking /api/digifabster-price-tweak route...");
  const tweak = await jsonGet("/api/digifabster-price-tweak");
  output.tweak = { status: tweak.status, ok: tweak.ok, hasEndpoint: Boolean(tweak.json?.endpoint) };
  output.acceptance.priceTweakRouteOk = tweak.ok && Boolean(tweak.json?.endpoint);
  log(`Price tweak route: ${tweak.status} — ${output.acceptance.priceTweakRouteOk ? "OK" : "FAIL"}`);

  // ── Step 4: Playwright viewer screenshot ──
  log("Step 4: Taking viewer screenshot...");
  try {
    const { chromium } = require("@playwright/test");
    const viewerUrl = fv.localModelUrl || fv.bubbleUrl;
    const isLocal = Boolean(viewerUrl);
    const targetUrl = isLocal
      ? shareUrl(`/viewer?localModelUrl=${encodeURIComponent(viewerUrl)}`)
      : shareUrl(`/viewer?access_token=${encodeURIComponent(finalPoll.json?.accessToken || upload.json?.accessToken || "")}&urn=${encodeURIComponent(urn)}`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(20000);
    const canvasCount = await page.locator("canvas").count();
    const screenshotPath = path.join(__dirname, "..", "e2e-production-viewer-proof.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await browser.close();

    output.viewerProof = {
      mode: isLocal ? "local" : "cloud",
      url: targetUrl.slice(0, 120) + "...",
      canvasCount,
      screenshot: "e2e-production-viewer-proof.png",
    };
    log(`Viewer screenshot saved. Canvas count: ${canvasCount}, mode: ${isLocal ? "local" : "cloud"}`);
  } catch (err) {
    log(`Playwright screenshot failed: ${err.message}`);
    output.viewerProof = { error: err.message };
  }

  // ── Verdict ──
  const quoteGate = REQUIRE_FRESH_UPLOAD
    ? output.acceptance.quoteFreshUpload
    : output.acceptance.quoteTerminal;

  const allPass = output.acceptance.viewerSuccess
    && quoteGate
    && output.acceptance.priceTweakRouteOk;

  output.verdict = allPass ? "PASS" : "PARTIAL";
  output.completedAt = new Date().toISOString();
  save(output);

  log(`\n${"=".repeat(60)}`);
  log(`VERDICT: ${output.verdict}`);
  log(`  requireFreshUpload: ${REQUIRE_FRESH_UPLOAD}`);
  log(`  viewerSuccess:      ${output.acceptance.viewerSuccess}`);
  log(`  quoteTerminal:      ${output.acceptance.quoteTerminal} (status=${fq.status})`);
  log(`  quoteSuccess:       ${output.acceptance.quoteSuccess}`);
  log(`  quoteFreshUpload:   ${output.acceptance.quoteFreshUpload}`);
  log(`  uploadIdsPresent:   ${output.acceptance.uploadIdsPresent}`);
  log(`  priceTweakRouteOk:  ${output.acceptance.priceTweakRouteOk}`);
  log(`  viewerMode:         ${fv.mode}`);
  if (fq.error) log(`  quoteError:         ${fq.error}`);
  log(`${"=".repeat(60)}`);

  if (!allPass) {
    process.exit(1);
  }
})().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
