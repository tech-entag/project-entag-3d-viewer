/**
 * Generate the materialId -> family mapping for /api/digifabster-material-group-config.
 *
 * DigiFabster's widget-technologies catalog carries each material's id + grade
 * title but NOT the family ("Steel"/"Aluminium"/...). This script fetches the
 * catalog and classifies each grade title into a family using the exact grade
 * lists from the storefront widget (below), then prints a ready-to-paste JSON
 * map plus a PUT-ready body.
 *
 * Usage:
 *   pnpm tsx scripts/gen-material-groups.ts https://project-entag-3d-viewer.pages.dev
 *
 * The base URL is your deployment that serves /api/digifabster-technologies.
 * Optionally set BYPASS_TOKEN to send x-vercel-protection-bypass.
 */

/** Family -> exact grade titles from the widget (normalized on compare). */
const FAMILIES: Record<string, string[]> = {
  Aluminium: [
    "Aluminium 5083", "Aluminium 5754", "Aluminium 6060", "Aluminium 6061",
    "Aluminium 6063", "Aluminium 6082", "Aluminium 7050", "Aluminium 7075",
  ],
  Steel: [
    "St37 / S235JR / 1.0570", "St52 / S355J2", "A36 / 1.025", "C45 / 1.0503 / 1045",
    "C40 / 1.0511", "C18 / 1.1147 / 1018", "C45E / 1.1191", "90MnCrV8 / 1.2842",
    "16MnCr5 / 1.7131", "25CrMo4 / 1.7218", "42CrMo4 / 1.7225",
  ],
  "Tool Steel": [
    "1.2312 / 40CrMnMoS8-6 / Bohler M200 / HOLDAX", "1.2738 / 40CrNiMo8-6-4 / Bohler M238",
    "1.2083 / X42Cr13 / Bohler M310 / STAVAX", "Bohler M333 / SUPREME",
    "1.2316 / X38CrMo16 / Bohler M300", "1.2316mod / X36CrMo17 / Bohler M303",
    "1.2085 / X33CrS16 / Bohler M314 / RAMAX", "1.2343 / X38CrMoV5-1 / Bohler W300 / AISI H11",
    "1.2344 / X40CrMoV5-1 / Bohler W302 / AISI H13", "1.2379 / X153CrMoV12 / Bohler K110",
  ],
  "Stainless Steel": ["SS201", "SS303", "SS304", "SS304L", "SS316", "SS416", "SS420"],
  Copper: ["Brass", "Copper", "Copper Beryllium", "Bronze (7% Tin)", "Bronze (12% Tin)"],
};

/** Skip these widget placeholder entries (not real materials). */
const SKIP = [/^any .*grade$/i, /^help me choose$/i];

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Exact-title lookup, then keyword fallback for resilience to minor title drift. */
const exact = new Map<string, string>();
for (const [family, titles] of Object.entries(FAMILIES)) {
  for (const t of titles) exact.set(norm(t), family);
}

const classify = (title: string): string | null => {
  const n = norm(title);
  if (exact.has(n)) return exact.get(n)!;
  if (/aluminium|aluminum/.test(n)) return "Aluminium";
  if (/bohler|stavax|holdax|ramax|supreme/.test(n)) return "Tool Steel";
  if (/^ss\d|stainless/.test(n)) return "Stainless Steel";
  if (/brass|bronze|copper/.test(n)) return "Copper";
  // Generic carbon/alloy/galvanized steel grades (St.., C.., A36, ..CrMo..,
  // ..CrNiMo.., ..MnCr.., galvanized, or anything else literally named "steel").
  if (/^st\d|^a36|^c\d{2}|crmo|crnimo|mncr|crv|s235|s355|galvani[sz]ed|steel/.test(n)) return "Steel";
  return null;
};

const main = async () => {
  const base = (process.argv[2] || process.env.PAGES_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    console.error("Usage: pnpm tsx scripts/gen-material-groups.ts <deployment-base-url>");
    process.exit(1);
  }

  const headers: Record<string, string> = {};
  if (process.env.BYPASS_TOKEN) headers["x-vercel-protection-bypass"] = process.env.BYPASS_TOKEN;

  const res = await fetch(`${base}/api/digifabster-technologies`, { headers });
  if (!res.ok) {
    console.error(`Catalog fetch failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const catalog = (await res.json()) as { results?: Array<{ materials?: Array<{ id?: number; title?: string }> }> };
  const results = Array.isArray(catalog.results) ? catalog.results : [];

  const groups: Record<string, string> = {};
  const unmapped: Array<{ id: number; title: string }> = [];
  const seen = new Set<number>();

  for (const tech of results) {
    for (const m of tech.materials ?? []) {
      const id = typeof m.id === "number" ? m.id : null;
      const title = typeof m.title === "string" ? m.title : "";
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      if (SKIP.some((re) => re.test(title))) continue;
      const family = classify(title);
      if (family) groups[String(id)] = family;
      else unmapped.push({ id, title });
    }
  }

  console.log("// Mapped:", Object.keys(groups).length, "| Unmapped:", unmapped.length);
  if (unmapped.length) {
    console.log("// Unmapped (classify by hand or extend FAMILIES):");
    for (const u of unmapped) console.log(`//   ${u.id}  ${u.title}`);
  }
  console.log("\n// PUT body for /api/digifabster-material-group-config:");
  console.log(JSON.stringify({ groups }, null, 2));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
