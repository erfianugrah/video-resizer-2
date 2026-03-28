/**
 * Internal route handlers.
 *
 * POST /internal/container-result — receives async container transform results
 *   and stores them in the Cache API for future requests.
 * GET  /internal/r2-source       — serves raw R2 objects for the container to
 *   fetch when doing URL-based async transforms of R2-only sources.
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { AppError } from '../errors';
import * as log from '../log';

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

export async function postContainerResult(c: HonoContext) {
	const cacheKey = c.req.query('cacheKey');
	const path = c.req.query('path');
	if (!cacheKey || !path) {
		throw new AppError(400, 'MISSING_PARAMS', 'cacheKey and path query params required');
	}

	const isError = c.req.header('X-Transform-Error') === 'true';
	if (isError) {
		const errorBody = await c.req.text().catch(() => '');
		log.error('Container async transform failed', { cacheKey, path, error: errorBody.slice(0, 500) });
		return c.json({ ok: false, error: 'transform failed' });
	}

	// Store the result in cache
	const body = c.req.raw.body;
	if (!body) {
		throw new AppError(400, 'EMPTY_BODY', 'Container result body is empty');
	}

	const contentType = c.req.header('Content-Type') ?? 'video/mp4';
	const contentLength = c.req.header('Content-Length');

	const headers = new Headers();
	headers.set('Content-Type', contentType);
	if (contentLength) headers.set('Content-Length', contentLength);
	headers.set('Cache-Control', 'public, max-age=86400');
	headers.set('Accept-Ranges', 'bytes');
	headers.set('Via', 'video-resizer');
	headers.set('X-Transform-Source', 'container');

	const cacheResponse = new Response(body, { status: 200, headers });
	const cache = caches.default;

	// Use the original request URL for caching so cache.match finds it.
	// The transform handler does cache.match(new Request(requestUrl, c.req.raw))
	// which is a GET request to the full user URL. We must cache.put with
	// a GET request to the same URL so the match succeeds.
	const originalUrl = c.req.query('requestUrl');
	const cacheUrl = originalUrl || (() => {
		const u = new URL(c.req.url);
		u.pathname = path;
		u.search = '';
		return u.toString();
	})();

	// Cache API only stores responses to GET requests
	const cacheRequest = new Request(cacheUrl, { method: 'GET' });
	await cache.put(cacheRequest, cacheResponse);
	log.info('Container result cached', {
		cacheKey,
		path,
		cacheUrl,
		contentType,
		contentLength: contentLength ?? 'unknown',
	});

	return c.json({ ok: true, cached: true });
}

/**
 * Serve raw R2 objects for internal container consumption.
 *
 * When the container needs to fetch a source that only exists in R2 (no remote
 * URL), we provide this endpoint so the container can download it via HTTP
 * without going through the transform pipeline (which would create a loop).
 *
 * GET /internal/r2-source?key=path/to/file&bucket=VIDEOS
 */
export async function getR2Source(c: HonoContext) {
	const key = c.req.query('key');
	const bucketBinding = c.req.query('bucket') ?? 'VIDEOS';

	if (!key) {
		throw new AppError(400, 'MISSING_KEY', 'key query param required');
	}

	const envRecord = c.env as unknown as Record<string, unknown>;
	const bucket = envRecord[bucketBinding] as R2Bucket | undefined;
	if (!bucket) {
		throw new AppError(500, 'MISSING_BUCKET', `R2 binding '${bucketBinding}' not available`);
	}

	const object = await bucket.get(key);
	if (!object) {
		throw new AppError(404, 'NOT_FOUND', `R2 object not found: ${key}`);
	}

	log.info('Serving R2 source for container', { key, size: object.size });

	return new Response(object.body, {
		headers: {
			'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
			'Content-Length': String(object.size),
			'ETag': object.etag,
		},
	});
}
