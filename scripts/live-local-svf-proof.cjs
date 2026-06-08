const fs = require('fs');
const { chromium } = require('@playwright/test');

const BASE = 'https://project-entag-3d-viewer-hhsavg6tm-citizendevio.vercel.app';
const SHARE = 'hY3CLiJQaPVkd7AGWmliZ2EjkhrwIobA';
const MODEL_URL = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/stl/ascii/slotted_disk.stl';

function withShare(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${BASE}${path}${sep}_vercel_share=${SHARE}`;
}

async function postJson(path, body) {
  const response = await fetch(withShare(path), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(globalThis.__AUTH_COOKIE ? { cookie: globalThis.__AUTH_COOKIE } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return { ok: response.ok, status: response.status, data };
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function initProtectionCookie() {
  const response = await fetch(withShare('/'), {
    method: 'GET',
    redirect: 'manual',
  });

  const setCookie = response.headers.get('set-cookie') || '';
  const firstPair = setCookie.split(';')[0] || '';
  if (firstPair.startsWith('_vercel_jwt=')) {
    globalThis.__AUTH_COOKIE = firstPair;
  }
}

(async () => {
  await initProtectionCookie();

  const creds = fs.readFileSync('creds.txt', 'utf8').trim();
  const [client_id, client_secret] = creds.split(':', 2);

  if (!client_id || !client_secret) {
    throw new Error('creds.txt must be client_id:client_secret');
  }

  const upload = await postJson('/api/autodesk', {
    url: MODEL_URL,
    part_id: `svf-local-${Date.now()}`,
    version: 'live-proof',
    client_id,
    client_secret,
  });

  if (!upload.ok || !upload.data?.urn) {
    fs.writeFileSync('live-local-proof-upload.json', JSON.stringify(upload, null, 2));
    throw new Error(`Upload failed with status ${upload.status}`);
  }

  const urn = upload.data.urn;
  let last = null;

  for (let i = 0; i < 40; i += 1) {
    const status = await postJson('/api/conversion-status', {
      urn,
      client_id,
      client_secret,
    });

    last = status;
    const viewer = status.data?.viewer || {};
    const localModelUrl = viewer.localModelUrl || viewer.bubbleUrl || null;

    console.log(`[poll ${i + 1}] viewer.status=${viewer.status} mode=${viewer.mode} local=${localModelUrl ? 'yes' : 'no'} err=${viewer.localError ? 'yes' : 'no'}`);

    if (status.ok && viewer.status === 'success' && viewer.mode === 'local' && localModelUrl) {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(withShare(`/viewer?localModelUrl=${encodeURIComponent(localModelUrl)}`), {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
      });

      await page.waitForTimeout(30000);

      const canvasCount = await page.locator('canvas').count();
      const modalError = await page.locator('.adsk-viewing-viewer .adsk-viewing-viewer-error').count();

      await page.screenshot({ path: 'live-local-viewer-proof.png', fullPage: true });
      await browser.close();

      const result = {
        urn,
        localModelUrl,
        viewer,
        canvasCount,
        modalError,
        screenshot: 'live-local-viewer-proof.png',
      };

      fs.writeFileSync('live-local-proof-result.json', JSON.stringify(result, null, 2));
      console.log('PROOF_SUCCESS');
      return;
    }

    await delay(15000);
  }

  fs.writeFileSync('live-local-proof-last.json', JSON.stringify(last, null, 2));
  throw new Error('Timed out waiting for local viewer readiness');
})().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
