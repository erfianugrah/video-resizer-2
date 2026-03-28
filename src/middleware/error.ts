/**
 * Global error handler for Hono app.onError.
 *
 * Catches all errors, logs them, records to D1 analytics, and returns
 * structured JSON responses.
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { AppError } from '../errors';
import { logAnalyticsEvent } from '../analytics/middleware';
import * as log from '../log';

export function errorHandler(err: Error, c: Context<{ Bindings: Env; Variables: Variables }>) {
	const status = err instanceof AppError ? err.status : 500;
	const code = err instanceof AppError ? err.code : 'INTERNAL';

	const errPath = new URL(c.req.url).pathname;
	if (err instanceof AppError) {
		log.error('AppError', { path: errPath, code: err.code, status: err.status, message: err.message, details: err.details });
	} else {
		log.error('Unhandled error', { path: errPath, message: err.message, stack: err.stack?.slice(0, 500) });
	}

	// Log error to D1 analytics (non-blocking)
	if (c.env.ANALYTICS) {
		const path = new URL(c.req.url).pathname;
		const startTime = c.get('startTime') ?? 0;
		logAnalyticsEvent(c.env.ANALYTICS, {
			path,
			origin: null,
			status,
			mode: null,
			derivative: null,
			durationMs: startTime ? Math.round(performance.now() - startTime) : 0,
			cacheHit: false,
			transformSource: null,
			sourceType: null,
			errorCode: code,
			bytes: null,
		}, c.executionCtx.waitUntil.bind(c.executionCtx));
	}

	if (err instanceof AppError) {
		return c.json(err.toJSON(), err.status as any);
	}
	return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
}
