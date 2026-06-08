const https = require("https");

// Fetch from local dev - make sure `pnpm dev` is running first
const fetchCatalog = () => {
  return new Promise((resolve, reject) => {
    const url = "http://localhost:3000/api/digifabster-price-tweak";
    https.get(url.replace("https", "http"), (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
};

const extractOptions = (catalog) => {
  const result = {
    materials: [],
    tolerances: [],
    inspection: [],
    roughness: [],
    finish: [],
    machines: [],
  };

  if (!catalog.data || !Array.isArray(catalog.data)) {
    console.error("No catalog data found");
    return result;
  }

  const machines = catalog.data.map((item) => {
    if (typeof item === "object" && item !== null) {
      const title = item.title || item.name || "";
      const materials = Array.isArray(item.materials)
        ? item.materials.map((m) => m.title || m.name || "").filter(Boolean)
        : [];
      return { title, materials };
    }
    return null;
  }).filter(Boolean);

  result.machines = machines.map((m) => m.title);

  // Collect all unique material titles from all machines
  const allMaterials = new Set();
  machines.forEach((m) => {
    m.materials.forEach((mat) => allMaterials.add(mat));
  });
  result.materials = Array.from(allMaterials).sort();

  // Try to find postproduction options (tolerances, inspection, roughness, finish)
  // These are usually in a separate catalog or nested in machine data
  if (catalog.bubbleStaticPayloadTemplate) {
    const template = catalog.bubbleStaticPayloadTemplate;
    if (template.tightest_tolerance) {
      result.tolerances = [template.tightest_tolerance].filter(Boolean);
    }
    if (template.inspection) {
      result.inspection = [template.inspection].filter(Boolean);
    }
    if (template.roughness) {
      result.roughness = [template.roughness].filter(Boolean);
    }
    if (template.finish) {
      result.finish = [template.finish].filter(Boolean);
    }
  }

  return result;
};

const formatMapping = (bubbleOptions, digifabsterOptions, field) => {
  console.log(`\n=== ${field.toUpperCase()} ===\n`);
  console.log("Bubble options:");
  bubbleOptions.forEach((opt) => console.log(`  - ${opt}`));

  console.log("\nDigiFabster options:");
  digifabsterOptions.forEach((opt) => console.log(`  - ${opt}`));

  console.log("\nMapping template:");
  const mapping = {};
  digifabsterOptions.forEach((df) => {
    // Try to find a matching Bubble option
    const bubbleMatch = bubbleOptions.find((b) =>
      b.toLowerCase().includes(df.toLowerCase()) ||
      df.toLowerCase().includes(b.toLowerCase())
    );
    if (bubbleMatch) {
      const key = bubbleMatch.toLowerCase().replace(/\s+/g, " ");
      mapping[key] = df;
    }
  });

  console.log(JSON.stringify(mapping, null, 2));
  return mapping;
};

(async () => {
  try {
    console.log("Fetching DigiFabster catalog...");
    const catalog = await fetchCatalog();
    const options = extractOptions(catalog);

    const bubbleData = {
      materials: [
        "Any aluminium grade",
        "Aluminium 5083",
        "Aluminium 5754",
        "Aluminium 6060",
        "Aluminium 6061",
        "Aluminium 6063",
        "Aluminium 6082",
        "Aluminium 7050",
        "Aluminium 7075",
        "Any steel grade",
        "St37 / S235JR / 1.0570",
        "St52 / S355J2",
        "A36 / 1.025",
        "C45 / 1.0503 / 1045",
        "C40 / 1.0511",
        "C18 / 1.1147 / 1018",
        "C45E / 1.1191",
        "90MnCrV8 / 1.2842",
        "16MnCr5 / 1.7131",
        "25CrMo4 / 1.7218",
        "42CrMo4 / 1.7225",
        "1.2312 / 40CrMnMoS8-6 / Bohler M200 / HOLDAX",
        "1.2738 / 40CrMnNiMo8-6-4 / Bohler M238",
        "1.2083 / X42Cr13 / Bohler M310 / STAVAX",
        "Bohler M333 / SUPREME",
        "1.2316 / X38CrMo16 / Bohler M300",
        "1.2316mod / X36CrMo17 / Bohler M303",
        "1.2085 / X33CrS16 / Bohler M314 / RAMAX",
        "1.2343 / X38CrMoV5-1 / Bohler W300 / AISI H11",
        "1.2344 / X40CrMoV5-1 / Bohler W302 / AISI H13",
        "1.2379 / X153CrMoV12 / Bohler K110",
        "Any stainless steel grade",
        "SS201",
        "SS303",
        "SS304",
        "SS304L",
        "SS316",
        "SS416",
        "SS420",
        "Any copper grade",
        "Brass",
        "Copper",
        "Copper Beryllium",
        "Bronze (7% Tin)",
        "Bronze (12% Tin)",
        "Help me choose",
      ],
      tolerances: [
        "ISO 2768 - Medium (Standard)",
        "ISO 2768 Fine – requires 2D drawings",
        "ISO 2768 Course",
      ],
      inspection: ["CMM", "First Article Inspection Report (FAIR)", "Measurement report"],
      roughness: ["As Machined", "Standard (3.2 um Ra)", "Smooth (1.6µm Ra)", "Fine (0.8µm Ra)"],
      finish: [
        "Standard",
        "Clear Coating (Lacquer/Enamel)",
        "Tin Plating",
        "Gold Plating",
        "Galvanizing",
        "Bead Blasting",
        "Polishing",
        "Anodizing",
        "Electroless Nickel Plating",
        "Powder Coating",
      ],
    };

    console.log("\n" + "=".repeat(60));
    console.log("BUBBLE ↔ DIGIFABSTER MAPPING ANALYSIS");
    console.log("=".repeat(60));

    formatMapping(bubbleData.materials, options.materials, "materials");
    formatMapping(bubbleData.tolerances, options.tolerances, "tolerances");
    formatMapping(bubbleData.inspection, options.inspection, "inspection");
    formatMapping(bubbleData.roughness, options.roughness, "roughness");
    formatMapping(bubbleData.finish, options.finish, "finish");

    console.log("\nRaw DigiFabster catalog extracted:");
    console.log(JSON.stringify(options, null, 2));
  } catch (error) {
    console.error("Error:", error.message);
    console.log("\nMake sure to run: pnpm dev");
  }
})();
