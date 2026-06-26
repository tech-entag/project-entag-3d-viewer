-- API request log captured by the Pages Functions dispatcher
-- (functions/api/[[path]].ts -> functions/api/_logs.ts).
CREATE TABLE IF NOT EXISTS api_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,          -- Date.now() ms
  method        TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  query         TEXT,
  status        INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  ip            TEXT,
  content_type  TEXT,
  req_body      TEXT,                       -- truncated ~64KB
  res_body      TEXT,                       -- truncated ~64KB
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_logs_ts     ON api_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_path   ON api_logs(path);
CREATE INDEX IF NOT EXISTS idx_api_logs_status ON api_logs(status);
