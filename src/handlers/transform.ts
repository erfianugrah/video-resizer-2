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
import type { JobMessage } from '../transform/job';
import { buildCacheKey } from '../cache/key';
import { getVersion } from '../cache/version';
import { RequestCoalescer } from '../cache/coalesce';
import { getPresignedUrl } from '../sources/presigned';
import { logAnalyticsEvent } from '../analytics/middleware';
import { registerJob } from '../queue/jobs-db';
import * as log from '../log';

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

/** CF Media Transformations error codes from Cf-Resized header.
 *  See: https://developers.cloudflare.com/stream/transform-videos/troubleshooting/ */
const CF_ERROR_CODES: Record<number, string> = {
	9401: 'Invalid or missing transform options',
	9402: 'Video too large or origin did not respond',
	9404: 'Video not found at origin',
	9406: 'Non-HTTPS URL or URL has spaces/unescaped Unicode',
	9407: 'DNS lookup error for origin hostname',
	9408: 'Origin returned HTTP 4xx (access denied)',
	9412: 'Origin returned non-video content (HTML/error page)',
	9419: 'Non-HTTPS URL or URL has spaces/unescaped Unicode',
	9504: 'Origin unreachable (timeout/refused)',
	9509: 'Origin returned HTTP 5xx',
	9517: 'Internal CF transform error',
	9523: 'Internal CF transform error',
};

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

/**
 * Enqueue a container transform job via Cloudflare Queue (durable, retryable),
 * or fall back to fire-and-forget via waitUntil if queue is not configured.
 */
