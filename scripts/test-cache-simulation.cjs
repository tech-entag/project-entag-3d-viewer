/**
 * Simulate the cached pricing flow locally (calls DigiFabster directly).
 * Demonstrates: 1st call fetches + strips, 2nd call reuses cached objects.
 * Vercel Blob cache only works in production — this tests the logic in-memory.
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
  for (const [k, v] of Object.entries(obj)) if (!keys.has(k)) out[k] = v;
  return out;
};

const jsonFetch = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: { accept: "application/json", "content-type": "application/json", ...opts.headers },
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
};

/** Simulated in-memory cache (stands in for Vercel Blob in production) */
const CACHE = new Map();

const getCached = (techSlug, machineId, materialId) => {
  const key = `${techSlug}/${machineId}/${materialId}`;
  return CACHE.get(key) || null;
};

const putCached = (record) => {
  const key = `${record.technologySlug}/${record.machineId}/${record.materialId}`;
  CACHE.set(key, { ...record, storedAt: new Date().toISOString() });
};

/**
 * Simulates the route POST handler — returns { fromCache, elapsed, nakedPrice, ppItems }.
 */
const priceTweakerCall = async (authHeaders, {
  objectModelId, machineId, materialId, techSlug, priceConfigOverrides = {}, skipCache = false,
}) => {
  const start = Date.now();
  let fromCache = false;
  let machine, material, tolerances, priorities, postproduction;

  // 1. Check cache
  if (!skipCache) {
    const cached = getCached(techSlug, machineId, materialId);
    if (cached) {
      machine = cached.machine;
      material = cached.material;
      tolerances = cached.tolerances;
      priorities = cached.priorities;
      postproduction = cached.postproduction;
      fromCache = true;
    }
  }

  // 2. Fetch on cache miss
  if (!machine) {
    const machRes = await jsonFetch(`${BASE}/v2/machines/${techSlug}/${machineId}/`, { headers: authHeaders });
    if (!machRes.ok) throw new Error(`Machine fetch failed: ${machRes.status}`);
    const raw = machRes.data;
    tolerances = raw.tolerances || [];
    priorities = raw.priorities || [];
    machine = stripKeys(raw, MACHINE_STRIP);
  }
  if (!material) {
    const matRes = await jsonFetch(`${BASE}/v2/materials/${techSlug}/${materialId}/`, { headers: authHeaders });
    if (!matRes.ok) throw new Error(`Material fetch failed: ${matRes.status}`);
    const raw = matRes.data;
    postproduction = raw.postproduction || [];
    material = stripKeys(raw, MATERIAL_STRIP);
  }

  // 3. Cache the result
  if (!fromCache) {
    putCached({
      technologySlug: techSlug, machineId, materialId,
      machine, material, tolerances, priorities, postproduction,
    });
  }

  // 4. Build price_config
  const priceConfig = {
    tolerance: tolerances[0]?.id,
    lead_time: priorities[0]?.id,
    is_non_recurring_cost_included: true,
    count: 1,
    ...priceConfigOverrides,
  };

  // 5. Call price_tweaker
  const res = await jsonFetch(`${BASE}/v2/price_tweaker/${techSlug}/`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      price_config: priceConfig,
      object_model_id: objectModelId,
      printer: machine,
      material,
    }),
  });

  const elapsed = Date.now() - start;
  const prices = res.data?.data?.prices || {};
  const ppPrices = res.data?.data?.post_production_prices || [];

  return {
    fromCache,
    elapsed,
    nakedPrice: prices.naked_price,
    totalPerPart: prices.total_per_part_price,
    ppItems: ppPrices.length,
    tolerancesAvail: tolerances.length,
    prioritiesAvail: priorities.length,
    postproductionAvail: postproduction?.length || 0,
  };
};

(async () => {
  const apiKey = process.env.DIGIFABSTER_API_KEY || process.env.DIGIFABSTER_API_TOKEN;
  if (!apiKey) { console.error("Missing DIGIFABSTER_API_KEY"); process.exit(1); }

  const tokenRes = await jsonFetch(`${BASE}/v2/obtain_s2s_token/`, {
    method: "POST", body: JSON.stringify({ api_key: apiKey }),
  });
  const authHeaders = { authorization: `Token ${tokenRes.data.token}` };

  const baseArgs = { objectModelId: MODEL_ID, machineId: MACHINE_ID, materialId: MATERIAL_ID, techSlug: TECH_SLUG };

  console.log("=== Cached Pricing Flow Simulation ===\n");

  // Call 1: COLD — fetches machine + material
  const r1 = await priceTweakerCall(authHeaders, baseArgs);
  console.log(`1. COLD  | ${r1.elapsed}ms | cache=${r1.fromCache} | price=$${r1.nakedPrice} | tols=${r1.tolerancesAvail} pris=${r1.prioritiesAvail} pp=${r1.postproductionAvail}`);

  // Call 2: WARM — reuses cached machine + material (only price_tweaker POST)
  const r2 = await priceTweakerCall(authHeaders, baseArgs);
  console.log(`2. WARM  | ${r2.elapsed}ms | cache=${r2.fromCache} | price=$${r2.nakedPrice}`);

  // Call 3: WARM + different tolerance
  const cached = getCached(TECH_SLUG, MACHINE_ID, MATERIAL_ID);
  const fineTol = cached?.tolerances?.[1]?.id;
  if (fineTol) {
    const r3 = await priceTweakerCall(authHeaders, { ...baseArgs, priceConfigOverrides: { tolerance: fineTol } });
    console.log(`3. WARM+ | ${r3.elapsed}ms | cache=${r3.fromCache} | price=$${r3.nakedPrice} (fine tolerance)`);
  }

  // Call 4: WARM + different count
  const r4 = await priceTweakerCall(authHeaders, { ...baseArgs, priceConfigOverrides: { count: 5 } });
  console.log(`4. WARM  | ${r4.elapsed}ms | cache=${r4.fromCache} | price=$${r4.nakedPrice} (count=5)`);

  // Call 5: skipCache — forces fresh fetch even though cached
  const r5 = await priceTweakerCall(authHeaders, { ...baseArgs, skipCache: true });
  console.log(`5. FORCE | ${r5.elapsed}ms | cache=${r5.fromCache} | price=$${r5.nakedPrice} (skipCache=true)`);

  // Summary
  const speedup = r1.elapsed > 0 ? ((r1.elapsed - r2.elapsed) / r1.elapsed * 100).toFixed(0) : "N/A";
  console.log(`\n--- Summary ---`);
  console.log(`Cold: ${r1.elapsed}ms (2 GETs + 1 POST)`);
  console.log(`Warm: ${r2.elapsed}ms (0 GETs + 1 POST)`);
  console.log(`Speedup: ~${speedup}% faster on cache hit`);
  console.log(`Prices consistent: ${r1.nakedPrice === r2.nakedPrice ? "YES" : "NO"}`);

  console.log("\n=== DONE ===");
})();
