/**
 * video-resizer-2
 */
import { Hono } from 'hono';
import type { Env } from './types';
import { AppError } from './errors';
import { loadConfig } from './config/loader';
import type { AppConfig } from './config/schema';
import { translateAkamaiParams, parseParams, needsContainer, type TransformParams } from './params/schema';
import { resolveDerivative } from './params/derivatives';
import { resolveResponsive } from './params/responsive';
import { matchOrigin } from './sources/router';
import { fetchSource } from './sources/fetch';
import { transformViaBinding } from './transform/binding';
import { buildCacheKey } from './cache/key';
import * as log from './log';

type Variables = { config: AppConfig; startTime: number };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Error handler ────────────────────────────────────────────────────────

app.onError((err, c) => {
	if (err instanceof AppError) {
		log.error('AppError', { code: err.code, status: err.status, message: err.message, details: err.details });
		return c.json(err.toJSON(), err.status as any);
	}
	log.error('Unhandled error', { message: err.message, stack: err.stack?.slice(0, 500) });
	return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
});

// ── Via loop prevention ──────────────────────────────────────────────────

app.use('*', async (c, next) => {
	if ((c.req.header('via') ?? '').includes('video-resizer')) {
		log.debug('Via loop detected');
		return fetch(c.req.raw);
	}
	c.set('startTime', performance.now());
	await next();
});

// ── Config ───────────────────────────────────────────────────────────────

app.use('*', async (c, next) => {
	c.set('config', await loadConfig(c.env.CONFIG));
	await next();
});

// ── Non-video passthrough ────────────────────────────────────────────────

app.use('*', async (c, next) => {
	const ext = new URL(c.req.url).pathname.split('.').pop()?.toLowerCase();
	if (ext && c.get('config').passthrough.enabled && !c.get('config').passthrough.formats.includes(ext)) {
		log.info('Passthrough', { ext });
		return fetch(c.req.raw);
	}
	await next();
});

// ── Admin ────────────────────────────────────────────────────────────────

app.get('/admin/config', async (c) => {
	const token = c.req.header('Authorization')?.replace('Bearer ', '');
	if (!c.env.CONFIG_API_TOKEN || token !== c.env.CONFIG_API_TOKEN) {
		throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing API token');
	}
	return c.json({ config: c.get('config'), _meta: { ts: Date.now() } });
});

// ── Transform handler ────────────────────────────────────────────────────

