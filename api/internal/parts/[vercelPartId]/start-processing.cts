import { kickoffPartProcessing, toEmbedPartStatePayload } from "../../../embed_helpers/part-pipeline";

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

  const vercelPartId = segments[partsIndex + 1];
  const action = segments[partsIndex + 2];
  if (!vercelPartId || action !== "start-processing") {
    return null;
  }

  return decodeURIComponent(vercelPartId);
};

const authorizeInternalCall = (req: Request) => {
  const requiredSecret = process.env.EMBED_INTERNAL_API_SECRET?.trim();
  if (!requiredSecret) {
    return true;
  }

  const headerSecret =
    req.headers.get("x-embed-internal-key")
    || req.headers.get("X-Embed-Internal-Key")
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    || "";

  return headerSecret.trim() === requiredSecret;
};

export async function POST(req: Request) {
  try {
    if (!authorizeInternalCall(req)) {
      return json({ error: "Unauthorized internal request" }, 401);
    }

    const vercelPartId = getPartIdFromPath(req);
    if (!vercelPartId) {
      return json({ error: "Missing vercelPartId in route path" }, 400);
    }

    let force = false;
    try {
      const body = await req.json();
      if (body && typeof body === "object" && (body as Record<string, unknown>).force === true) {
        force = true;
      }
    } catch {
      // Body is optional.
    }

    const origin = new URL(req.url).origin;
    const part = await kickoffPartProcessing(vercelPartId, origin, { force });
    if (!part) {
      return json({ error: "Part not found" }, 404);
    }

    return json(
      {
        success: true,
        force,
        state: toEmbedPartStatePayload(part),
      },
      part.status === "ready" ? 200 : 202
    );
  } catch (startError) {
    console.error("[embed] Failed to start part processing", startError);
    return json({ error: "Failed to start part processing" }, 500);
  }
}
