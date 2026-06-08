// Verify the production BLOB_READ_WRITE_TOKEN and fix if needed
const fs = require("fs");
const { execSync } = require("child_process");

// Step 1: Pull production env
execSync("npx vercel env pull .vercel/.env.prod-verify.local --environment production --yes", {
  stdio: "inherit",
});

// Step 2: Read and verify
const env = fs.readFileSync(".vercel/.env.prod-verify.local", "utf8");
const match = env.match(/BLOB_READ_WRITE_TOKEN="([^"]*)"/);

if (!match) {
  console.log("ERROR: BLOB_READ_WRITE_TOKEN not found in production env!");
  process.exit(1);
}

const token = match[1];
console.log(`\nProduction token length: ${token.length}`);
console.log(`Has newline: ${token.includes("\n") || token.includes("\r")}`);
console.log(`Starts with: ${token.substring(0, 15)}...`);
console.log(`Ends with: ...${token.substring(token.length - 15)}`);
console.log(`End chars: ${JSON.stringify(token.slice(-5))}`);

// Step 3: Read preview token for comparison
const previewEnv = fs.readFileSync(".vercel/.env.preview.local", "utf8");
const previewMatch = previewEnv.match(/BLOB_READ_WRITE_TOKEN="([^"]*)"/);
if (previewMatch) {
  const previewToken = previewMatch[1];
  console.log(`\nPreview token length: ${previewToken.length}`);
  console.log(`Tokens match: ${token.trim() === previewToken.trim()}`);
}

// Step 4: If token has issues, fix it
if (token.includes("\n") || token.includes("\r") || token !== token.trim()) {
  console.log("\n⚠️  Token has whitespace issues. Fixing...");

  // Remove current production token
  execSync("npx vercel env rm BLOB_READ_WRITE_TOKEN production --yes", { stdio: "inherit" });

  // Write clean token to temp file (no trailing newline)
  const cleanToken = previewMatch ? previewMatch[1].trim() : token.trim();
  const tempPath = ".vercel/blob-token-clean.txt";
  fs.writeFileSync(tempPath, cleanToken); // No trailing newline

  // Use stdin from file
  execSync(`npx vercel env add BLOB_READ_WRITE_TOKEN production < "${tempPath}"`, {
    stdio: "inherit",
    shell: "cmd.exe",
  });

  fs.unlinkSync(tempPath);
  console.log("✅  Token fixed.");
} else {
  console.log("\n✅  Token looks clean.");
}

// Cleanup
try { fs.unlinkSync(".vercel/.env.prod-verify.local"); } catch {}
