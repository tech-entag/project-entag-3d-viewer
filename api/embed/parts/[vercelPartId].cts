import { ensurePartDefaultsSnapshot, kickoffPartProcessing, refreshPartProcessing, toEmbedPartStatePayload } from "../../embed_helpers/part-pipeline";
import { ensureGuestTokenForPart } from "../../embed_helpers/request-auth";

export const config = {
  maxDuration: 60,
};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const getPartIdFromPath = (req: Request) => {
  const pathname = new URL(req.url).pathname;
  const segments = pathname.split("/").filter(Boolean);
  return segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : null;
};

const isDisabled = (value: string | null) => {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
};

export async function GET(req: Request) {
  try {
    const vercelPartId = getPartIdFromPath(req);
    if (!vercelPartId) {
      return json({ error: "Missing vercelPartId" }, 400);
    }

    const auth = await ensureGuestTokenForPart(req, vercelPartId);
    if (!auth.ok) {
      return auth.response;
    }

    const url = new URL(req.url);
    const autoStart = !isDisabled(url.searchParams.get("autoStart"));
    const shouldRefresh = !isDisabled(url.searchParams.get("refresh"));

    const origin = new URL(req.url).origin;
    let part = auth.part;

    if (autoStart && !part.autodesk.urn) {
      const started = await kickoffPartProcessing(vercelPartId, origin);
      if (started) {
        part = started;
      }
    } else if (shouldRefresh) {
      const refreshed = await refreshPartProcessing(vercelPartId, origin);
      if (refreshed) {
        part = refreshed;
      }
    }

    if (part.quote?.upload?.objectModelId && !part.defaultsSnapshot) {
      const withDefaults = await ensurePartDefaultsSnapshot(vercelPartId, origin);
      if (withDefaults) {
        part = withDefaults;
      }
    }

    return json(
      {
        success: part.status !== "failed",
        state: toEmbedPartStatePayload(part),
      },
      part.status === "ready" ? 200 : part.status === "failed" ? 424 : 202
    );
  } catch (partError) {
    console.error("[embed] Failed to read part processing state", partError);
    return json({ error: "Failed to read part processing state" }, 500);
  }
}
