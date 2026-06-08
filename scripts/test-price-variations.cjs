/**
 * Explore available pricing options from cached machine/material data,
 * then test price_tweaker with various config changes.
 *
 * Usage:
 *   node scripts/test-price-variations.cjs
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

const priceCall = async (authHeaders, cleanMachine, cleanMaterial, priceConfig, label) => {
  const payload = {
    price_config: priceConfig,
    object_model_id: MODEL_ID,
    printer: cleanMachine,
    material: cleanMaterial,
  };
  const res = await jsonFetch(`${BASE}/v2/price_tweaker/${TECH_SLUG}/`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(payload),
  });
  const prices = res.data?.data?.prices || {};
  const pp = res.data?.data?.post_production_prices || {};
  console.log(`  [${label}] ${res.status} → naked_price=$${prices.naked_price || 'N/A'}, total=$${prices.total_per_part_price || 'N/A'}, pp_total=$${pp.total_price ?? 'N/A'}`);
  return { ok: res.ok, prices, pp, raw: res.data };
};

(async () => {
  const apiKey = process.env.DIGIFABSTER_API_KEY || process.env.DIGIFABSTER_API_TOKEN;
  if (!apiKey) { console.error("Missing DIGIFABSTER_API_KEY"); process.exit(1); }

  // Auth
  const tokenRes = await jsonFetch(`${BASE}/v2/obtain_s2s_token/`, {
    method: "POST", body: JSON.stringify({ api_key: apiKey }),
  });
  const token = tokenRes.data.token;
  const authHeaders = { authorization: `Token ${token}` };

  // Fetch machine
  const machRes = await jsonFetch(`${BASE}/v2/machines/${TECH_SLUG}/${MACHINE_ID}/`, { headers: authHeaders });
  const machRaw = machRes.data;
  const cleanMachine = stripKeys(machRaw, MACHINE_STRIP);

  // Fetch material
  const matRes = await jsonFetch(`${BASE}/v2/materials/${TECH_SLUG}/${MATERIAL_ID}/`, { headers: authHeaders });
  const matRaw = matRes.data;
  const cleanMaterial = stripKeys(matRaw, MATERIAL_STRIP);

  // Discover options
  console.log("============ AVAILABLE OPTIONS ============");

  console.log("\nTOLERANCES:");
  (machRaw.tolerances || []).forEach((t, i) =>
    console.log(`  [${i}] ${t.id} → ${t.title} (markup: ${t.markup}%)`)
  );

  console.log("\nPRIORITIES (lead times):");
  (machRaw.priorities || []).forEach((p, i) =>
    console.log(`  [${i}] ${p.id} → ${p.title} (markup: ${p.markup}%)`)
  );

  console.log("\nPOST-PRODUCTION options (from machine):");
  (machRaw.post_production || []).forEach((pp, i) =>
    console.log(`  [${i}] id=${pp.id} → ${pp.title || pp.name} (price: ${pp.price ?? 'N/A'})`)
  );
  
  console.log("\nMATERIAL post_production:");
  (matRaw.post_production || []).forEach((pp, i) =>
    console.log(`  [${i}] id=${pp.id} → ${pp.title || pp.name} (type: ${pp.post_production_type})`)
  );

  console.log("\nMACHINE extra fields:");
  console.log("  hardness:", machRaw.hardness);
  console.log("  min_wall_thickness:", machRaw.min_wall_thickness);
  console.log("  min_detail_size:", machRaw.min_detail_size);
  console.log("  infill keys:", Object.keys(machRaw).filter(k => k.includes("infill") || k.includes("fill")));

  // Fetch available materials to try a different one
  console.log("\nAVAILABLE MATERIALS for 3-axis-milling:");
  const mmRes = await jsonFetch(`${BASE}/v2/machines_materials/`, { headers: authHeaders });
  const techEntry = (mmRes.data || []).find(t => t.slug === TECH_SLUG);
  if (techEntry?.machines) {
    const curMachine = techEntry.machines.find(m => m.id === MACHINE_ID);
    if (curMachine?.materials) {
      curMachine.materials.slice(0, 10).forEach(mat =>
        console.log(`  id=${mat.id} → ${mat.title}`)
      );
      console.log(`  ... (${curMachine.materials.length} total)`);
    }
  }

  // Default config
  const tolerances = machRaw.tolerances || [];
  const priorities = machRaw.priorities || [];
  const basePriceConfig = {
    tolerance: tolerances[0]?.id,
    lead_time: priorities[0]?.id,
    is_non_recurring_cost_included: true,
    count: 1,
  };

  console.log("\n============ PRICE VARIATION TESTS ============\n");

  // Test 1: Baseline
  console.log("Test 1: Baseline (default tolerance, default lead time, count=1)");
  const baseline = await priceCall(authHeaders, cleanMachine, cleanMaterial, basePriceConfig, "baseline");

  // Test 2: Different tolerance (if more exist)
  if (tolerances.length > 1) {
    console.log(`\nTest 2: Tighter tolerance [1] → ${tolerances[1].title}`);
    await priceCall(authHeaders, cleanMachine, cleanMaterial,
      { ...basePriceConfig, tolerance: tolerances[1].id }, "tolerance-1");
  }

  if (tolerances.length > 2) {
    console.log(`\nTest 2b: Tightest tolerance [2] → ${tolerances[2].title}`);
    await priceCall(authHeaders, cleanMachine, cleanMaterial,
      { ...basePriceConfig, tolerance: tolerances[2].id }, "tolerance-2");
  }

  // Test 3: Different lead time
  if (priorities.length > 1) {
    console.log(`\nTest 3: Faster lead time [1] → ${priorities[1].title}`);
    await priceCall(authHeaders, cleanMachine, cleanMaterial,
      { ...basePriceConfig, lead_time: priorities[1].id }, "lead-time-1");
  }

  // Test 4: Higher quantity
  console.log("\nTest 4: count=5");
  await priceCall(authHeaders, cleanMachine, cleanMaterial,
    { ...basePriceConfig, count: 5 }, "count-5");

  console.log("\nTest 4b: count=10");
  await priceCall(authHeaders, cleanMachine, cleanMaterial,
    { ...basePriceConfig, count: 10 }, "count-10");

  // Test 5: Include post-production
  const ppOptions = matRaw.post_production || machRaw.post_production || [];
  if (ppOptions.length > 0) {
    console.log(`\nTest 5: With post-production option [0] → ${ppOptions[0].title || ppOptions[0].name}`);
    const ppConfig = { ...basePriceConfig, post_production: [ppOptions[0].id] };
    await priceCall(authHeaders, cleanMachine, cleanMaterial, ppConfig, "post-prod-0");
  }

  // Test 6: Different material (fetch 2nd material if available)
  if (techEntry?.machines) {
    const curMachine = techEntry.machines.find(m => m.id === MACHINE_ID);
    const altMat = curMachine?.materials?.find(m => m.id !== MATERIAL_ID);
    if (altMat) {
      console.log(`\nTest 6: Different material → ${altMat.title} (id=${altMat.id})`);
      const altMatRes = await jsonFetch(
        `${BASE}/v2/materials/${TECH_SLUG}/${altMat.id}/`, { headers: authHeaders }
      );
      if (altMatRes.ok) {
        const cleanAltMat = stripKeys(altMatRes.data, MATERIAL_STRIP);
        await priceCall(authHeaders, cleanMachine, cleanAltMat, basePriceConfig, "alt-material");
      }
    }
  }

  // Test 7: non-recurring cost disabled
  console.log("\nTest 7: is_non_recurring_cost_included = false");
  await priceCall(authHeaders, cleanMachine, cleanMaterial,
    { ...basePriceConfig, is_non_recurring_cost_included: false }, "no-nrc");

  // Test 8: Combined: tighter tolerance + faster lead + qty 3
  if (tolerances.length > 1 && priorities.length > 1) {
    console.log("\nTest 8: Combined (tighter tol + faster lead + qty 3)");
    await priceCall(authHeaders, cleanMachine, cleanMaterial, {
      tolerance: tolerances[1].id,
      lead_time: priorities[1].id,
      is_non_recurring_cost_included: true,
      count: 3,
    }, "combined");
  }

  console.log("\n============ DONE ============");
})();
