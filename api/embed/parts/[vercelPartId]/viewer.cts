import { kickoffPartProcessing, refreshPartProcessing } from "../../../embed_helpers/part-pipeline";
import { ensureGuestTokenForPart } from "../../../embed_helpers/request-auth";

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
  const partsIndex = segments.lastIndexOf("parts");
  if (partsIndex < 0) {
    return null;
  }

  const partId = segments[partsIndex + 1];
  const resource = segments[partsIndex + 2];
  if (!partId || resource !== "viewer") {
    return null;
  }

  return decodeURIComponent(partId);
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

    const origin = new URL(req.url).origin;
    let part = auth.part;

    if (!part.autodesk.urn) {
      const started = await kickoffPartProcessing(vercelPartId, origin);
      if (started) {
        part = started;
      }
    } else {
      const refreshed = await refreshPartProcessing(vercelPartId, origin);
      if (refreshed) {
        part = refreshed;
      }
    }

    if (part.status === "failed") {
      return json(
        {
          vercelPartId,
          viewerStatus: "failed",
          error: part.failure.message || "Part processing failed before viewer readiness.",
        },
        424
      );
    }

    if (part.viewer?.status === "success" && part.viewer.localModelUrl) {
      return json({
        vercelPartId,
        viewerStatus: "ready",
        viewerUrl: part.viewer.localModelUrl,
        thumbnailUrl: null,
      });
    }

    return json(
      {
        vercelPartId,
        viewerStatus: "processing",
        retryAfterMs: 5000,
        stage: part.processingStage,
      },
      202
    );
  } catch (viewerError) {
    console.error("[embed] Failed to resolve part viewer state", viewerError);
    return json({ error: "Failed to resolve part viewer state" }, 500);
  }
}