app.get('*', async (c) => {
	const config = c.get('config');
	const url = new URL(c.req.url);
	const path = url.pathname;
	const requestUrl = c.req.url;
	const startTime = c.get('startTime') ?? performance.now();
	const skipCache = url.searchParams.has('debug');

	log.info('Request', { path, query: url.search });

	// 1. Parse + resolve params
	const { params: translated, clientHints } = translateAkamaiParams(url.searchParams);
	let params = parseParams(translated);
	params = resolveDerivative(params, config.derivatives);

	const reqHeaders = new Headers(c.req.raw.headers);
	for (const [k, v] of Object.entries(clientHints)) {
		if (!reqHeaders.has(k)) reqHeaders.set(k, v);
	}
	params = resolveResponsive(params, reqHeaders, config.responsive, config.derivatives);
	if (params.derivative && !params.width) {
		params = resolveDerivative(params, config.derivatives);
	}

	log.info('Params resolved', {
		derivative: params.derivative,
		width: params.width,
		height: params.height,
		mode: params.mode,
		fit: params.fit,
	});

	// 2. Match origin
	const originMatch = matchOrigin(path, config.origins);
	if (!originMatch) throw new AppError(404, 'NO_MATCHING_ORIGIN', `No origin matched: ${path}`);

	if (originMatch.origin.videoCompression && !params.compression) {
		params = { ...params, compression: originMatch.origin.videoCompression };
	}
	if (originMatch.origin.quality && !params.quality) {
		params = { ...params, quality: originMatch.origin.quality };
	}

	log.info('Origin matched', { origin: originMatch.origin.name });

	// 3. Cache lookup
	//    Construct a fresh Request from the URL string — never use c.req.raw
	//    for cache operations because Hono may have locked its body stream.
	//    Forward Range/conditional headers so cache.match returns 206/304.
	const cacheKey = buildCacheKey(path, params);
	const cache = caches.default;

	// Build cache request with only the headers cache.match cares about
	const cacheHeaders = new Headers();
	const rangeHeader = c.req.header('Range');
	if (rangeHeader) cacheHeaders.set('Range', rangeHeader);
	const ifNoneMatch = c.req.header('If-None-Match');
	if (ifNoneMatch) cacheHeaders.set('If-None-Match', ifNoneMatch);
	const ifModifiedSince = c.req.header('If-Modified-Since');
	if (ifModifiedSince) cacheHeaders.set('If-Modified-Since', ifModifiedSince);

	const cacheRequest = new Request(requestUrl, { headers: cacheHeaders });

	if (!skipCache) {
		const cached = await cache.match(cacheRequest);
		if (cached) {
			log.info('Cache HIT', { path, cacheKey, status: cached.status });
			return cached;
		}
		log.info('Cache MISS', { path, cacheKey, url: requestUrl });
	}

	// 4. Fetch source
	if (needsContainer(params)) {
		log.warn('Container-only params — not yet implemented');
	}

	const source = await fetchSource(originMatch.origin, path, originMatch.captures, c.env as unknown as Record<string, unknown>);

	log.info('Source fetched', {
		sourceType: source.source.type,
		contentLength: source.contentLength,
	});

	// 5. Transform
	const transformed = await transformViaBinding(c.env.MEDIA, source.stream, params);
	const durationMs = Math.round(performance.now() - startTime);

	log.info('Transform complete', { path, cacheKey, durationMs, status: transformed.status });

	// 6. Response headers
	let maxAge = 86400;
	const ttl = originMatch.origin.ttl;
	if (ttl) {
		const s = transformed.status;
		if (s >= 200 && s < 300) maxAge = ttl.ok;
		else if (s >= 300 && s < 400) maxAge = ttl.redirects;
		else if (s >= 400 && s < 500) maxAge = ttl.clientError;
		else if (s >= 500) maxAge = ttl.serverError;
	}

	const headers = new Headers(transformed.headers);
	headers.set('Cache-Control', `public, max-age=${maxAge}`);
	headers.set('Accept-Ranges', 'bytes');
	headers.set('Via', 'video-resizer');
	headers.set('X-Cache-Key', cacheKey);
	headers.set('X-Origin', originMatch.origin.name);
	headers.set('X-Source-Type', source.source.type);
	headers.set('X-Processing-Time-Ms', String(durationMs));
	if (params.derivative) headers.set('X-Derivative', params.derivative);
	if (params.filename) headers.set('Content-Disposition', `inline; filename="${params.filename}"`);

	// Cache-Tag for purge-by-tag
	const tags: string[] = [];
	if (params.derivative) tags.push(`derivative:${params.derivative}`);
	tags.push(`origin:${originMatch.origin.name}`);
	if (params.mode && params.mode !== 'video') tags.push(`mode:${params.mode}`);
	if (originMatch.origin.cacheTags) tags.push(...originMatch.origin.cacheTags);
	if (tags.length) headers.set('Cache-Tag', tags.join(','));

	headers.delete('Set-Cookie');

	// 7. Tee body → client + cache
	const body = transformed.body;
	if (!body) {
		return new Response(null, { status: transformed.status, headers });
	}

	const [toClient, toCache] = body.tee();

	if (!skipCache) {
		const cacheResponse = new Response(toCache, { status: transformed.status, headers });
		// Clean GET request for cache.put — same URL, no Range
		const putRequest = new Request(requestUrl, { method: 'GET' });
		c.executionCtx.waitUntil(
			cache
				.put(putRequest, cacheResponse)
				.then(() => log.info('cache.put OK', { cacheKey }))
				.catch((err) =>
					log.error('cache.put FAILED', {
						cacheKey,
						error: err instanceof Error ? err.message : String(err),
					}),
				),
		);
	}

	return new Response(toClient, { status: transformed.status, headers });
});

// ── Export ────────────────────────────────────────────────────────────────

export default {
	fetch: app.fetch,
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		if (controller.cron === '0 0 * * 0' && env.ANALYTICS) {
			await env.ANALYTICS.exec(`
				DROP TABLE IF EXISTS transform_log;
				CREATE TABLE IF NOT EXISTS transform_log (
					id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, path TEXT NOT NULL,
					origin TEXT, status INTEGER NOT NULL, mode TEXT, derivative TEXT,
					duration_ms INTEGER, cache_hit INTEGER NOT NULL DEFAULT 0,
					transform_source TEXT, source_type TEXT, error_code TEXT, bytes INTEGER
				);
				CREATE INDEX IF NOT EXISTS idx_log_ts ON transform_log(ts);
				CREATE INDEX IF NOT EXISTS idx_log_status ON transform_log(status);
			`);
			log.info('Weekly analytics cleanup');
		}
	},
};
