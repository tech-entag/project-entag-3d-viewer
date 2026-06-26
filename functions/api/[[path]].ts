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
import * as digifabsterPartData from "../../api/digifabster-part-data.cts";
import * as digifabsterPartDataAdmin from "../../api/digifabster-part-data-admin.cts";
import * as digifabsterPartDataConfig from "../../api/digifabster-part-data-config.cts";
import * as digifabsterPlaceOrder from "../../api/digifabster-place-order.cts";
import * as digifabsterPriceTweak from "../../api/digifabster-price-tweak.cts";
import * as digifabsterSuitableMaterials from "../../api/digifabster-suitable-materials.cts";
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
import {
  writeApiLog,
  queryApiLogs,
  truncate,
  type D1Like,
  type ApiLogEntry,
} from "./_logs";

type Handler = (req: Request) => Response | Promise<Response>;
type RouteModule = Record<string, unknown>;

interface PagesContext {
  request: Request;
  env: Record<string, unknown>;
  /** Provided by the Pages runtime; absent under some local setups. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** URL path (under the /api prefix) -> handler module. `:param` = one segment. */
const ROUTES: Array<{ pattern: string; mod: RouteModule }> = [
  { pattern: "/api/autodesk", mod: autodesk },
  { pattern: "/api/bubble-trigger", mod: bubbleTrigger },
  { pattern: "/api/conversion-status", mod: conversionStatus },
  { pattern: "/api/digifabster-batch-price", mod: digifabsterBatchPrice },
  { pattern: "/api/digifabster-order", mod: digifabsterOrder },
  { pattern: "/api/digifabster-part-data", mod: digifabsterPartData },
  { pattern: "/api/digifabster-part-data-admin", mod: digifabsterPartDataAdmin },
  { pattern: "/api/digifabster-part-data-config", mod: digifabsterPartDataConfig },
  { pattern: "/api/digifabster-place-order", mod: digifabsterPlaceOrder },
  { pattern: "/api/digifabster-price-tweak", mod: digifabsterPriceTweak },
  { pattern: "/api/digifabster-suitable-materials", mod: digifabsterSuitableMaterials },
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

/** Stash the D1 logging binding so the outbound fetch wrapper can reach it. */
const bridgeD1 = (env: Record<string, unknown>) => {
  const db = env.API_LOGS_DB;
  if (db) {
    (globalThis as { __ENTAG_D1__?: unknown }).__ENTAG_D1__ = db;
  }
};

/** URLs whose outbound traffic we persist (the Bubble Data API). */
const isLoggedOutbound = (urlStr: string): boolean =>
  /app\.entag\.co/i.test(urlStr) || /\/api\/1\.1\/(obj|wf)\//i.test(urlStr);

const reqBodyText = (init?: { body?: unknown }): string | null => {
  const body = init?.body;
  return typeof body === "string" ? truncate(body) : null;
};

/**
 * Install (once) a global fetch wrapper that logs every call the worker makes
 * to Bubble into the same api_logs table with direction = "outbound". This is
 * how the handler-side Bubble PATCH/POST/GET calls get captured without editing
 * the untouched api/**.cts handlers. The D1 binding is read at call time from
 * globalThis (set per-request by bridgeD1).
 */
let outboundLoggingInstalled = false;
const installOutboundLogging = () => {
  if (outboundLoggingInstalled) return;
  outboundLoggingInstalled = true;
  const original = globalThis.fetch.bind(globalThis);

  const wrapped = async (input: unknown, init?: { method?: string; body?: unknown }): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : (input as { url?: string })?.url ?? String(input);

    if (!isLoggedOutbound(url)) return original(input as RequestInfo, init as RequestInit);

    const db = (globalThis as { __ENTAG_D1__?: D1Like }).__ENTAG_D1__;
    const method = (
      init?.method ??
      (typeof input === "object" ? (input as { method?: string })?.method : undefined) ??
      "GET"
    ).toUpperCase();
    const start = Date.now();

    try {
      const res = await original(input as RequestInfo, init as RequestInit);
      if (db) {
        try {
          const resText = await res.clone().text();
          await writeApiLog(db, {
            direction: "outbound",
            ts: Date.now(),
            method,
            path: url,
            query: null,
            status: res.status,
            duration_ms: Date.now() - start,
            ip: null,
            content_type: res.headers.get("content-type"),
            req_body: reqBodyText(init),
            res_body: resText ? truncate(resText) : null,
            error: res.ok ? null : `HTTP ${res.status}`,
          });
        } catch {
          /* logging is best-effort */
        }
      }
      return res;
    } catch (err) {
      if (db) {
        await writeApiLog(db, {
          direction: "outbound",
          ts: Date.now(),
          method,
          path: url,
          query: null,
          status: 0,
          duration_ms: Date.now() - start,
          ip: null,
          content_type: null,
          req_body: reqBodyText(init),
          res_body: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  };

  globalThis.fetch = wrapped as unknown as typeof fetch;
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

/** Minimal structural shape we read for logging (avoids Request/Response generic clashes). */
interface BodySource {
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Read a body from a cloned Request/Response, but only when it's text-ish. */
const captureBody = async (
  source: BodySource,
  contentType: string | null,
): Promise<string | null> => {
  const ct = (contentType ?? "").toLowerCase();
  const textual =
    ct.includes("json") ||
    ct.includes("text") ||
    ct.includes("xml") ||
    ct.includes("x-www-form-urlencoded") ||
    ct === "";
  if (!textual) {
    const len = source.headers.get("content-length");
    return `[binary ${ct || "unknown"}${len ? `, ${len} bytes` : ""}]`;
  }
  try {
    const text = await source.text();
    return text ? truncate(text) : null;
  } catch {
    return null;
  }
};

/** Best-effort: build a log entry from the captured request/response and persist it. */
const logRequest = async (
  db: D1Like,
  reqClone: BodySource,
  resClone: BodySource,
  meta: {
    method: string;
    path: string;
    query: string;
    status: number;
    duration_ms: number;
    ip: string | null;
    error: string | null;
  },
): Promise<void> => {
  const resContentType = resClone.headers.get("content-type");
  const entry: ApiLogEntry = {
    direction: "inbound",
    ts: Date.now(),
    method: meta.method,
    path: meta.path,
    query: meta.query || null,
    status: meta.status,
    duration_ms: meta.duration_ms,
    ip: meta.ip,
    content_type: resContentType,
    req_body: await captureBody(reqClone, reqClone.headers.get("content-type")),
    res_body: await captureBody(resClone, resContentType),
    error: meta.error,
  };
  await writeApiLog(db, entry);
};

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const { request, env } = context;
  bridgeEnv(env);
  bridgeR2(env);
  bridgeD1(env);
  installOutboundLogging();

  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();
  const db = env.API_LOGS_DB as D1Like | undefined;

  // Read endpoint backing the /api-logs page. Handled inline (not via a route
  // module) because it needs the D1 binding object, not process.env strings.
  // Not logged itself, to avoid self-noise.
  if (pathname === "/api/logs") {
    if (method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (method !== "GET") {
      return json({ error: "Method Not Allowed", method, path: pathname }, 405);
    }
    if (!db) return json({ error: "API_LOGS_DB binding not configured" }, 503);
    try {
      const p = url.searchParams;
      const num = (v: string | null) => (v != null && v !== "" ? Number(v) : undefined);
      const result = await queryApiLogs(db, {
        limit: num(p.get("limit")),
        offset: num(p.get("offset")),
        method: p.get("method"),
        path: p.get("path"),
        status: num(p.get("status")) ?? null,
        q: p.get("q"),
        direction: p.get("direction"),
      });
      return json(result, 200);
    } catch (err) {
      return json({ error: "Failed to query logs", detail: String(err) }, 500);
    }
  }

  const start = Date.now();
  // Clone before the handler consumes the request body stream.
  const reqClone = db ? request.clone() : null;
  let error: string | null = null;

  const produce = async (): Promise<Response> => {
    const mod = matchRoute(pathname);
    if (!mod) return json({ error: "Not Found", path: pathname }, 404);

    const handler = mod[method] as Handler | undefined;
    if (typeof handler !== "function") {
      // Generic preflight when the route doesn't define its own OPTIONS.
      if (method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
      return json({ error: "Method Not Allowed", method, path: pathname }, 405);
    }
    return withCors(await handler(request));
  };

  let response: Response;
  try {
    response = await produce();
  } catch (err) {
    error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    response = json({ error: "Internal Server Error" }, 500);
  }

  if (db && reqClone) {
    const resClone = response.clone();
    const logPromise = logRequest(db, reqClone, resClone, {
      method,
      path: pathname,
      query: url.search.replace(/^\?/, ""),
      status: response.status,
      duration_ms: Date.now() - start,
      ip: request.headers.get("CF-Connecting-IP"),
      error,
    });
    if (context.waitUntil) context.waitUntil(logPromise);
    else void logPromise;
  }

  return response;
};
