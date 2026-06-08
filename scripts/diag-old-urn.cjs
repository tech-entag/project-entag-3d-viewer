/**
 * Quick test: Try downloading STEP from the OLD (first) uploaded URN.
 * If this also 404s from CDN, the issue is FBX→STEP conversion itself.
 */
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Old URN from first E2E test
const OLD_URN = "dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6MTc3NTU5MjQzNTEzOC9TYW1iYSUyNTIwRGFuY2luZy5mYng";

const creds = fs.readFileSync(path.join(__dirname, "..", "creds.txt"), "utf8").trim();
const idx = creds.indexOf(":");
const CLIENT_ID = creds.slice(0, idx);
const CLIENT_SECRET = creds.slice(idx + 1);

async function getToken() {
  const resp = await fetch("https://developer.api.autodesk.com/authentication/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "data:read data:write bucket:create bucket:read",
    }),
  });
  return (await resp.json()).access_token;
}

async function main() {
  const token = await getToken();

  // Get manifest
  const manifestResp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${OLD_URN}/manifest`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const manifest = await manifestResp.json();

  // Find STEP
  const stepBranch = manifest.derivatives?.find(d => d.outputType?.toLowerCase() === "step");
  if (!stepBranch) { console.log("No STEP branch"); return; }

  function findStepUrn(node) {
    if (node.urn && node.role?.toLowerCase() === "step") return node;
    for (const child of node.children || []) {
      const found = findStepUrn(child);
      if (found) return found;
    }
    return null;
  }

  const stepNode = findStepUrn(stepBranch);
  console.log("STEP node:", JSON.stringify(stepNode, null, 2));

  const encoded = encodeURIComponent(stepNode.urn);
  const scUrl = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${OLD_URN}/manifest/${encoded}/signedcookies`;

  // Get signed cookies
  const scResp = await axios.get(scUrl, {
    timeout: 30_000,
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log("Signedcookies:", scResp.status, "size:", scResp.data.size, "url:", scResp.data.url?.slice(0, 80));

  // Extract cookies from headers
  const cookieHeaders = scResp.headers["set-cookie"];
  const cookies = {};
  const vals = Array.isArray(cookieHeaders) ? cookieHeaders : [cookieHeaders].filter(Boolean);
  for (const c of vals) {
    const [pair] = c.split(";");
    const sepIdx = pair.indexOf("=");
    if (sepIdx > 0) cookies[pair.slice(0, sepIdx).trim()] = pair.slice(sepIdx + 1).trim();
  }
  const allCookies = { ...(scResp.data.cookie || {}), ...cookies };
  const cookieHeader = Object.entries(allCookies).map(([k, v]) => `${k}=${v}`).join("; ");

  // Try CDN download
  try {
    const dlResp = await axios.get(scResp.data.url, {
      responseType: "arraybuffer",
      timeout: 30_000,
      headers: { Cookie: cookieHeader },
    });
    console.log("✅ CDN download:", dlResp.status, "bytes:", dlResp.data.byteLength);
  } catch (err) {
    console.log("❌ CDN download:", err.response?.status, err.response?.headers?.["x-cache"]);

    // Also try with regular fetch (no Cookie header, no redirect follow)
    console.log("\nTrying raw fetch of signed URL (no cookies)...");
    const rawResp = await fetch(scResp.data.url);
    console.log("Fetch status:", rawResp.status);
    if (rawResp.ok) {
      const buf = await rawResp.arrayBuffer();
      console.log("✅ Downloaded:", buf.byteLength, "bytes");
    } else {
      console.log("❌ Failed:", rawResp.statusText);
    }
  }
}

main().catch(console.error);
