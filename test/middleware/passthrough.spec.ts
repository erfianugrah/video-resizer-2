/**
 * Tests for passthrough middleware — cdn-cgi paths and non-video extensions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../../src/types';
import type { AppConfig } from '../../src/config/schema';
import { cdnCgiPassthrough, nonVideoPassthrough } from '../../src/middleware/passthrough';

const testConfig: Partial<AppConfig> = {
	passthrough: { enabled: true, formats: ['mp4', 'webm', 'mov'] },
};

function buildApp(cfg: Partial<AppConfig> = testConfig) {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.use('*', async (c, next) => {
		c.set('config', cfg as AppConfig);
		await next();
	});
	app.use('*', cdnCgiPassthrough);
	app.use('*', nonVideoPassthrough);
	app.get('*', (c) => c.text('handler-reached'));
	return app;
}

describe('cdnCgiPassthrough', () => {
	it('passes through /cdn-cgi/ paths to origin (skips handler)', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('cdn-cgi-origin'));
		const app = buildApp();

		const res = await app.request(new Request('https://example.com/cdn-cgi/media/width=640/https://src.com/v.mp4'));

		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(await res.text()).toBe('cdn-cgi-origin');
		fetchSpy.mockRestore();
	});

	it('does not pass through non-cdn-cgi paths', async () => {
		const app = buildApp();
		const res = await app.request(new Request('https://example.com/video.mp4'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('handler-reached');
	});
});

describe('nonVideoPassthrough', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('passes through non-video extensions when passthrough enabled', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('image-body', {
			headers: { 'Content-Type': 'image/png' },
		}));
		const app = buildApp();

		const res = await app.request(new Request('https://example.com/image.png'));

		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(await res.text()).toBe('image-body');
		fetchSpy.mockRestore();
	});

	it('does not pass through whitelisted video extensions', async () => {
		const app = buildApp();
		const res = await app.request(new Request('https://example.com/video.mp4'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('handler-reached');
	});

	it('respects passthrough.enabled=false (no passthrough, all paths go to handler)', async () => {
		const app = buildApp({ passthrough: { enabled: false, formats: ['mp4'] } });
		const res = await app.request(new Request('https://example.com/image.png'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('handler-reached');
	});

	it('exempts /admin/ paths from passthrough', async () => {
		const app = buildApp();
		const res = await app.request(new Request('https://example.com/admin/config'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('handler-reached');
	});

	it('exempts /internal/ paths from passthrough', async () => {
		const app = buildApp();
		const res = await app.request(new Request('https://example.com/internal/r2-source'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('handler-reached');
	});

	it('exempts /sse/ paths from passthrough', async () => {
		const app = buildApp();
		const res = await app.request(new Request('https://example.com/sse/job/abc'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('handler-reached');
	});

	it('normalizes trailing slashes before extension check', async () => {
		// /video.mp4/ should still match .mp4 extension and NOT passthrough
		const app = buildApp();
		const res = await app.request(new Request('https://example.com/video.mp4/'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('handler-reached');
	});
});
