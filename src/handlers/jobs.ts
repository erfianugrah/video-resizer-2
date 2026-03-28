/**
 * Job management handlers.
 *
 * GET  /admin/jobs          — list active/recent jobs from D1 registry
 * GET  /admin/jobs/:id      — get single job status from TransformJobDO
 * GET  /ws/job/:id          — WebSocket upgrade to TransformJobDO for real-time progress
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../errors';
import { listJobs, listActiveJobs, listFilteredJobs } from '../queue/jobs-db';

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * GET /ws/job/:id — WebSocket proxy to TransformJobDO.
 */
export async function wsJobHandler(c: HonoContext) {
	const jobId = c.req.param('id');
	if (!jobId) throw new AppError(400, 'MISSING_JOB_ID', 'Job ID required');

	if (!c.env.TRANSFORM_JOB) {
		throw new AppError(503, 'JOBS_UNAVAILABLE', 'TRANSFORM_JOB binding not configured');
	}

	const upgradeHeader = c.req.header('Upgrade');
	if (!upgradeHeader || upgradeHeader !== 'websocket') {
		throw new AppError(426, 'UPGRADE_REQUIRED', 'Expected WebSocket upgrade');
	}

	const jobDO = c.env.TRANSFORM_JOB.get(c.env.TRANSFORM_JOB.idFromName(jobId));
	return jobDO.fetch(c.req.raw);
}

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

	let jobs;
	if (active) {
		jobs = await listActiveJobs(c.env.ANALYTICS);
	} else if (filter) {
		jobs = await listFilteredJobs(c.env.ANALYTICS, sinceMs, filter, limit);
	} else {
		jobs = await listJobs(c.env.ANALYTICS, sinceMs, limit);
	}

	// Parse params_json for each job
	const parsed = jobs.map((j) => ({
		...j,
		params: j.params_json ? JSON.parse(j.params_json) : null,
		params_json: undefined,
	}));

	return c.json({ jobs: parsed, _meta: { ts: Date.now(), hours, active, filter: filter ?? null } });
}

/**
 * GET /admin/jobs/:id — get status of a single job via TransformJobDO.
 */
export async function getJobStatus(c: HonoContext) {
	requireAuth(c);
	const jobId = c.req.param('id');
	if (!jobId) throw new AppError(400, 'MISSING_JOB_ID', 'Job ID required');

	if (!c.env.TRANSFORM_JOB) {
		throw new AppError(503, 'JOBS_UNAVAILABLE', 'TRANSFORM_JOB binding not configured');
	}

	const jobDO = c.env.TRANSFORM_JOB.get(c.env.TRANSFORM_JOB.idFromName(jobId));
	const resp = await jobDO.fetch(new Request('http://job/status', { method: 'GET' }));
	const state = await resp.json();
	return c.json({ job: state, _meta: { ts: Date.now() } });
}
