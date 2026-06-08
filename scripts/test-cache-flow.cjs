/**
 * Test the cached pricing flow:
 * 1. First call (cache miss) — fetches machine + material, caches, returns price
 * 2. Second call (cache hit) — skips fetch, reuses cached objects, returns price
 * 3. Third call with different tolerance — cache hit + config change
 * 4. Fourth call with skipCache — forces fresh fetch
 *
 * Run against local dev or deployed Vercel.
 */

const LOCAL = process.env.BASE_URL || "http://localhost:5173";
const MODEL_ID = 4287635;
const MACHINE_ID = 44270;
const MATERIAL_ID = 72325;

const jsonPost = async (url, body, label) => {
  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - start;
  const data = await res.json();

  const prices = data.result?.data?.prices || {};
  console.log(`\n[${label}] ${res.status} in ${elapsed}ms`);
  console.log(`  fromCache: ${data.fromCache}`);
  console.log(`  naked_price: $${prices.naked_price}`);
  console.log(`  total_per_part: $${prices.total_per_part_price}`);
  if (data.availableOptions) {
    console.log(`  tolerances: ${data.availableOptions.tolerances?.length}`);
    console.log(`  priorities: ${data.availableOptions.priorities?.length}`);
    console.log(`  postproduction: ${data.availableOptions.postproduction?.length}`);
  }
  return data;
};

(async () => {
  const endpoint = `${LOCAL}/api/digifabster-price-tweak`;
  console.log(`=== Cache Flow Test against ${endpoint} ===`);

  // 1. First call — cache miss
  const r1 = await jsonPost(endpoint, {
    objectModelId: MODEL_ID,
    machineId: MACHINE_ID,
    materialId: MATERIAL_ID,
  }, "1-COLD (cache miss)");

  // Grab tolerance UUIDs from response
  const tols = r1.availableOptions?.tolerances || [];
  console.log(`\n  Available tolerances: ${tols.map(t => t.name + ' (margin:' + t.margin + ')').join(', ')}`);

  // 2. Second call — same IDs → should be cache hit
  const r2 = await jsonPost(endpoint, {
    objectModelId: MODEL_ID,
    machineId: MACHINE_ID,
    materialId: MATERIAL_ID,
  }, "2-WARM (cache hit expected)");

  // 3. Third call — different tolerance via priceConfig
  if (tols.length > 1) {
    const r3 = await jsonPost(endpoint, {
      objectModelId: MODEL_ID,
      machineId: MACHINE_ID,
      materialId: MATERIAL_ID,
      priceConfig: {
        tolerance: tols[1].id,
      },
    }, "3-WARM + Fine tolerance");
  }

  // 4. Fourth call — skipCache = true
  const r4 = await jsonPost(endpoint, {
    objectModelId: MODEL_ID,
    machineId: MACHINE_ID,
    materialId: MATERIAL_ID,
    skipCache: true,
  }, "4-FORCED FRESH (skipCache=true)");

  // 5. Fifth call — confirm cache was refreshed
  const r5 = await jsonPost(endpoint, {
    objectModelId: MODEL_ID,
    machineId: MACHINE_ID,
    materialId: MATERIAL_ID,
  }, "5-WARM (after refresh)");

  console.log("\n=== DONE ===");
})();
