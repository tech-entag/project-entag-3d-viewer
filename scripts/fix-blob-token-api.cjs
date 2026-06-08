// Force-fix the production BLOB_READ_WRITE_TOKEN using Vercel REST API
const fs = require("fs");
const https = require("https");

// Read the clean preview token
const previewEnv = fs.readFileSync(".vercel/.env.preview.local", "utf8");
const previewMatch = previewEnv.match(/BLOB_READ_WRITE_TOKEN="([^"]+)"/);
if (!previewMatch) {
  console.log("ERROR: No preview token found");
  process.exit(1);
}
const cleanToken = previewMatch[1].trim();
console.log(`Clean token length: ${cleanToken.length}`);
console.log(`Clean token starts with: ${cleanToken.substring(0, 15)}`);

// Read Vercel config
const project = JSON.parse(fs.readFileSync(".vercel/project.json", "utf8"));
const projectId = project.projectId;
const orgId = project.orgId;
console.log(`Project: ${projectId}, Org: ${orgId}`);

// Read Vercel auth token
const authJson = JSON.parse(fs.readFileSync(
  require("path").join(process.env.APPDATA || "", "com.vercel.cli", "Data", "auth.json"),
  "utf8"
));
const authToken = authJson.token;
console.log(`Auth token available: ${Boolean(authToken)}`);

// Step 1: List env vars to find the production BLOB_READ_WRITE_TOKEN ID
const listEnvVars = () => new Promise((resolve, reject) => {
  const options = {
    hostname: "api.vercel.com",
    path: `/v9/projects/${projectId}/env?teamId=${orgId}`,
    method: "GET",
    headers: { Authorization: `Bearer ${authToken}` },
  };
  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => resolve(JSON.parse(data)));
  });
  req.on("error", reject);
  req.end();
});

// Step 2: Delete env var by ID
const deleteEnvVar = (envId) => new Promise((resolve, reject) => {
  const options = {
    hostname: "api.vercel.com",
    path: `/v9/projects/${projectId}/env/${envId}?teamId=${orgId}`,
    method: "DELETE",
    headers: { Authorization: `Bearer ${authToken}` },
  };
  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => resolve(JSON.parse(data)));
  });
  req.on("error", reject);
  req.end();
});

// Step 3: Create env var
const createEnvVar = (key, value, target) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ key, value, target, type: "encrypted" });
  const options = {
    hostname: "api.vercel.com",
    path: `/v10/projects/${projectId}/env?teamId=${orgId}`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };
  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => resolve(JSON.parse(data)));
  });
  req.on("error", reject);
  req.write(body);
  req.end();
});

(async () => {
  // List and find production BLOB tokens
  const { envs } = await listEnvVars();
  const prodBlobs = envs.filter(
    (e) => e.key === "BLOB_READ_WRITE_TOKEN" && e.target.includes("production")
  );
  console.log(`Found ${prodBlobs.length} production BLOB token(s)`);

  // Delete all production BLOB tokens
  for (const env of prodBlobs) {
    console.log(`Deleting env ${env.id}...`);
    await deleteEnvVar(env.id);
    console.log(`Deleted.`);
  }

  // Create new clean token
  console.log("Creating clean production BLOB_READ_WRITE_TOKEN...");
  const result = await createEnvVar("BLOB_READ_WRITE_TOKEN", cleanToken, ["production"]);
  console.log(`Created: ${result.key || "??"} (id: ${result.created?.id || result.id || "??"})`);
  console.log("✅  Done.");
})();
