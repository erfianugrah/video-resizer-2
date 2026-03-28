/**
 * Admin route handlers.
 *
 * GET  /admin/config           — retrieve config from KV
 * POST /admin/config           — upload config with Zod validation
 * POST /admin/cache/bust       — bump version for a path
 * GET  /admin/analytics        — summary with ?hours=N
 * GET  /admin/analytics/errors — recent errors with ?hours=N&limit=N
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { AppConfigSchema } from '../config/schema';
import { resetConfigCache } from '../config/loader';
import { AppError } from '../errors';
import { requireAuth } from '../middleware/auth';
import { bumpVersion } from '../cache/version';
import { getSummary, getRecentErrors } from '../analytics/queries';
import * as log from '../log';

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

export async function getConfig(c: HonoContext) {
	requireAuth(c);
	return c.json({ config: c.get('config'), _meta: { ts: Date.now() } });
}

export async function postConfig(c: HonoContext) {
	requireAuth(c);
	const body = await c.req.json();
	const result = AppConfigSchema.safeParse(body);
	if (!result.success) {
		throw new AppError(400, 'INVALID_CONFIG', 'Config validation failed', {
			errors: result.error.issues.slice(0, 10),
		});
	}
	await c.env.CONFIG.put('worker-config', JSON.stringify(result.data));
	resetConfigCache();
	log.info('Config updated via admin API');
	return c.json({ ok: true, config: result.data, _meta: { ts: Date.now() } });
}

export async function postCacheBust(c: HonoContext) {
	requireAuth(c);
	const body = await c.req.json();
	const path = body?.path;
	if (typeof path !== 'string' || !path) {
		throw new AppError(400, 'INVALID_PATH', 'Request body must include { "path": "/some/video.mp4" }');
	}
	const newVersion = await bumpVersion(c.env.CACHE_VERSIONS, path);
	log.info('Cache version bumped', { path, version: newVersion });
	return c.json({ ok: true, path, version: newVersion });
}

export async function getAnalytics(c: HonoContext) {
	requireAuth(c);
	if (!c.env.ANALYTICS) throw new AppError(503, 'ANALYTICS_UNAVAILABLE', 'D1 ANALYTICS binding not configured');
	const hours = parseInt(c.req.query('hours') ?? '24', 10);
	const sinceMs = Date.now() - hours * 3600_000;
	const summary = await getSummary(c.env.ANALYTICS, sinceMs);
	return c.json({ summary, _meta: { hours, sinceMs, ts: Date.now() } });
}

export async function getAnalyticsErrors(c: HonoContext) {
	requireAuth(c);
	if (!c.env.ANALYTICS) throw new AppError(503, 'ANALYTICS_UNAVAILABLE', 'D1 ANALYTICS binding not configured');
	const hours = parseInt(c.req.query('hours') ?? '24', 10);
	const limit = parseInt(c.req.query('limit') ?? '50', 10);
	const sinceMs = Date.now() - hours * 3600_000;
	const errors = await getRecentErrors(c.env.ANALYTICS, sinceMs, limit);
	return c.json({ errors, _meta: { hours, limit, sinceMs, ts: Date.now() } });
}
