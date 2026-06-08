/**
 * Diagnostic: Fetch manifest for the last uploaded URN and try downloading STEP derivative.
 * Replicates the exact serverless function flow with axios.
 * Usage: node scripts/diag-step-download.cjs
 */
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const result = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "e2e-production-proof-result.json"), "utf8")
);
const urn = result.upload.urn;

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
  const data = await resp.json();
  return data.access_token;
}

async function main() {
  console.log("URN:", urn);
  const token = await getToken();
  console.log("Token acquired, length:", token.length);

  // Fetch manifest
  const manifestResp = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const manifest = await manifestResp.json();
  console.log("\n=== MANIFEST ===");
  console.log("Status:", manifest.status, "Progress:", manifest.progress);
  console.log("Derivatives count:", manifest.derivatives?.length);

  // Find STEP branch
  for (const deriv of manifest.derivatives || []) {
    console.log(`\n--- Derivative: outputType=${deriv.outputType}, status=${deriv.status}, progress=${deriv.progress}`);
    if (deriv.children) {
      for (const child of deriv.children) {
        console.log(`  Child: role=${child.role}, type=${child.type}, status=${child.status}, urn=${child.urn?.slice(0, 80)}...`);
        if (child.children) {
          for (const grandchild of child.children) {
            console.log(`    Grandchild: role=${grandchild.role}, type=${grandchild.type}, status=${grandchild.status}, urn=${grandchild.urn?.slice(0, 80)}...`);
          }
        }
      }
    }
  }

  // Try to find and download STEP derivative
  const stepBranch = manifest.derivatives?.find(d => d.outputType?.toLowerCase() === "step");
  if (!stepBranch) {
    console.log("\n❌ No STEP branch found in manifest.");
    return;
  }

  console.log(`\nSTEP branch status: ${stepBranch.status}, progress: ${stepBranch.progress}`);

  // Find downloadable node (with urn and role=step)
  function findStepUrn(node) {
    if (node.urn && node.role?.toLowerCase() === "step") return node.urn;
    for (const child of node.children || []) {
      const found = findStepUrn(child);
      if (found) return found;
    }
    return null;
  }

  const stepUrn = findStepUrn(stepBranch);
  if (!stepUrn) {
    console.log("❌ No STEP URN found in children.");
    return;
  }
  console.log("STEP derivative URN:", stepUrn);

  // Try signedcookies endpoint (exact serverless function flow using axios)
  const encoded = encodeURIComponent(stepUrn);
  const scUrl = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest/${encoded}/signedcookies`;
  console.log("\n=== STEP 1: Signedcookies via axios ===");
  console.log("URL:", scUrl.slice(0, 120), "...");

  try {
    const scResp = await axios.get(scUrl, {
      timeout: 45_000,
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log("✅ Signedcookies status:", scResp.status);
    console.log("Response data keys:", Object.keys(scResp.data));
    console.log("Signed URL:", scResp.data.url?.slice(0, 80));
    console.log("Cookie from body:", scResp.data.cookie ? Object.keys(scResp.data.cookie) : "none");

    // Extract set-cookie headers
    const cookieHeaders = scResp.headers["set-cookie"];
    const headerCookies = {};
    const cookieValues = Array.isArray(cookieHeaders)
      ? cookieHeaders
      : typeof cookieHeaders === "string"
        ? [cookieHeaders]
        : [];
    for (const cookie of cookieValues) {
      const [pair] = cookie.split(";");
      const sepIdx = pair.indexOf("=");
      if (sepIdx > 0) {
        headerCookies[pair.slice(0, sepIdx).trim()] = pair.slice(sepIdx + 1).trim();
      }
    }
    console.log("Cookies from headers:", Object.keys(headerCookies));

    const allCookies = { ...(scResp.data.cookie || {}), ...headerCookies };
    console.log("All cookie keys:", Object.keys(allCookies));

    // STEP 2: Download from CDN URL with cookies (exact serverless flow)
    console.log("\n=== STEP 2: Download from CDN via axios ===");
    const cookieHeader = Object.entries(allCookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    console.log("Cookie header:", cookieHeader.slice(0, 80), "...");

    try {
      const dlResp = await axios.get(scResp.data.url, {
        responseType: "arraybuffer",
        timeout: 45_000,
        headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
      });
      console.log("✅ CDN download status:", dlResp.status);
      console.log("Downloaded bytes:", dlResp.data.byteLength);
    } catch (dlError) {
      console.log("❌ CDN download failed:", dlError.response?.status, dlError.message);
      if (dlError.response?.headers) {
        console.log("Response headers:", Object.fromEntries(
          Object.entries(dlError.response.headers).filter(([k]) => k.startsWith("x-") || k === "content-type")
        ));
      }
    }
  } catch (scError) {
    console.log("❌ Signedcookies failed:", scError.response?.status, scError.message);
    if (scError.response?.data) {
      const text = typeof scError.response.data === "string"
        ? scError.response.data
        : Buffer.from(scError.response.data).toString("utf8");
      console.log("Response:", text.slice(0, 500));
    }
  }

  // Also try direct download
  const directUrl = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest/${encoded}`;
  console.log("\n=== STEP 3: Direct download via axios ===");
  try {
    const dlResp = await axios.get(directUrl, {
      responseType: "arraybuffer",
      timeout: 45_000,
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log("✅ Direct download status:", dlResp.status);
    console.log("Downloaded bytes:", dlResp.data.byteLength);
  } catch (err) {
    console.log("❌ Direct download failed:", err.response?.status, err.message);
  }
}

main().catch(console.error);
