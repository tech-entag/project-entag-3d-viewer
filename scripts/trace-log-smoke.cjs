const fs = require("fs");

const base = process.argv[2];
const share = process.argv[3];
const modelUrl = "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/stl/ascii/slotted_disk.stl";

async function run() {
  if (!base || !share) {
    throw new Error("Usage: node scripts/trace-log-smoke.cjs <deployment-base-url> <vercel-share-token>");
  }

  const [client_id, client_secret] = fs.readFileSync("creds.txt", "utf8").trim().split(":", 2);
  if (!client_id || !client_secret) {
    throw new Error("creds.txt must contain client_id:client_secret");
  }

  const traceId = `trace-log-smoke-${Date.now()}`;
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
      part_id: "log-smoke",
      version: "live",
      client_id,
      client_secret,
      traceId,
    }),
  });

  const uploadBody = await uploadRes.text();
  console.log("TRACE_ID", traceId);
  console.log("UPLOAD_STATUS", uploadRes.status);
  console.log("UPLOAD_BODY", uploadBody);

  let urn = null;
  try {
    urn = JSON.parse(uploadBody).urn;
  } catch {
    urn = null;
  }

  if (!urn) {
    return;
  }

  const statusRes = await fetch(`${base}/api/conversion-status?_vercel_share=${share}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      urn,
      client_id,
      client_secret,
      part_id: "log-smoke",
      version: "live",
      traceId,
    }),
  });

  const statusBody = await statusRes.text();
  console.log("STATUS_STATUS", statusRes.status);
  console.log("STATUS_BODY", statusBody);
}

run().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
