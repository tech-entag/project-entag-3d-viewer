/**
 * Trace the full DigiFabster price_tweaker flow:
 *   1. Exchange API key for S2S token
 *   2. GET /v2/machines_materials/
 *   3. GET /v2/users/models/?id={modelId}
 *   4. GET /v2/materials/{tech}/{materialId}/
 *   5. GET /v2/machines/{tech}/{machineId}/
 *   6. POST /v2/price_tweaker/{tech}/
 *
 * Usage:
 *   node scripts/trace-price-tweaker-flow.cjs
 *
 * Env (or hardcoded below for testing):
 *   DIGIFABSTER_API_KEY
 */

const BASE = "https://digifabster.com";

// Known IDs from the user's browser trace
const MODEL_ID = 4287635;
const TECH_SLUG = "3-axis-milling";
const MATERIAL_ID = 72325;
const MACHINE_ID = 44270;

const step = (n, label) => console.log(`\n${"=".repeat(60)}\n  Step ${n}: ${label}\n${"=".repeat(60)}`);

const jsonFetch = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text.slice(0, 3000) };
  }
  return { status: res.status, ok: res.ok, data };
};

const summarize = (obj, maxKeys = 15) => {
  if (Array.isArray(obj)) return `[Array length=${obj.length}]`;
  if (typeof obj !== "object" || !obj) return obj;
  const keys = Object.keys(obj);
  const display = {};
  for (const k of keys.slice(0, maxKeys)) {
    const v = obj[k];
    if (Array.isArray(v)) display[k] = `[Array length=${v.length}]`;
    else if (typeof v === "object" && v !== null) display[k] = `{Object keys=${Object.keys(v).length}}`;
    else display[k] = v;
  }
  if (keys.length > maxKeys) display["..."] = `(${keys.length - maxKeys} more keys)`;
  return display;
};

