const fs = require("fs");

const base = process.argv[2];
const share = process.argv[3];
const modelUrl = process.argv[4] || "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/fbx/Samba%20Dancing.fbx";
const maxPolls = Number(process.argv[5] || 40);

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  if (!base || !share) {
    throw new Error("Usage: node scripts/trace-quote-flow.cjs <deployment-base-url> <vercel-share-token> [model-url] [max-polls]");
  }

  const [client_id, client_secret] = fs.readFileSync("creds.txt", "utf8").trim().split(":", 2);
  if (!client_id || !client_secret) {
    throw new Error("creds.txt must contain client_id:client_secret");
  }

  const traceId = `trace-quote-flow-${Date.now()}`;
  const init = await fetch(`${base}/?_vercel_share=${share}`, { redirect: "manual" });
  const cookie = (init.headers.get("set-cookie") || "").split(";")[0];

  const headers = {
    "content-type": "application/json",
    ...(cookie ? { cookie } : {}),
  };

  const uploadRes = await fetch(`${base}/api/autodesk?_vercel_share=${share}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: modelUrl,
      part_id: "quote-flow",
      version: "live",
      client_id,
      client_secret,
      traceId,
    }),
  });

  const uploadBodyText = await uploadRes.text();
  console.log("TRACE_ID", traceId);
  console.log("MODEL_URL", modelUrl);
  console.log("UPLOAD_STATUS", uploadRes.status);
  console.log("UPLOAD_BODY", uploadBodyText);

  if (!uploadRes.ok) {
    return;
  }

  let uploadBody;
  try {
    uploadBody = JSON.parse(uploadBodyText);
  } catch {
    throw new Error("Upload response was not valid JSON");
  }

  const urn = uploadBody?.urn;
  if (!urn) {
    throw new Error("Missing urn in upload response");
  }

  for (let i = 1; i <= maxPolls; i += 1) {
    const statusRes = await fetch(`${base}/api/conversion-status?_vercel_share=${share}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        urn,
        client_id,
        client_secret,
        part_id: "quote-flow",
        version: "live",
        traceId,
      }),
    });

    const statusBodyText = await statusRes.text();
    let statusBody;
    try {
      statusBody = JSON.parse(statusBodyText);
    } catch {
      statusBody = null;
    }

    const viewerStatus = statusBody?.viewer?.status || "unknown";
    const quoteStatus = statusBody?.quote?.status || "unknown";
    const quoteTarget = statusBody?.quote?.targetFormat || null;
    const uploadStatus = statusBody?.quote?.upload?.status || null;
    const uploadSource = statusBody?.quote?.upload?.source || null;

    console.log(`[poll ${i}] viewer=${viewerStatus} quote=${quoteStatus} target=${quoteTarget} uploadStatus=${uploadStatus} uploadSource=${uploadSource}`);

    if (!statusRes.ok) {
      console.log("STATUS_ERROR", statusBodyText);
      break;
    }

    if (quoteStatus === "success" && (uploadStatus === "submitted" || uploadStatus === "cached")) {
      console.log("QUOTE_SYNC_READY", JSON.stringify(statusBody));
      return;
    }

    if (quoteStatus === "failed") {
      console.log("QUOTE_FAILED", JSON.stringify(statusBody));
      return;
    }

    await delay(15000);
  }

  console.log("QUOTE_TIMEOUT");
}

run().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
