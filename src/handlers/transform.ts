/**
 * Main transform handler — GET *.
 *
 * Pipeline: parse params → resolve derivative → responsive sizing → match origin →
 * debug diagnostics → cache lookup → request coalescing → source resolution →
 * transform (binding/cdn-cgi/container) → response headers → tee body → cache.put.
 */
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { AppError } from '../errors';
import { translateAkamaiParams, parseParams, needsContainer, type TransformParams } from '../params/schema';
import { resolveDerivative } from '../params/derivatives';
import { resolveResponsive } from '../params/responsive';
import { matchOrigin, sortedSources, resolveSourcePath } from '../sources/router';
import { transformViaBinding } from '../transform/binding';
import { transformViaCdnCgi } from '../transform/cdncgi';
import { transformViaContainer, transformViaContainerUrl, buildContainerInstanceKey } from '../transform/container';
import { buildCacheKey } from '../cache/key';
import { getVersion } from '../cache/version';
import { RequestCoalescer } from '../cache/coalesce';
import { getPresignedUrl } from '../sources/presigned';
import { logAnalyticsEvent } from '../analytics/middleware';
import * as log from '../log';

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Single-flight dedup: max 500 concurrent transforms, 5-min TTL. */
const coalescer = new RequestCoalescer({ maxSize: 500, ttlMs: 300_000 });

/**
 * Downgrade HTTPS to HTTP for container outbound interception.
 * Containers can only intercept HTTP traffic. Used ONLY for callback
 * URLs to our own Worker (which must go through the outbound handler
 * to access bindings). Source URLs stay HTTPS — the container fetches
 * them directly via enableInternet=true.
 */
function toCallbackUrl(zoneHost: string, path: string): string {
	return `http://${zoneHost}${path}`;
}

export async function transformHandler(c: HonoContext) {
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
	const coalesceKey = buildCacheKey(path, params);
	const inflight = coalescer.get(coalesceKey);
	if (inflight) {
		rlog.info('Coalesced', { path, coalesceKey });
		return inflight;
	}

	// 5. Resolve source + transform (wrapped in a coalescing promise)
	const transformPromise = (async () => {
		const envRecord = c.env as unknown as Record<string, unknown>;
		const zoneHost = new URL(c.req.url).host;
		const sources = sortedSources(originMatch.origin);
		const errors: string[] = [];
		let transformed: Response | null = null;
		let etag: string | undefined;
		let version: number | undefined;
		let sourceType: string = 'unknown';

		// Container-only params: route to container if enabled
		const containerNeeded = needsContainer(params);
		if (containerNeeded && config.container?.enabled && c.env.FFMPEG_CONTAINER) {
			rlog.info('Routing to FFmpeg container', { path });
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
						const instanceKey = buildContainerInstanceKey(originMatch.origin.name, path, params);
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
					// R2 -> check size -> binding (<=100MB) or container (>100MB)
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
						const instanceKey = buildContainerInstanceKey(originMatch.origin.name, path, params);

						if (object.size > 256 * 1024 * 1024) {
							// Very large (>256MB): use URL-based async container
							// Use http:// — container outbound handler only intercepts HTTP (not HTTPS).
							// The Worker's outbound handler proxies this via fetch() which handles TLS.
							const callbackUrl = `http://${zoneHost}/internal/container-result?path=${encodeURIComponent(path)}&cacheKey=${encodeURIComponent(buildCacheKey(path, params, undefined, etag))}&requestUrl=${encodeURIComponent(requestUrl)}`;
							// Find a fetchable URL for the source:
							// 1. Prefer remote/fallback source URL if configured
							// 2. Fall back to /internal/r2-source endpoint (avoids transform loop)
							const remoteSource = sources.find((s) => s.type === 'remote' || s.type === 'fallback');
							// Source URLs use HTTPS — container fetches directly via internet (enableInternet=true).
							// R2-only fallback uses http:// to go through outbound handler to access R2 binding.
							const fetchableUrl = remoteSource && 'url' in remoteSource
								? remoteSource.url.replace(/\/+$/, '') + path
								: toCallbackUrl(zoneHost, `/internal/r2-source?key=${encodeURIComponent(resolved)}&bucket=${encodeURIComponent(source.bucketBinding)}`);
							rlog.info('R2 object too large for sync, using URL-based async container', {
								size: object.size, fetchableUrl, callbackUrl,
							});
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
								const instanceKey = buildContainerInstanceKey(originMatch.origin.name, path, params);
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
						const instanceKey = buildContainerInstanceKey(originMatch.origin.name, path, params);

						// Use http:// — container outbound handler only intercepts HTTP (not HTTPS).
						const callbackUrl = `http://${zoneHost}/internal/container-result?path=${encodeURIComponent(path)}&cacheKey=${encodeURIComponent(buildCacheKey(path, params, version))}&requestUrl=${encodeURIComponent(requestUrl)}`;
						rlog.info('Remote source exceeds cdn-cgi limit, routing to URL-based async container', {
							size: contentLength, limit: CDN_CGI_SIZE_LIMIT, sourceUrl, callbackUrl,
						});

						c.executionCtx.waitUntil(
							transformViaContainerUrl(c.env.FFMPEG_CONTAINER, sourceUrl, params, instanceKey, callbackUrl)
								.then((r: Response) => rlog.info('Async container accepted', { status: r.status }))
								.catch((err: unknown) => rlog.error('Async container failed', { error: err instanceof Error ? err.message : String(err) })),
						);
						// Return immediate passthrough
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

					// Detect untransformed passthrough
					const respCT = resp.headers.get('Content-Type') ?? '';
					const isRawPassthrough =
						(params.mode === 'frame' && !respCT.startsWith('image/')) ||
						(params.mode === 'audio' && !respCT.startsWith('audio/')) ||
						(contentLength > 0 && parseInt(resp.headers.get('Content-Length') ?? '0', 10) === contentLength);
					if (isRawPassthrough) {
						errors.push(`${source.type}(p${source.priority}): cdn-cgi returned raw source (transforms not enabled?)`);
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

		// Last resort: raw passthrough from any source
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

		return { transformed, etag, version, sourceType };
	})();

	// Register for coalescing, clean up when done
	const responsePromise = transformPromise.then(({ transformed, etag, version, sourceType }) => {
		const cacheKey = buildCacheKey(path, params, version, etag);
		const durationMs = Math.round(performance.now() - startTime);

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
		headers.set('X-Request-ID', requestId);
		headers.set('Via', 'video-resizer');
		if (params.derivative) headers.set('X-Derivative', params.derivative);
		if (params.filename) headers.set('Content-Disposition', `inline; filename="${params.filename}"`);

		// Debug headers
		headers.set('X-Cache-Key', cacheKey);
		headers.set('X-Origin', originMatch.origin.name);
		headers.set('X-Source-Type', sourceType);
		headers.set('X-Transform-Source', sourceType === 'r2' ? 'binding' : 'cdn-cgi');
		headers.set('X-Processing-Time-Ms', String(durationMs));
		if (etag) headers.set('X-Source-Etag', etag);
		if (params.width) headers.set('X-Resolved-Width', String(params.width));
		if (params.height) headers.set('X-Resolved-Height', String(params.height));

		// Playback hint headers
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
					.then(() => log.info('cache.put resolved', { requestId, path }))
					.catch((err) =>
						log.error('cache.put FAILED', {
							requestId,
							path,
							error: err instanceof Error ? err.message : String(err),
						}),
					),
			);
		} else {
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
	});

	coalescer.set(coalesceKey, responsePromise);
	responsePromise.finally(() => coalescer.delete(coalesceKey));

	return await responsePromise;
}
