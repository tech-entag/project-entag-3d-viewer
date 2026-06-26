/**
 * Persistent API request logging into Cloudflare D1 (`api-logs`).
 *
 * The dispatcher (functions/api/[[path]].ts) calls `writeApiLog` for every
 * /api/* request (best-effort, via waitUntil) and `queryApiLogs` to serve the
 * GET /api/logs read endpoint backing the /api-logs frontend page.
 *
 * Unlike the route handlers under ../../api, this module receives the D1
 * binding object directly — it can't come through the env -> process.env
 * bridge, which only carries string values.
 */

/** Minimal shape of the D1 binding we depend on (subset of D1Database). */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(colName?: string): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
    };
  };
}

export type LogDirection = "inbound" | "outbound";

export interface ApiLogEntry {
  /** "inbound" = request hitting /api/*; "outbound" = call the worker makes (e.g. to Bubble). */
  direction: LogDirection;
  ts: number;
  method: string;
  path: string;
  query: string | null;
  status: number;
  duration_ms: number;
  ip: string | null;
  content_type: string | null;
  req_body: string | null;
  res_body: string | null;
  error: string | null;
}

export interface ApiLogRow extends ApiLogEntry {
  id: number;
}

const DEFAULT_MAX = 64_000;

/** Cap a captured body so a single row can't blow up the D1 row size. */
export const truncate = (
  text: string | null | undefined,
  max = DEFAULT_MAX,
): string | null => {
  if (text == null) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
};

/**
 * Insert one log row. Never throws — a logging failure must not affect the
 * actual API response, so errors are swallowed (logged to console only).
 */
export const writeApiLog = async (
  db: D1Like,
  entry: ApiLogEntry,
): Promise<void> => {
  try {
    await db
      .prepare(
        `INSERT INTO api_logs
           (direction, ts, method, path, query, status, duration_ms, ip, content_type, req_body, res_body, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.direction,
        entry.ts,
        entry.method,
        entry.path,
        entry.query,
        entry.status,
        entry.duration_ms,
        entry.ip,
        entry.content_type,
        entry.req_body,
        entry.res_body,
        entry.error,
      )
      .run();
  } catch (err) {
    console.error("[api-logs] failed to write log row", err);
  }
};

export interface QueryParams {
  limit?: number;
  offset?: number;
  method?: string | null;
  path?: string | null;
  status?: number | null;
  q?: string | null;
  direction?: string | null;
}

export interface QueryResult {
  rows: ApiLogRow[];
  total: number;
  limit: number;
  offset: number;
}

/** Paginated, filtered read of the log, newest first. */
export const queryApiLogs = async (
  db: D1Like,
  params: QueryParams,
): Promise<QueryResult> => {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);

  const where: string[] = [];
  const args: unknown[] = [];

  if (params.direction) {
    where.push("direction = ?");
    args.push(params.direction.toLowerCase());
  }
  if (params.method) {
    where.push("method = ?");
    args.push(params.method.toUpperCase());
  }
  if (params.path) {
    where.push("path LIKE ?");
    args.push(`%${params.path}%`);
  }
  if (params.status != null && Number.isFinite(params.status)) {
    where.push("status = ?");
    args.push(params.status);
  }
  if (params.q) {
    where.push("(path LIKE ? OR req_body LIKE ? OR res_body LIKE ?)");
    const like = `%${params.q}%`;
    args.push(like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM api_logs ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(
      `SELECT id, direction, ts, method, path, query, status, duration_ms, ip, content_type, req_body, res_body, error
         FROM api_logs ${whereSql}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...args, limit, offset)
    .all<ApiLogRow>();

  return { rows: results, total: countRow?.n ?? 0, limit, offset };
};
