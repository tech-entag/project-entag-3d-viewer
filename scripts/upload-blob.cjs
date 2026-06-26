// Upload a file to Vercel Blob with the preview token
const fs = require("fs");
const path = require("path");
const { put } = require("@vercel/blob");

async function main() {
  // Parse token from .env.preview (may be multi-line)
  const raw = fs.readFileSync(path.join(__dirname, "..", ".env.preview"), "utf8");
  const match = raw.match(/BLOB_READ_WRITE_TOKEN="([^"]+)"/s);
  if (!match) {
    console.error("Could not find BLOB_READ_WRITE_TOKEN in .env.preview");
    process.exit(1);
  }
  const token = match[1].replace(/[\r\n\s]/g, "");
  console.log("Token length:", token.length);

  const filePath = path.join(__dirname, "fixtures", "cutting-blade-1-k110-1.STEP");
  const buf = fs.readFileSync(filePath);
  console.log("File size:", buf.length);

  const result = await put("test-fixtures/cutting-blade-1-k110-1.STEP", buf, {
    access: "public",
    contentType: "application/octet-stream",
    token,
  });

  console.log("Blob URL:", result.url);
}

main().catch(e => {
  console.error("Error:", e.message);
  process.exit(1);
});
