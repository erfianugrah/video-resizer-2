/**
 * Tests for config middleware — loads config from KV and attaches to c.var.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../../src/types';
import { configMiddleware } from '../../src/middleware/config';
import { resetConfigCache } from '../../src/config/loader';

/** Minimal KV namespace stub returning a provided config shape (or null). */
function mockKv(value: unknown): KVNamespace {
	return {
		get: async (_key: string, _type: string) => value,
	} as unknown as KVNamespace;
}

describe('configMiddleware', () => {
	it('loads default config when KV binding is absent', async () => {
		resetConfigCache();
		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.use('*', configMiddleware);
		app.get('/check', (c) => {
			const cfg = c.get('config');
			return c.json({
				hasOrigins: Array.isArray(cfg.origins) && cfg.origins.length > 0,
				originsCount: cfg.origins.length,
				cdnCgiSizeLimit: cfg.cdnCgiSizeLimit,
				asyncContainerThreshold: cfg.asyncContainerThreshold,
			});
		});

		const res = await app.request(new Request('https://example.com/check'), undefined, {
			CONFIG: undefined,
		} as unknown as Env);
		const body = await res.json() as { hasOrigins: boolean; cdnCgiSizeLimit: number; asyncContainerThreshold: number };
		expect(body.hasOrigins).toBe(true);
		expect(body.cdnCgiSizeLimit).toBe(100 * 1024 * 1024);
		expect(body.asyncContainerThreshold).toBe(256 * 1024 * 1024);
	});

	it('loads config from KV when binding returns valid data', async () => {
		resetConfigCache();
		const kvConfig = {
			origins: [{ name: 'custom', matcher: '.*', sources: [{ type: 'remote', url: 'https://a', priority: 0 }] }],
			asyncContainerThreshold: 512 * 1024 * 1024,
		};
		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.use('*', configMiddleware);
		app.get('/check', (c) => c.json(c.get('config')));

		const res = await app.request(new Request('https://example.com/check'), undefined, {
			CONFIG: mockKv(kvConfig),
		} as unknown as Env);
		const body = await res.json() as { origins: { name: string }[]; asyncContainerThreshold: number };
		expect(body.origins[0].name).toBe('custom');
		expect(body.asyncContainerThreshold).toBe(512 * 1024 * 1024);
	});

	it('falls back to defaults when KV data fails validation', async () => {
		resetConfigCache();
		// Missing required `origins` field → validation fails → default config used
		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.use('*', configMiddleware);
		app.get('/check', (c) => c.json(c.get('config')));

		const res = await app.request(new Request('https://example.com/check'), undefined, {
			CONFIG: mockKv({ garbage: 'data' }),
		} as unknown as Env);
		const body = await res.json() as { origins: { name: string }[] };
		// DEFAULT_CONFIG has one origin named 'default'
		expect(body.origins[0].name).toBe('default');
	});

	it('supports nested root.video.origins structure (legacy KV shape)', async () => {
		resetConfigCache();
		const kvConfig = {
			video: {
				origins: [{ name: 'nested', matcher: '.*', sources: [{ type: 'remote', url: 'https://b', priority: 0 }] }],
			},
		};
		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		app.use('*', configMiddleware);
		app.get('/check', (c) => c.json(c.get('config')));

		const res = await app.request(new Request('https://example.com/check'), undefined, {
			CONFIG: mockKv(kvConfig),
		} as unknown as Env);
		const body = await res.json() as { origins: { name: string }[] };
		expect(body.origins[0].name).toBe('nested');
	});
});
