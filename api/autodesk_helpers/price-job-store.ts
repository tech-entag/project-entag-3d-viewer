/**
 * Pending batch-price jobs, stored in R2 under `price-jobs/{modelId}.json`.
 *
 * DigiFabster computes batch prices asynchronously (often longer than one
 * request window), so /api/autodesk enqueues a job here once the model is
 * uploaded. A separate Cloudflare Cron Worker (workers/price-scheduler) drains
 * the queue by calling /api/digifabster-batch-price until the price is ready,
 * then deletes the job. This keeps Bubble's side to a single /api/autodesk call.
 */
import { hasStorage, putObject } from "../embed_helpers/blob-storage";

export interface PriceJob {
  objectModelId: number;
  /** OrderPart id — the price write target (OrderPart.requestedPrice). */
  partId?: string;
  /** Bubble order id (kept for reference / fallback). */
  orderId?: string;
  version?: string;
  createdAt: number;
}

export const priceJobKey = (objectModelId: number): string => `price-jobs/${objectModelId}.json`;

/** Write (or refresh) a pending price job for the cron scheduler to drain. */
export const enqueuePriceJob = async (params: {
  objectModelId: number;
  partId?: string;
  orderId?: string | null;
  version?: string;
}): Promise<{ status: "queued" | "skipped" | "error"; reason?: string; key?: string }> => {
  if (!hasStorage()) {
    return { status: "skipped", reason: "no_r2_storage" };
  }

  const job: PriceJob = {
    objectModelId: params.objectModelId,
    partId: params.partId,
    orderId: params.orderId ?? undefined,
    version: params.version,
    createdAt: Date.now(),
  };
  const key = priceJobKey(params.objectModelId);

  try {
    await putObject(key, JSON.stringify(job), "application/json");
    return { status: "queued", key };
  } catch {
    return { status: "error", reason: "r2_write_failed" };
  }
};
