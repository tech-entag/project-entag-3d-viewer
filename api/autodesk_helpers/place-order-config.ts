/**
 * Runtime place-order config, stored in R2 at `config/place-order.json` so it
 * can be edited WITHOUT a redeploy — the same mechanism as `config/pricing.json`
 * (see pricing-config.ts):
 *
 *   {
 *     "clientId": 435622,
 *     "customer": { "name": "Omar", "surname": "Hawary",
 *                   "phone": "1111111111", "email": "omar@entag.co" },
 *     "submitStatus": "firm_offer_sent",
 *     "placeStatus": "placed"
 *   }
 *
 * Update it anytime with:
 *   wrangler r2 object put entag-3d-viewer/config/place-order.json \
 *     --file place-order.json --content-type application/json
 *
 * The /api/digifabster-place-order route reads this per call to supply the fixed
 * client id + customer details, so Bubble no longer needs to send them.
 */
import { getObjectText, putObject } from "../embed_helpers/blob-storage";

export const PLACE_ORDER_CONFIG_KEY = "config/place-order.json";

export interface PlaceOrderCustomer {
  name: string;
  surname: string;
  phone: string;
  email: string;
}

export interface PlaceOrderConfig {
  /** Fixed DigiFabster client/user that Entag places all orders under. */
  clientId: number;
  /** Fixed customer details for submit_initial_order. */
  customer: PlaceOrderCustomer;
  /** Status sent to submit_initial_order. */
  submitStatus: string;
  /** Status the invoice is PATCHed to when confirming. */
  placeStatus: string;
}

/** Fallback used when R2 has no config/place-order.json yet (Omar's fixed data). */
const DEFAULT_PLACE_ORDER_CONFIG: PlaceOrderConfig = {
  clientId: 435622,
  customer: { name: "Omar", surname: "Hawary", phone: "1111111111", email: "omar@entag.co" },
  submitStatus: "firm_offer_sent",
  placeStatus: "placed",
};

const cloneDefault = (): PlaceOrderConfig => ({
  ...DEFAULT_PLACE_ORDER_CONFIG,
  customer: { ...DEFAULT_PLACE_ORDER_CONFIG.customer },
});

const pickStr = (...values: unknown[]): string | null => {
  for (const v of values) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
};

/** Read the place-order config from R2; falls back to the built-in fixed data. */
export const getPlaceOrderConfig = async (): Promise<PlaceOrderConfig> => {
  try {
    const text = await getObjectText(PLACE_ORDER_CONFIG_KEY);
    if (!text) return cloneDefault();

    const parsed = JSON.parse(text) as {
      clientId?: unknown;
      client_id?: unknown;
      customer?: unknown;
      submitStatus?: unknown;
      submit_status?: unknown;
      placeStatus?: unknown;
      place_status?: unknown;
    };

    const result = cloneDefault();

    const clientId = Number(parsed.clientId ?? parsed.client_id);
    if (Number.isInteger(clientId) && clientId > 0) result.clientId = clientId;

    const customer =
      parsed.customer && typeof parsed.customer === "object" && !Array.isArray(parsed.customer)
        ? (parsed.customer as Record<string, unknown>)
        : {};
    result.customer = {
      name: pickStr(customer.name) ?? result.customer.name,
      surname: pickStr(customer.surname) ?? result.customer.surname,
      phone: pickStr(customer.phone) ?? result.customer.phone,
      email: pickStr(customer.email) ?? result.customer.email,
    };

    const submitStatus = pickStr(parsed.submitStatus, parsed.submit_status);
    if (submitStatus) result.submitStatus = submitStatus;
    const placeStatus = pickStr(parsed.placeStatus, parsed.place_status);
    if (placeStatus) result.placeStatus = placeStatus;

    return result;
  } catch {
    return cloneDefault();
  }
};

/** Persist the place-order config to R2. */
export const putPlaceOrderConfig = async (config: PlaceOrderConfig): Promise<void> => {
  await putObject(PLACE_ORDER_CONFIG_KEY, JSON.stringify(config), "application/json");
};
