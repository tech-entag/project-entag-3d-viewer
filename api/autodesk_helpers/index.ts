import axios from "axios";

type TranslationFormat = {
  type: string;
  views?: string[];
  advanced?: Record<string, unknown>;
};

type AutodeskSignedUploadResponse = {
  uploadKey: string;
  urls: string[];
};

type AutodeskFinalizeUploadResponse = {
  objectId: string;
  objectKey: string;
};

type ManifestDerivativeMatch = {
  derivativeUrn: string;
  status: string;
  progress: string;
};

type ManifestNode = {
  outputType?: string;
  urn?: string;
  status?: string;
  progress?: string;
  children?: ManifestNode[];
};

const fetchAccessToken = async (clientId: string, clientSecret: string) => {
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch("https://developer.api.autodesk.com/authentication/v2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope:
        "code:all data:write data:read data:create bucket:create bucket:delete bucket:read viewables:read",
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch access token: ${response.statusText}`);
  }

  const data = await response.json();
  return data.access_token as string;
};

const createBucket = async (accessToken: string) => {
  const bucketData = {
    bucketKey: Date.now().toString(),
    access: "full",
    policyKey: "temporary",
  };

  const response = await fetch("https://developer.api.autodesk.com/oss/v2/buckets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(bucketData),
  });

  if (!response.ok) {
    throw new Error(`Failed to create bucket: ${response.statusText}`);
  }

  const data = await response.json();
  return data.bucketKey as string;
};

const obtainSignedUrl = async (
  bucketKey: string,
  accessToken: string,
  selectedFile: File
): Promise<AutodeskSignedUploadResponse> => {
  const response = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(selectedFile.name)}/signeds3upload?minutesExpiration=10`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to obtain signed URL: ${response.statusText}`);
  }

  return (await response.json()) as AutodeskSignedUploadResponse;
};

const uploadFile = async (url: string, selectedFile: File) => {
  const arrayBuffer = await selectedFile.arrayBuffer();
  const binaryData = new Uint8Array(arrayBuffer);

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: binaryData,
  });

  if (!response.ok) {
    throw new Error("Failed to upload file to Autodesk signed URL.");
  }

  return response;
};

const finalizeUpload = async (
  bucketKey: string,
  uploadKey: string,
  accessToken: string,
  selectedFile: File
): Promise<AutodeskFinalizeUploadResponse> => {
  const response = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(selectedFile.name)}/signeds3upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uploadKey }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to finalize upload: ${response.statusText}`);
  }

  return (await response.json()) as AutodeskFinalizeUploadResponse;
};

const startTranslation = async (
  ossEncodedSourceFileURN: string,
  ossSourceFileObjectKey: string,
  accessToken: string,
  extraFormats: TranslationFormat[] = []
) => {
  const baseFormats: TranslationFormat[] = [
    {
      type: "svf",
      views: ["2d", "3d"],
    },
    {
      type: "thumbnail",
      advanced: {
        width: 400,
        height: 400,
      },
    },
  ];

  const seen = new Set(baseFormats.map((item) => item.type.toLowerCase()));
  const mergedFormats = [...baseFormats];

  for (const format of extraFormats) {
    const key = format.type.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mergedFormats.push(format);
  }

  const input = {
    urn: ossEncodedSourceFileURN,
    compressedUrn: false,
  } as {
    urn: string;
    compressedUrn: false;
    rootFilename?: string;
  };

  // rootFilename is only valid for compressed archive inputs.
  if (/\.(zip)$/i.test(ossSourceFileObjectKey)) {
    input.rootFilename = ossSourceFileObjectKey;
  }

  const response = await fetch("https://developer.api.autodesk.com/modelderivative/v2/designdata/job", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input,
      output: {
        destination: {
          region: "us",
        },
        formats: mergedFormats,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to start translation: ${response.statusText}`);
  }

  return response.json();
};

const getManifest = async (urn: string, accessToken: string) => {
  const response = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch manifest: ${response.statusText}`);
  }

  return response.json();
};

const getThumbnail = async (urn: string, accessToken: string) => {
  const response = await fetch(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/thumbnail?width=400&height=400`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch thumbnail: ${response.statusText}`);
  }

  return response.arrayBuffer();
};

