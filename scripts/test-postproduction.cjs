/**
 * Test post-production inclusion in price_tweaker payload.
 * Tests: selected_postproduction in price_config vs material.postproduction toggling.
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
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
};

const priceCall = async (authHeaders, payload, label) => {
  const res = await jsonFetch(`${BASE}/v2/price_tweaker/${TECH_SLUG}/`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(payload),
  });
  const prices = res.data?.data?.prices || {};
  const pp = res.data?.data?.post_production_prices || [];
  const ppActive = pp.filter(p => p.price > 0);
  console.log(`  [${label}] ${res.status} → naked=$${prices.naked_price}, pp_items=${ppActive.length}, pp_prices=[${ppActive.map(p => p.uuid.slice(0,8)+'=$'+p.price).join(', ')}]`);
  return res.data;
};

(async () => {
  const apiKey = process.env.DIGIFABSTER_API_KEY || process.env.DIGIFABSTER_API_TOKEN;
  if (!apiKey) { console.error("Missing env"); process.exit(1); }

  const tokenRes = await jsonFetch(`${BASE}/v2/obtain_s2s_token/`, {
    method: "POST", body: JSON.stringify({ api_key: apiKey }),
  });
  const authHeaders = { authorization: `Token ${tokenRes.data.token}` };

  const machRes = await jsonFetch(`${BASE}/v2/machines/${TECH_SLUG}/${MACHINE_ID}/`, { headers: authHeaders });
  const matRes = await jsonFetch(`${BASE}/v2/materials/${TECH_SLUG}/${MATERIAL_ID}/`, { headers: authHeaders });

  const cleanMachine = stripKeys(machRes.data, MACHINE_STRIP);
  const cleanMaterial = stripKeys(matRes.data, MATERIAL_STRIP);
  const tolerances = machRes.data.tolerances || [];
  const priorities = machRes.data.priorities || [];

  const basePriceConfig = {
    tolerance: tolerances[0]?.id,
    lead_time: priorities[0]?.id,
    is_non_recurring_cost_included: true,
    count: 1,
  };

  const basePayload = {
    price_config: basePriceConfig,
    object_model_id: MODEL_ID,
    printer: cleanMachine,
    material: cleanMaterial,
  };

  const ppOptions = matRes.data.postproduction || [];
  const polishing = ppOptions.find(p => p.title === "Polishing");
  const heatTreating = ppOptions.find(p => p.title === "Heat Treating");
  const cmm = ppOptions.find(p => p.title === "CMM");
  const smoothRa = ppOptions.find(p => p.title.includes("1.6um"));

  console.log("=== Post-Production Pricing Tests ===\n");

  // Baseline
  console.log("1. Baseline (no PP selected):");
  await priceCall(authHeaders, basePayload, "baseline");

  // Try: selected_postproduction in price_config
  if (polishing) {
    console.log("\n2. selected_postproduction: [Polishing]");
    await priceCall(authHeaders, {
      ...basePayload,
      price_config: { ...basePriceConfig, selected_postproduction: [polishing.id] },
    }, "pp-polishing");
  }

  if (heatTreating) {
    console.log("\n3. selected_postproduction: [Heat Treating]");
    await priceCall(authHeaders, {
      ...basePayload,
      price_config: { ...basePriceConfig, selected_postproduction: [heatTreating.id] },
    }, "pp-heat");
  }

  if (cmm) {
    console.log("\n4. selected_postproduction: [CMM] ($1000/model):");
    await priceCall(authHeaders, {
      ...basePayload,
      price_config: { ...basePriceConfig, selected_postproduction: [cmm.id] },
    }, "pp-cmm");
  }

  if (smoothRa) {
    console.log("\n5. selected_postproduction: [Smooth 1.6um Ra]:");
    await priceCall(authHeaders, {
      ...basePayload,
      price_config: { ...basePriceConfig, selected_postproduction: [smoothRa.id] },
    }, "pp-smooth");
  }

  // Multiple PP
  if (polishing && heatTreating && cmm) {
    console.log("\n6. Multiple PP: [Polishing + Heat Treating + CMM]:");
    await priceCall(authHeaders, {
      ...basePayload,
      price_config: { ...basePriceConfig, selected_postproduction: [polishing.id, heatTreating.id, cmm.id] },
    }, "pp-multi");
  }

  // Combined: tighter tolerance + PP
  if (tolerances.length > 1 && polishing) {
    console.log("\n7. Tighter tolerance + Polishing:");
    await priceCall(authHeaders, {
      ...basePayload,
      price_config: {
        ...basePriceConfig,
        tolerance: tolerances[1].id,
        selected_postproduction: [polishing.id],
      },
    }, "tol+pp");
  }

  // Different material with PP
  console.log("\n8. Testing different material + PP...");
  // Fetch list to find alt material
  const mmRes = await jsonFetch(`${BASE}/v2/machines_materials/`, { headers: authHeaders });
  const techEntry = (mmRes.data || []).find(t => t.slug === TECH_SLUG);
  const curMachine = techEntry?.machines?.find(m => m.id === MACHINE_ID);
  const altMatSummary = curMachine?.materials?.find(m => m.id !== MATERIAL_ID);
  if (altMatSummary) {
    const altMatRes = await jsonFetch(`${BASE}/v2/materials/${TECH_SLUG}/${altMatSummary.id}/`, { headers: authHeaders });
    if (altMatRes.ok) {
      const cleanAltMat = stripKeys(altMatRes.data, MATERIAL_STRIP);
      const altPP = altMatRes.data.postproduction || [];
      console.log(`   Alt material: ${altMatRes.data.title} (${altPP.length} PP options)`);
      await priceCall(authHeaders, {
        price_config: basePriceConfig,
        object_model_id: MODEL_ID,
        printer: cleanMachine,
        material: cleanAltMat,
      }, "alt-mat");

      if (altPP.length > 0) {
        await priceCall(authHeaders, {
          price_config: { ...basePriceConfig, selected_postproduction: [altPP[0].id] },
          object_model_id: MODEL_ID,
          printer: cleanMachine,
          material: cleanAltMat,
        }, "alt-mat+pp");
      }
    }
  }

  console.log("\n=== DONE ===");
})();
