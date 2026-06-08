const url = "https://project-entag-3d-viewer.vercel.app/api/digifabster-price-tweak?x-vercel-protection-bypass=qlQfStfLPXLfXBliB9xoS9FQFjMxys1V";
const body = { objectModelId: 4287635, machineId: 44270, materialId: 72325, count: 1, tightest_tolerance: null, inspection: null, roughness: null, finish: null };
fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => {
    const t = await r.text();
    console.log("STATUS", r.status);
    console.log(t);
  })
  .catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
  });