const findDerivativeByType = (
  manifest: { derivatives?: ManifestNode[] } | null | undefined,
  targetType: string
): ManifestDerivativeMatch | null => {
  const normalizedType = targetType.toLowerCase();
  type StackItem = {
    node: ManifestNode;
    inTargetBranch: boolean;
    inheritedStatus?: string;
    inheritedProgress?: string;
  };

  const stack: StackItem[] = Array.isArray(manifest?.derivatives)
    ? manifest.derivatives.map((node) => {
        const outputType = typeof node?.outputType === "string" ? node.outputType.toLowerCase() : "";
        return {
          node,
          inTargetBranch: outputType === normalizedType,
          inheritedStatus: typeof node?.status === "string" ? node.status : undefined,
          inheritedProgress: typeof node?.progress === "string" ? node.progress : undefined,
        };
      })
    : [];

  while (stack.length > 0) {
    const currentItem = stack.pop();
    const current = currentItem?.node;
    const outputType = typeof current?.outputType === "string" ? current.outputType.toLowerCase() : "";
    const role = typeof (current as { role?: string } | undefined)?.role === "string"
      ? ((current as { role?: string }).role || "").toLowerCase()
      : "";
    const derivativeUrn = typeof current?.urn === "string" ? current.urn : null;
    const effectiveStatus = typeof current?.status === "string"
      ? current.status
      : currentItem?.inheritedStatus;
    const effectiveProgress = typeof current?.progress === "string"
      ? current.progress
      : currentItem?.inheritedProgress;
    const inTargetBranch = Boolean(currentItem?.inTargetBranch || outputType === normalizedType);

    if (outputType === normalizedType && derivativeUrn) {
      return {
        derivativeUrn,
        status: effectiveStatus || "unknown",
        progress: effectiveProgress || "0%",
      };
    }

    const isQuoteTarget = normalizedType === "step" || normalizedType === "dwg";

    // Some manifests place downloadable URNs in descendants under the target branch.
    // Keep SVF/SVF2 strict to graphics URNs, but allow STEP/DWG descendants by role.
    if (inTargetBranch && derivativeUrn && (role === "graphics" || (isQuoteTarget && role === normalizedType))) {
      return {
        derivativeUrn,
        status: effectiveStatus || "unknown",
        progress: effectiveProgress || "0%",
      };
    }

    if (Array.isArray(current?.children)) {
      for (const child of current.children) {
        stack.push({
          node: child,
          inTargetBranch,
          inheritedStatus: effectiveStatus,
          inheritedProgress: effectiveProgress,
        });
      }
    }
  }

  return null;
};

const getDerivativeDownloadUrl = async (
  urn: string,
  derivativeUrn: string,
  accessToken: string
) => {
  const encodedDerivative = encodeURIComponent(derivativeUrn);
  const response = await axios.get(
    `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest/${encodedDerivative}/signedcookies`,
    {
      timeout: 45_000,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const data = response.data as {
    url?: string;
    size?: number;
    cookie?: Record<string, string>;
  };

  const cookieHeaders = response.headers["set-cookie"];
  const headerCookies: Record<string, string> = {};

  const cookieValues = Array.isArray(cookieHeaders)
    ? cookieHeaders
    : typeof cookieHeaders === "string"
      ? [cookieHeaders]
      : [];

  for (const cookie of cookieValues) {
    const [pair] = cookie.split(";");
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (key) {
      headerCookies[key] = value;
    }
  }

  if (!data?.url) {
    throw new Error("Failed to get derivative signed URL: missing URL in Autodesk response.");
  }

  return {
    url: data.url,
    size: data.size ?? -1,
    cookies: {
      ...(data.cookie ?? {}),
      ...headerCookies,
    },
  };
};

const downloadDerivativeFile = async (
  signedUrl: string,
  cookies: Record<string, string> = {},
  timeoutMs = 45_000
) => {
  const cookieHeader = Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");

  const response = await axios.get<ArrayBuffer>(signedUrl, {
    responseType: "arraybuffer",
    timeout: timeoutMs,
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
  });

  return new Uint8Array(response.data);
};

export {
  fetchAccessToken,
  createBucket,
  obtainSignedUrl,
  uploadFile,
  finalizeUpload,
  startTranslation,
  getManifest,
  getThumbnail,
  findDerivativeByType,
  getDerivativeDownloadUrl,
  downloadDerivativeFile,
};
