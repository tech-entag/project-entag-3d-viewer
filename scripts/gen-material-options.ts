/**
 * Emit a CSV of every selectable option (uuid + name) for each material in the
 * saved material-group mapping — both post_production and tolerance. UUIDs are
 * per-material, so each row is one (materialId, option) pair.
 *
 * Pulls live data from a deployment:
 *   - GET /api/digifabster-technologies            (the catalog)
 *   - GET /api/digifabster-material-group-config    (the mapped materialIds + family)
 *
 * Usage:
 *   pnpm tsx scripts/gen-material-options.ts https://project-entag-3d-viewer.pages.dev > docs/digifabster-material-options.csv
 *
 * Columns:
 *   optionType  post_production | tolerance
 *   group       normalized group (Finishing/Inspection/Surface Roughness/Heat
 *               Treatment for post_production; "Tolerance" for tolerance)
 *   name        option name (post_production title / tolerance name_for_user)
 *   uuid, price, price_units            (price* only for post_production)
 *   displayName, deviationFrom/To, margin (only for tolerance)
 *   rawGroup    original post_production group_title (DigiFabster's is unreliable)
 */

/** post_production option name -> normalized group (group_title is dirty). */
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

interface PostProd { id?: string; title?: string; group_title?: string; price?: number; price_units?: string }
interface Tol { id?: string; name_for_user?: string; display_name?: string; deviation_from?: number; deviation_to?: number; margin?: number }
interface Material { id?: number; title?: string; post_production?: PostProd[]; tolerance?: Tol[] }

const COLUMNS = [
  "optionType", "materialId", "materialName", "family", "group", "name", "uuid",
  "price", "price_units", "displayName", "deviationFrom", "deviationTo", "margin", "rawGroup",
];

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (o: Record<string, unknown>): string => COLUMNS.map((c) => csvCell(o[c])).join(",");

const main = async () => {
  const base = (process.argv[2] || process.env.PAGES_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    console.error("Usage: pnpm tsx scripts/gen-material-options.ts <deployment-base-url> > out.csv");
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

  const lines: string[] = [COLUMNS.join(",")];
  let pp = 0;
  let tol = 0;
  const ids = Object.keys(groups).map(Number).sort((a, b) => a - b);
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) continue;
    const base = { materialId: id, materialName: m.title ?? "", family: groups[String(id)] };
    for (const p of m.post_production ?? []) {
      const name = (p.title ?? "").trim();
      lines.push(row({
        optionType: "post_production", ...base,
        group: GROUP_BY_NAME[name] ?? p.group_title ?? "",
        name, uuid: p.id ?? "", price: p.price ?? "", price_units: p.price_units ?? "",
        rawGroup: p.group_title ?? "",
      }));
      pp += 1;
    }
    for (const t of m.tolerance ?? []) {
      lines.push(row({
        optionType: "tolerance", ...base,
        group: "Tolerance",
        name: (t.name_for_user ?? "").trim(), uuid: t.id ?? "",
        displayName: t.display_name ?? "", deviationFrom: t.deviation_from ?? "",
        deviationTo: t.deviation_to ?? "", margin: t.margin ?? "",
      }));
      tol += 1;
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
  console.error(`Wrote ${pp} post_production + ${tol} tolerance rows across ${ids.length} materials.`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
