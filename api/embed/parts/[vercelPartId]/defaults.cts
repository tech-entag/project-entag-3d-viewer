import { ensurePartDefaultsSnapshot, kickoffPartProcessing, refreshPartProcessing } from "../../../embed_helpers/part-pipeline";
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
  if (!partId || resource !== "defaults") {
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

    const withDefaults = await ensurePartDefaultsSnapshot(vercelPartId, origin);
    if (withDefaults) {
      part = withDefaults;
    }

    if (!part.defaultsSnapshot) {
      return json(
        {
          vercelPartId,
          status: "pending",
          reason: "default_snapshot_not_ready",
        },
        202
      );
    }

    const objectModelId = part.quote?.upload?.objectModelId ?? null;
    const responsePayload = {
      vercelPartId,
      defaultConfigSnapshotId: part.defaultsSnapshot.snapshotId,
      digifabsterObjectModelId: objectModelId,
      digifabsterOrderId: part.quote?.upload?.orderId ?? null,
      defaults: part.defaultsSnapshot.defaults,
      pricing: part.defaultsSnapshot.pricing,
      warnings: part.defaultsSnapshot.warnings,
      status: part.defaultsSnapshot.status,
    };

    return json(responsePayload, part.defaultsSnapshot.status === "ready" ? 200 : 202);
  } catch (defaultsError) {
    console.error("[embed] Failed to resolve part defaults", defaultsError);
    return json({ error: "Failed to resolve part defaults" }, 500);
  }
}
