-- D1 schema for video-resizer-2.
--
-- SINGLE SOURCE OF TRUTH. All table definitions live here.
--
-- Usage:
--   Initial setup:  npx wrangler d1 execute video-resizer-analytics --remote --file=src/analytics/schema.sql
--   Reset (nuke):   npx wrangler d1 execute video-resizer-analytics --remote --file=src/analytics/schema.sql
--   Weekly cron:    uses CLEANUP_SQL in src/analytics/middleware.ts (copy of this file)
--
-- If you change this file, update CLEANUP_SQL in src/analytics/middleware.ts to match.

-- ── Analytics: transform request log (7-day rolling, dropped weekly by cron) ──

DROP TABLE IF EXISTS transform_log;
CREATE TABLE IF NOT EXISTS transform_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  path             TEXT    NOT NULL,
  origin           TEXT,
  status           INTEGER NOT NULL,
  mode             TEXT,
  derivative       TEXT,
  duration_ms      INTEGER,
  cache_hit        INTEGER NOT NULL DEFAULT 0,
  transform_source TEXT,
  source_type      TEXT,
  error_code       TEXT,
  bytes            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_log_ts     ON transform_log(ts);
CREATE INDEX IF NOT EXISTS idx_log_status ON transform_log(status);

-- ── Jobs: container transform job registry (7-day rolling, dropped weekly by cron) ──

DROP TABLE IF EXISTS transform_jobs;
CREATE TABLE IF NOT EXISTS transform_jobs (
  job_id       TEXT    PRIMARY KEY,
  path         TEXT    NOT NULL,
  origin       TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending',
  params_json  TEXT,
  source_url   TEXT,
  source_type  TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER,
  error        TEXT,
  output_size  INTEGER,
  percent      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON transform_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON transform_jobs(created_at);
