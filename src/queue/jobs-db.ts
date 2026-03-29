/**
 * D1 job registry — tracks container transform jobs for the dashboard.
 *
 * D1 is the sole source of truth for job state (no TransformJobDO).
 * Progress (phase + percent) is written directly by the container
 * outbound handler and read by the SSE endpoint for real-time updates.
 */
import * as log from '../log';

// Schema lives in src/analytics/schema.sql (single source of truth).
// Run: npx wrangler d1 execute video-resizer-analytics --remote --file=src/analytics/schema.sql

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
const UPDATE_PROGRESS_SQL = `UPDATE transform_jobs SET status = ?, percent = ?, started_at = COALESCE(started_at, ?) WHERE job_id = ?`;
const COMPLETE_SQL = `UPDATE transform_jobs SET status = 'complete', completed_at = ?, output_size = ?, percent = 100 WHERE job_id = ?`;
const FAIL_SQL = `UPDATE transform_jobs SET status = 'failed', completed_at = ?, error = ? WHERE job_id = ?`;

/** Update job status in D1. Fire-and-forget. */
export function updateJobStatus(db: D1Database, jobId: string, status: string): void {
	db.prepare(UPDATE_STATUS_SQL).bind(status, Date.now(), jobId).run()
		.catch((err) => log.error('Job status update failed', { error: err instanceof Error ? err.message : String(err) }));
}

/** Update job status + percent progress in D1. Fire-and-forget. */
export function updateJobProgress(db: D1Database, jobId: string, status: string, percent: number): void {
	db.prepare(UPDATE_PROGRESS_SQL).bind(status, percent, Date.now(), jobId).run()
		.catch((err) => log.error('Job progress update failed', { error: err instanceof Error ? err.message : String(err) }));
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
	percent: number | null;
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
