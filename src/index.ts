/**
 * video-resizer-2
 */
import { Hono } from 'hono';
import type { Env } from './types';
import { AppError } from './errors';
import { loadConfig, resetConfigCache } from './config/loader';
import { AppConfigSchema, type AppConfig } from './config/schema';
import { translateAkamaiParams, parseParams, needsContainer, type TransformParams } from './params/schema';
import { resolveDerivative } from './params/derivatives';
import { resolveResponsive } from './params/responsive';
import { matchOrigin } from './sources/router';
// sources/fetch.ts resolveSource is no longer used — source resolution is inline
// in the transform handler for proper fallback chain control.
import { transformViaBinding } from './transform/binding';
import { transformViaCdnCgi } from './transform/cdncgi';
import { transformViaContainer, transformViaContainerUrl, FFmpegContainer } from './transform/container';
import { buildCacheKey } from './cache/key';
import { getVersion, bumpVersion } from './cache/version';
import { RequestCoalescer } from './cache/coalesce';
import { getPresignedUrl } from './sources/presigned';
import { logAnalyticsEvent, CLEANUP_SQL, type AnalyticsEvent } from './analytics/middleware';
import { getSummary, getRecentErrors } from './analytics/queries';
import * as log from './log';

/** Single-flight dedup: max 500 concurrent transforms, 5-min TTL. */
const coalescer = new RequestCoalescer({ maxSize: 500, ttlMs: 300_000 });

type Variables = { config: AppConfig; startTime: number };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Error handler ────────────────────────────────────────────────────────

