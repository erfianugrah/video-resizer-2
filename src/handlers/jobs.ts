/**
 * Job management handlers.
 *
 * GET  /admin/jobs          — list active/recent jobs from D1 registry
 * GET  /sse/job/:id         — SSE stream of job progress from D1
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../errors';
import { listJobs, listActiveJobs, listFilteredJobs, retryJob, resetStaleJobs, deleteJob, type JobRow } from '../queue/jobs-db';
import * as log from '../log';

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * GET /admin/jobs — list all recent/active jobs from D1 registry.
 *
 * Query params:
 *   ?hours=24    — how far back to look (default 24)
 *   ?filter=foo  — text search on path/jobId/status
 *   ?active=true — only show non-terminal jobs
 *   ?limit=50    — max results
 */
export async function listJobsHandler(c: HonoContext) {
	requireAuth(c);
	if (!c.env.ANALYTICS) {
		throw new AppError(503, 'ANALYTICS_UNAVAILABLE', 'D1 ANALYTICS binding not configured');
	}

	const active = c.req.query('active') === 'true';
	const filter = c.req.query('filter');
	const hours = parseInt(c.req.query('hours') ?? '24', 10);
	const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
	const sinceMs = Date.now() - hours * 3600_000;

	// Staleness is computed client-side in the dashboard, not via D1 mutation.
	// The DLQ consumer marks terminal failures. Active jobs stay in their
	// current status (downloading/transcoding/uploading) until the container
	// reports completion or the DLQ consumer marks them failed.

	let jobs: JobRow[];
	if (active) {
		jobs = await listActiveJobs(c.env.ANALYTICS);
	} else if (filter) {
		jobs = await listFilteredJobs(c.env.ANALYTICS, sinceMs, filter, limit);
	} else {
		jobs = await listJobs(c.env.ANALYTICS, sinceMs, limit);
	}

	// Parse params_json for each job
	const parsed = jobs.map((j) => {
		let params: Record<string, unknown> | null = null;
		try { params = j.params_json ? JSON.parse(j.params_json) : null; } catch { /* corrupt data */ }
		return { ...j, params, params_json: undefined };
	});

	return c.json({ jobs: parsed, _meta: { ts: Date.now(), hours, active, filter: filter ?? null } });
}

/**
 * POST /admin/jobs/retry — retry a stuck job or clear all stale jobs.
 *
 * Body options:
 *   { "jobId": "..." }                — reset a single job to 'pending' + re-enqueue
 *   { "staleMinutes": 30 }            — reset all jobs stuck longer than N minutes
 *   { "jobId": "...", "delete": true } — delete a job from D1 entirely
 */
export async function retryJobHandler(c: HonoContext) {
	requireAuth(c);
	if (!c.env.ANALYTICS) throw new AppError(503, 'ANALYTICS_UNAVAILABLE', 'D1 binding not configured');

	const body = await c.req.json();
	const db = c.env.ANALYTICS;

	// Delete a single job
	if (body.jobId && body.delete === true) {
		// Also clean up partial R2 result so a fresh transform can be stored
		const r2Key = `_transformed/${body.jobId}`;
		await c.env.VIDEOS.delete(r2Key).catch(() => {});
		const deleted = await deleteJob(db, body.jobId);
		log.info('Job deleted', { jobId: body.jobId, deleted });
		return c.json({ ok: true, deleted, jobId: body.jobId });
	}

	// Retry a single job — reset D1 status + clean R2 + re-enqueue
	if (body.jobId) {
		const r2Key = `_transformed/${body.jobId}`;
		await c.env.VIDEOS.delete(r2Key).catch(() => {});
		const reset = await retryJob(db, body.jobId);
		if (!reset) {
			throw new AppError(404, 'JOB_NOT_FOUND', `Job not found or already complete: ${body.jobId}`);
		}

		// Re-enqueue if queue is available — the consumer will re-dispatch to container
		if (c.env.TRANSFORM_QUEUE) {
			// Fetch the job row to reconstruct the queue message
			const row = await db.prepare('SELECT * FROM transform_jobs WHERE job_id = ?')
				.bind(body.jobId).first<Record<string, unknown>>();
			if (row && row.source_url) {
				await c.env.TRANSFORM_QUEUE.send({
					jobId: body.jobId,
					path: row.path,
					params: row.params_json ? JSON.parse(row.params_json as string) : {},
					sourceUrl: row.source_url,
					callbackCacheKey: body.jobId,
					requestUrl: `https://${new URL(c.req.url).host}${row.path}`,
					origin: row.origin ?? 'unknown',
					sourceType: row.source_type ?? 'unknown',
					createdAt: Date.now(),
				});
				log.info('Job re-enqueued', { jobId: body.jobId });
			}
		}

		return c.json({ ok: true, reset: true, jobId: body.jobId, requeued: !!c.env.TRANSFORM_QUEUE });
	}

	// Bulk: reset all stale jobs
	if (body.staleMinutes) {
		const staleMs = body.staleMinutes * 60_000;
		const count = await resetStaleJobs(db, staleMs);
		log.info('Stale jobs reset', { staleMinutes: body.staleMinutes, count });
		return c.json({ ok: true, resetCount: count, staleMinutes: body.staleMinutes });
	}

	throw new AppError(400, 'INVALID_BODY', 'Provide { jobId } or { staleMinutes }');
}

/**
 * GET /sse/job/:id — Server-Sent Events stream for job progress.
 *
 * Polls D1 every 2s and streams status/percent updates to the client.
 * Auto-closes when job reaches a terminal state (complete/failed).
 * Dashboard uses EventSource API for auto-reconnect.
 */
export async function sseJobProgress(c: HonoContext) {
	const jobId = c.req.param('id');
	if (!jobId) throw new AppError(400, 'MISSING_JOB_ID', 'Job ID required');
	if (!c.env.ANALYTICS) throw new AppError(503, 'ANALYTICS_UNAVAILABLE', 'D1 binding not configured');

	const db = c.env.ANALYTICS;
	const encoder = new TextEncoder();
	let closed = false;

	const stream = new ReadableStream({
		async start(controller) {
			const TERMINAL = new Set(['complete', 'failed']);
			const POLL_MS = 2000;
			let lastStatus = '';
			let lastPercent = -1;

			const poll = async () => {
				if (closed) return;
				try {
					const row = await db.prepare(
						'SELECT status, percent, error, output_size, completed_at FROM transform_jobs WHERE job_id = ?',
					).bind(jobId).first<{ status: string; percent: number | null; error: string | null; output_size: number | null; completed_at: number | null }>();

					if (!row) {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: 'not_found', jobId })}\n\n`));
						controller.close();
						closed = true;
						return;
					}

					const percent = row.percent ?? 0;
					// Only send if something changed
					if (row.status !== lastStatus || percent !== lastPercent) {
						lastStatus = row.status;
						lastPercent = percent;
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({
							status: row.status,
							percent,
							error: row.error,
							outputSize: row.output_size,
							completedAt: row.completed_at,
						})}\n\n`));
					}

					if (TERMINAL.has(row.status)) {
						controller.close();
						closed = true;
						return;
					}

					// Schedule next poll
					setTimeout(poll, POLL_MS);
				} catch {
					if (!closed) {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: 'error', message: 'D1 query failed' })}\n\n`));
						setTimeout(poll, POLL_MS * 2);
					}
				}
			};

			// Initial send immediately
			await poll();
		},
		cancel() {
			closed = true;
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no', // disable nginx buffering if proxied
		},
	});
}