async function enqueueOrFireAndForget(
	c: HonoContext,
	job: {
		jobId: string;
		path: string;
		params: TransformParams;
		sourceUrl: string;
		callbackCacheKey: string;
		requestUrl: string;
		origin: string;
		sourceType: string;
		etag?: string;
		version?: number;
	},
	rlog: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void },
): Promise<{ status: 'queued' | 'processing'; jobId: string }> {
	const sanitized: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(job.params)) {
		if (v !== undefined) sanitized[k] = v;
	}

	const jobMessage: JobMessage = {
		jobId: job.jobId,
		path: job.path,
		params: sanitized,
		sourceUrl: job.sourceUrl,
		callbackCacheKey: job.callbackCacheKey,
		requestUrl: job.requestUrl,
		origin: job.origin,
		sourceType: job.sourceType,
		etag: job.etag,
		version: job.version,
		createdAt: Date.now(),
	};

	// If queue is available, use durable queue path (survives deploys)
	if (c.env.TRANSFORM_QUEUE) {
		// Register in D1 for dashboard discovery (idempotent upsert)
		if (c.env.ANALYTICS) {
			registerJob(c.env.ANALYTICS, {
				jobId: job.jobId, path: job.path, origin: job.origin,
				params: sanitized, sourceUrl: job.sourceUrl,
				sourceType: job.sourceType, createdAt: jobMessage.createdAt,
			}, c.executionCtx.waitUntil.bind(c.executionCtx));
		}

		// Enqueue — the consumer handles dedup by checking R2 for existing results.
		// Duplicate sends are harmless (consumer is idempotent).
		try {
			await c.env.TRANSFORM_QUEUE.send(jobMessage);
			rlog.info('Job enqueued', { jobId: job.jobId, path: job.path });
			return { status: 'queued', jobId: job.jobId };
		} catch (sendErr) {
			rlog.error('Queue send failed, falling back to fire-and-forget', {
				jobId: job.jobId,
				error: sendErr instanceof Error ? sendErr.message : String(sendErr),
			});
			// Fall through to fire-and-forget path below
		}
	}

	// Fallback: fire-and-forget via waitUntil (no queue available)
	if (c.env.FFMPEG_CONTAINER) {
		const instanceKey = buildContainerInstanceKey(job.origin, job.path, job.params);
		const zoneHost = new URL(job.requestUrl).host;
		const callbackUrl = toCallbackUrl(
			zoneHost,
			`/internal/container-result?path=${encodeURIComponent(job.path)}&cacheKey=${encodeURIComponent(job.callbackCacheKey)}&requestUrl=${encodeURIComponent(job.requestUrl)}`,
		);
		c.executionCtx.waitUntil(
			transformViaContainerUrl(c.env.FFMPEG_CONTAINER, job.sourceUrl, job.params, instanceKey, callbackUrl)
				.then((r: Response) => rlog.info('Async container accepted', { status: r.status }))
				.catch((err: unknown) => rlog.error('Async container failed', { error: err instanceof Error ? err.message : String(err) })),
		);

		if (c.env.ANALYTICS) {
			registerJob(c.env.ANALYTICS, {
				jobId: job.jobId, path: job.path, origin: job.origin,
				params: sanitized, sourceUrl: job.sourceUrl,
				sourceType: job.sourceType, createdAt: Date.now(),
			}, c.executionCtx.waitUntil.bind(c.executionCtx));
		}
	}
	return { status: 'processing', jobId: job.jobId };
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

			// Log cache hit to analytics + mark job complete in D1
			if (c.env.ANALYTICS) {
				const bytes = parseInt(cached.headers.get('Content-Length') ?? '0', 10) || null;
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
					bytes,
				}, c.executionCtx.waitUntil.bind(c.executionCtx));

				// Mark any matching job as complete (idempotent — skips already-complete jobs)
				const baseKey = buildCacheKey(path, params);
				c.executionCtx.waitUntil(
					c.env.ANALYTICS.prepare(
						'UPDATE transform_jobs SET status = ?, completed_at = COALESCE(completed_at, ?), output_size = COALESCE(output_size, ?) WHERE job_id LIKE ? AND status NOT IN (?, ?)',
					).bind('complete', Date.now(), bytes, baseKey + '%', 'complete', 'failed').run().catch(() => {}),
				);
			}

			return resp;
		}
		rlog.info('Cache MISS', { path });
	}

	// 3b. Check R2 for previously transformed results.
	//     ALL transform results (binding, cdn-cgi, container) are stored in R2
	//     for persistent global availability. On hit: stream from R2, tee into
	//     cache.put (for future same-colo edge cache hits) + serve to client.
	//
	//     NOTE: This runs even with ?debug. Debug skips edge cache reads/writes
	//     but still serves from R2 — intentional, so container job results are
	//     visible immediately and D1 job status gets updated.
	const r2Version = await getVersion(c.env.CACHE_VERSIONS, path);
	const r2CacheKey = buildCacheKey(path, params, r2Version);
	const r2TransformKey = `_transformed/${r2CacheKey}`;
	const r2Result = await c.env.VIDEOS.get(r2TransformKey);
	if (r2Result) {
		rlog.info('R2 transform cache HIT', { r2Key: r2TransformKey, size: r2Result.size });
		// Update D1 job status to complete (if it was tracked as a queue job).
		// Match on job_id LIKE pattern since the cache key may include etag
		// that wasn't in the original job_id.
		if (c.env.ANALYTICS) {
			// The job_id in D1 is the callbackCacheKey from enqueue time.
			// The r2CacheKey here may differ if etag/version changed.
			// Use LIKE match on the base path+params portion.
			const baseKey = buildCacheKey(path, params);
			c.executionCtx.waitUntil(
				c.env.ANALYTICS.prepare('UPDATE transform_jobs SET status = ?, completed_at = COALESCE(completed_at, ?), output_size = ? WHERE job_id LIKE ? AND status != ?')
					.bind('complete', Date.now(), r2Result.size, baseKey + '%', 'complete')
					.run().catch(() => {}),
			);
		}
		const ct = r2Result.httpMetadata?.contentType ?? 'video/mp4';
		const transformSource = r2Result.customMetadata?.transformSource ?? 'unknown';
		const storedSourceType = r2Result.customMetadata?.sourceType ?? 'unknown';

		let maxAge = 86400;
		const ttl = originMatch.origin.ttl;
		if (ttl) maxAge = ttl.ok;

		const headers = new Headers();
		headers.set('Content-Type', ct);
		headers.set('Content-Length', String(r2Result.size));
		headers.set('Cache-Control', `public, max-age=${maxAge}`);
		headers.set('Accept-Ranges', 'bytes');
		headers.set('Via', 'video-resizer');
		headers.set('X-Request-ID', requestId);
		headers.set('X-Transform-Source', transformSource);
		headers.set('X-Source-Type', storedSourceType);
		headers.set('X-Origin', originMatch.origin.name);
		headers.set('X-Cache-Key', r2CacheKey);
		headers.set('X-R2-Cache', 'HIT');
		if (params.derivative) headers.set('X-Derivative', params.derivative);
		if (params.filename) headers.set('Content-Disposition', `inline; filename="${params.filename}"`);
		if (params.width) headers.set('X-Resolved-Width', String(params.width));
		if (params.height) headers.set('X-Resolved-Height', String(params.height));

		// Playback hint headers
		if (params.loop !== undefined) headers.set('X-Playback-Loop', String(params.loop));
		if (params.autoplay !== undefined) headers.set('X-Playback-Autoplay', String(params.autoplay));
		if (params.muted !== undefined) headers.set('X-Playback-Muted', String(params.muted));
		if (params.preload) headers.set('X-Playback-Preload', params.preload);

		// Cache-Tag for purge-by-tag
		const tags: string[] = [];
		if (params.derivative) tags.push(`derivative:${params.derivative}`);
		tags.push(`origin:${originMatch.origin.name}`);
		if (params.mode && params.mode !== 'video') tags.push(`mode:${params.mode}`);
		if (originMatch.origin.cacheTags) tags.push(...originMatch.origin.cacheTags);
		if (tags.length) headers.set('Cache-Tag', tags.join(','));

		// Store R2 result in edge cache, then serve via cache.match for
		// native range request handling (206 + Content-Range).
		// Use the non-debug URL so non-debug requests benefit from edge cache.
		const edgeCacheUrl = requestUrl.replace(/[&?]debug(&|$)/, '$1').replace(/[?&]$/, '');
		const edgeCacheReq = new Request(edgeCacheUrl, { method: 'GET' });
		await cache.put(edgeCacheReq, new Response(r2Result.body, { status: 200, headers: new Headers(headers) }));
		rlog.info('R2 result cached in colo', { path });

		// Serve via cache.match — handles Range headers natively
		const cachedFromR2 = await cache.match(new Request(edgeCacheUrl, c.req.raw));
		if (cachedFromR2) return cachedFromR2;

		// Fallback — cache.put may not be immediately visible to cache.match.
		// Re-read from R2 to serve the client (body was consumed by cache.put above).
		rlog.warn('cache.match miss after R2 promotion, re-reading from R2', { path });
		const r2Fallback = await c.env.VIDEOS.get(r2TransformKey);
		if (r2Fallback) {
			headers.set('Content-Length', String(r2Fallback.size));
			return new Response(r2Fallback.body, { status: 200, headers });
		}
		return new Response('Transform result unavailable', { status: 502 });
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

					const BINDING_SIZE_LIMIT = config.bindingSizeLimit;
					etag = object.etag;
					sourceType = 'r2';
					rlog.info('Source fetched (R2)', { path: resolved, size: object.size, etag });

					// Oversized: route to FFmpeg container (async for very large files)
					if (object.size > BINDING_SIZE_LIMIT && c.env.FFMPEG_CONTAINER) {
						const instanceKey = buildContainerInstanceKey(originMatch.origin.name, path, params);

						if (object.size > 256 * 1024 * 1024) {
							// Very large (>256MB): use queue-based async container.
							const pendingCacheKey = buildCacheKey(path, params, undefined, etag);
							// Prefer remote URL for large files — container fetches directly
						// via internet (enableInternet=true), avoiding Worker memory limits.
						// Fall back to /internal/r2-source only for R2-only sources.
							const remoteSource = sources.find((s) => s.type === 'remote' || s.type === 'fallback');
							const fetchableUrl = remoteSource && 'url' in remoteSource
								? remoteSource.url.replace(/\/+$/, '') + path
								: toCallbackUrl(zoneHost, `/internal/r2-source?key=${encodeURIComponent(resolved)}&bucket=${encodeURIComponent(source.bucketBinding)}`);
							rlog.info('R2 object too large for sync, enqueuing async container', {
								size: object.size, fetchableUrl,
							});
							object.body.cancel().catch(() => {});
							const jobId = pendingCacheKey;
							const result = await enqueueOrFireAndForget(c, {
								jobId,
								path,
								params,
								sourceUrl: fetchableUrl,
								callbackCacheKey: pendingCacheKey,
								requestUrl,
								origin: originMatch.origin.name,
								sourceType,
								etag,
								version,
							}, rlog);
							const wsUrl = c.env.TRANSFORM_JOB ? `wss://${zoneHost}/ws/job/${encodeURIComponent(jobId)}` : undefined;
							return {
								transformed: new Response(
									JSON.stringify({ status: result.status, jobId, message: 'Video is being transformed. Retry shortly.', path, ws: wsUrl }),
									{ status: 202, headers: { 'Content-Type': 'application/json', 'Retry-After': '10', 'X-Transform-Pending': 'true', 'X-Job-Id': jobId } },
								),
								etag, version, sourceType,
							};
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
					const CDN_CGI_SIZE_LIMIT = config.cdnCgiSizeLimit;
					const headResp = await fetch(sourceUrl, { method: 'HEAD' }).catch(() => null);
					const contentLength = parseInt(headResp?.headers.get('Content-Length') ?? '0', 10);

					if (contentLength > CDN_CGI_SIZE_LIMIT && (c.env.FFMPEG_CONTAINER || c.env.TRANSFORM_QUEUE)) {
						const pendingCacheKey = buildCacheKey(path, params, version);
						// Use remote URL for container fetch — container downloads directly
						// via internet (enableInternet=true), bypassing Worker memory limits.
						// R2 binding path (/internal/r2-source) streams through the Worker
						// outbound handler which hits memory limits on 725MB+ files.
						rlog.info('Remote source exceeds cdn-cgi limit, enqueuing async container', {
							size: contentLength, limit: CDN_CGI_SIZE_LIMIT, sourceUrl,
						});
						const containerSourceUrl = sourceUrl;
						const jobId = pendingCacheKey;
						const result = await enqueueOrFireAndForget(c, {
							jobId,
							path,
							params,
							sourceUrl: containerSourceUrl,
							callbackCacheKey: pendingCacheKey,
							requestUrl,
							origin: originMatch.origin.name,
							sourceType,
							version,
						}, rlog);
						const wsUrl = c.env.TRANSFORM_JOB ? `wss://${zoneHost}/ws/job/${encodeURIComponent(jobId)}` : undefined;
						return {
							transformed: new Response(
								JSON.stringify({ status: result.status, jobId, message: 'Video is being transformed. Retry shortly.', path, ws: wsUrl }),
								{ status: 202, headers: { 'Content-Type': 'application/json', 'Retry-After': '10', 'X-Transform-Pending': 'true', 'X-Job-Id': jobId } },
							),
							etag, version, sourceType,
						};
					}

					rlog.info('Source resolved (cdn-cgi)', { path: resolved, sourceUrl, sourceType, contentLength });
					const resp = await transformViaCdnCgi(zoneHost, sourceUrl, params, version);

					// Check Cf-Resized header for CF error codes (e.g. err=9402).
					// cdn-cgi may return 200 with an error in this header. The response
					// body also contains a human-readable error message from CF.
					// See: https://developers.cloudflare.com/stream/transform-videos/troubleshooting/
					const cfResized = resp.headers.get('Cf-Resized') ?? '';
					const cfErrMatch = cfResized.match(/err=(\d+)/);
					if (cfErrMatch) {
						const cfErr = parseInt(cfErrMatch[1], 10);
						// Read the CF error message from the response body
						const cfErrBody = await resp.text().catch(() => '');
						const cfErrDesc = CF_ERROR_CODES[cfErr] ?? 'Unknown CF transform error';
						rlog.warn('cdn-cgi transform error', {
							cfErr, cfErrDesc,
							cfErrBody: cfErrBody.slice(0, 500),
							sourceUrl, resolved,
						});

						// 9402 = origin too large — route to container if available
						if (cfErr === 9402 && (c.env.FFMPEG_CONTAINER || c.env.TRANSFORM_QUEUE)) {
							const pendingCacheKey = buildCacheKey(path, params, version);
							const containerSrc9402 = sourceUrl;
							const jobId = pendingCacheKey;
							const result = await enqueueOrFireAndForget(c, {
								jobId,
								path,
								params,
								sourceUrl: containerSrc9402,
								callbackCacheKey: pendingCacheKey,
								requestUrl,
								origin: originMatch.origin.name,
								sourceType,
								version,
							}, rlog);
							const wsUrl = c.env.TRANSFORM_JOB ? `wss://${zoneHost}/ws/job/${encodeURIComponent(jobId)}` : undefined;
							return { transformed: new Response(
								JSON.stringify({ status: result.status, jobId, message: `Source too large for edge transform (${cfErrDesc}). Processing via container.`, path, ws: wsUrl }),
								{ status: 202, headers: { 'Content-Type': 'application/json', 'Retry-After': '10', 'X-Transform-Pending': 'true', 'X-Job-Id': jobId } },
							), etag, version, sourceType };
						}
						// All other CF errors — push descriptive message and try next source
						errors.push(`${source.type}(p${source.priority}): cdn-cgi err=${cfErr} (${cfErrDesc}) for ${resolved}`);
						continue;
					}

					// HTTP status checks
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
	const responsePromise = transformPromise.then(async ({ transformed, etag, version, sourceType }) => {
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

		// Determine cacheability early — used for both X-R2-Cache header and storage
		const isPendingPassthrough = headers.get('X-Transform-Pending') === 'true';
		const shouldCache = !skipCache && !isPendingPassthrough && transformed.status >= 200 && transformed.status < 400;

		// Debug headers
		headers.set('X-Cache-Key', cacheKey);
		// X-R2-Cache: HIT = result is stored in R2 (serves from R2 on edge eviction)
		headers.set('X-R2-Cache', shouldCache ? 'HIT' : 'MISS');
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

		// Content-type correction for non-video modes (skip for 202 pending responses)
		if (!isPendingPassthrough) {
			if (params.mode === 'audio') {
				headers.set('Content-Type', 'audio/mp4');
			} else if (params.mode === 'frame') {
				const fmt = params.format === 'png' ? 'image/png' : 'image/jpeg';
				headers.set('Content-Type', fmt);
			} else if (params.mode === 'spritesheet') {
				headers.set('Content-Type', 'image/jpeg');
			}
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

		// 7. Store: transform → R2 → cache.put → serve via cache.match
		//    This ensures range requests work on first request (cache.match
		//    handles Range headers natively). R2 is the durable global store,
		//    edge cache is the fast per-colo layer on top.
		// Log to analytics (non-blocking)
		if (c.env.ANALYTICS) {
			logAnalyticsEvent(c.env.ANALYTICS, {
				path,
				origin: originMatch!.origin.name,
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

		if (shouldCache && transformed.body) {
			// Flow: transform → R2 put → R2 get → cache.put → cache.match → serve
			// Sequential streaming, zero memory buffering. R2 is the single source
			// of truth, edge cache is a read-through layer for range request support.
			const r2StoreKey = `_transformed/${cacheKey}`;
			const ct = headers.get('Content-Type') ?? 'video/mp4';
			const contentLength = transformed.headers.get('Content-Length');

			// 1. Stream transform output directly to R2
			if (contentLength) {
				const fixedStream = new FixedLengthStream(parseInt(contentLength, 10));
				transformed.body.pipeTo(fixedStream.writable);
				await c.env.VIDEOS.put(r2StoreKey, fixedStream.readable, {
					httpMetadata: { contentType: ct },
					customMetadata: {
						transformSource: sourceType === 'r2' ? 'binding' : 'cdn-cgi',
						sourceType,
						cacheKey,
					},
				});
			} else {
				// No Content-Length — can't stream to R2, skip persistent store
				rlog.warn('No Content-Length, skipping R2 store', { path });
				await cache.put(cacheReq, new Response(transformed.body, { status: 200, headers: new Headers(headers) }));
				const cached = await cache.match(cacheReq);
				if (cached) return cached;
				return new Response(null, { status: 200, headers });
			}
			rlog.info('R2 transform stored', { path, r2Key: r2StoreKey, size: contentLength });

			// 2. Read back from R2 → stream to edge cache
			const r2Obj = await c.env.VIDEOS.get(r2StoreKey);
			if (r2Obj) {
				headers.set('Content-Length', String(r2Obj.size));
				await cache.put(cacheReq, new Response(r2Obj.body, { status: 200, headers: new Headers(headers) }));
				rlog.info('cache.put from R2', { path });
			}

			// 3. Serve via cache.match — handles Range headers natively
			const cached = await cache.match(cacheReq);
			if (cached) return cached;

			rlog.warn('cache.match miss after put', { path });
			return new Response(null, { status: 200, headers });
		} else {
			// Not cacheable (debug or passthrough) — serve directly
			return new Response(transformed.body, { status: transformed.status, headers });
		}
	});

	coalescer.set(coalesceKey, responsePromise);
	responsePromise.finally(() => coalescer.delete(coalesceKey));

	return await responsePromise;
}
