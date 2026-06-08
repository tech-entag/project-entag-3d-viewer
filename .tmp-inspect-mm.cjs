const url = "https://project-entag-3d-viewer-6p9wh92rs-citizendevio.vercel.app/api/digifabster-price-tweak?x-vercel-protection-bypass=qlQfStfLPXLfXBliB9xoS9FQFjMxys1V";
fetch(url)
  .then(async (r) => {
    const data = await r.json();
    const mm = Array.isArray(data?.machinesMaterials) ? data.machinesMaterials : [];
    console.log('status', r.status, 'rows', mm.length);
    for (let i = 0; i < Math.min(3, mm.length); i++) {
      const row = mm[i];
      console.log('ROW', i, Object.keys(row || {}));
      console.log(JSON.stringify(row, null, 2).slice(0, 2500));
    }
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