app.onError((err, c) => {
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

// ── CDN-CGI passthrough ──────────────────────────────────────────────────
//    Requests already on /cdn-cgi/ are internal Cloudflare paths — pass them
//    through to avoid loops when our Worker makes cdn-cgi/media subrequests.

app.use('*', async (c, next) => {
	if (new URL(c.req.url).pathname.startsWith('/cdn-cgi/')) {
		return fetch(c.req.raw);
	}
	await next();
});

// ── Non-video passthrough ────────────────────────────────────────────────
//    Skip admin/internal paths — those are handled by explicit route handlers.

app.use('*', async (c, next) => {
	const pathname = new URL(c.req.url).pathname;
	if (pathname.startsWith('/admin/') || pathname.startsWith('/internal/')) {
		await next();
		return;
	}
	const ext = pathname.split('.').pop()?.toLowerCase();
	if (ext && c.get('config').passthrough.enabled && !c.get('config').passthrough.formats.includes(ext)) {
		log.info('Passthrough', { ext });
		return fetch(c.req.raw);
	}
	await next();
});

// ── Admin: auth helper ───────────────────────────────────────────────────

function requireAuth(c: { req: { header(name: string): string | undefined }; env: Env }): void {
	const token = c.req.header('Authorization')?.replace('Bearer ', '');
	if (!c.env.CONFIG_API_TOKEN || token !== c.env.CONFIG_API_TOKEN) {
		throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing API token');
	}
}

// ── Admin: GET /admin/config ─────────────────────────────────────────────

app.get('/admin/config', async (c) => {
	requireAuth(c);
	return c.json({ config: c.get('config'), _meta: { ts: Date.now() } });
});

// ── Admin: POST /admin/config ────────────────────────────────────────────

app.post('/admin/config', async (c) => {
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
});

// ── Admin: POST /admin/cache/bust ────────────────────────────────────────

app.post('/admin/cache/bust', async (c) => {
	requireAuth(c);
	const body = await c.req.json();
	const path = body?.path;
	if (typeof path !== 'string' || !path) {
		throw new AppError(400, 'INVALID_PATH', 'Request body must include { "path": "/some/video.mp4" }');
	}
	const newVersion = await bumpVersion(c.env.CACHE_VERSIONS, path);
	log.info('Cache version bumped', { path, version: newVersion });
	return c.json({ ok: true, path, version: newVersion });
});

// ── Internal: container result callback ───────────────────────────────────
//    The FFmpeg container POSTs the transformed result here when using the
//    async transform-and-callback pattern.

app.post('/internal/container-result', async (c) => {
	const cacheKey = c.req.query('cacheKey');
	const path = c.req.query('path');
	if (!cacheKey || !path) {
		throw new AppError(400, 'MISSING_PARAMS', 'cacheKey and path query params required');
	}

	const isError = c.req.header('X-Transform-Error') === 'true';
	if (isError) {
		log.error('Container async transform failed', { cacheKey, path });
		return c.json({ ok: false, error: 'transform failed' });
	}

	// Store the result in cache
	const body = c.req.raw.body;
	if (!body) {
		throw new AppError(400, 'EMPTY_BODY', 'Container result body is empty');
	}

	const headers = new Headers();
	headers.set('Content-Type', c.req.header('Content-Type') ?? 'video/mp4');
	headers.set('Cache-Control', 'public, max-age=86400');
	headers.set('Via', 'video-resizer');
	headers.set('X-Transform-Source', 'container');

	const cacheResponse = new Response(body, { status: 200, headers });
	const cache = caches.default;

	// Use the original request URL for caching so cache.match finds it
	const originalUrl = c.req.query('requestUrl');
	const cacheUrl = originalUrl || (() => {
		const u = new URL(c.req.url);
		u.pathname = path;
		u.search = '';
		return u.toString();
	})();

	await cache.put(new Request(cacheUrl), cacheResponse);
	log.info('Container result cached', { cacheKey, path, cacheUrl });

	return c.json({ ok: true, cached: true });
});

// ── Admin: GET /admin/analytics ───────────────────────────────────────────

app.get('/admin/analytics', async (c) => {
	requireAuth(c);
	if (!c.env.ANALYTICS) throw new AppError(503, 'ANALYTICS_UNAVAILABLE', 'D1 ANALYTICS binding not configured');
	const hours = parseInt(c.req.query('hours') ?? '24', 10);
	const sinceMs = Date.now() - hours * 3600_000;
	const summary = await getSummary(c.env.ANALYTICS, sinceMs);
	return c.json({ summary, _meta: { hours, sinceMs, ts: Date.now() } });
});

// ── Admin: GET /admin/analytics/errors ───────────────────────────────────

app.get('/admin/analytics/errors', async (c) => {
	requireAuth(c);
	if (!c.env.ANALYTICS) throw new AppError(503, 'ANALYTICS_UNAVAILABLE', 'D1 ANALYTICS binding not configured');
	const hours = parseInt(c.req.query('hours') ?? '24', 10);
	const limit = parseInt(c.req.query('limit') ?? '50', 10);
	const sinceMs = Date.now() - hours * 3600_000;
	const errors = await getRecentErrors(c.env.ANALYTICS, sinceMs, limit);
	return c.json({ errors, _meta: { hours, limit, sinceMs, ts: Date.now() } });
});

// ── Transform handler ────────────────────────────────────────────────────

app.get('*', async (c) => {
	const config = c.get('config');
	const url = new URL(c.req.url);
	const path = url.pathname;
	const requestUrl = c.req.url;
	const startTime = c.get('startTime') ?? performance.now();
	const skipCache = url.searchParams.has('debug');
	const requestId = crypto.randomUUID();

	// Scoped logger — every log line includes requestId for E2E tracing
	const rlog = {
		info: (msg: string, data?: Record<string, unknown>) => log.info(msg, { requestId, ...data }),
		warn: (msg: string, data?: Record<string, unknown>) => log.warn(msg, { requestId, ...data }),
		error: (msg: string, data?: Record<string, unknown>) => log.error(msg, { requestId, ...data }),
		debug: (msg: string, data?: Record<string, unknown>) => log.debug(msg, { requestId, ...data }),
	};

	rlog.info('Request', { path, query: url.search });

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

	rlog.info('Params resolved', {
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

	rlog.info('Origin matched', { origin: originMatch.origin.name });

	// 2b. Debug diagnostics — ?debug=view returns JSON diagnostics instead of video
	if (url.searchParams.get('debug') === 'view') {
		const diagnostics = {
			requestId,
			path,
			params,
			origin: {
				name: originMatch.origin.name,
				sources: originMatch.origin.sources.map((s) => ({ type: s.type, priority: s.priority })),
				ttl: originMatch.origin.ttl,
			},
			captures: originMatch.captures,
			config: {
				derivatives: Object.keys(config.derivatives),
				responsive: config.responsive,
				passthrough: config.passthrough,
				containerEnabled: config.container?.enabled ?? false,
			},
			needsContainer: needsContainer(params),
			resolvedWidth: params.width ?? null,
			resolvedHeight: params.height ?? null,
		};
		return c.json({ diagnostics, _meta: { ts: Date.now() } });
	}

	// 3. Cache lookup
	//    Use the raw request URL as the cache key with caches.default so the
	//    standard Cloudflare Purge API (purge by URL/tag/everything) works.
	const cacheReq = new Request(requestUrl, c.req.raw);
	const cache = caches.default;

	if (!skipCache) {
		const cached = await cache.match(cacheReq);
		if (cached) {
			rlog.info('Cache HIT', { path });
			const resp = new Response(cached.body, cached);
			resp.headers.set('X-Request-ID', requestId);

			// Log cache hit to analytics
			if (c.env.ANALYTICS) {
				logAnalyticsEvent(c.env.ANALYTICS, {
					path,
					origin: originMatch.origin.name,
					status: cached.status,
					mode: params.mode ?? null,
					derivative: params.derivative ?? null,
					durationMs: Math.round(performance.now() - startTime),
					cacheHit: true,
					transformSource: null,
					sourceType: null,
					errorCode: null,
					bytes: parseInt(cached.headers.get('Content-Length') ?? '0', 10) || null,
				}, c.executionCtx.waitUntil.bind(c.executionCtx));
			}

			return resp;
		}
		rlog.info('Cache MISS', { path });
	}

	// 4. Request coalescing — join in-flight transform if one exists
	//    Build a preliminary cache key for coalescing (without etag — we
	//    don't have it yet since we haven't fetched the source).
	const coalesceKey = buildCacheKey(path, params);
	const inflight = coalescer.get(coalesceKey);
	if (inflight) {
		rlog.info('Coalesced', { path, coalesceKey });
		return inflight;
	}

	// 5. Resolve source + transform (wrapped in a coalescing promise)
	//    Three-tier routing:
	//      R2 source         → env.MEDIA.input(stream) — direct binding, no HTTP overhead
	//      Remote/fallback   → cdn-cgi/media URL fetch — edge handles fetch + transform,
	//                          no video bytes in Worker memory, supports 256MB limit
	//      Container params  → FFmpeg container DO (not yet implemented)
	//
	//    Sources are tried in priority order. If a remote source returns 404
	//    via cdn-cgi, we fall through to the next source (which may be R2).
	const transformPromise = (async () => {
		const envRecord = c.env as unknown as Record<string, unknown>;
		const zoneHost = new URL(c.req.url).host;
		const { sortedSources, resolveSourcePath } = await import('./sources/router');
		const { applyAuth: _applyAuth } = await import('./sources/auth');
		const sources = sortedSources(originMatch.origin);
		const errors: string[] = [];
		let transformed: Response | null = null;
		let etag: string | undefined;
		let version: number | undefined;
		let sourceType: string = 'unknown';

		// Container-only params: if the container is enabled and available, route there.
		// If not, log a warning and proceed with binding/cdn-cgi (which will
		// ignore unsupported params like fps/speed/rotate/crop/bitrate).
		const containerNeeded = needsContainer(params);
		if (containerNeeded && config.container?.enabled && c.env.FFMPEG_CONTAINER) {
			rlog.info('Routing to FFmpeg container', { path });
			// Fetch the source stream for the container
			for (const source of sources) {
				try {
					const resolved = resolveSourcePath(source, path, originMatch.captures);
					let stream: ReadableStream<Uint8Array> | null = null;

					if (source.type === 'r2') {
						const bucket = envRecord[source.bucketBinding] as R2Bucket | undefined;
						const object = bucket ? await bucket.get(resolved) : null;
						if (object) {
							etag = object.etag;
							sourceType = 'r2';
							stream = object.body;
						}
					} else if (source.url) {
						const resp = await fetch(source.url.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
						if (resp.ok && resp.body) {
							sourceType = source.type;
							stream = resp.body;
						}
					}

					if (stream) {
						const instanceKey = `ffmpeg:${originMatch.origin.name}:${path}`;
						transformed = await transformViaContainer(c.env.FFMPEG_CONTAINER, stream, params, instanceKey);
						break;
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					errors.push(`container(${source.type}): ${msg}`);
					continue;
				}
			}

		} else if (containerNeeded) {
			rlog.warn('Container-only params present but container disabled — proceeding with binding', {
				params: { fps: params.fps, speed: params.speed, rotate: params.rotate, crop: params.crop, bitrate: params.bitrate, duration: params.duration },
			});
		}

		// Normal source loop (skipped if container already produced a result)
		if (transformed) {
			// Container handled it — skip to response headers
		} else for (const source of sources) {
			try {
				const resolved = resolveSourcePath(source, path, originMatch.captures);

				if (source.type === 'r2') {
					// R2 → check size → binding (<=100MB) or container (>100MB)
					const bucket = envRecord[source.bucketBinding] as R2Bucket | undefined;
					if (!bucket) throw new Error(`R2 binding '${source.bucketBinding}' not available`);
					const object = await bucket.get(resolved);
					if (!object) throw new Error(`R2 object not found: ${resolved}`);

					const BINDING_SIZE_LIMIT = 100 * 1024 * 1024; // 100MB
					etag = object.etag;
					sourceType = 'r2';
					rlog.info('Source fetched (R2)', { path: resolved, size: object.size, etag });

					// Oversized: route to FFmpeg container (async for very large files)
					if (object.size > BINDING_SIZE_LIMIT && c.env.FFMPEG_CONTAINER) {
						const instanceKey = `ffmpeg:${originMatch.origin.name}:${path}`;

						if (object.size > 256 * 1024 * 1024) {
							// Very large (>256MB): use URL-based async container.
							// Container fetches source directly — no streaming through DO.
							const callbackUrl = `https://${zoneHost}/internal/container-result?path=${encodeURIComponent(path)}&cacheKey=${encodeURIComponent(buildCacheKey(path, params, undefined, etag))}&requestUrl=${encodeURIComponent(requestUrl)}`;
							// Find a fetchable URL for the source (remote source from origin, or construct one)
							const remoteSource = sources.find((s) => s.type === 'remote' || s.type === 'fallback');
							const fetchableUrl = remoteSource && 'url' in remoteSource
								? remoteSource.url.replace(/\/+$/, '') + path
								: `https://${zoneHost}${path}`;
							rlog.info('R2 object too large for sync, using URL-based async container', {
								size: object.size, fetchableUrl, callbackUrl,
							});
							// Cancel the R2 body — container will fetch independently
							object.body.cancel().catch(() => {});
							c.executionCtx.waitUntil(
								transformViaContainerUrl(c.env.FFMPEG_CONTAINER, fetchableUrl, params, instanceKey, callbackUrl)
									.then((r: Response) => rlog.info('Async container accepted', { status: r.status }))
									.catch((err: unknown) => rlog.error('Async container failed', { error: err instanceof Error ? err.message : String(err) })),
							);
							// Return raw passthrough — next request will get cached transform
							const passthroughObject = await bucket.get(resolved);
							if (passthroughObject) {
								transformed = new Response(passthroughObject.body, {
									headers: {
										'Content-Type': passthroughObject.httpMetadata?.contentType ?? 'video/mp4',
										'X-Transform-Pending': 'true',
									},
								});
							}
							break;
						}

						// Large but fits in sync (100-256MB): wait for container
						rlog.info('R2 object exceeds binding limit, routing to container', {
							size: object.size, limit: BINDING_SIZE_LIMIT,
						});
						transformed = await transformViaContainer(c.env.FFMPEG_CONTAINER, object.body, params, instanceKey);
						break;
					}

					try {
						transformed = await transformViaBinding(c.env.MEDIA, object.body, params);
					} catch (bindingErr) {
						// Reactive container fallback: if binding rejects oversized input
						if (bindingErr instanceof AppError && bindingErr.code.startsWith('MEDIA_ERROR') && c.env.FFMPEG_CONTAINER) {
							rlog.warn('Binding failed, falling back to container', { error: bindingErr.message });
							const retryObject = await bucket.get(resolved);
							if (retryObject) {
								const instanceKey = `ffmpeg:${originMatch.origin.name}:${path}`;
								transformed = await transformViaContainer(c.env.FFMPEG_CONTAINER, retryObject.body, params, instanceKey);
								break;
							}
						}
						// Duration limit retry
						if (bindingErr instanceof AppError && bindingErr.message.includes('duration')) {
							const maxMatch = bindingErr.message.match(/(\d+)s/);
							if (maxMatch) {
								const maxDur = `${maxMatch[1]}s`;
								rlog.warn('Duration retry', { original: params.duration, capped: maxDur });
								const retryObject = await bucket.get(resolved);
								if (retryObject) {
									const retryParams = { ...params, duration: maxDur };
									transformed = await transformViaBinding(c.env.MEDIA, retryObject.body, retryParams);
								}
							}
						}
						if (!transformed) throw bindingErr;
					}
					break;
				} else {
					// Remote/fallback — check size via HEAD to decide routing
					version = await getVersion(c.env.CACHE_VERSIONS, path);
					sourceType = source.type;

					let sourceUrl = resolved;
					if (source.auth && source.auth.type === 'aws-s3') {
						sourceUrl = await getPresignedUrl(
							c.env.CACHE_VERSIONS,
							resolved,
							source.auth,
							envRecord,
						);
					}

					// Check content-length via HEAD to detect oversized sources
					const CDN_CGI_SIZE_LIMIT = 256 * 1024 * 1024; // 256MB
					const headResp = await fetch(sourceUrl, { method: 'HEAD' }).catch(() => null);
					const contentLength = parseInt(headResp?.headers.get('Content-Length') ?? '0', 10);

					if (contentLength > CDN_CGI_SIZE_LIMIT && c.env.FFMPEG_CONTAINER) {
						const instanceKey = `ffmpeg:${originMatch.origin.name}:${path}`;

						// URL-based async: container fetches source directly
						const callbackUrl = `https://${zoneHost}/internal/container-result?path=${encodeURIComponent(path)}&cacheKey=${encodeURIComponent(buildCacheKey(path, params, version))}&requestUrl=${encodeURIComponent(requestUrl)}`;
						rlog.info('Remote source exceeds cdn-cgi limit, routing to URL-based async container', {
							size: contentLength, limit: CDN_CGI_SIZE_LIMIT, sourceUrl, callbackUrl,
						});

						c.executionCtx.waitUntil(
							transformViaContainerUrl(c.env.FFMPEG_CONTAINER, sourceUrl, params, instanceKey, callbackUrl)
								.then((r: Response) => rlog.info('Async container accepted', { status: r.status }))
								.catch((err: unknown) => rlog.error('Async container failed', { error: err instanceof Error ? err.message : String(err) })),
						);
						// Return immediate passthrough — container will cache when done
						const passthroughResp = await fetch(sourceUrl);
						if (passthroughResp.ok) {
							transformed = new Response(passthroughResp.body, {
								headers: {
									'Content-Type': passthroughResp.headers.get('Content-Type') ?? 'video/mp4',
									'X-Transform-Pending': 'true',
								},
							});
							break;
						}
					}

					rlog.info('Source resolved (cdn-cgi)', { path: resolved, sourceUrl, sourceType, contentLength });
					const resp = await transformViaCdnCgi(zoneHost, sourceUrl, params, version);

					// If cdn-cgi returns 404/5xx, the source doesn't exist — try next
					if (resp.status === 404 || resp.status === 410) {
						errors.push(`${source.type}(p${source.priority}): cdn-cgi 404 for ${resolved}`);
						continue;
					}
					if (resp.status >= 500 && resp.status < 600) {
						const body = await resp.text().catch(() => '');
						errors.push(`${source.type}(p${source.priority}): cdn-cgi ${resp.status}: ${body.slice(0, 200)}`);
						continue;
					}

					// Detect untransformed passthrough: if we asked for frame/audio
					// but got a video content-type back, cdn-cgi didn't transform.
					// This happens when transforms aren't enabled on the zone.
					const respCT = resp.headers.get('Content-Type') ?? '';
					const isRawPassthrough =
						(params.mode === 'frame' && !respCT.startsWith('image/')) ||
						(params.mode === 'audio' && !respCT.startsWith('audio/')) ||
						(contentLength > 0 && parseInt(resp.headers.get('Content-Length') ?? '0', 10) === contentLength);
					if (isRawPassthrough) {
						errors.push(`${source.type}(p${source.priority}): cdn-cgi returned raw source (transforms not enabled?)`);
						// Consume the body to avoid leaking
						await resp.body?.cancel().catch(() => {});
						continue;
					}

					transformed = resp;
					break;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				errors.push(`${source.type}(p${source.priority}): ${msg}`);
				rlog.warn('Source failed, trying next', { source: source.type, error: msg });
				continue;
			}
		}

		// Last resort: if all transforms failed, try raw passthrough from any source
		if (!transformed) {
			rlog.warn('All transforms failed, attempting raw passthrough', { errors });
			for (const source of sources) {
				try {
					const resolved = resolveSourcePath(source, path, originMatch.captures);
					if (source.type === 'r2') {
						const bucket = envRecord[source.bucketBinding] as R2Bucket | undefined;
						const object = bucket ? await bucket.get(resolved) : null;
						if (object) {
							sourceType = 'r2';
							etag = object.etag;
							transformed = new Response(object.body, {
								headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'video/mp4' },
							});
							break;
						}
					} else if (source.url) {
						const resp = await fetch(source.url.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
						if (resp.ok) {
							sourceType = source.type;
							transformed = resp;
							break;
						}
					}
				} catch { continue; }
			}
		}

		if (!transformed) {
			throw new AppError(502, 'ALL_SOURCES_FAILED', `All sources failed for origin '${originMatch.origin.name}'`, {
				origin: originMatch.origin.name,
				path,
				errors,
			});
		}

		const cacheKey = buildCacheKey(path, params, version, etag);

		const durationMs = Math.round(performance.now() - startTime);
		rlog.info('Transform complete', { path, cacheKey, durationMs, status: transformed.status });

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
		// Standard headers (always present)
		headers.set('X-Request-ID', requestId);
		// cf-cache-status is set by Cloudflare's edge automatically (HIT/MISS/DYNAMIC).
		// We don't set our own — it would be misleading on cached responses.
		headers.set('Via', 'video-resizer');
		if (params.derivative) headers.set('X-Derivative', params.derivative);
		if (params.filename) headers.set('Content-Disposition', `inline; filename="${params.filename}"`);

		// Debug headers (always set — useful for monitoring, low overhead)
		headers.set('X-Cache-Key', cacheKey);
		headers.set('X-Origin', originMatch.origin.name);
		headers.set('X-Source-Type', sourceType);
		headers.set('X-Transform-Source', sourceType === 'r2' ? 'binding' : 'cdn-cgi');
		headers.set('X-Processing-Time-Ms', String(durationMs));
		if (etag) headers.set('X-Source-Etag', etag);
		if (params.width) headers.set('X-Resolved-Width', String(params.width));
		if (params.height) headers.set('X-Resolved-Height', String(params.height));

		// Playback hint headers (HTML attributes, not transform params)
		if (params.loop !== undefined) headers.set('X-Playback-Loop', String(params.loop));
		if (params.autoplay !== undefined) headers.set('X-Playback-Autoplay', String(params.autoplay));
		if (params.muted !== undefined) headers.set('X-Playback-Muted', String(params.muted));
		if (params.preload) headers.set('X-Playback-Preload', params.preload);

		// Content-type correction for non-video modes
		if (params.mode === 'audio') {
			headers.set('Content-Type', 'audio/mp4');
		} else if (params.mode === 'frame') {
			const fmt = params.format === 'png' ? 'image/png' : 'image/jpeg';
			headers.set('Content-Type', fmt);
		}

		// Cache-Tag for purge-by-tag
		const tags: string[] = [];
		if (params.derivative) tags.push(`derivative:${params.derivative}`);
		tags.push(`origin:${originMatch.origin.name}`);
		if (params.mode && params.mode !== 'video') tags.push(`mode:${params.mode}`);
		if (originMatch.origin.cacheTags) tags.push(...originMatch.origin.cacheTags);
		if (tags.length) headers.set('Cache-Tag', tags.join(','));

		// Strip headers that prevent caching
		headers.delete('Set-Cookie');
		if (headers.get('Vary') === '*') headers.delete('Vary');

		// 7. Tee body -> client + cache
		//    Always tee() so neither stream holds a lock on the original body.
		//    tee() creates two independent streams that can be consumed without
		//    buffering the entire response in memory (critical at 128MB limit).
		//    If the client disconnects early, the cache stream still drains.
		const body = transformed.body;
		if (!body) {
			return new Response(null, { status: transformed.status, headers });
		}

		const [toClient, toCache] = body.tee();
		const isPendingPassthrough = headers.get('X-Transform-Pending') === 'true';
		const shouldCache = !skipCache && !isPendingPassthrough && transformed.status >= 200 && transformed.status < 400;

		if (shouldCache) {
			const cacheHeaders = new Headers(headers);
			c.executionCtx.waitUntil(
				cache
					.put(cacheReq, new Response(toCache, { status: transformed.status, headers: cacheHeaders }))
					.then(() => rlog.info('cache.put resolved', { path }))
					.catch((err) =>
						rlog.error('cache.put FAILED', {
							path,
							error: err instanceof Error ? err.message : String(err),
						}),
					),
			);
		} else {
			// Not caching — cancel the unused stream so it doesn't leak
			toCache.cancel().catch(() => {});
		}

		// Log to analytics (non-blocking)
		if (c.env.ANALYTICS) {
			logAnalyticsEvent(c.env.ANALYTICS, {
				path,
				origin: originMatch.origin.name,
				status: transformed.status,
				mode: params.mode ?? null,
				derivative: params.derivative ?? null,
				durationMs,
				cacheHit: false,
				transformSource: sourceType === 'r2' ? 'binding' : 'cdn-cgi',
				sourceType,
				errorCode: null,
				bytes: parseInt(transformed.headers.get('Content-Length') ?? '0', 10) || null,
			}, c.executionCtx.waitUntil.bind(c.executionCtx));
		}

		return new Response(toClient, { status: transformed.status, headers });
	})();

	// Register for coalescing, clean up when done
	coalescer.set(coalesceKey, transformPromise);
	transformPromise.finally(() => coalescer.delete(coalesceKey));

	return await transformPromise;
});

// ── Export ────────────────────────────────────────────────────────────────

// Re-export the Container class so wrangler can register it as a Durable Object
export { FFmpegContainer };

export default {
	fetch: app.fetch,
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		if (controller.cron === '0 0 * * sun' && env.ANALYTICS) {
			await env.ANALYTICS.exec(CLEANUP_SQL);
			log.info('Weekly analytics cleanup');
		}
	},
};
