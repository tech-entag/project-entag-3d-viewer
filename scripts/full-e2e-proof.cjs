/**
 * Full E2E proof script — production-grade flow.
 *
 * 1. Upload STEP file → Autodesk translation
 * 2. Poll conversion-status until viewer=success (local mode) + DigiFabster model created
 * 3. POST price tweaker with the objectModelId
 *
 * Usage:
 *   node scripts/full-e2e-proof.cjs
 *
 * Env overrides:
 *   E2E_BASE_URL    — deployment URL
 *   E2E_MODEL_URL   — source STEP file URL
 */

const fs = require("fs");
const path = require("path");

// ── Config ──
const CREDS_FILE = path.join(__dirname, "..", "creds.txt");
const RESULT_FILE = path.join(__dirname, "..", "full-e2e-result.json");

const BASE = process.env.E2E_BASE_URL || "https://project-entag-3d-viewer.vercel.app";
const BYPASS = "qlQfStfLPXLfXBliB9xoS9FQFjMxys1V";
const MODEL_URL = process.env.E2E_MODEL_URL ||
  "https://e799e59cf1a17ec1dc9aca7d16738397.cdn.bubble.io/f1775554802869x303260948826025400/chair_extension_v3.step";
const MODEL_FILENAME = "chair_extension_v3.step";
const CLIENT_ID = process.env.E2E_CLIENT_ID || "";
const CLIENT_SECRET = process.env.E2E_CLIENT_SECRET || "";

const MAX_POLLS = 50;
const POLL_MS = 15000;

// ── Helpers ──
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function readCreds() {
  if (CLIENT_ID && CLIENT_SECRET) {
    return { client_id: CLIENT_ID, client_secret: CLIENT_SECRET };
  }

  const raw = fs.readFileSync(CREDS_FILE, "utf8").trim();
  const idx = raw.indexOf(":");
  return { client_id: raw.slice(0, idx), client_secret: raw.slice(idx + 1) };
}

