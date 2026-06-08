/*
 * Backfill Bubble orderparts (current month) missing URN + thumbnail.
 *
 * Flow per record:
 * 1) POST /api/autodesk
 * 2) Poll /api/conversion-status until viewer is terminal
 * 3) Generate Autodesk thumbnail (data URL)
 * 4) PATCH Bubble orderpart with URN + image
 * 5) Re-read record and verify urn/image fields
 *
 * Usage examples:
 *   node scripts/backfill-bubble-urn-thumbnail.cjs --limit=1
 *   node scripts/backfill-bubble-urn-thumbnail.cjs --max=20
 *   node scripts/backfill-bubble-urn-thumbnail.cjs --dry-run
 *
 * Required env:
 *   BUBBLE_API_TOKEN  (or BUBBLE_TOKEN)
 *
 * Optional env:
 *   BUBBLE_DATA_API_BASE_URL (default: https://app.entag.co/api/1.1/obj)
 *   PRODUCTION_BASE_URL      (default: https://project-entag-3d-viewer.vercel.app)
 *   BUBBLE_VERSION           (default: live)
 *   POLL_MAX_ATTEMPTS        (default: 40)
 *   POLL_INTERVAL_MS         (default: 12000)
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

const getArgValue = (name) => {
  const prefix = `--${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

const hasFlag = (name) => args.includes(`--${name}`);

const DRY_RUN = hasFlag("dry-run");
const LIMIT = Number(getArgValue("limit") || "0");
const MAX = Number(getArgValue("max") || "0");
const INCLUDE_3MF = hasFlag("include-3mf");
const WINDOW_DAYS = Math.max(0, Number(getArgValue("window-days") || "0"));
const INCLUDE_MISSING_URN_WITH_IMAGE = hasFlag("include-missing-urn-with-image");

const BASE_URL = (process.env.PRODUCTION_BASE_URL || "https://project-entag-3d-viewer.vercel.app").trim();
const BUBBLE_BASE = (
  process.env.BUBBLE_DATA_API_BASE_URL ||
  "https://app.entag.co/api/1.1/obj"
).trim();
const BUBBLE_VERSION = (process.env.BUBBLE_VERSION || "live").trim();
const POLL_MAX_ATTEMPTS = Math.max(1, Number(process.env.POLL_MAX_ATTEMPTS || 40));
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 12000));
const UPLOAD_MAX_ATTEMPTS = Math.max(1, Number(process.env.UPLOAD_MAX_ATTEMPTS || 3));

const BUBBLE_TOKEN = (
  process.env.BUBBLE_API_TOKEN ||
  process.env.BUBBLE_TOKEN ||
  ""
).trim();

const CREDS_PATH = path.join(__dirname, "..", "creds.txt");
const REPORT_PATH = path.join(__dirname, "..", "bubble-urn-thumbnail-backfill-report.json");

const KNOWN_INCOMPATIBLE_EXTENSIONS = new Set(["3mf"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (message) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

const parseJson = async (response) => {
  const text = await response.text();
  if (!text.trim()) {
    return { text, json: null };
  }

  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
};

const readAutodeskCreds = () => {
  const raw = fs.readFileSync(CREDS_PATH, "utf8").trim();
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    throw new Error("Invalid creds.txt format. Expected client_id:client_secret");
  }

  return {
    client_id: raw.slice(0, idx).trim(),
    client_secret: raw.slice(idx + 1).trim(),
  };
};

const getExtensionFromFileUrl = (rawFileUrl) => {
  if (!rawFileUrl || typeof rawFileUrl !== "string") {
    return "";
  }

  const tail = rawFileUrl.split("?")[0].split("#")[0].split("/").pop() || "";
  const idx = tail.lastIndexOf(".");
  if (idx === -1 || idx === tail.length - 1) {
    return "";
  }

  return tail.slice(idx + 1).toLowerCase();
};

const getFileNameFromUrl = (rawFileUrl) => {
  if (!rawFileUrl || typeof rawFileUrl !== "string") {
    return "source-model";
  }

  const tail = rawFileUrl.split("?")[0].split("#")[0].split("/").pop() || "source-model";
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
};

const toAbsoluteUrl = (maybeRelativeUrl) => {
  if (!maybeRelativeUrl || typeof maybeRelativeUrl !== "string") {
    return "";
  }

  if (maybeRelativeUrl.startsWith("http://") || maybeRelativeUrl.startsWith("https://")) {
    return maybeRelativeUrl;
  }

  if (maybeRelativeUrl.startsWith("//")) {
    return `https:${maybeRelativeUrl}`;
  }

  return maybeRelativeUrl;
};

const bubbleRequest = async ({ method, pathName, body }) => {
  const url = `${BUBBLE_BASE.replace(/\/$/, "")}/${pathName.replace(/^\//, "")}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${BUBBLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const parsed = await parseJson(response);

  return {
    status: response.status,
    ok: response.ok,
    ...parsed,
  };
};

const appRequest = async ({ method, pathName, body }) => {
  const url = `${BASE_URL.replace(/\/$/, "")}/${pathName.replace(/^\//, "")}`;
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const parsed = await parseJson(response);

  return {
    status: response.status,
    ok: response.ok,
    ...parsed,
  };
};

const shouldRetryUpload = (responseLike) => {
  const status = Number(responseLike?.status || 0);
  const text = String(responseLike?.text || "").toLowerCase();
  if (status === 502 || status === 503 || status === 504) {
    return true;
  }

  if (status >= 500 && text.includes("timeout")) {
    return true;
  }

  if (text.includes("function_invocation_timeout")) {
    return true;
  }

  return false;
};

const autodeskUploadWithRetry = async ({ sourceUrl, partId, creds }) => {
  let last = null;

  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    const upload = await appRequest({
      method: "POST",
      pathName: "api/autodesk",
      body: {
        url: sourceUrl,
        part_id: partId,
        version: BUBBLE_VERSION,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        auto_modelid: false,
        bubble_data_api_base_url: BUBBLE_BASE,
        bubble_api_token: BUBBLE_TOKEN,
      },
    });

    last = upload;

    if (upload.ok && upload.json?.urn) {
      return upload;
    }

    const retryable = shouldRetryUpload(upload);
    if (!retryable || attempt >= UPLOAD_MAX_ATTEMPTS) {
      return upload;
    }

    const waitMs = attempt * 5000;
    log(`upload retry part=${partId} attempt=${attempt} status=${upload.status} waitMs=${waitMs}`);
    await sleep(waitMs);
  }

  return last;
};

const resolveFilterWindow = () => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

  if (WINDOW_DAYS > 0) {
    const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return {
      label: `last_${WINDOW_DAYS}_days`,
      start: windowStart,
      startIso: windowStart.toISOString(),
    };
  }

  return {
    label: "current_month",
    start: monthStart,
    startIso: monthStart.toISOString(),
  };
};

const fetchCandidates = async () => {
  const limit = 100;
  let cursor = 0;
  const all = [];
  const filterWindow = resolveFilterWindow();

  while (true) {
    const pathName = `orderpart?limit=${limit}&cursor=${cursor}&sort_field=Created%20Date&descending=true`;
    const page = await bubbleRequest({ method: "GET", pathName });
    if (!page.ok || !page.json?.response?.results) {
      throw new Error(`Bubble pagination failed at cursor=${cursor} (HTTP ${page.status})`);
    }

    const results = page.json.response.results;
    if (!Array.isArray(results) || results.length === 0) {
      break;
    }

    all.push(...results);

    const last = results[results.length - 1];
    const lastDate = new Date(last["Created Date"]);
    if (!Number.isNaN(lastDate.valueOf()) && lastDate < filterWindow.start) {
      break;
    }

    const remaining = Number(page.json?.response?.remaining || 0);
    if (!Number.isFinite(remaining) || remaining <= 0) {
      break;
    }

    cursor += limit;
  }

  const windowRecords = all.filter((row) => {
    const createdAt = new Date(row["Created Date"]);
    return !Number.isNaN(createdAt.valueOf()) && createdAt >= filterWindow.start;
  });

  const missingBoth = windowRecords.filter((row) => {
    const urn = row.urn;
    const image = row.image;
    const noUrn = urn === null || urn === undefined || String(urn).trim() === "";
    const noImage = image === null || image === undefined || String(image).trim() === "";
    return noUrn && noImage;
  });

  const missingUrnWithImage = windowRecords.filter((row) => {
    const urn = row.urn;
    const image = row.image;
    const noUrn = urn === null || urn === undefined || String(urn).trim() === "";
    const hasImage = image !== null && image !== undefined && String(image).trim() !== "";
    return noUrn && hasImage;
  });

  return {
    filterLabel: filterWindow.label,
    filterStart: filterWindow.startIso,
    windowRecords,
    missingBoth,
    missingUrnWithImage,
  };
};

const pollConversionStatus = async ({ urn, client_id, client_secret, partId, sourceUrl, sourceFileName }) => {
  let last = null;

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
    const status = await appRequest({
      method: "POST",
      pathName: "api/conversion-status",
      body: {
        urn,
        client_id,
        client_secret,
        part_id: partId,
        version: BUBBLE_VERSION,
        source_url: sourceUrl,
        source_file_name: sourceFileName,
        bubble_data_api_base_url: BUBBLE_BASE,
        bubble_api_token: BUBBLE_TOKEN,
      },
    });

    last = status;

    const viewer = status.json?.viewer || {};
    const quote = status.json?.quote || {};
    const viewerDone = viewer.status === "success" || viewer.status === "failed";
    const quoteDone =
      quote.status === "success" ||
      quote.status === "failed" ||
      quote.status === "not_required";

    log(
      `poll part=${partId} attempt=${attempt} viewer=${viewer.status || "unknown"}/${viewer.mode || "n/a"} quote=${quote.status || "unknown"}`
    );

    if (viewerDone && quoteDone) {
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return last;
};

const fetchAutodeskThumbnailDataUrl = async ({ urn, accessToken }) => {
  if (!urn || !accessToken) {
    return null;
  }

  const sizes = [400, 300, 200, 100];

  for (const size of sizes) {
    const url = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(
      urn
    )}/thumbnail?width=${size}&height=${size}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      continue;
    }

    const mimeType = response.headers.get("content-type") || "image/png";
    const bytes = Buffer.from(await response.arrayBuffer());
    const base64 = bytes.toString("base64");
    return `data:${mimeType};base64,${base64}`;
  }

  return null;
};

const backfillOne = async ({ row, creds }) => {
  const id = row._id;
  const sourceUrl = toAbsoluteUrl(row.file);
  const sourceFileName = getFileNameFromUrl(row.file);
  const existingImage =
    typeof row.image === "string" && row.image.trim().length > 0 ? row.image.trim() : null;

  if (!id || !sourceUrl) {
    return {
      id,
      status: "skipped",
      reason: "missing_id_or_file_url",
    };
  }

  const ext = getExtensionFromFileUrl(sourceUrl);
  if (!INCLUDE_3MF && KNOWN_INCOMPATIBLE_EXTENSIONS.has(ext)) {
    return {
      id,
      ext,
      status: "skipped",
      reason: "known_incompatible_with_svf_pipeline",
    };
  }

  if (DRY_RUN) {
    return {
      id,
      ext,
      status: "dry_run",
      sourceUrl,
    };
  }

  const upload = await autodeskUploadWithRetry({
    sourceUrl,
    partId: id,
    creds,
  });

  if (!upload.ok || !upload.json?.urn) {
    return {
      id,
      ext,
      status: "failed",
      step: "autodesk_upload",
      httpStatus: upload.status,
      error: upload.json?.error || upload.text?.slice(0, 300) || "Upload failed",
    };
  }

  const urn = upload.json.urn;
  let viewerAccessToken = upload.json.accessToken || null;

  const status = await pollConversionStatus({
    urn,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    partId: id,
    sourceUrl,
    sourceFileName,
  });

  if (status?.json?.viewer?.accessToken) {
    viewerAccessToken = status.json.viewer.accessToken;
  }

  const viewerStatus = status?.json?.viewer?.status || "unknown";
  if (viewerStatus === "failed") {
    return {
      id,
      ext,
      status: "failed",
      step: "viewer_translation",
      urn,
      error: status?.json?.error || status?.json?.viewer?.localError || "Viewer failed",
    };
  }

  let thumbnailDataUrl = existingImage;
  let imageSource = existingImage ? "existing" : "fetched";

  if (!thumbnailDataUrl) {
    thumbnailDataUrl = await fetchAutodeskThumbnailDataUrl({ urn, accessToken: viewerAccessToken });
    if (!thumbnailDataUrl) {
      return {
        id,
        ext,
        status: "failed",
        step: "thumbnail_fetch",
        urn,
        error: "Could not fetch Autodesk thumbnail",
      };
    }
  }

  const patch = await bubbleRequest({
    method: "PATCH",
    pathName: `orderpart/${id}`,
    body: {
      urn,
      image: thumbnailDataUrl,
    },
  });

  if (!patch.ok) {
    return {
      id,
      ext,
      status: "failed",
      step: "bubble_patch_urn_image",
      urn,
      httpStatus: patch.status,
      error: patch.json?.error || patch.text?.slice(0, 300) || "Bubble urn/image patch failed",
    };
  }

  await sleep(1500);

  const verify = await bubbleRequest({
    method: "GET",
    pathName: `orderpart/${id}`,
  });

  const updated = verify.json?.response || {};
  const finalUrn = updated.urn || null;
  const finalImage = updated.image || null;

  const hasUrn = typeof finalUrn === "string" && finalUrn.trim().length > 0;
  const hasImage = typeof finalImage === "string" && finalImage.trim().length > 0;

  if (!hasUrn || !hasImage) {
    return {
      id,
      ext,
      status: "failed",
      step: "verification",
      urn,
      hasUrn,
      hasImage,
      verifyStatus: verify.status,
      imagePreview: hasImage ? finalImage.slice(0, 120) : null,
    };
  }

  return {
    id,
    ext,
    status: "updated",
    urn: finalUrn,
    image: finalImage,
    imageSource,
    viewerStatus,
    quoteStatus: status?.json?.quote?.status || null,
    quoteUploadStatus: status?.json?.quote?.upload?.status || null,
  };
};

const buildSummary = (results) => {
  const summary = {
    total: results.length,
    updated: results.filter((item) => item.status === "updated").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    dryRun: results.filter((item) => item.status === "dry_run").length,
  };

  const byExtension = {};
  for (const row of results) {
    const ext = row.ext || "(none)";
    if (!byExtension[ext]) {
      byExtension[ext] = { total: 0, updated: 0, failed: 0, skipped: 0, dryRun: 0 };
    }

    byExtension[ext].total += 1;
    if (row.status === "updated") byExtension[ext].updated += 1;
    if (row.status === "failed") byExtension[ext].failed += 1;
    if (row.status === "skipped") byExtension[ext].skipped += 1;
    if (row.status === "dry_run") byExtension[ext].dryRun += 1;
  }

  return { summary, byExtension };
};

const main = async () => {
  if (!DRY_RUN && !BUBBLE_TOKEN) {
    throw new Error("Missing BUBBLE_API_TOKEN (or BUBBLE_TOKEN) env var");
  }

  const creds = readAutodeskCreds();

  log(`base=${BASE_URL}`);
  log(`bubbleBase=${BUBBLE_BASE}`);
  log(`version=${BUBBLE_VERSION}`);
  log(`dryRun=${DRY_RUN}`);

  const candidateSet = await fetchCandidates();
  const results = [];

  log(`window=${candidateSet.filterLabel}`);
  log(`windowStart=${candidateSet.filterStart}`);
  log(`recordsInWindow=${candidateSet.windowRecords.length}`);
  log(`missingUrnAndImage=${candidateSet.missingBoth.length}`);
  log(`missingUrnWithImage=${candidateSet.missingUrnWithImage.length}`);
  log(`includeMissingUrnWithImage=${INCLUDE_MISSING_URN_WITH_IMAGE}`);

  const selected = [...candidateSet.missingBoth];
  if (INCLUDE_MISSING_URN_WITH_IMAGE) {
    selected.push(...candidateSet.missingUrnWithImage);
  }

  const seen = new Set();
  let queue = selected
    .filter((row) => {
      const id = row?._id;
      if (!id || seen.has(id)) {
        return false;
      }

      seen.add(id);
      return true;
    })
    .map((row) => {
    const sourceUrl = toAbsoluteUrl(row.file);
    return {
      ...row,
      file: sourceUrl,
    };
    });

  if (LIMIT > 0) {
    queue = queue.slice(0, LIMIT);
  }

  if (MAX > 0) {
    queue = queue.slice(0, MAX);
  }

  log(`queued=${queue.length}`);

  for (const [index, row] of queue.entries()) {
    const id = row._id;
    const ext = getExtensionFromFileUrl(row.file);
    log(`processing ${index + 1}/${queue.length} id=${id} ext=${ext || "(none)"}`);

    try {
      const result = await backfillOne({ row, creds });
      results.push(result);
      log(`result id=${id} status=${result.status}${result.step ? ` step=${result.step}` : ""}`);
    } catch (error) {
      results.push({
        id,
        ext,
        status: "failed",
        step: "unexpected_error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
      log(`result id=${id} status=failed step=unexpected_error`);
    }
  }

  const aggregates = buildSummary(results);

  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    bubbleBase: BUBBLE_BASE,
    bubbleVersion: BUBBLE_VERSION,
    dryRun: DRY_RUN,
    include3mf: INCLUDE_3MF,
    windowLabel: candidateSet.filterLabel,
    windowStart: candidateSet.filterStart,
    recordsInWindow: candidateSet.windowRecords.length,
    missingUrnAndImage: candidateSet.missingBoth.length,
    missingUrnWithImage: candidateSet.missingUrnWithImage.length,
    includeMissingUrnWithImage: INCLUDE_MISSING_URN_WITH_IMAGE,
    queued: queue.length,
    ...aggregates,
    results,
    completedAt: new Date().toISOString(),
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  log(`updated=${report.summary.updated} failed=${report.summary.failed} skipped=${report.summary.skipped} dryRun=${report.summary.dryRun}`);
  log(`report=${path.basename(REPORT_PATH)}`);

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
