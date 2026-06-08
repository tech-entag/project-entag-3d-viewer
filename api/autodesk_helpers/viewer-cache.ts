import { list, put } from "@vercel/blob";
import { posix as pathPosix } from "node:path";
import { strFromU8, unzipSync } from "fflate";

import {
  downloadDerivativeFile,
  findDerivativeByType,
  getDerivativeDownloadUrl,
  getManifest,
} from "./index.js";

type NormalizedViewerStatus = "queued" | "inprogress" | "success" | "failed";

export interface ViewerCacheRecord {
  urn: string;
  localModelUrl: string;
  derivativeUrn: string;
  storedAt: string;
}

type EnsureViewerBubbleResult = {
  status: "ready" | "processing" | "blob_unavailable";
  localModelUrl: string | null;
  viewerStatus: NormalizedViewerStatus;
  fromCache: boolean;
};

const normalizeStatus = (status: string | undefined, progress: string | undefined): NormalizedViewerStatus => {
  const normalizedStatus = (status || "").toLowerCase();
  const normalizedProgress = (progress || "").toLowerCase();

  if (normalizedStatus === "success" || normalizedStatus === "complete" || normalizedProgress === "complete") {
    return "success";
  }

  if (normalizedStatus === "failed" || normalizedStatus === "timeout") {
    return "failed";
  }

  if (
    normalizedStatus === "inprogress" ||
    normalizedStatus === "pending" ||
    normalizedStatus === "created" ||
    normalizedProgress.includes("%")
  ) {
    return "inprogress";
  }

  return "queued";
};

const getBlobToken = () => process.env.BLOB_READ_WRITE_TOKEN || "";

const hasBlobToken = () => Boolean(getBlobToken());

const toUrnKey = (urn: string) => Buffer.from(urn).toString("base64url");

const mappingPath = (urn: string) => `viewer-mappings/${toUrnKey(urn)}.json`;

const deriveRelativeDerivativePath = (derivativeUrn: string) => {
  const clean = derivativeUrn.split("?")[0];
  const outputMarker = "/output/";
  const outputIndex = clean.indexOf(outputMarker);

  if (outputIndex >= 0) {
    return `output/${clean.slice(outputIndex + outputMarker.length)}`;
  }

  return clean.split("/").pop() || "model.svf";
};

const collectUriFields = (value: unknown, result: Set<string>) => {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUriFields(item, result);
    }
    return;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const uri = record.URI;
    if (typeof uri === "string" && uri.trim()) {
      result.add(uri.trim());
    }

    for (const child of Object.values(record)) {
      collectUriFields(child, result);
    }
  }
};

const readSvfDependencyUris = (svfBytes: Uint8Array) => {
  try {
    const archive = unzipSync(svfBytes);
    const manifestEntry = Object.keys(archive).find((entry) => entry.endsWith("manifest.json"));
    if (!manifestEntry) {
      return [] as string[];
    }

    const manifestContent = strFromU8(archive[manifestEntry]);
    const parsed = JSON.parse(manifestContent) as unknown;
    const uris = new Set<string>();
    collectUriFields(parsed, uris);
    return [...uris];
  } catch {
    return [] as string[];
  }
};

const toRelativePath = (rootDirectory: string, uri: string) => {
  const cleaned = uri.replace(/^embed:\//i, "").replace(/^\/+/, "");
  if (!cleaned) {
    return null;
  }

  const normalized = pathPosix.normalize(pathPosix.join(rootDirectory, cleaned));
  if (normalized.startsWith("../") || normalized === "..") {
    return null;
  }

  return normalized;
};

const findBlobByPath = async (pathname: string) => {
  const token = getBlobToken();
  const result = await list({
    prefix: pathname,
    limit: 5,
    token,
  });

  return result.blobs.find((blob) => blob.pathname === pathname) || null;
};

export const getViewerCacheRecord = async (urn: string): Promise<ViewerCacheRecord | null> => {
  if (!hasBlobToken()) {
    return null;
  }

  const blob = await findBlobByPath(mappingPath(urn));
  if (!blob) {
    return null;
  }

  const response = await fetch(blob.url, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    urn?: string;
    localModelUrl?: string;
    bubbleUrl?: string;
    derivativeUrn?: string;
    storedAt?: string;
  };

  const localModelUrl = payload.localModelUrl || payload.bubbleUrl;
  if (!payload.urn || !localModelUrl || !payload.derivativeUrn || !payload.storedAt) {
    return null;
  }

  return {
    urn: payload.urn,
    localModelUrl,
    derivativeUrn: payload.derivativeUrn,
    storedAt: payload.storedAt,
  };
};

const saveViewerCacheRecord = async (record: ViewerCacheRecord) => {
  const token = getBlobToken();
  await put(mappingPath(record.urn), JSON.stringify(record), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token,
  });
};

