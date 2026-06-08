const body = { objectModelId: 4287635, machineId: 44270, materialId: 72325, count: 1, tightest_tolerance: null, inspection: null, roughness: null, finish: null };
const urls = [
  "https://project-entag-3d-viewer-mbhk1w473-citizendevio.vercel.app/api/digifabster-price-tweak?x-vercel-protection-bypass=qlQfStfLPXLfXBliB9xoS9FQFjMxys1V",
  "https://project-entag-3d-viewer-mjpco8yq0-citizendevio.vercel.app/api/digifabster-price-tweak?x-vercel-protection-bypass=qlQfStfLPXLfXBliB9xoS9FQFjMxys1V"
];
(async () => {
  for (const url of urls) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const t = await r.text();
    console.log("URL", url);
    console.log("STATUS", r.status);
    console.log("BODY", t.slice(0, 600));
    console.log("---");
  }
})().catch((e)=>{console.error(e);process.exit(1);});
