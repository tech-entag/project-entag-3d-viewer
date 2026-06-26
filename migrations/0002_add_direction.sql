-- Distinguish inbound /api/* requests from outbound calls the worker makes
-- (e.g. PATCH/POST to the Bubble Data API). Existing rows are inbound.
ALTER TABLE api_logs ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound';

CREATE INDEX IF NOT EXISTS idx_api_logs_direction ON api_logs(direction);