export const ensureViewerBubbleInBlob = async (
  urn: string,
  accessToken: string
): Promise<EnsureViewerBubbleResult> => {
  if (!hasBlobToken()) {
    return {
      status: "blob_unavailable",
      localModelUrl: null,
      viewerStatus: "success",
      fromCache: false,
    };
  }

  const existing = await getViewerCacheRecord(urn);
  if (existing?.localModelUrl && existing.localModelUrl.includes("/output/")) {
    return {
      status: "ready",
      localModelUrl: existing.localModelUrl,
      viewerStatus: "success",
      fromCache: true,
    };
  }

  const manifest = await getManifest(urn, accessToken);
  const viewerDerivative = findDerivativeByType(manifest, "svf") || findDerivativeByType(manifest, "svf2");
  const viewerStatus = viewerDerivative
    ? normalizeStatus(viewerDerivative.status, viewerDerivative.progress)
    : normalizeStatus(manifest?.status, manifest?.progress);

  if (!viewerDerivative || viewerStatus !== "success") {
    return {
      status: "processing",
      localModelUrl: null,
      viewerStatus,
      fromCache: false,
    };
  }

  const signed = await getDerivativeDownloadUrl(urn, viewerDerivative.derivativeUrn, accessToken);
  const rootBytes = await downloadDerivativeFile(signed.url, signed.cookies);

  const token = getBlobToken();
  const urnKey = toUrnKey(urn);
  const rootRelativePath = deriveRelativeDerivativePath(viewerDerivative.derivativeUrn);
  const rootBlobPath = `viewer-bubbles/${urnKey}/${rootRelativePath}`;
  const uploaded = await put(rootBlobPath, Buffer.from(rootBytes), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/octet-stream",
    token,
  });

  const rootDirectory = pathPosix.dirname(rootRelativePath);
  const derivativePrefix = viewerDerivative.derivativeUrn.slice(
    0,
    Math.max(0, viewerDerivative.derivativeUrn.length - rootRelativePath.length)
  );

  const dependencyRelativePaths = new Set<string>();
  for (const uri of readSvfDependencyUris(rootBytes)) {
    const relativePath = toRelativePath(rootDirectory, uri);
    if (relativePath && relativePath !== rootRelativePath) {
      dependencyRelativePaths.add(relativePath);
    }
  }

  for (const relativePath of dependencyRelativePaths) {
    const dependencyUrn = `${derivativePrefix}${relativePath}`;

    try {
      const dependencySigned = await getDerivativeDownloadUrl(urn, dependencyUrn, accessToken);
      const dependencyBytes = await downloadDerivativeFile(dependencySigned.url, dependencySigned.cookies);
      await put(`viewer-bubbles/${urnKey}/${relativePath}`, Buffer.from(dependencyBytes), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/octet-stream",
        token,
      });
    } catch (error) {
      console.warn(`Failed to cache SVF dependency: ${relativePath}`, error);
    }
  }

  const record: ViewerCacheRecord = {
    urn,
    localModelUrl: uploaded.url,
    derivativeUrn: viewerDerivative.derivativeUrn,
    storedAt: new Date().toISOString(),
  };

  await saveViewerCacheRecord(record);

  return {
    status: "ready",
    localModelUrl: uploaded.url,
    viewerStatus: "success",
    fromCache: false,
  };
};
