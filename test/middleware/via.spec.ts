/**
 * Tests for via middleware — loop prevention.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../../src/types';
import { viaMiddleware } from '../../src/middleware/via';

function buildApp() {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.use('*', viaMiddleware);
	app.get('/test', (c) => c.text('handler-reached'));
	return app;
}

describe('viaMiddleware', () => {
	it('passes through to handler when no Via header', async () => {
		const app = buildApp();
		const res = await app.request(new Request('https://example.com/test'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('handler-reached');
	});

	it('passes through to handler when Via header does not contain video-resizer', async () => {
		const app = buildApp();
		const res = await app.request(new Request('https://example.com/test', {
			headers: { Via: '1.1 other-proxy' },
		}));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('handler-reached');
	});

	it('bypasses handler and fetches origin when Via loop detected', async () => {
		// Intercept global fetch — middleware calls fetch(c.req.raw) when loop detected
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('origin-body', { status: 200 }));

		const app = buildApp();
		const res = await app.request(new Request('https://example.com/test', {
			headers: { Via: '1.1 video-resizer' },
		}));

		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('origin-body');

		fetchSpy.mockRestore();
	});

	it('sets startTime on context for non-loop requests', async () => {
		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.use('*', viaMiddleware);
		app.get('/test', (c) => {
			const st = c.get('startTime');
			return c.json({ hasStartTime: typeof st === 'number', value: st });
		});

		const res = await app.request(new Request('https://example.com/test'));
		const body = await res.json() as { hasStartTime: boolean; value: number };
		expect(body.hasStartTime).toBe(true);
		expect(body.value).toBeGreaterThan(0);
	});
});
