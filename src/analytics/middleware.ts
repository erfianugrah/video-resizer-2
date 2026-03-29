/**
 * Analytics middleware — logs every request outcome to D1.
 *
 * Non-blocking: the D1 insert runs via waitUntil so it never delays
 * the response to the client. Errors are swallowed (analytics should
 * never break the request pipeline).
 */
import * as log from '../log';

export interface AnalyticsEvent {
	path: string;
	origin: string | null;
	status: number;
	mode: string | null;
	derivative: string | null;
	durationMs: number;
	cacheHit: boolean;
	transformSource: string | null;
	sourceType: string | null;
	errorCode: string | null;
	bytes: number | null;
}

const INSERT_SQL = `
INSERT INTO transform_log
  (ts, path, origin, status, mode, derivative, duration_ms, cache_hit, transform_source, source_type, error_code, bytes)
VALUES
  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Log an analytics event to D1. Fire-and-forget via waitUntil.
 */
export function logAnalyticsEvent(
	db: D1Database,
	event: AnalyticsEvent,
	waitUntil: (p: Promise<unknown>) => void,
): void {
	const promise = db
		.prepare(INSERT_SQL)
		.bind(
			Date.now(),
			event.path,
			event.origin,
			event.status,
			event.mode,
			event.derivative,
			event.durationMs,
			event.cacheHit ? 1 : 0,
			event.transformSource,
			event.sourceType,
			event.errorCode,
			event.bytes,
		)
		.run()
		.catch((err) => {
			log.error('Analytics insert failed', {
				error: err instanceof Error ? err.message : String(err),
			});
		});

	waitUntil(promise);
}

/**
 * SQL for the weekly cron cleanup — DROP + recreate tables.
 * This MUST match src/analytics/schema.sql (the single source of truth).
 * If you change the schema, update both this constant and the .sql file.
 */
export const CLEANUP_SQL = `
DROP TABLE IF EXISTS transform_log;
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

DROP TABLE IF EXISTS transform_jobs;
CREATE TABLE IF NOT EXISTS transform_jobs (
  job_id       TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  origin       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
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
CREATE INDEX IF NOT EXISTS idx_jobs_status ON transform_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON transform_jobs(created_at);
`;
