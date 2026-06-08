const base = "https://project-entag-3d-viewer.vercel.app/api/digifabster-price-tweak?x-vercel-protection-bypass=qlQfStfLPXLfXBliB9xoS9FQFjMxys1V";
const tests = [
  {
    name: "CNC + 42CrMo4",
    body: {
      objectModelId: 4287635,
      machine: "CNC Machining",
      material: "42CrMo4 / 1.7225",
      count: 1,
      tightest_tolerance: null,
      inspection: null,
      roughness: null,
      finish: null
    }
  },
  {
    name: "Sheet + Aluminium 5083",
    body: {
      objectModelId: 4287635,
      machine: "Sheet metal fabrication",
      material: "Aluminium 5083",
      count: 1,
      tightest_tolerance: null,
      inspection: null,
      roughness: null,
      finish: null
    }
  }
];
(async () => {
  for (const t of tests) {
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t.body) });
    const txt = await r.text();
    console.log("TEST", t.name);
    console.log("STATUS", r.status);
    console.log("BODY", txt.slice(0, 600));
    console.log("---");
  }
})();
