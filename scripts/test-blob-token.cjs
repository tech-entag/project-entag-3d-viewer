/**
 * Test if the BLOB_READ_WRITE_TOKEN is valid by trying to list blobs.
 */
const fs = require("fs");
const path = require("path");

async function main() {
  // Load token from .env.vercel-check
  const envPath = path.join(__dirname, "..", ".env.vercel-check");
  const raw = fs.readFileSync(envPath, "utf8");
  const match = raw.match(/BLOB_READ_WRITE_TOKEN="([\s\S]*?)"/);
  if (!match) {
    console.log("ERROR: BLOB_READ_WRITE_TOKEN not found in .env.vercel-check");
    process.exit(1);
  }
  const token = match[1].replace(/[\r\n\s]+/g, "");
  console.log("Token length:", token.length);
  console.log("Token start:", token.slice(0, 30) + "...");

  process.env.BLOB_READ_WRITE_TOKEN = token;

  const { list } = require("@vercel/blob");

  try {
    const result = await list({ limit: 2 });
    console.log("SUCCESS — blobs found:", result.blobs.length);
    if (result.blobs.length > 0) {
      console.log("First blob:", result.blobs[0].pathname);
    }
  } catch (err) {
    console.log("ERROR:", err.message);
  }
}

main();
