import { repriceEmbedPart } from "../../../embed_helpers/part-pipeline";
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
  if (!partId || resource !== "reprice") {
    return null;
  }

  return decodeURIComponent(partId);
};

export async function POST(req: Request) {
  try {
    const vercelPartId = getPartIdFromPath(req);
    if (!vercelPartId) {
      return json({ error: "Missing vercelPartId" }, 400);
    }

    const auth = await ensureGuestTokenForPart(req, vercelPartId);
    if (!auth.ok) {
      return auth.response;
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const result = await repriceEmbedPart(vercelPartId, new URL(req.url).origin, body as Record<string, unknown>);
    if (!result.ok) {
      return json({ error: result.error }, result.status);
    }

    return json({
      vercelPartId,
      pricing: result.pricing,
      selectedConfig: result.selectedConfig,
      warnings: result.warnings,
      status: "ready",
    });
  } catch (repriceError) {
    console.error("[embed] Failed to reprice part", repriceError);
    return json({ error: "Failed to reprice part" }, 500);
  }
}
