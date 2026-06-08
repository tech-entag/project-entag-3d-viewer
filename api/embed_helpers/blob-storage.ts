import { list, put } from "@vercel/blob";

const normalizeToken = (value: string | undefined) => {
  return (value || "").replace(/[\r\n\s]+/g, "").trim();
};

export const getBlobToken = () => {
  return normalizeToken(process.env.BLOB_READ_WRITE_TOKEN);
};

export const hasBlobToken = () => {
  return Boolean(getBlobToken());
};

export const findBlobByPath = async (pathname: string) => {
  const token = getBlobToken();
  if (!token) {
    return null;
  }

  const result = await list({
    prefix: pathname,
    limit: 5,
    token,
  });

  return result.blobs.find((blob) => blob.pathname === pathname) || null;
};

export const readJsonBlob = async <T>(pathname: string): Promise<T | null> => {
  const blob = await findBlobByPath(pathname);
  if (!blob) {
    return null;
  }

  const response = await fetch(blob.url, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

export const writeJsonBlob = async (pathname: string, payload: unknown) => {
  const token = getBlobToken();
  if (!token) {
    return null;
  }

  return put(pathname, JSON.stringify(payload), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token,
  });
};
