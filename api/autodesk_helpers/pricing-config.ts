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
  priceMultiplier: number;
}

const DEFAULT_PRICING_CONFIG: PricingConfig = { priceMultiplier: 1 };

/** Read the pricing config from R2; falls back to a 1.0 (no-op) multiplier. */
export const getPricingConfig = async (): Promise<PricingConfig> => {
  try {
    const text = await getObjectText(PRICING_CONFIG_KEY);
    if (!text) return { ...DEFAULT_PRICING_CONFIG };
    const parsed = JSON.parse(text) as { priceMultiplier?: unknown };
    const multiplier = Number(parsed.priceMultiplier);
    if (Number.isFinite(multiplier) && multiplier > 0) {
      return { priceMultiplier: multiplier };
    }
  } catch {
    /* fall through to default */
  }
  return { ...DEFAULT_PRICING_CONFIG };
};

/** Persist the pricing config to R2. */
export const putPricingConfig = async (config: PricingConfig): Promise<void> => {
  await putObject(PRICING_CONFIG_KEY, JSON.stringify(config), "application/json");
};