async function jsonPost(urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vercel-protection-bypass": BYPASS,
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
    headers: { "x-vercel-protection-bypass": BYPASS },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════
//  Main E2E
// ══════════════════════════════════════════════════════════════
async function main() {
  const results = {
    startedAt: new Date().toISOString(),
    base: BASE,
    modelUrl: MODEL_URL,
    steps: {},
    verdict: null,
  };

  try {
    // ── Auth check ──
    log("══════ Step 0: Auth Check ══════");
    const authRes = await fetch(`${BASE}/`, {
      method: "GET",
      headers: { "x-vercel-protection-bypass": BYPASS },
    });
    if (authRes.status !== 200) {
      log(`FAIL: Auth check returned ${authRes.status}`);
      results.steps.auth = { pass: false, status: authRes.status };
      throw new Error("Auth failed");
    }
    results.steps.auth = { pass: true, status: 200 };
    log("PASS: Deployment reachable");

    // ── Step 1: Upload & Translate ──
    log("");
    log("══════ Step 1: Upload & Translate ══════");
    const { client_id, client_secret } = readCreds();
    const partId = `e2e-full-${Date.now()}`;

    const upload = await jsonPost("/api/autodesk", {
      url: MODEL_URL,
      part_id: partId,
      version: "live",
      client_id,
      client_secret,
    });

    const urn = upload.json?.urn;
    const accessToken = upload.json?.accessToken;
    log(`HTTP ${upload.status} — URN: ${urn ? urn.slice(0, 50) + "..." : "NONE"}`);
    log(`Source format: ${upload.json?.sourceFormat}`);
    log(`Viewer: ${JSON.stringify(upload.json?.viewer)}`);
    log(`Quote: ${JSON.stringify(upload.json?.quote)}`);

    if (!upload.ok || !urn) {
      log(`FAIL: Upload rejected — ${upload.text.slice(0, 300)}`);
      results.steps.upload = { pass: false, status: upload.status, error: upload.text.slice(0, 300) };
      throw new Error("Upload failed");
    }

    results.steps.upload = {
      pass: true,
      status: upload.status,
      urn: urn.slice(0, 50) + "...",
      sourceFormat: upload.json?.sourceFormat,
      viewerStatus: upload.json?.viewer?.status,
      quoteStatus: upload.json?.quote?.status,
    };
    log("PASS: Upload succeeded, translation queued");

    // ── Step 2: Poll for Viewer (local mode) + DigiFabster model ──
    log("");
    log("══════ Step 2: Poll Viewer + DigiFabster Sync ══════");
    log(`Polling every ${POLL_MS / 1000}s, max ${MAX_POLLS} polls...`);

    let viewerReady = false;
    let viewerMode = null;
    let localModelUrl = null;
    let quoteSuccess = false;
    let objectModelId = null;
    let orderId = null;
    let sessionId = null;
    let priceTweakingEndpoint = null;
    let lastPoll = null;

    for (let i = 1; i <= MAX_POLLS; i++) {
      const poll = await jsonPost("/api/conversion-status", {
        urn,
        client_id,
        client_secret,
        part_id: partId,
        version: "live",
        source_url: MODEL_URL,
        source_file_name: MODEL_FILENAME,
        traceId: `e2e-full-poll-${i}-${Date.now()}`,
      });

      lastPoll = poll.json;
      const v = poll.json?.viewer || {};
      const q = poll.json?.quote || {};

      const vStr = `viewer=${v.status}/${v.mode}`;
      const qStr = `quote=${q.status}${q.upload?.objectModelId ? " objModel=" + q.upload.objectModelId : ""}`;
      const localStr = v.localModelUrl ? " local=YES" : (v.localError ? ` localErr=${v.localError.slice(0, 50)}` : "");
      log(`  Poll ${String(i).padStart(2)}: ${vStr} ${qStr}${localStr}`);

      // Check viewer
      if (v.status === "success") {
        viewerReady = true;
        viewerMode = v.mode;
        localModelUrl = v.localModelUrl || v.bubbleUrl || null;
      }

      // Check quote/DigiFabster
      if (q.status === "success" && q.upload?.objectModelId) {
        quoteSuccess = true;
        objectModelId = q.upload.objectModelId;
        orderId = q.upload.orderId;
        sessionId = q.upload.sessionId;
        priceTweakingEndpoint = q.priceTweaking?.endpoint;
      }

      // Both ready?
      if (viewerReady && quoteSuccess) {
        log("Both viewer and DigiFabster sync complete!");
        break;
      }

      // Viewer failed
      if (v.status === "failed") {
        log("FAIL: Viewer translation failed");
        break;
      }

      // Quote failed (non-retryable)
      if (q.status === "failed") {
        log(`Quote failed: ${q.error}`);
        // Continue polling — viewer may still be in progress
        if (viewerReady) break;
      }

      await sleep(POLL_MS);
    }

    results.steps.viewer = {
      pass: viewerReady,
      mode: viewerMode,
      localModelUrl: localModelUrl ? localModelUrl.slice(0, 80) + "..." : null,
      isLocal: viewerMode === "local",
    };

    results.steps.digifabster = {
      pass: quoteSuccess,
      objectModelId,
      orderId,
      sessionId,
      quoteStatus: lastPoll?.quote?.status,
      uploadStatus: lastPoll?.quote?.upload?.status,
    };

    if (viewerReady) {
      log(`PASS: Viewer ready — mode=${viewerMode}`);
      if (viewerMode === "local") {
        log(`  Local URL: ${localModelUrl ? localModelUrl.slice(0, 100) : "N/A"}`);
      } else {
        log(`  WARNING: Viewer is in cloud mode, not local. Local error: ${lastPoll?.viewer?.localError || "none"}`);
      }
    } else {
      log("FAIL: Viewer did not reach success");
    }

    if (quoteSuccess) {
      log(`PASS: DigiFabster model created — objectModelId=${objectModelId}`);
    } else {
      log(`FAIL: DigiFabster sync did not succeed — last quote status: ${lastPoll?.quote?.status}`);
      log(`  Error: ${lastPoll?.quote?.error || "none"}`);
    }

    // ── Step 3: Price Tweaker ──
    log("");
    log("══════ Step 3: Price Tweaker ══════");

    if (!objectModelId) {
      log("SKIP: No objectModelId — cannot run price tweaker");
      results.steps.priceTweak = { pass: false, skipped: true, reason: "no objectModelId" };
    } else {
      // 3a: GET catalog
      log("GET /api/digifabster-price-tweak (catalog)...");
      const catalog = await jsonGet("/api/digifabster-price-tweak");
      log(`  HTTP ${catalog.status} — success=${catalog.json?.success}`);

      if (!catalog.ok || !catalog.json?.success) {
        log("FAIL: Could not fetch machine/material catalog");
        results.steps.priceTweak = { pass: false, error: "catalog_fetch_failed" };
      } else {
        const machines = catalog.json.machinesMaterials || [];
        const defaultSlug = catalog.json.defaultTechnologySlug;
        log(`  Default tech slug: ${defaultSlug}`);
        log(`  Machines available: ${machines.length}`);

        // Pick first machine and first material for testing
        const firstMachine = machines[0];
        const firstMachineId = firstMachine?.id;
        const firstMachineName = firstMachine?.title;
        const firstMaterial = Array.isArray(firstMachine?.materials) ? firstMachine.materials[0] : null;
        const firstMaterialId = firstMaterial?.id;
        const firstMaterialName = firstMaterial?.title;

        log(`  Using machine: ${firstMachineName} (${firstMachineId})`);
        log(`  Using material: ${firstMaterialName} (${firstMaterialId})`);

        // 3b: POST price tweak
        log("");
        log(`POST /api/digifabster-price-tweak (objectModelId=${objectModelId})...`);
        const tweak = await jsonPost("/api/digifabster-price-tweak", {
          objectModelId,
          machineId: firstMachineId,
          materialId: firstMaterialId,
          count: 1,
        });

        log(`  HTTP ${tweak.status}`);
        if (tweak.json?.status === "success") {
          log(`  PASS: Price = $${tweak.json.total_per_part_price}`);
          log(`  Total holes: ${tweak.json.total_holes}`);
          results.steps.priceTweak = {
            pass: true,
            objectModelId,
            machineId: firstMachineId,
            machineName: firstMachineName,
            materialId: firstMaterialId,
            materialName: firstMaterialName,
            price: tweak.json.total_per_part_price,
            totalHoles: tweak.json.total_holes,
          };
        } else {
          log(`  FAIL: ${JSON.stringify(tweak.json).slice(0, 300)}`);
          results.steps.priceTweak = {
            pass: false,
            objectModelId,
            machineId: firstMachineId,
            materialId: firstMaterialId,
            httpStatus: tweak.status,
            error: tweak.json?.error || tweak.text.slice(0, 300),
          };
        }
      }
    }

    // ── Verdict ──
    log("");
    log("══════════════════════════════════════════");
    log("  FINAL VERDICT");
    log("══════════════════════════════════════════");
    log("");

    const uploadPass = results.steps.upload?.pass;
    const viewerPass = results.steps.viewer?.pass;
    const viewerIsLocal = results.steps.viewer?.isLocal;
    const digifabsterPass = results.steps.digifabster?.pass;
    const priceTweakPass = results.steps.priceTweak?.pass;

    log(`  1. Upload & Translate:   ${uploadPass ? "PASS ✓" : "FAIL ✗"}`);
    log(`  2. 3D Viewer (local):    ${viewerPass ? "PASS ✓" : "FAIL ✗"} (mode=${viewerMode}${viewerIsLocal ? "" : " — wanted local"})`);
    log(`  3. DigiFabster model:    ${digifabsterPass ? "PASS ✓" : "FAIL ✗"} (objectModelId=${objectModelId || "none"})`);
    log(`  4. Price Tweaker:        ${priceTweakPass ? "PASS ✓" : "FAIL ✗"}${results.steps.priceTweak?.price ? " ($" + results.steps.priceTweak.price + ")" : ""}`);
    log("");

    const allPass = uploadPass && viewerPass && digifabsterPass && priceTweakPass;
    const corePass = uploadPass && viewerPass && digifabsterPass;

    if (allPass) {
      results.verdict = viewerIsLocal ? "PASS" : "PASS_CLOUD_VIEWER";
      log(`  VERDICT: ${results.verdict}`);
    } else if (corePass) {
      results.verdict = "PARTIAL";
      log("  VERDICT: PARTIAL (core passes, price tweak failed)");
    } else {
      results.verdict = "FAIL";
      log("  VERDICT: FAIL");
    }
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    results.verdict = results.verdict || "FAIL";
    results.error = err.message;
  }

  results.completedAt = new Date().toISOString();
  fs.writeFileSync(RESULT_FILE, JSON.stringify(results, null, 2));
  log("");
  log(`Results saved to full-e2e-result.json`);

  if (results.verdict === "FAIL") process.exit(1);
}

main();
