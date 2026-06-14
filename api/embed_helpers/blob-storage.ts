/**
 * Cloudflare R2-backed object storage (replaces @vercel/blob).
 *
 * The R2 bucket binding is stashed on `globalThis.__ENTAG_R2__` by the Pages
 * dispatcher (functions/api/[[path]].ts) so the platform-agnostic api handlers
 * can reach it without changing their (req: Request) signatures.
 *
 * Historical "Blob"/"hasBlobToken" names are kept so existing callers compile
 * unchanged; there is no token — availability is simply whether the bucket
 * binding is present. Public URLs (for objects fetched by external services or
 * the browser) are built from R2_PUBLIC_BASE_URL.
 */

interface R2ObjectBody {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2BucketLike {
  put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ objects: Array<{ key: string }> }>;
  delete(key: string): Promise<void>;
}

const getBucket = (): R2BucketLike | null => {
  const bucket = (globalThis as { __ENTAG_R2__?: R2BucketLike }).__ENTAG_R2__;
  return bucket ?? null;
};

/** Whether object storage is available (R2 bucket binding present). */
export const hasStorage = (): boolean => Boolean(getBucket());

/** Back-compat: storage availability used to be gated on a Blob token. */
export const hasBlobToken = (): boolean => hasStorage();

/** Deprecated no-op kept so legacy callers compile; R2 needs no token. */
export const getBlobToken = (): string => "";

/** Public URL for an object, built from R2_PUBLIC_BASE_URL (empty if unset). */
export const publicUrl = (pathname: string): string => {
  const base = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return "";
  const encoded = pathname.split("/").map(encodeURIComponent).join("/");
  return `${base}/${encoded}`;
};

/** Store an object. Returns its public URL (requires R2_PUBLIC_BASE_URL) + key. */
export const putObject = async (
  pathname: string,
  body: string | ArrayBuffer | ArrayBufferView | Blob,
  contentType?: string,
): Promise<{ url: string; pathname: string }> => {
  const bucket = getBucket();
  if (!bucket) {
    throw new Error("R2 storage not configured (missing bucket binding).");
  }
  await bucket.put(pathname, body, contentType ? { httpMetadata: { contentType } } : undefined);
  return { url: publicUrl(pathname), pathname };
};

/** Read an object as text via the binding (strongly consistent, no public URL). */
export const getObjectText = async (pathname: string): Promise<string | null> => {
  const bucket = getBucket();
  if (!bucket) return null;
  const obj = await bucket.get(pathname);
  return obj ? obj.text() : null;
};

/** Read an object as bytes via the binding. */
export const getObjectBytes = async (pathname: string): Promise<Uint8Array | null> => {
  const bucket = getBucket();
  if (!bucket) return null;
  const obj = await bucket.get(pathname);
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
};

export const findBlobByPath = async (
  pathname: string,
): Promise<{ url: string; pathname: string } | null> => {
  const bucket = getBucket();
  if (!bucket) return null;
  const obj = await bucket.get(pathname);
  return obj ? { url: publicUrl(pathname), pathname } : null;
};

export const readJsonBlob = async <T>(pathname: string): Promise<T | null> => {
  const text = await getObjectText(pathname);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

export const writeJsonBlob = async (pathname: string, payload: unknown) => {
  if (!hasStorage()) return null;
  return putObject(pathname, JSON.stringify(payload), "application/json");
};
