-- D1 schema for transform_log table.
-- Used by the weekly cron cleanup (DROP + CREATE) and initial setup.

CREATE TABLE IF NOT EXISTS transform_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  path            TEXT NOT NULL,
  origin          TEXT,
  status          INTEGER NOT NULL,
  mode            TEXT,
  derivative      TEXT,
  duration_ms     INTEGER,
  cache_hit       INTEGER NOT NULL DEFAULT 0,
  transform_source TEXT,
  source_type     TEXT,
  error_code      TEXT,
  bytes           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_log_ts ON transform_log(ts);
CREATE INDEX IF NOT EXISTS idx_log_status ON transform_log(status);
