const url = "https://project-entag-3d-viewer-6p9wh92rs-citizendevio.vercel.app/api/digifabster-price-tweak?x-vercel-protection-bypass=qlQfStfLPXLfXBliB9xoS9FQFjMxys1V";
const machineId = 44270;
const materialId = 72325;
fetch(url)
  .then(async (r) => {
    const data = await r.json();
    const mm = Array.isArray(data?.machinesMaterials) ? data.machinesMaterials : [];
    const matches = [];
    for (const row of mm) {
      const techSlug = row?.slug || row?.technology_slug || row?.name || null;
      const machines = Array.isArray(row?.machines) ? row.machines : [];
      const materials = Array.isArray(row?.materials) ? row.materials : [];
      const hasM = machines.some((m) => Number(m?.id) === machineId);
      const hasMat = materials.some((m) => Number(m?.id) === materialId);
      if (hasM || hasMat) {
        matches.push({ techSlug, hasMachine: hasM, hasMaterial: hasMat, machineCount: machines.length, materialCount: materials.length });
      }
    }
    console.log('status', r.status, 'rows', mm.length);
    console.log(JSON.stringify(matches.slice(0, 20), null, 2));
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
