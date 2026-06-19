/**
 * Cloudflare Cron Worker — drains pending DigiFabster batch-price jobs.
 *
 * DigiFabster prices asynchronously, so /api/autodesk enqueues a job in R2
 * (price-jobs/{modelId}.json) once a model is uploaded. This worker runs on a
 * cron schedule, and for each pending job calls the Pages endpoint
 * /api/digifabster-batch-price (which auto-resolves material/tolerance/lead_time
 * and writes [price]manufacturingCost to the order). When the price is ready
 * (shouldRetry === false) the job is deleted; stale jobs expire after MAX_AGE.
 *
 * Deploy separately from the Pages project:
 *   wrangler deploy --config workers/price-scheduler/wrangler.toml
 *
 * It only needs the shared R2 bucket + PAGES_BASE_URL; DigiFabster/Bubble
 * credentials stay in the Pages app that the endpoint runs in.
 */

interface R2Object {
  text(): Promise<string>;
}

interface R2Bucket {
  list(options?: { prefix?: string; limit?: number }): Promise<{ objects: Array<{ key: string }> }>;
  get(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}

export interface Env {
  BLOB_BUCKET: R2Bucket;
  /** e.g. https://project-entag-3d-viewer.pages.dev */
  PAGES_BASE_URL: string;
  /** Jobs older than this are abandoned. Default 15 min. */
  PRICE_JOB_MAX_AGE_MS?: string;
  /** Max jobs processed per drain pass (keeps the run within limits). Default 10. */
  PRICE_JOB_BATCH_SIZE?: string;
  /** How often to drain within a single cron invocation. Default 10s. */
  PRICE_POLL_INTERVAL_MS?: string;
  /** How long a single cron invocation keeps self-looping. Default 50s. */
  PRICE_POLL_WINDOW_MS?: string;
}

interface PriceJob {
  objectModelId: number;
  partId?: string;
  orderId?: string;
  version?: string;
  createdAt: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One drain pass: price every pending job once, deleting priced/expired ones. */
const drainOnce = async (env: Env, base: string, maxAge: number, batchSize: number): Promise<void> => {
  const listing = await env.BLOB_BUCKET.list({ prefix: "price-jobs/", limit: batchSize });
  if (listing.objects.length === 0) return;

  for (const obj of listing.objects) {
    try {
      const stored = await env.BLOB_BUCKET.get(obj.key);
      if (!stored) continue;

      const job = JSON.parse(await stored.text()) as PriceJob;

      if (Date.now() - job.createdAt > maxAge) {
        await env.BLOB_BUCKET.delete(obj.key);
        console.log("price-scheduler: expired job removed", { key: obj.key });
        continue;
      }

      const res = await fetch(`${base}/api/digifabster-batch-price`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objectModelId: job.objectModelId,
          part_id: job.partId,
          orderId: job.orderId,
          version: job.version,
          // Single fast attempt — the scheduler provides the retry cadence.
          attempts: 1,
          traceId: `price-job-${job.objectModelId}`,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | { shouldRetry?: boolean; selectedPrice?: { cost?: number } | null; bubble?: { status?: string } }
        | null;

      if (res.ok && data && data.shouldRetry === false) {
        await env.BLOB_BUCKET.delete(obj.key);
        console.log("price-scheduler: priced + job removed", {
          key: obj.key,
          cost: data.selectedPrice?.cost ?? null,
          bubble: data.bubble?.status ?? null,
        });
      } else {
        console.log("price-scheduler: not ready, will retry", {
          key: obj.key,
          httpStatus: res.status,
          shouldRetry: data?.shouldRetry ?? null,
        });
      }
    } catch (err) {
      console.error("price-scheduler: job error", {
        key: obj.key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

export default {
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    const base = (env.PAGES_BASE_URL || "").replace(/\/+$/, "");
    if (!base) {
      console.error("price-scheduler: PAGES_BASE_URL not set");
      return;
    }
    const maxAge = Number(env.PRICE_JOB_MAX_AGE_MS) || 15 * 60 * 1000;
    const batchSize = Number(env.PRICE_JOB_BATCH_SIZE) || 10;
    const intervalMs = Number(env.PRICE_POLL_INTERVAL_MS) || 10_000;
    const windowMs = Number(env.PRICE_POLL_WINDOW_MS) || 50_000;

    // Cloudflare crons fire at most once per minute, so to "check every ~10s"
    // a single invocation self-loops for ~a minute, draining every intervalMs.
    const deadline = Date.now() + windowMs;
    for (;;) {
      await drainOnce(env, base, maxAge, batchSize);
      if (Date.now() + intervalMs >= deadline) break;
      await sleep(intervalMs);
    }
  },
};
