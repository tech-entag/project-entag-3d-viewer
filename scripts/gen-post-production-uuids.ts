/**
 * Emit a CSV of every post_production option (uuid + name) for each material in
 * the saved material-group mapping. UUIDs are per-material, so each row is one
 * (materialId, option) pair.
 *
 * Pulls live data from a deployment:
 *   - GET /api/digifabster-technologies            (the catalog)
 *   - GET /api/digifabster-material-group-config    (the mapped materialIds + family)
 *
 * Usage:
 *   pnpm tsx scripts/gen-post-production-uuids.ts https://project-entag-3d-viewer.pages.dev > docs/digifabster-post-production-uuids.csv
 *
 * DigiFabster's `group_title` is unreliable (stray "F", "{{group}}", blank), so
 * the `group` column is normalized from the option name; `rawGroup` keeps the
 * original value for reference.
 */

/** Option name -> normalized group (DigiFabster's own group_title is dirty). */
const GROUP_BY_NAME: Record<string, string> = {
  "Polishing": "Finishing",
  "Electroless Nickel Plating": "Finishing",
  "Galvanizing": "Finishing",
  "Powder Coating": "Finishing",
  "Bead Blasting": "Finishing",
  "CMM": "Inspection",
  "Measurement report": "Inspection",
  "First Article Inspection Report (FAIR)": "Inspection",
  "Standard (3.2um RA)": "Surface Roughness",
  "Smooth (1.6um RA)": "Surface Roughness",
  "Fine (0.8um RA)": "Surface Roughness",
  "Heat Treating": "Heat Treatment",
  "Heat Treatment": "Heat Treatment",
};

interface Material {
  id?: number;
  title?: string;
  post_production?: Array<{ id?: string; title?: string; group_title?: string; price?: number; price_units?: string }>;
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const main = async () => {
  const base = (process.argv[2] || process.env.PAGES_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    console.error("Usage: pnpm tsx scripts/gen-post-production-uuids.ts <deployment-base-url> > out.csv");
    process.exit(1);
  }
  const headers: Record<string, string> = {};
  if (process.env.BYPASS_TOKEN) headers["x-vercel-protection-bypass"] = process.env.BYPASS_TOKEN;

  const [catRes, cfgRes] = await Promise.all([
    fetch(`${base}/api/digifabster-technologies`, { headers }),
    fetch(`${base}/api/digifabster-material-group-config`, { headers }),
  ]);
  if (!catRes.ok) throw new Error(`catalog ${catRes.status}`);
  if (!cfgRes.ok) throw new Error(`group-config ${cfgRes.status}`);

  const catalog = (await catRes.json()) as { results?: Array<{ materials?: Material[] }> };
  const groups = ((await cfgRes.json()) as { groups?: Record<string, string> }).groups ?? {};

  const byId = new Map<number, Material>();
  for (const tech of catalog.results ?? []) {
    for (const m of tech.materials ?? []) if (typeof m.id === "number") byId.set(m.id, m);
  }

  const rows: string[] = ["materialId,materialName,family,group,name,uuid,price,price_units,rawGroup"];
  let count = 0;
  const ids = Object.keys(groups).map(Number).sort((a, b) => a - b);
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) continue;
    for (const p of m.post_production ?? []) {
      const name = (p.title ?? "").trim();
      const group = GROUP_BY_NAME[name] ?? p.group_title ?? "";
      rows.push(
        [id, m.title ?? "", groups[String(id)], group, name, p.id ?? "", p.price ?? "", p.price_units ?? "", p.group_title ?? ""]
          .map(csvCell)
          .join(","),
      );
      count += 1;
    }
  }

  process.stdout.write(rows.join("\n") + "\n");
  console.error(`Wrote ${count} option rows across ${ids.length} materials.`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
