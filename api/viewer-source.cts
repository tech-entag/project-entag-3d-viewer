import { ensureViewerBubbleInBlob, getViewerCacheRecord } from "./autodesk_helpers/viewer-cache";

export const config = {
  maxDuration: 60,
};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const getUrnFromQuery = (req: Request) => {
  const url = new URL(req.url);
  return url.searchParams.get("urn");
};

const normalizeQueryToken = (value: string | null) => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "undefined" || normalized === "null") {
    return null;
  }

  return trimmed;
};

const getAccessTokenFromQuery = (req: Request) => {
  const url = new URL(req.url);
  return normalizeQueryToken(url.searchParams.get("access_token"))
    || normalizeQueryToken(url.searchParams.get("accessToken"));
};

export async function GET(req: Request) {
  try {
    const urn = getUrnFromQuery(req);
    const accessToken = getAccessTokenFromQuery(req);

    if (!urn) {
      return json({ error: "Missing required parameter: urn" }, 400);
    }

    const cached = await getViewerCacheRecord(urn);
    if (cached?.localModelUrl) {
      return json({
        success: true,
        urn,
        mode: "local",
        localModelUrl: cached.localModelUrl,
        bubbleUrl: cached.localModelUrl,
        storedAt: cached.storedAt,
        source: "cache",
      });
    }

    if (accessToken) {
      let persisted;
      try {
        persisted = await ensureViewerBubbleInBlob(urn, accessToken);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown local source generation error.";
        const isUnauthorized = /unauthorized|401|auth-001/i.test(message);

        if (isUnauthorized) {
          return json(
            {
              error: "Autodesk access token is not authorized for this manifest.",
              status: "unauthorized",
              hint: "Request a fresh viewer link or poll conversion-status with Autodesk credentials to refresh the local cache.",
              reason: "autodesk_manifest_unauthorized",
            },
            401
          );
        }

        return json(
          {
            error: "Failed to generate local viewer source from Autodesk manifest.",
            status: "upstream_error",
            details: message,
          },
          502
        );
      }

      if (persisted.localModelUrl) {
        return json({
          success: true,
          urn,
          mode: "local",
          localModelUrl: persisted.localModelUrl,
          bubbleUrl: persisted.localModelUrl,
          storedAt: new Date().toISOString(),
          source: persisted.fromCache ? "cache" : "generated",
        });
      }

      if (persisted.status === "blob_unavailable") {
        return json(
          {
            error: "BLOB_READ_WRITE_TOKEN is not configured. Local viewer source cannot be persisted.",
            status: "unavailable",
          },
          503
        );
      }

      if (persisted.viewerStatus === "failed") {
        return json(
          {
            error: "Viewer translation failed before a local model could be cached.",
            status: "failed",
            viewerStatus: persisted.viewerStatus,
          },
          424
        );
      }

      return json(
        {
          success: false,
          urn,
          mode: "processing",
          status: "processing",
          viewerStatus: persisted.viewerStatus,
          retryAfterMs: 4000,
          hint: "Autodesk translation is still preparing the local viewer source.",
        },
        202
      );
    }

    return json(
      {
        error: "No local viewer model is cached for this URN yet.",
        status: "queued",
        hint: "Provide access_token to allow on-demand local cache generation.",
      },
      404
    );
  } catch (error) {
    console.error("Error in viewer-source endpoint:", error);
    return json({ error: "Failed to resolve viewer source" }, 500);
  }
}
