// Debug: run the full Autodesk flow locally step by step
const fs = require("fs");
const path = require("path");

async function main() {
  // 1. Read credentials
  // Allow override via env vars or fall back to creds.txt
  let clientId = process.env.APS_CLIENT_ID;
  let clientSecret = process.env.APS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const creds = fs.readFileSync(path.join(__dirname, "..", "creds.txt"), "utf8").trim();
    const idx = creds.indexOf(":");
    clientId = creds.slice(0, idx);
    clientSecret = creds.slice(idx + 1);
  }

  // 2. Get access token
  console.log("[1] Fetching access token...");
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenRes = await fetch("https://developer.api.autodesk.com/authentication/v2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=code:all data:write data:read data:create bucket:create bucket:delete bucket:read viewables:read",
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error("Token failed:", tokenData);
    process.exit(1);
  }
  const accessToken = tokenData.access_token;
  console.log("  Token OK, expires_in:", tokenData.expires_in);

  // 3. Create bucket
  const bucketKey = Date.now().toString();
  console.log(`[2] Creating bucket "${bucketKey}"...`);
  const bucketRes = await fetch("https://developer.api.autodesk.com/oss/v2/buckets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ bucketKey, access: "full", policyKey: "temporary" }),
  });
  if (!bucketRes.ok) {
    const err = await bucketRes.text();
    console.error("Bucket failed:", bucketRes.status, err);
    process.exit(1);
  }
  const bucketData = await bucketRes.json();
  console.log("  Bucket OK:", bucketData.bucketKey);

  // 4. Read local STEP file
  const filePath = path.join(__dirname, "..", "cutting-blade-1-k110-1.STEP");
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = "cutting-blade-1-k110-1.STEP";
  console.log(`[3] File: ${fileName} (${fileBuffer.length} bytes)`);

  // 5. Get signed URL
  console.log("[4] Getting signed URL...");
  const signedRes = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(fileName)}/signeds3upload?minutesExpiration=10`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!signedRes.ok) {
    const err = await signedRes.text();
    console.error("Signed URL failed:", signedRes.status, err);
    process.exit(1);
  }
  const signedData = await signedRes.json();
  console.log("  Signed URL OK, urls:", signedData.urls.length);

  // 6. Upload file
  console.log("[5] Uploading file...");
  const uploadRes = await fetch(signedData.urls[0], {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: fileBuffer,
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    console.error("Upload failed:", uploadRes.status, err);
    process.exit(1);
  }
  console.log("  Upload OK:", uploadRes.status);

  // 7. Finalize upload
  console.log("[6] Finalizing upload...");
  const finalRes = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(fileName)}/signeds3upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uploadKey: signedData.uploadKey }),
    }
  );
  if (!finalRes.ok) {
    const err = await finalRes.text();
    console.error("Finalize failed:", finalRes.status, err);
    process.exit(1);
  }
  const finalData = await finalRes.json();
  console.log("  Finalize OK:", finalData.objectKey);
  console.log("  Object ID:", finalData.objectId);

  // 8. Start translation
  const encodedURN = Buffer.from(finalData.objectId).toString("base64");
  console.log(`[7] Starting translation (URN: ${encodedURN.slice(0, 40)}...)...`);
  const translationRes = await fetch("https://developer.api.autodesk.com/modelderivative/v2/designdata/job", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        urn: encodedURN,
        rootFilename: finalData.objectKey,
        compressedUrn: false,
      },
      output: {
        destination: { region: "us" },
        formats: [
          { type: "svf", views: ["2d", "3d"] },
          { type: "thumbnail", advanced: { width: 400, height: 400 } },
          { type: "step" },
        ],
      },
    }),
  });

  const translationBody = await translationRes.text();
  console.log("  Translation status:", translationRes.status);
  console.log("  Translation response:", translationBody);

  if (!translationRes.ok) {
    console.error("TRANSLATION FAILED");
    process.exit(1);
  }

  console.log("\n[OK] Full flow succeeded!");
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
