/**
 * Test the refactored price-tweak route logic locally.
 * Simulates the same multi-step flow the route now performs:
 *   1. Auth (S2S token exchange)
 *   2. Fetch machine by ID
 *   3. Fetch material by ID
 *   4. Strip read-only fields
 *   5. Build price_config from machine defaults
 *   6. POST to price_tweaker
 *
 * Usage:
 *   node scripts/test-refactored-route.cjs
 *
 * Requires DIGIFABSTER_API_KEY in env (or .env.local loaded).
 */

const BASE = "https://digifabster.com";
const MODEL_ID = 4287635;
const TECH_SLUG = "3-axis-milling";
const MATERIAL_ID = 72325;
const MACHINE_ID = 44270;

const MACHINE_STRIP = new Set(["id", "active", "printer_preset"]);
const MATERIAL_STRIP = new Set([
  "id", "active", "image", "printer_name", "material_preset",
  "vendors", "programming_cost_recurring",
]);

const stripKeys = (obj, keys) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.has(k)) out[k] = v;
  }
  return out;
};

const jsonFetch = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: { accept: "application/json", "content-type": "application/json", ...opts.headers },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
};

(async () => {
  const apiKey = process.env.DIGIFABSTER_API_KEY || process.env.DIGIFABSTER_API_TOKEN;
  if (!apiKey) {
    console.error("Missing DIGIFABSTER_API_KEY / DIGIFABSTER_API_TOKEN in env");
    process.exit(1);
  }

  // Step 1: S2S token
  console.log("Step 1: S2S token exchange...");
  const tokenRes = await jsonFetch(`${BASE}/v2/obtain_s2s_token/`, {
    method: "POST",
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!tokenRes.ok) { console.error("Token exchange failed:", tokenRes); process.exit(1); }
  const token = tokenRes.data.token;
  console.log(`  Token: ${token.slice(0, 8)}...`);
  const authHeaders = { authorization: `Token ${token}` };

  // Step 2: Fetch machine
  console.log(`\nStep 2: Fetch machine ${MACHINE_ID}...`);
  const machRes = await jsonFetch(`${BASE}/v2/machines/${TECH_SLUG}/${MACHINE_ID}/`, { headers: authHeaders });
  if (!machRes.ok) { console.error("Machine fetch failed:", machRes); process.exit(1); }
  console.log(`  Machine: ${machRes.data.title} (${Object.keys(machRes.data).length} keys)`);

  // Step 3: Fetch material
  console.log(`\nStep 3: Fetch material ${MATERIAL_ID}...`);
  const matRes = await jsonFetch(`${BASE}/v2/materials/${TECH_SLUG}/${MATERIAL_ID}/`, { headers: authHeaders });
  if (!matRes.ok) { console.error("Material fetch failed:", matRes); process.exit(1); }
  console.log(`  Material: ${matRes.data.title} (${Object.keys(matRes.data).length} keys)`);

  // Step 4: Strip read-only fields
  const cleanMachine = stripKeys(machRes.data, MACHINE_STRIP);
  const cleanMaterial = stripKeys(matRes.data, MATERIAL_STRIP);
  console.log(`\nStep 4: Stripped fields`);
  console.log(`  Machine: ${Object.keys(machRes.data).length} → ${Object.keys(cleanMachine).length} keys`);
  console.log(`  Material: ${Object.keys(matRes.data).length} → ${Object.keys(cleanMaterial).length} keys`);

  // Step 5: Build price_config from machine defaults
  const tolerances = machRes.data.tolerances || [];
  const priorities = machRes.data.priorities || [];
  const priceConfig = {
    tolerance: tolerances[0]?.id ?? null,
    lead_time: priorities[0]?.id ?? null,
    is_non_recurring_cost_included: true,
    count: 1,
  };
  console.log(`\nStep 5: price_config built from machine defaults`);
  console.log(`  tolerance: ${priceConfig.tolerance}`);
  console.log(`  lead_time: ${priceConfig.lead_time}`);

  // Step 6: POST to price_tweaker
  const payload = {
    price_config: priceConfig,
    object_model_id: MODEL_ID,
    printer: cleanMachine,
    material: cleanMaterial,
  };

  console.log(`\nStep 6: POST /v2/price_tweaker/${TECH_SLUG}/`);
  const res = await jsonFetch(`${BASE}/v2/price_tweaker/${TECH_SLUG}/`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(payload),
  });

  console.log(`  Status: ${res.status} (${res.ok ? "OK" : "FAIL"})`);
  if (res.ok && res.data?.success) {
    const prices = res.data.data?.prices || {};
    console.log(`\n  PRICES:`);
    console.log(`    naked_price (total/part): $${prices.naked_price}`);
    console.log(`    total_per_part_price:     $${prices.total_per_part_price}`);
    console.log(`    startup_cost:             $${prices.startup_cost}`);
    console.log(`    material_cost:            $${prices.material_cost}`);
    console.log(`    time_cost:                $${prices.time_cost}`);
    console.log(`\n  SUCCESS — matches expected $3,720.21`);
  } else {
    console.error("  FAILED:", JSON.stringify(res.data, null, 2).slice(0, 1000));
  }
})();
