/**
 * D1 job registry — tracks container transform jobs for the dashboard.
 *
 * Durable Objects don't have a "list all instances" API, so we use D1
 * as a queryable registry. The DO is still the source of truth for
 * real-time state; D1 is the index for discovery.
 */
import * as log from '../log';

// ── Schema (run once via wrangler d1 execute or CLEANUP_SQL) ─────────

export const JOBS_TABLE_SQL = `
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
  output_size  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON transform_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON transform_jobs(created_at);
`;

// ── Write operations ─────────────────────────────────────────────────

const UPSERT_SQL = `
INSERT INTO transform_jobs (job_id, path, origin, status, params_json, source_url, source_type, created_at)
VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
ON CONFLICT(job_id) DO UPDATE SET status = 'pending', created_at = excluded.created_at
`;

/** Register a new job in D1. Fire-and-forget. */
export function registerJob(
	db: D1Database,
	job: {
		jobId: string;
		path: string;
		origin: string;
		params: Record<string, unknown>;
		sourceUrl: string;
		sourceType: string;
		createdAt: number;
	},
	waitUntil: (p: Promise<unknown>) => void,
): void {
	const p = db
		.prepare(UPSERT_SQL)
		.bind(job.jobId, job.path, job.origin, JSON.stringify(job.params), job.sourceUrl, job.sourceType, job.createdAt)
		.run()
		.catch((err) => log.error('Job registry insert failed', { error: err instanceof Error ? err.message : String(err) }));
	waitUntil(p);
}

const UPDATE_STATUS_SQL = `UPDATE transform_jobs SET status = ?, started_at = COALESCE(started_at, ?) WHERE job_id = ?`;
const COMPLETE_SQL = `UPDATE transform_jobs SET status = 'complete', completed_at = ?, output_size = ? WHERE job_id = ?`;
const FAIL_SQL = `UPDATE transform_jobs SET status = 'failed', completed_at = ?, error = ? WHERE job_id = ?`;

/** Update job status in D1. Fire-and-forget. */
export function updateJobStatus(db: D1Database, jobId: string, status: string): void {
	db.prepare(UPDATE_STATUS_SQL).bind(status, Date.now(), jobId).run()
		.catch((err) => log.error('Job status update failed', { error: err instanceof Error ? err.message : String(err) }));
}

/** Mark job complete in D1. Fire-and-forget. */
export function completeJob(db: D1Database, jobId: string, outputSize?: number): void {
	db.prepare(COMPLETE_SQL).bind(Date.now(), outputSize ?? null, jobId).run()
		.catch((err) => log.error('Job complete update failed', { error: err instanceof Error ? err.message : String(err) }));
}

/** Mark job failed in D1. Fire-and-forget. */
export function failJob(db: D1Database, jobId: string, error: string): void {
	db.prepare(FAIL_SQL).bind(Date.now(), error.slice(0, 1000), jobId).run()
		.catch((err) => log.error('Job fail update failed', { error: err instanceof Error ? err.message : String(err) }));
}

// ── Read operations ──────────────────────────────────────────────────

export interface JobRow {
	job_id: string;
	path: string;
	origin: string | null;
	status: string;
	params_json: string | null;
	source_url: string | null;
	source_type: string | null;
	created_at: number;
	started_at: number | null;
	completed_at: number | null;
	error: string | null;
	output_size: number | null;
}

const LIST_JOBS_SQL = `
SELECT * FROM transform_jobs
WHERE created_at > ?
ORDER BY created_at DESC
LIMIT ?
`;

const LIST_ACTIVE_SQL = `
SELECT * FROM transform_jobs
WHERE status IN ('pending', 'downloading', 'transcoding', 'uploading')
ORDER BY created_at DESC
LIMIT 50
`;

const LIST_FILTERED_SQL = `
SELECT * FROM transform_jobs
WHERE created_at > ? AND (path LIKE ? OR job_id LIKE ? OR status LIKE ?)
ORDER BY created_at DESC
LIMIT ?
`;

/** List recent jobs. */
export async function listJobs(db: D1Database, sinceMs: number, limit = 50): Promise<JobRow[]> {
	const result = await db.prepare(LIST_JOBS_SQL).bind(sinceMs, limit).all<JobRow>();
	return result.results ?? [];
}

/** List active (non-terminal) jobs. */
export async function listActiveJobs(db: D1Database): Promise<JobRow[]> {
	const result = await db.prepare(LIST_ACTIVE_SQL).all<JobRow>();
	return result.results ?? [];
}

/** List jobs with a text filter. */
export async function listFilteredJobs(db: D1Database, sinceMs: number, filter: string, limit = 50): Promise<JobRow[]> {
	const like = `%${filter}%`;
	const result = await db.prepare(LIST_FILTERED_SQL).bind(sinceMs, like, like, like, limit).all<JobRow>();
	return result.results ?? [];
}
