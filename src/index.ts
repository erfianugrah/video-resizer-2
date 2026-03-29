/**
 * video-resizer-2 — Hono app wiring.
 *
 * All middleware and handlers are in separate files. This file only
 * wires them together and exports the Worker + Durable Object.
 */
import { Hono } from 'hono';
import type { Env, Variables } from './types';

// Middleware
import { errorHandler } from './middleware/error';
import { viaMiddleware } from './middleware/via';
import { configMiddleware } from './middleware/config';
import { cdnCgiPassthrough, nonVideoPassthrough } from './middleware/passthrough';

// Handlers
import { getConfig, postConfig, postCacheBust, getAnalytics, getAnalyticsErrors } from './handlers/admin';
import { getR2Source } from './handlers/internal';
import { transformHandler } from './handlers/transform';
import { listJobsHandler, sseJobProgress } from './handlers/jobs';

// Durable Object + analytics cleanup
import { FFmpegContainer, ContainerProxy } from './transform/container';
// TransformJobDO removed — replaced by D1 + SSE for job progress
import { handleQueue, handleDLQ } from './queue/consumer';
import { CLEANUP_SQL } from './analytics/middleware';
import * as log from './log';
import type { JobMessage } from './transform/job';

// ── App ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Error handler ────────────────────────────────────────────────────────

app.onError(errorHandler);

// ── Middleware pipeline ──────────────────────────────────────────────────

app.use('*', viaMiddleware);
app.use('*', configMiddleware);
app.use('*', cdnCgiPassthrough);
app.use('*', nonVideoPassthrough);

// ── Admin routes ─────────────────────────────────────────────────────────

app.get('/admin/config', getConfig);
app.post('/admin/config', postConfig);
app.post('/admin/cache/bust', postCacheBust);
app.get('/admin/analytics', getAnalytics);
app.get('/admin/analytics/errors', getAnalyticsErrors);

// ── Job management routes ────────────────────────────────────────────────

app.get('/admin/jobs', listJobsHandler);
app.get('/sse/job/:id', sseJobProgress);

// ── Dashboard (static assets, auth-gated) ────────────────────────────────

import { dashboardAuth, dashboardLogin } from './handlers/dashboard';

app.post('/admin/dashboard/login', dashboardLogin);
app.get('/admin/dashboard', dashboardAuth);
app.get('/admin/dashboard/*', dashboardAuth);

// ── Internal routes ──────────────────────────────────────────────────────

// postContainerResult removed — the container outbound handler (container.ts:148)
// intercepts POST /internal/container-result before it reaches the Hono router.
app.get('/internal/r2-source', getR2Source);

// ── Transform handler (catch-all) ────────────────────────────────────────

app.get('*', transformHandler);

// ── Export ────────────────────────────────────────────────────────────────

export { FFmpegContainer, ContainerProxy };

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx);
	},
	async queue(batch: MessageBatch<JobMessage>, env: Env, ctx: ExecutionContext) {
		if (batch.queue === 'video-transform-dlq') {
			await handleDLQ(batch, env);
		} else {
			await handleQueue(batch, env);
		}
	},
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		if (controller.cron === '0 0 * * sun' && env.ANALYTICS) {
			await env.ANALYTICS.exec(CLEANUP_SQL);
			log.info('Weekly analytics cleanup');
		}
	},
};
