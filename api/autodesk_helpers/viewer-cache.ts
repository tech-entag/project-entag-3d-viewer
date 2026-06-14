import { posix as pathPosix } from "node:path";
import { strFromU8, unzipSync } from "fflate";

import { getObjectText, hasStorage, putObject } from "../embed_helpers/blob-storage";
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

export const getViewerCacheRecord = async (urn: string): Promise<ViewerCacheRecord | null> => {
  if (!hasStorage()) {
    return null;
  }

  const text = await getObjectText(mappingPath(urn));
  if (text === null) {
    return null;
  }

  let payload: {
    urn?: string;
    localModelUrl?: string;
    bubbleUrl?: string;
    derivativeUrn?: string;
    storedAt?: string;
  };
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }

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
  await putObject(mappingPath(record.urn), JSON.stringify(record), "application/json");
};

export const ensureViewerBubbleInBlob = async (
  urn: string,
  accessToken: string
): Promise<EnsureViewerBubbleResult> => {
  if (!hasStorage()) {
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

  const urnKey = toUrnKey(urn);
  const rootRelativePath = deriveRelativeDerivativePath(viewerDerivative.derivativeUrn);
  const rootBlobPath = `viewer-bubbles/${urnKey}/${rootRelativePath}`;
  const uploaded = await putObject(rootBlobPath, Buffer.from(rootBytes), "application/octet-stream");

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
      await putObject(`viewer-bubbles/${urnKey}/${relativePath}`, Buffer.from(dependencyBytes), "application/octet-stream");
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