(async () => {
  // Step 1: Token exchange
  step(1, "Exchange API key → S2S token");
  const apiKey = process.env.DIGIFABSTER_API_KEY || process.env.DIGIFABSTER_API_TOKEN || "";
  if (!apiKey) {
    console.error("ERROR: Set DIGIFABSTER_API_KEY env var");
    process.exit(1);
  }
  const tokenRes = await jsonFetch(`${BASE}/v2/obtain_s2s_token/`, {
    method: "POST",
    body: JSON.stringify({ api_key: apiKey }),
  });
  console.log("Status:", tokenRes.status);
  if (!tokenRes.ok || !tokenRes.data.token) {
    console.error("Token exchange failed:", tokenRes.data);
    process.exit(1);
  }
  const token = tokenRes.data.token;
  console.log("Token obtained:", token.slice(0, 8) + "...");
  const authHeaders = { authorization: `Token ${token}` };

  // Step 2: machines_materials
  step(2, "GET /v2/machines_materials/");
  const mmRes = await jsonFetch(`${BASE}/v2/machines_materials/`, { headers: authHeaders });
  console.log("Status:", mmRes.status);
  if (Array.isArray(mmRes.data)) {
    console.log(`Results: ${mmRes.data.length} entries`);
    for (const entry of mmRes.data.slice(0, 3)) {
      console.log(" -", summarize(entry));
    }
    if (mmRes.data.length > 3) console.log(`  ... and ${mmRes.data.length - 3} more`);
  } else {
    console.log("Response shape:", summarize(mmRes.data));
  }

  // Step 3: model info
  step(3, `GET /v2/users/models/?id=${MODEL_ID}`);
  const modelRes = await jsonFetch(`${BASE}/v2/users/models/?id=${MODEL_ID}`, { headers: authHeaders });
  console.log("Status:", modelRes.status);
  if (Array.isArray(modelRes.data)) {
    console.log(`Models returned: ${modelRes.data.length}`);
    for (const m of modelRes.data.slice(0, 2)) {
      console.log(" -", summarize(m));
    }
  } else {
    console.log("Response shape:", summarize(modelRes.data));
  }

  // Step 4: material detail
  step(4, `GET /v2/materials/${TECH_SLUG}/${MATERIAL_ID}/`);
  const matRes = await jsonFetch(`${BASE}/v2/materials/${TECH_SLUG}/${MATERIAL_ID}/`, { headers: authHeaders });
  console.log("Status:", matRes.status);
  console.log("Material shape:", summarize(matRes.data));

  // Step 5: machine detail
  step(5, `GET /v2/machines/${TECH_SLUG}/${MACHINE_ID}/`);
  const machRes = await jsonFetch(`${BASE}/v2/machines/${TECH_SLUG}/${MACHINE_ID}/`, { headers: authHeaders });
  console.log("Status:", machRes.status);
  console.log("Machine shape:", summarize(machRes.data));

  // Step 6: price_tweaker POST
  step(6, `POST /v2/price_tweaker/${TECH_SLUG}/`);
  if (!matRes.ok || !machRes.ok) {
    console.error("Cannot call price_tweaker — material or machine fetch failed");
    process.exit(1);
  }

  // Build the price_config from known defaults
  const machineData = machRes.data;
  const materialData = matRes.data;

  // Use first tolerance and first priority as defaults
  const firstTolerance = machineData.tolerances?.[0]?.id || null;
  const firstPriority = machineData.priorities?.[0]?.id || null;

  const priceConfig = {
    tolerance: firstTolerance,
    lead_time: firstPriority,
    is_non_recurring_cost_included: true,
    count: 1,
  };

  const priceTweakerPayload = {
    price_config: priceConfig,
    object_model_id: MODEL_ID,
    printer: machineData,
    material: materialData,
  };

  console.log("Payload keys:", Object.keys(priceTweakerPayload));
  console.log("price_config:", priceConfig);
  console.log("printer keys:", Object.keys(machineData).length);
  console.log("material keys:", Object.keys(materialData).length);

  const ptRes = await jsonFetch(`${BASE}/v2/price_tweaker/${TECH_SLUG}/`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(priceTweakerPayload),
  });
  console.log("Status:", ptRes.status);
  console.log("Response:", JSON.stringify(ptRes.data, null, 2).slice(0, 3000));

  // Write full responses for inspection
  const fs = require("fs");
  fs.writeFileSync(
    "trace-price-tweaker-result.json",
    JSON.stringify(
      {
        tokenExchange: { status: tokenRes.status },
        machinesMaterials: { status: mmRes.status, count: Array.isArray(mmRes.data) ? mmRes.data.length : null },
        model: { status: modelRes.status, data: modelRes.data },
        material: { status: matRes.status, data: matRes.data },
        machine: { status: machRes.status, data: machRes.data },
        priceTweaker: { status: ptRes.status, data: ptRes.data },
        payload: { price_config: priceConfig, object_model_id: MODEL_ID },
      },
      null,
      2
    )
  );
  console.log("\nFull trace saved to trace-price-tweaker-result.json");

  // Step 6b: Retry with filtered payload (strip read-only fields)
  step("6b", `POST /v2/price_tweaker/${TECH_SLUG}/ (filtered payload)`);
  
  // Fields from the browser's actual POST — strip `id`, `active`, `printer_name`, 
  // `material_preset`, `image`, `vendors`, `printer_preset` etc.
  const MACHINE_READ_ONLY = new Set(["id", "active", "printer_preset"]);
  const MATERIAL_READ_ONLY = new Set([
    "id", "active", "image", "printer_name", "material_preset",
    "display_name", "vendors", "sorting_priority", "note_for_user",
    "spec_sheet_url", "programming_cost_recurring",
  ]);

  const filterObj = (obj, readOnly) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!readOnly.has(k)) out[k] = v;
    }
    return out;
  };

  const filteredMachine = filterObj(machineData, MACHINE_READ_ONLY);
  const filteredMaterial = filterObj(materialData, MATERIAL_READ_ONLY);

  console.log("Filtered printer keys:", Object.keys(filteredMachine).length,
              "(removed:", Object.keys(machineData).length - Object.keys(filteredMachine).length, ")");
  console.log("Filtered material keys:", Object.keys(filteredMaterial).length,
              "(removed:", Object.keys(materialData).length - Object.keys(filteredMaterial).length, ")");

  const filteredPayload = {
    price_config: priceConfig,
    object_model_id: MODEL_ID,
    printer: filteredMachine,
    material: filteredMaterial,
  };

  const pt2Res = await jsonFetch(`${BASE}/v2/price_tweaker/${TECH_SLUG}/`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(filteredPayload),
  });
  console.log("Status:", pt2Res.status);
  console.log("Response:", JSON.stringify(pt2Res.data, null, 2).slice(0, 3000));

  // Update result
  fs.writeFileSync(
    "trace-price-tweaker-result.json",
    JSON.stringify(
      {
        tokenExchange: { status: tokenRes.status },
        machinesMaterials: { status: mmRes.status, count: Array.isArray(mmRes.data) ? mmRes.data.length : null },
        model: { status: modelRes.status, data: modelRes.data },
        material: { status: matRes.status, data: matRes.data },
        machine: { status: machRes.status, data: machRes.data },
        priceTweakerRaw: { status: ptRes.status },
        priceTweakerFiltered: { status: pt2Res.status, data: pt2Res.data },
        filteredPayload,
      },
      null,
      2
    )
  );
  console.log("\nFull trace saved to trace-price-tweaker-result.json");
})();
