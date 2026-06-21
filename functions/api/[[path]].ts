/**
 * Cloudflare Pages Functions catch-all dispatcher for /api/*.
 *
 * Migration adapter: the existing Vercel-style route handlers in ../../api/**.cts
 * export Web-standard `GET`/`POST`/`OPTIONS`(...) functions that take a bare
 * `Request` and return a `Response`, and they self-parse dynamic path params
 * from `request.url`. That makes them portable to Cloudflare without edits —
 * this dispatcher just maps the URL to the right module + method.
 *
 * It also bridges Cloudflare's `env` bindings onto `process.env` so the
 * untouched handlers (which read `process.env.*`) keep working. Requires the
 * `nodejs_compat` compatibility flag (see wrangler.toml).
 *
 * NOTE: The Vercel code under ../../api is intentionally left unchanged.
 */

import * as autodesk from "../../api/autodesk.cts";
import * as bubbleTrigger from "../../api/bubble-trigger.cts";
import * as conversionStatus from "../../api/conversion-status.cts";
import * as digifabsterBatchPrice from "../../api/digifabster-batch-price.cts";
import * as digifabsterOrder from "../../api/digifabster-order.cts";
import * as digifabsterPlaceOrder from "../../api/digifabster-place-order.cts";
import * as digifabsterPriceTweak from "../../api/digifabster-price-tweak.cts";
import * as digifabsterTechnologies from "../../api/digifabster-technologies.cts";
import * as viewerSource from "../../api/viewer-source.cts";
import * as sheetNesting from "../../api/sheet-nesting.cts";
import * as embedSessionsIndex from "../../api/embed/sessions/index.cts";
import * as embedSession from "../../api/embed/sessions/[embedSessionId].cts";
import * as embedSessionFiles from "../../api/embed/sessions/[embedSessionId]/files.cts";
import * as embedPart from "../../api/embed/parts/[vercelPartId].cts";
import * as embedPartDefaults from "../../api/embed/parts/[vercelPartId]/defaults.cts";
import * as embedPartReprice from "../../api/embed/parts/[vercelPartId]/reprice.cts";
import * as embedPartViewer from "../../api/embed/parts/[vercelPartId]/viewer.cts";
import * as internalStartProcessing from "../../api/internal/parts/[vercelPartId]/start-processing.cts";

type Handler = (req: Request) => Response | Promise<Response>;
type RouteModule = Record<string, unknown>;

interface PagesContext {
  request: Request;
  env: Record<string, unknown>;
}

/** URL path (under the /api prefix) -> handler module. `:param` = one segment. */
const ROUTES: Array<{ pattern: string; mod: RouteModule }> = [
  { pattern: "/api/autodesk", mod: autodesk },
  { pattern: "/api/bubble-trigger", mod: bubbleTrigger },
  { pattern: "/api/conversion-status", mod: conversionStatus },
  { pattern: "/api/digifabster-batch-price", mod: digifabsterBatchPrice },
  { pattern: "/api/digifabster-order", mod: digifabsterOrder },
  { pattern: "/api/digifabster-place-order", mod: digifabsterPlaceOrder },
  { pattern: "/api/digifabster-price-tweak", mod: digifabsterPriceTweak },
  { pattern: "/api/digifabster-technologies", mod: digifabsterTechnologies },
  { pattern: "/api/viewer-source", mod: viewerSource },
  { pattern: "/api/sheet-nesting", mod: sheetNesting },
  { pattern: "/api/embed/sessions", mod: embedSessionsIndex },
  { pattern: "/api/embed/sessions/:embedSessionId", mod: embedSession },
  { pattern: "/api/embed/sessions/:embedSessionId/files", mod: embedSessionFiles },
  { pattern: "/api/embed/parts/:vercelPartId", mod: embedPart },
  { pattern: "/api/embed/parts/:vercelPartId/defaults", mod: embedPartDefaults },
  { pattern: "/api/embed/parts/:vercelPartId/reprice", mod: embedPartReprice },
  { pattern: "/api/embed/parts/:vercelPartId/viewer", mod: embedPartViewer },
  { pattern: "/api/internal/parts/:vercelPartId/start-processing", mod: internalStartProcessing },
];

const GLOBAL_CORS: Record<string, string> = {
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS,PATCH,DELETE,POST,PUT",
};

const splitSegments = (path: string): string[] => path.split("/").filter(Boolean);

const matchRoute = (pathname: string): RouteModule | null => {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const segments = splitSegments(normalized);

  for (const route of ROUTES) {
    const patternSegments = splitSegments(route.pattern);
    if (patternSegments.length !== segments.length) continue;

    const matches = patternSegments.every(
      (seg, i) => seg.startsWith(":") || seg === segments[i],
    );
    if (matches) return route.mod;
  }

  return null;
};

/** Copy Cloudflare env bindings onto process.env so untouched handlers can read them. */
const bridgeEnv = (env: Record<string, unknown>) => {
  const proc = (globalThis as { process?: { env?: Record<string, string> } }).process;
  if (!proc?.env) return;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && proc.env[key] === undefined) {
      proc.env[key] = value;
    }
  }
};

/**
 * Stash the R2 bucket binding on globalThis so the storage adapter
 * (api/embed_helpers/blob-storage.ts) can reach it without an `env` param.
 */
const bridgeR2 = (env: Record<string, unknown>) => {
  const bucket = env.BLOB_BUCKET;
  if (bucket) {
    (globalThis as { __ENTAG_R2__?: unknown }).__ENTAG_R2__ = bucket;
  }
};

const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(GLOBAL_CORS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const json = (payload: unknown, status: number): Response =>
  withCors(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const { request, env } = context;
  bridgeEnv(env);
  bridgeR2(env);

  const { pathname } = new URL(request.url);
  const mod = matchRoute(pathname);

  if (!mod) {
    return json({ error: "Not Found", path: pathname }, 404);
  }

  const method = request.method.toUpperCase();
  const handler = mod[method] as Handler | undefined;

  if (typeof handler !== "function") {
    // Generic preflight when the route doesn't define its own OPTIONS.
    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    return json({ error: "Method Not Allowed", method, path: pathname }, 405);
  }

  const response = await handler(request);
  return withCors(response);
};
