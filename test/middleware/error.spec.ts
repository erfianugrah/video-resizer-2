/**
 * Tests for error handler middleware.
 *
 * Verifies AppError serialization, unknown error 500 fallback, and that
 * errors from downstream handlers reach the onError hook.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../../src/types';
import { AppError } from '../../src/errors';
import { errorHandler } from '../../src/middleware/error';

/** Minimal env — errorHandler reads c.env.ANALYTICS to log analytics. */
const emptyEnv = {} as Env;

function buildApp() {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	// Set startTime so error handler doesn't trip on missing context var
	app.use('*', async (c, next) => {
		c.set('startTime', performance.now());
		await next();
	});
	app.onError(errorHandler);
	return app;
}

/** Wrap `app.request` to always pass the empty env (errorHandler reads c.env). */
function request(app: Hono<{ Bindings: Env; Variables: Variables }>, url: string) {
	return app.request(new Request(url), undefined, emptyEnv);
}

describe('errorHandler', () => {
	it('returns AppError as structured JSON with correct status', async () => {
		const app = buildApp();
		app.get('/bad', () => {
			throw new AppError(404, 'NOT_FOUND', 'Video not found', { path: '/bad' });
		});

		const res = await request(app, 'https://example.com/bad');
		expect(res.status).toBe(404);
		const body = await res.json() as { error: { code: string; message: string; details: unknown } };
		expect(body.error.code).toBe('NOT_FOUND');
		expect(body.error.message).toBe('Video not found');
		expect(body.error.details).toEqual({ path: '/bad' });
	});

	it('returns 500 INTERNAL for unknown errors (no stack leak)', async () => {
		const app = buildApp();
		app.get('/boom', () => {
			throw new Error('Secret stack trace with credentials');
		});

		const res = await request(app, 'https://example.com/boom');
		expect(res.status).toBe(500);
		const body = await res.json() as { error: { code: string; message: string } };
		expect(body.error.code).toBe('INTERNAL');
		expect(body.error.message).toBe('Internal server error');
		// Stack/secret must NOT leak to client
		expect(JSON.stringify(body)).not.toContain('credentials');
	});

	it('returns AppError with no details field when none provided', async () => {
		const app = buildApp();
		app.get('/simple', () => {
			throw new AppError(400, 'BAD_REQUEST', 'Missing param');
		});

		const res = await request(app, 'https://example.com/simple');
		expect(res.status).toBe(400);
		const body = await res.json() as { error: { code: string; message: string; details?: unknown } };
		expect(body.error.code).toBe('BAD_REQUEST');
		expect(body.error.details).toBeUndefined();
	});

	it('preserves AppError status codes across the 4xx/5xx range', async () => {
		const app = buildApp();
		app.get('/401', () => { throw new AppError(401, 'UNAUTHORIZED', 'nope'); });
		app.get('/422', () => { throw new AppError(422, 'INVALID_PARAMS', 'bad'); });
		app.get('/503', () => { throw new AppError(503, 'UNAVAILABLE', 'down'); });

		const r401 = await request(app, 'https://example.com/401');
		const r422 = await request(app, 'https://example.com/422');
		const r503 = await request(app, 'https://example.com/503');
		expect(r401.status).toBe(401);
		expect(r422.status).toBe(422);
		expect(r503.status).toBe(503);
	});
});
