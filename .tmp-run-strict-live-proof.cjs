const fs = require("fs");
const { chromium } = require("@playwright/test");

const base = process.argv[2];
const share = process.argv[3];
const modelUrl = process.argv[4] || "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/fbx/Samba%20Dancing.fbx";
const maxPolls = Number(process.argv[5] || 45);
const pollMs = Number(process.argv[6] || 10000);

if (!base || !share) {
  console.error("Usage: node .tmp-run-strict-live-proof.cjs <base-url> <share-token> [model-url] [max-polls] [poll-ms]");
  process.exit(1);
}

function withShare(path) {
  const sep = path.includes("?") ? "&" : "?";
  return `${base}${path}${sep}_vercel_share=${share}`;
}

async function parseJsonSafe(response) {
  const text = await response.text();
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
}

async function postJson(path, body, cookie) {
  const res = await fetch(withShare(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const parsed = await parseJsonSafe(res);
  return { status: res.status, ok: res.ok, body: parsed.json, raw: parsed.text };
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const creds = fs.readFileSync("creds.txt", "utf8").trim();
  const idx = creds.indexOf(":");
  const client_id = creds.slice(0, idx);
  const client_secret = creds.slice(idx + 1);

  if (!client_id || !client_secret) {
    throw new Error("creds.txt must contain client_id:client_secret");
  }

  const init = await fetch(withShare("/"), { method: "GET", redirect: "manual" });
  const setCookie = init.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0] || "";

  const partId = `strict-proof-${Date.now()}`;
  const version = "live";

  const upload = await postJson(
    "/api/autodesk",
    {
      url: modelUrl,
      part_id: partId,
      version,
      client_id,
      client_secret,
    },
    cookie
  );

  const output = {
    startedAt: new Date().toISOString(),
    base,
    shareToken: share,
    modelUrl,
    upload,
    polls: [],
    acceptance: {
      viewerLocalMode: false,
      quoteSuccess: false,
      uploadIdsPresent: false,
      priceTweakSuccess: false,
    },
  };

  if (!upload.ok || !upload.body?.urn) {
    output.failure = "upload_failed";
    fs.writeFileSync("live-strict-proof-result.json", JSON.stringify(output, null, 2));
    throw new Error(`Upload failed: ${upload.status}`);
  }

  const urn = upload.body.urn;
  const quoteTarget = upload.body?.quote?.targetFormat || "step";

  let finalPoll = null;
  for (let i = 1; i <= maxPolls; i += 1) {
    const poll = await postJson(
      "/api/conversion-status",
      {
        urn,
        client_id,
        client_secret,
        quoteTarget,
        part_id: partId,
        version,
      },
      cookie
    );

    const viewer = poll.body?.viewer || {};
    const quote = poll.body?.quote || {};
    output.polls.push({
      poll: i,
      status: poll.status,
      ok: poll.ok,
      viewerStatus: viewer.status,
      viewerMode: viewer.mode,
      hasLocalModelUrl: Boolean(viewer.localModelUrl || viewer.bubbleUrl),
      localError: viewer.localError || null,
      quoteStatus: quote.status,
      quoteTarget: quote.targetFormat || null,
      quoteError: quote.error || null,
      uploadStatus: quote.upload?.status || null,
      uploadSource: quote.upload?.source || null,
      objectModelId: quote.upload?.objectModelId || null,
      orderId: quote.upload?.orderId || null,
      sessionId: quote.upload?.sessionId || null,
    });

    finalPoll = poll;

    const localReady = poll.ok && viewer.status === "success" && viewer.mode === "local" && Boolean(viewer.localModelUrl || viewer.bubbleUrl);
    const quoteReady = poll.ok && quote.status === "success";
    const idsReady = quoteReady && quote.upload && Number.isFinite(quote.upload.objectModelId) && Number.isFinite(quote.upload.orderId);

    if (localReady && quoteReady && idsReady) {
      output.acceptance.viewerLocalMode = true;
      output.acceptance.quoteSuccess = true;
      output.acceptance.uploadIdsPresent = true;
      break;
    }

    await delay(pollMs);
  }

  if (!finalPoll || !output.acceptance.viewerLocalMode || !output.acceptance.quoteSuccess || !output.acceptance.uploadIdsPresent) {
    output.failure = "conversion_or_quote_conditions_not_met";
    output.finalPoll = finalPoll;
    fs.writeFileSync("live-strict-proof-result.json", JSON.stringify(output, null, 2));
    throw new Error("Strict conditions not met before timeout");
  }

  const finalViewer = finalPoll.body.viewer;
  const finalQuote = finalPoll.body.quote;
  const tweakPayload = {
    part_id: partId,
    version,
    objectModelId: finalQuote.upload.objectModelId,
    orderId: finalQuote.upload.orderId,
    sessionId: finalQuote.upload.sessionId || null,
    quoteTarget,
    fileUrl: finalQuote.upload.fileUrl || null,
    fileName: finalQuote.upload.fileName || null,
    quantity: 1,
  };

  const tweak = await postJson("/api/digifabster-price-tweak", tweakPayload, cookie);
  output.tweak = {
    status: tweak.status,
    ok: tweak.ok,
    body: tweak.body,
    raw: tweak.raw,
    payload: tweakPayload,
  };
  output.acceptance.priceTweakSuccess = Boolean(tweak.ok && tweak.body?.success === true);

  const localModelUrl = finalViewer.localModelUrl || finalViewer.bubbleUrl;
  if (localModelUrl) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(withShare(`/viewer?localModelUrl=${encodeURIComponent(localModelUrl)}`), {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForTimeout(25000);
    const canvasCount = await page.locator("canvas").count();
    const modalErrorCount = await page.locator(".adsk-viewing-viewer .adsk-viewing-viewer-error").count();
    const screenshotPath = "live-strict-local-viewer-proof.png";
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await browser.close();

    output.viewerProof = {
      localModelUrl,
      canvasCount,
      modalErrorCount,
      screenshot: screenshotPath,
    };
  }

  output.completedAt = new Date().toISOString();
  fs.writeFileSync("live-strict-proof-result.json", JSON.stringify(output, null, 2));

  const allPass =
    output.acceptance.viewerLocalMode &&
    output.acceptance.quoteSuccess &&
    output.acceptance.uploadIdsPresent &&
    output.acceptance.priceTweakSuccess;

  if (!allPass) {
    throw new Error("Strict proof completed but acceptance checks failed");
  }

  console.log("STRICT_PROOF_SUCCESS");
})().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
