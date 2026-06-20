/**
 * Runtime pricing config, stored in R2 at `config/pricing.json` so it can be
 * edited WITHOUT a redeploy:
 *
 *   { "priceMultiplier": 1.54 }
 *
 * Update it anytime with:
 *   wrangler r2 object put entag-3d-viewer/config/pricing.json \
 *     --file pricing.json --content-type application/json
 *
 * The batch-price route reads this per call and multiplies the DigiFabster cost
 * before writing to Bubble. A body `priceMultiplier` overrides it (for testing).
 */
import { getObjectText, putObject } from "../embed_helpers/blob-storage";

export const PRICING_CONFIG_KEY = "config/pricing.json";

export interface PricingConfig {
  /** Markup applied to the DigiFabster cost before the Bubble write. */
  priceMultiplier: number;
  /** Pin the material id (skips preselection auto-pick). */
  materialId?: number;
  /** Quantity ladder priced by batch_price (max 10). */
  count?: number[];
  /** batch_price config object: { tolerance, thickness, post_production, ... }. */
  config?: Record<string, unknown>;
}

const DEFAULT_PRICING_CONFIG: PricingConfig = { priceMultiplier: 1 };

/** Read the pricing config from R2; falls back to a 1.0 (no-op) multiplier. */
export const getPricingConfig = async (): Promise<PricingConfig> => {
  try {
    const text = await getObjectText(PRICING_CONFIG_KEY);
    if (!text) return { ...DEFAULT_PRICING_CONFIG };
    const parsed = JSON.parse(text) as {
      priceMultiplier?: unknown;
      materialId?: unknown;
      material_id?: unknown;
      count?: unknown;
      config?: unknown;
    };

    const result: PricingConfig = { priceMultiplier: 1 };

    const multiplier = Number(parsed.priceMultiplier);
    if (Number.isFinite(multiplier) && multiplier > 0) result.priceMultiplier = multiplier;

    const materialId = Number(parsed.materialId ?? parsed.material_id);
    if (Number.isInteger(materialId) && materialId > 0) result.materialId = materialId;

    if (Array.isArray(parsed.count)) {
      const ladder = parsed.count.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10);
      if (ladder.length > 0) result.count = ladder;
    }

    if (parsed.config && typeof parsed.config === "object" && !Array.isArray(parsed.config)) {
      result.config = parsed.config as Record<string, unknown>;
    }

    return result;
  } catch {
    return { ...DEFAULT_PRICING_CONFIG };
  }
};

/** Persist the pricing config to R2. */
export const putPricingConfig = async (config: PricingConfig): Promise<void> => {
  await putObject(PRICING_CONFIG_KEY, JSON.stringify(config), "application/json");
};
