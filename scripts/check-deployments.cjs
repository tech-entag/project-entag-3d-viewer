const fs = require("fs");

const targets = [
  {
    name: "ie",
    base: "https://project-entag-3d-viewer-ie0jyc9ck-citizendevio.vercel.app",
    share: "E6jmUG0sqp4bHilanZSE0lcCv2tRgGc8",
  },
  {
    name: "hhs",
    base: "https://project-entag-3d-viewer-hhsavg6tm-citizendevio.vercel.app",
    share: "hY3CLiJQaPVkd7AGWmliZ2EjkhrwIobA",
  },
];

const urn = "dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6MTc3NTU4NzA5NzA4My9TYW1iYSUyNTIwRGFuY2luZy5mYng";

async function parseJsonSafe(res) {
  const text = await res.text();
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
}

async function main() {
  const creds = fs.readFileSync("creds.txt", "utf8").trim();
  const split = creds.indexOf(":");
  const client_id = creds.slice(0, split);
  const client_secret = creds.slice(split + 1);

  const rows = [];

  for (const t of targets) {
    let cookie = "";
    const initRes = await fetch(`${t.base}/?_vercel_share=${t.share}`, {
      method: "GET",
      redirect: "manual",
    });
    const setCookie = initRes.headers.get("set-cookie") || "";
    cookie = setCookie.split(";")[0] || "";

    const baseHeaders = cookie ? { cookie } : {};

    let tweakStatus = null;
    let tweakBody = null;
    try {
      const tweakRes = await fetch(`${t.base}/api/digifabster-price-tweak?_vercel_share=${t.share}`, {
        method: "GET",
        headers: baseHeaders,
      });
      const tweakParsed = await parseJsonSafe(tweakRes);
      tweakStatus = tweakRes.status;
      tweakBody = tweakParsed.json || tweakParsed.text;
    } catch (err) {
      tweakStatus = "network_error";
      tweakBody = String(err?.message || err);
    }

    let convStatus = null;
    let convBody = null;
    try {
      const convRes = await fetch(`${t.base}/api/conversion-status?_vercel_share=${t.share}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...baseHeaders,
        },
        body: JSON.stringify({
          urn,
          client_id,
          client_secret,
          quoteTarget: "step",
          part_id: "probe",
          version: "live",
        }),
      });
      const convParsed = await parseJsonSafe(convRes);
      convStatus = convRes.status;
      convBody = convParsed.json || convParsed.text;
    } catch (err) {
      convStatus = "network_error";
      convBody = String(err?.message || err);
    }

    rows.push({
      target: t.name,
      base: t.base,
      tweakStatus,
      tweakBody,
      convStatus,
      convBody,
    });
  }

  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
