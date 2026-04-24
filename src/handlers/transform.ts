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
import { matchOrigin, sortedSources, resolveSourcePath, type OriginMatch } from '../sources/router';
import type { AppConfig } from '../config/schema';
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

/**
 * Output of the source-resolution + transform pipeline.
 * Produced by resolveAndTransform() and consumed by the response-assembly
 * phase which layers on headers, analytics, and cache storage.
 */
interface TransformResult {
	/** The raw transform Response (binding / cdn-cgi / container / 202 pending). */
	transformed: Response;
	/** Source etag, if known from HEAD/R2 metadata. */
	etag?: string;
	/** Source Last-Modified, if known from HEAD. */
	sourceLastModified?: string;
	/** Resolved source path (R2 key or remote URL). */
	sourcePath?: string;
	/** Matched source tier ('r2' | 'remote' | 'fallback' | 'unknown'). */
	sourceType: string;
	/** Which transform engine produced the response ('binding' | 'cdn-cgi' | 'container' | 'passthrough' | 'unknown'). */
	transformSource: string;
	/** Cache version used, if any. */
	version?: number;
}

/** Logger used by transform-side helpers. Matches the rlog shape built in main handler. */
type RLog = {
	info: (msg: string, data?: Record<string, unknown>) => void;
	warn: (msg: string, data?: Record<string, unknown>) => void;
	error: (msg: string, data?: Record<string, unknown>) => void;
};

/**
 * Build the final response Headers bundle for a successful transform.
 *
 * Copies upstream headers, applies Cache-Control from origin config, sets
 * debug/observability headers (X-Request-ID, X-Origin, X-Cache-Key, etc.),
 * applies playback hints, corrects Content-Type for non-video modes, and
 * assembles Cache-Tag for purge-by-tag. Strips Set-Cookie + Vary=* which
 * prevent caching.
 */
function buildFinalHeaders(args: {
	transformed: Response;
	transformSource: string;
	sourceType: string;
	etag?: string;
	params: TransformParams;
	originMatch: OriginMatch;
	cacheKey: string;
	durationMs: number;
	requestId: string;
	warnings: { param: string; reason: string }[];
	skipCache: boolean;
}): { headers: Headers; shouldCache: boolean; isPendingPassthrough: boolean } {
	const { transformed, transformSource, sourceType, etag, params, originMatch, cacheKey, durationMs, requestId, warnings, skipCache } = args;

	const cacheControlHeader = buildCacheControl(
		transformed.status,
		originMatch.origin.cacheControl,
		originMatch.origin.ttl,
	);

	const headers = new Headers(transformed.headers);
	headers.set('Cache-Control', cacheControlHeader);
	headers.set('Accept-Ranges', 'bytes');
	headers.set('X-Request-ID', requestId);
	headers.set('Via', 'video-resizer');
	if (params.derivative) headers.set('X-Derivative', params.derivative);
	if (params.filename) headers.set('Content-Disposition', `inline; filename="${params.filename}"`);

	// Determine cacheability — used for both X-R2-Stored header and R2 persistence
	const isPendingPassthrough = headers.get('X-Transform-Pending') === 'true';
	const shouldCache = !skipCache && !isPendingPassthrough && transformed.status >= 200 && transformed.status < 400;

	// Debug headers
	headers.set('X-Cache-Key', cacheKey);
	headers.set('X-R2-Stored', shouldCache ? 'true' : 'false');
	headers.set('X-Origin', originMatch.origin.name);
	headers.set('X-Source-Type', sourceType);
	headers.set('X-Transform-Source', transformSource);
	headers.set('X-Processing-Time-Ms', String(durationMs));
	if (etag) headers.set('X-Source-Etag', etag);
	if (params.width) headers.set('X-Resolved-Width', String(params.width));
	if (params.height) headers.set('X-Resolved-Height', String(params.height));
	if (warnings.length > 0) headers.set('X-Param-Warnings', warnings.map((w) => `${w.param}: ${w.reason}`).join('; '));

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

	return { headers, shouldCache, isPendingPassthrough };
}

/**
 * Build the Cache-Control header for a response based on status and origin config.
 * Prefers origin.cacheControl.{range} over derived `public, max-age={ttl.range}`.
 */
function buildCacheControl(
	status: number,
	cacheControl: { ok?: string; redirects?: string; clientError?: string; serverError?: string } | undefined,
	ttl: { ok?: number; redirects?: number; clientError?: number; serverError?: number } | undefined,
): string {
	if (status >= 200 && status < 300) return cacheControl?.ok ?? `public, max-age=${ttl?.ok ?? 86400}`;
	if (status >= 300 && status < 400) return cacheControl?.redirects ?? `public, max-age=${ttl?.redirects ?? 300}`;
	if (status >= 400 && status < 500) return cacheControl?.clientError ?? `public, max-age=${ttl?.clientError ?? 60}`;
	return cacheControl?.serverError ?? `public, max-age=${ttl?.serverError ?? 10}`;
}

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

/** Input bundle for resolveAndTransform — groups the pipeline context. */
interface ResolveContext {
	c: HonoContext;
	path: string;
	params: TransformParams;
	cacheKey: string;
	requestUrl: string;
	rlog: RLog;
	config: AppConfig;
	originMatch: OriginMatch;
	forceBust: boolean;
	forceVersion: number;
}

/**
 * Source resolution + transform pipeline.
 *
 * Walks the origin's sources in priority order: container-only params first,
 * then normal binding/cdn-cgi routing, then raw passthrough as last resort.
 * Returns a TransformResult for the response-assembly phase to wrap in
 * final headers, analytics, and R2/cache storage.
 *
 * Throws AppError(502, 'ALL_SOURCES_FAILED') if every source and the
 * passthrough fallback fail to produce a Response.
 */
async function resolveAndTransform(ctx: ResolveContext): Promise<TransformResult> {
	const { c, path, params, cacheKey, requestUrl, rlog, config, originMatch, forceBust, forceVersion } = ctx;
	const envRecord = c.env as unknown as Record<string, unknown>;
	const zoneHost = new URL(c.req.url).host;
	const sources = sortedSources(originMatch.origin);
	const errors: string[] = [];
	let transformed: Response | null = null;
	let etag: string | undefined;
	let sourceLastModified: string | undefined;
	let sourcePath: string | undefined;
	let version: number | undefined;
	let sourceType: string = 'unknown';
	let transformSource: string = 'unknown';

	// Container-only params: route to container if enabled
	const containerNeeded = needsContainer(params);
	if (containerNeeded && config.container?.enabled && c.env.FFMPEG_CONTAINER) {
		rlog.info('Routing to FFmpeg container', { path });
		for (const source of sources) {
			try {
				const resolved = resolveSourcePath(source, path, originMatch.captures);

				if (source.type === 'r2') {
					const bucket = envRecord[source.bucketBinding] as R2Bucket | undefined;
					if (!bucket) continue;
					const object = await bucket.get(resolved);
					if (!object) continue;
					etag = object.etag;
					sourcePath = resolved;
					sourceType = 'r2';

					// Size-based routing: very large files use async queue path
					// to avoid streaming hundreds of MB through the DO.
					if (object.size > config.asyncContainerThreshold) {
						const remoteSource = sources.find((s) => s.type === 'remote' || s.type === 'fallback');
						const fetchableUrl = remoteSource && 'url' in remoteSource
							? (remoteSource as { url: string }).url.replace(/\/+$/, '') + path
							: toCallbackUrl(zoneHost, `/internal/r2-source?key=${encodeURIComponent(resolved)}&bucket=${encodeURIComponent(source.bucketBinding)}`);
						rlog.info('Container-only + oversized R2, enqueuing async container', {
							size: object.size, fetchableUrl,
						});
						object.body.cancel().catch(() => {});
						const resp = await routeToAsyncContainer(c, zoneHost, path, cacheKey, {
							sourceUrl: fetchableUrl,
							origin: originMatch.origin.name,
							sourceType, etag, sourcePath: resolved, version,
						}, params, requestUrl, rlog);
						return { transformed: resp, etag, sourceType, transformSource: 'container', version };
					}

					// Fits in sync container (<= 256MB)
					const instanceKey = buildContainerInstanceKey(originMatch.origin.name, path, params);
					transformed = await transformViaContainer(c.env.FFMPEG_CONTAINER, object.body, params, instanceKey);
					transformSource = 'container';
					break;
				} else if (source.url) {
					// Remote source: check size via HEAD, route to async if large
					const remoteUrl = source.url.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
					const headResp = await fetch(remoteUrl, { method: 'HEAD' }).catch(() => null);
					const contentLength = parseInt(headResp?.headers.get('Content-Length') ?? '0', 10);
					sourceType = source.type;
					sourcePath = remoteUrl;
					if (headResp) {
						etag = headResp.headers.get('ETag') ?? undefined;
						sourceLastModified = headResp.headers.get('Last-Modified') ?? undefined;
					}

					if (contentLength > config.asyncContainerThreshold) {
						rlog.info('Container-only + oversized remote, enqueuing async container', {
							size: contentLength, fetchableUrl: remoteUrl,
						});
						const resp = await routeToAsyncContainer(c, zoneHost, path, cacheKey, {
							sourceUrl: remoteUrl,
							origin: originMatch.origin.name,
							sourceType, etag, sourceLastModified, sourcePath: remoteUrl, version,
						}, params, requestUrl, rlog);
						return { transformed: resp, etag, sourceType, transformSource: 'container', version };
					}

					const resp = await fetch(remoteUrl);
					if (resp.ok && resp.body) {
						const instanceKey = buildContainerInstanceKey(originMatch.origin.name, path, params);
						transformed = await transformViaContainer(c.env.FFMPEG_CONTAINER, resp.body, params, instanceKey);
						transformSource = 'container';
						break;
					}
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
				sourcePath = resolved;
				sourceType = 'r2';
				rlog.info('Source fetched (R2)', { path: resolved, size: object.size, etag });

				// Oversized: route to FFmpeg container (async for very large files)
				if (object.size > BINDING_SIZE_LIMIT && c.env.FFMPEG_CONTAINER) {
					const instanceKey = buildContainerInstanceKey(originMatch.origin.name, path, params);

					if (object.size > config.asyncContainerThreshold) {
						// Above asyncContainerThreshold (default 256MB): use queue-based async container.
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
						const resp = await routeToAsyncContainer(c, zoneHost, path, cacheKey, {
							sourceUrl: fetchableUrl,
							origin: originMatch.origin.name,
							sourceType, etag, sourcePath: resolved, version,
						}, params, requestUrl, rlog);
						return { transformed: resp, etag, sourceType, transformSource: 'container', version };
					}

					// Large but fits in sync (100-256MB): wait for container
					rlog.info('R2 object exceeds binding limit, routing to container', {
						size: object.size, limit: BINDING_SIZE_LIMIT,
					});
					transformed = await transformViaContainer(c.env.FFMPEG_CONTAINER, object.body, params, instanceKey);
					transformSource = 'container';
					break;
				}

				try {
					transformed = await transformViaBinding(c.env.MEDIA, object.body, params);
					transformSource = 'binding';
				} catch (bindingErr) {
					// Reactive container fallback: if binding rejects oversized input
					if (bindingErr instanceof AppError && bindingErr.code.startsWith('MEDIA_ERROR') && c.env.FFMPEG_CONTAINER) {
						rlog.warn('Binding failed, falling back to container', { error: bindingErr.message });
						const retryObject = await bucket.get(resolved);
						if (retryObject) {
							// Check size: above asyncContainerThreshold must use async path to avoid DO timeout
							if (retryObject.size > config.asyncContainerThreshold) {
								retryObject.body.cancel().catch(() => {});
								const remoteSource = sources.find((s) => s.type === 'remote' || s.type === 'fallback');
								const fetchableUrl = remoteSource && 'url' in remoteSource
									? (remoteSource as { url: string }).url.replace(/\/+$/, '') + path
									: toCallbackUrl(zoneHost, `/internal/r2-source?key=${encodeURIComponent(resolved)}&bucket=${encodeURIComponent(source.bucketBinding)}`);
								const resp = await routeToAsyncContainer(c, zoneHost, path, cacheKey, {
									sourceUrl: fetchableUrl,
									origin: originMatch.origin.name,
									sourceType, etag, sourcePath: resolved, version,
								}, params, requestUrl, rlog);
								return { transformed: resp, etag, sourceType, transformSource: 'container', version };
							}
							const instanceKey = buildContainerInstanceKey(originMatch.origin.name, path, params);
							transformed = await transformViaContainer(c.env.FFMPEG_CONTAINER, retryObject.body, params, instanceKey);
							transformSource = 'container';
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
								transformSource = 'binding';
							}
						}
					}
					if (!transformed) throw bindingErr;
				}
				break;
			} else {
				// Remote/fallback — check size via HEAD to decide routing
				version = forceBust ? forceVersion : undefined;
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

				// Capture source freshness metadata for revalidation
				sourcePath = sourceUrl;
				if (headResp) {
					etag = headResp.headers.get('ETag') ?? undefined;
					sourceLastModified = headResp.headers.get('Last-Modified') ?? undefined;
				}

				if (contentLength > CDN_CGI_SIZE_LIMIT && (c.env.FFMPEG_CONTAINER || c.env.TRANSFORM_QUEUE)) {
					// Use remote URL for container fetch — container downloads directly
					// via internet (enableInternet=true), bypassing Worker memory limits.
					// R2 binding path (/internal/r2-source) streams through the Worker
					// outbound handler which hits memory limits on 725MB+ files.
					rlog.info('Remote source exceeds cdn-cgi limit, enqueuing async container', {
						size: contentLength, limit: CDN_CGI_SIZE_LIMIT, sourceUrl,
					});
					const resp = await routeToAsyncContainer(c, zoneHost, path, cacheKey, {
						sourceUrl,
						origin: originMatch.origin.name,
						sourceType, etag, sourceLastModified, sourcePath: sourceUrl, version,
					}, params, requestUrl, rlog);
					return { transformed: resp, etag, sourceType, transformSource: 'container', version };
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
						const pending = await routeToAsyncContainer(c, zoneHost, path, cacheKey, {
							sourceUrl,
							origin: originMatch.origin.name,
							sourceType, etag, sourceLastModified, sourcePath: sourceUrl, version,
						}, params, requestUrl, rlog,
							`Source too large for edge transform (${cfErrDesc}). Processing via container.`,
						);
						return { transformed: pending, etag, sourceType, transformSource: 'container', version };
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
				transformSource = 'cdn-cgi';
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
						transformSource = 'passthrough';
						transformed = new Response(object.body, {
							headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'video/mp4' },
						});
						break;
					}
				} else if (source.url) {
					const resp = await fetch(source.url.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
					if (resp.ok) {
						sourceType = source.type;
						transformSource = 'passthrough';
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

	return { transformed, etag, sourceLastModified, sourcePath, sourceType, transformSource, version };
}

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
 * Route a transform request to the async container path.
 *
 * Combines the two-step pattern used at every async dispatch site:
 *   1. Enqueue (via queue or fire-and-forget fallback)
 *   2. Build the 202 pending Response
 *
 * Returns the Response only; callers retain their own `etag` / `sourceType`
 * captured from the source-resolution phase.
 */
async function routeToAsyncContainer(
	c: HonoContext,
	zoneHost: string,
	path: string,
	cacheKey: string,
	job: {
		sourceUrl: string;
		origin: string;
		sourceType: string;
		etag?: string;
		sourceLastModified?: string;
		sourcePath?: string;
		version?: number;
	},
	params: TransformParams,
	requestUrl: string,
	rlog: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void },
	message?: string,
): Promise<Response> {
	const result = await enqueueOrFireAndForget(c, {
		jobId: cacheKey,
		path,
		params,
		sourceUrl: job.sourceUrl,
		callbackCacheKey: cacheKey,
		requestUrl,
		origin: job.origin,
		sourceType: job.sourceType,
		etag: job.etag,
		sourceLastModified: job.sourceLastModified,
		sourcePath: job.sourcePath,
		version: job.version,
	}, rlog);
	return buildPendingResponse(cacheKey, path, zoneHost, result.status, message);
}

/**
 * Build a 202 Accepted response for async container transforms.
 *
 * Every async-routed request (oversized R2/remote/binding-fallback/cdn-cgi
 * 9402 fallback) returns the same response shape: JSON body with jobId
 * and SSE URL + standard headers that let the client poll /sse/job/:id
 * for progress.
 *
 * @param jobId     D1/cache key identifying the job (also the SSE subject)
 * @param path      Original request path, echoed in the body for logging
 * @param zoneHost  Current request host (used to build the SSE URL)
 * @param status    'queued' | 'processing' — echoed in body for diagnostics
 * @param message   Optional human-readable detail (e.g. 9402 fallback reason)
 */
function buildPendingResponse(
	jobId: string,
	path: string,
	zoneHost: string,
	status: 'queued' | 'processing',
	message: string = 'Video is being transformed. Retry shortly.',
): Response {
	const sseUrl = `https://${zoneHost}/sse/job/${encodeURIComponent(jobId)}`;
	return new Response(
		JSON.stringify({ status, jobId, message, path, sse: sseUrl }),
		{
			status: 202,
			headers: {
				'Content-Type': 'application/json',
				'Retry-After': '10',
				'X-Transform-Pending': 'true',
				'X-Job-Id': jobId,
			},
		},
	);
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
		sourceLastModified?: string;
		sourcePath?: string;
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
		sourceLastModified: job.sourceLastModified,
		sourcePath: job.sourcePath,
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
		let cbQuery = `/internal/container-result?path=${encodeURIComponent(job.path)}&cacheKey=${encodeURIComponent(job.callbackCacheKey)}&requestUrl=${encodeURIComponent(job.requestUrl)}&jobId=${encodeURIComponent(job.jobId)}`;
		if (job.etag) cbQuery += `&srcEtag=${encodeURIComponent(job.etag)}`;
		if (job.sourceLastModified) cbQuery += `&srcLM=${encodeURIComponent(job.sourceLastModified)}`;
		if (job.sourcePath) cbQuery += `&srcPath=${encodeURIComponent(job.sourcePath)}`;
		if (job.sourceType) cbQuery += `&srcType=${encodeURIComponent(job.sourceType)}`;
		if (job.version && job.version > 1) cbQuery += `&cacheVer=${job.version}`;
		const callbackUrl = toCallbackUrl(zoneHost, cbQuery);
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
	const path = url.pathname.replace(/\/+$/, '') || '/';
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
	const { params: translated, clientHints, rawImWidth, rawImHeight } = translateAkamaiParams(url.searchParams);
	const { params: parsed, warnings } = parseParams(translated);
	let params = parsed;

	if (warnings.length > 0) {
		rlog.warn('Param validation warnings', { warnings });
	}

	// IMQuery breakpoint matching: imwidth/imheight are used to SELECT a derivative
	// via breakpoint ranges, not as raw width/height values. This happens before
	// derivative/responsive resolution so the matched derivative takes priority.
	if ((rawImWidth || rawImHeight) && !params.derivative && config.responsive) {
		const effectiveWidth = rawImWidth ?? rawImHeight ?? 0;
		const sorted = [...config.responsive.breakpoints].sort((a, b) => a.maxWidth - b.maxWidth);
		for (const bp of sorted) {
			if (effectiveWidth <= bp.maxWidth && bp.derivative in config.derivatives) {
				params = { ...params, derivative: bp.derivative };
				break;
			}
		}
		// No breakpoint matched — use default
		if (!params.derivative) {
			params = { ...params, derivative: config.responsive.defaultDerivative };
		}
	}

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
		rawImWidth,
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
			rawImWidth,
			rawImHeight,
			warnings,
		};
		return c.json({ diagnostics, _meta: { ts: Date.now() } });
	}

	// 3. Compute cache key ONCE — single source of truth for all lookups.
	//    Version is NO LONGER part of the cache key. Freshness is validated
	//    via source etag/last-modified metadata on R2 HIT. KV version is
	//    only checked as an optional manual force-bust override.
	const cacheKey = buildCacheKey(path, params);
	const r2TransformKey = `_transformed/${cacheKey}`;

	// Optional: check if admin has a force-bust version in KV.
	// Only fetched once, only used if version > 1 (default is 1 = no bust).
	const forceVersion = await getVersion(c.env.CACHE_VERSIONS, path);
	const forceBust = forceVersion > 1;

	const cacheReq = new Request(requestUrl, c.req.raw);
	const cache = caches.default;

	if (!skipCache) {
		const cached = await cache.match(cacheReq);
		if (cached) {
			// Validate the cached response matches the current cache key.
			// After a version bump, edge cache may still hold stale results
			// from the old version. Compare X-Cache-Key to detect this.
			const cachedKey = cached.headers.get('X-Cache-Key');
			if (cachedKey && cachedKey !== cacheKey) {
				rlog.info('Edge cache stale (version mismatch)', { path, cachedKey, currentKey: cacheKey });
				// Fall through to R2 / transform — stale edge entry will be
				// overwritten by cache.put when the fresh result is stored.
			} else {
				rlog.info('Edge cache HIT', { path });
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

					// Mark matching job as complete (idempotent)
					c.executionCtx.waitUntil(
						c.env.ANALYTICS.prepare(
							'UPDATE transform_jobs SET status = ?, completed_at = COALESCE(completed_at, ?), output_size = COALESCE(output_size, ?) WHERE job_id = ? AND status NOT IN (?, ?)',
						).bind('complete', Date.now(), bytes, cacheKey, 'complete', 'failed').run().catch(() => {}),
					);
				}

				return resp;
			}
		} else {
			rlog.info('Edge cache MISS', { path });
		}
	}

	// 3b. Check R2 persistent storage for previously transformed results.
	//     ALL transform results (binding, cdn-cgi, container) are stored in R2
	//     for durable global availability. On hit: validate source freshness,
	//     then stream from R2, promote into edge cache + serve to client.
	//
	//     NOTE: This runs even with ?debug. Debug skips edge cache reads/writes
	//     but still serves from R2 — intentional, so container job results are
	//     visible immediately and D1 job status gets updated.
	const r2Result = await c.env.VIDEOS.get(r2TransformKey);
	if (r2Result) {
		rlog.info('R2 storage HIT', { r2Key: r2TransformKey, size: r2Result.size });

		// ── Source freshness validation ──────────────────────────────
		// Compare stored source metadata against current source to detect
		// stale transforms. If stale, cancel the R2 body and fall through
		// to the transform path (result overwrites same R2 key — no orphans).
		const storedEtag = r2Result.customMetadata?.sourceEtag;
		const storedSourceType = r2Result.customMetadata?.sourceType;
		const storedSourcePath = r2Result.customMetadata?.sourcePath;
		let isStale = false;

		// Force bust via KV version override (admin-triggered)
		if (forceBust) {
			const storedVersion = r2Result.customMetadata?.cacheVersion;
			if (storedVersion !== String(forceVersion)) {
				isStale = true;
				rlog.info('Force bust: KV version mismatch', { storedVersion, forceVersion });
			}
		}

		// Etag/Last-Modified revalidation against current source
		if (!isStale && storedEtag && storedSourcePath) {
			if (storedSourceType === 'r2') {
				// R2 source → head() the source object, compare etag
				const sourceHead = await c.env.VIDEOS.head(storedSourcePath);
				if (sourceHead && sourceHead.etag !== storedEtag) {
					isStale = true;
					rlog.info('R2 source changed', { storedEtag, currentEtag: sourceHead.etag });
				}
				// sourceHead === null means source deleted — serve stale (better than error)
			} else if (storedSourceType === 'remote' || storedSourceType === 'fallback') {
				// Remote source → HEAD the origin URL with 3s timeout
				// If origin is slow/unreachable, serve stale (better than error)
				try {
					const headResp = await Promise.race([
						fetch(storedSourcePath, { method: 'HEAD' }),
						new Promise<null>((r) => setTimeout(() => r(null), 3000)),
					]);
					if (headResp) {
						const currentEtag = headResp.headers.get('ETag');
						const currentLastMod = headResp.headers.get('Last-Modified');
						const storedLastMod = r2Result.customMetadata?.sourceLastModified;
						if (currentEtag && storedEtag && currentEtag !== storedEtag) {
							isStale = true;
							rlog.info('Remote source ETag changed', { storedEtag, currentEtag });
						} else if (!currentEtag && currentLastMod && storedLastMod && currentLastMod !== storedLastMod) {
							isStale = true;
							rlog.info('Remote source Last-Modified changed', { storedLastMod, currentLastMod });
						}
					}
					// null = timeout, serve stale
				} catch {
					// Network error — serve stale (better than error)
				}
			}
		}

		if (isStale) {
			rlog.info('R2 result stale, re-transforming', { r2Key: r2TransformKey });
			// Cancel the R2 body we won't use, then fall through to transform path
			r2Result.body.cancel().catch(() => {});
		} else {
			// ── Serve cached result ─────────────────────────────────────
			// Update D1 job status to complete (if it was tracked as a queue job).
			if (c.env.ANALYTICS) {
				c.executionCtx.waitUntil(
					c.env.ANALYTICS.prepare('UPDATE transform_jobs SET status = ?, completed_at = COALESCE(completed_at, ?), output_size = ? WHERE job_id = ? AND status NOT IN (?, ?)')
						.bind('complete', Date.now(), r2Result.size, cacheKey, 'complete', 'failed')
						.run().catch(() => {}),
				);
			}
			const ct = r2Result.httpMetadata?.contentType ?? 'video/mp4';
			const transformSource = r2Result.customMetadata?.transformSource ?? 'unknown';
			const displaySourceType = storedSourceType ?? 'unknown';

			// R2 HIT is always a 2xx — Cache-Control from origin config
			const r2CacheControl = buildCacheControl(200, originMatch.origin.cacheControl, originMatch.origin.ttl);

			const headers = new Headers();
			headers.set('Content-Type', ct);
			headers.set('Content-Length', String(r2Result.size));
			headers.set('Cache-Control', r2CacheControl);
			headers.set('Accept-Ranges', 'bytes');
			headers.set('Via', 'video-resizer');
			headers.set('X-Request-ID', requestId);
			headers.set('X-Transform-Source', transformSource);
			headers.set('X-Source-Type', displaySourceType);
			headers.set('X-Origin', originMatch.origin.name);
			headers.set('X-Cache-Key', cacheKey);
			headers.set('X-R2-Stored', 'true');
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

			if (skipCache) {
				// Debug: serve R2 result directly, no edge cache interaction
				return new Response(r2Result.body, { status: 200, headers });
			}

			// Promote R2 result to edge cache, then serve via cache.match for
			// native range request handling (206 + Content-Range).
			const edgeCacheUrl = requestUrl;
			const edgeCacheReq = new Request(edgeCacheUrl, { method: 'GET' });
			await cache.put(edgeCacheReq, new Response(r2Result.body, { status: 200, headers: new Headers(headers) }));
			rlog.info('R2 result promoted to edge cache', { path });

			// Serve via cache.match — handles Range headers natively
			const cachedFromR2 = await cache.match(new Request(edgeCacheUrl, c.req.raw));
			if (cachedFromR2) return cachedFromR2;

			// Fallback — cache.put may not be immediately visible to cache.match.
			// Re-read from R2 (body was consumed by cache.put above).
			rlog.warn('cache.match miss after R2 promotion, re-reading from R2', { path });
			const r2Fallback = await c.env.VIDEOS.get(r2TransformKey);
			if (r2Fallback) {
				headers.set('Content-Length', String(r2Fallback.size));
				return new Response(r2Fallback.body, { status: 200, headers });
			}
			return new Response('Transform result unavailable', { status: 502 });
		}
	}

	// 4. Request coalescing — join in-flight transform if one exists
	//    Only coalesce cacheable requests. Non-cacheable (debug/pending) responses
	//    have live-stream bodies that can't be shared between requests.
	if (!skipCache) {
		const inflight = coalescer.get(cacheKey);
		if (inflight) {
			rlog.info('Coalesced — waiting for in-flight transform', { path, cacheKey });
			// Safety timeout: don't block forever if the in-flight transform hangs.
			// After 60s, give up waiting and proceed with own transform.
			const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 60_000));
			const result = await Promise.race([inflight.then(() => 'done' as const), timeout]);
			if (result === 'timeout') {
				rlog.warn('Coalesce wait timed out after 60s, proceeding with own transform', { path, cacheKey });
				coalescer.delete(cacheKey);
			} else {
				// Transform is done and stored — read from cache independently
				const cached = await cache.match(cacheReq);
				if (cached) {
					rlog.info('Coalesced cache HIT', { path });
					cached.headers.set('X-Request-ID', requestId);
					return cached;
				}
				// Rare: cache.match miss right after put. Fall through to R2 check
				const r2Retry = await c.env.VIDEOS.get(r2TransformKey);
				if (r2Retry) {
					rlog.info('Coalesced R2 fallback HIT', { path });
					return new Response(r2Retry.body, {
						headers: {
							'Content-Type': r2Retry.httpMetadata?.contentType ?? 'video/mp4',
							'Content-Length': String(r2Retry.size),
							'X-Request-ID': requestId,
						},
					});
				}
				rlog.warn('Coalesced miss after signal, proceeding with own transform', { path });
			}
		}
	}

	// 5. Resolve source + transform (wrapped in a coalescing promise)
	const transformPromise = resolveAndTransform({
		c, path, params, cacheKey, requestUrl, rlog, config, originMatch, forceBust, forceVersion,
	});

	// Register for coalescing, clean up when done
	const responsePromise = transformPromise.then(async ({ transformed, etag, sourceLastModified: srcLastMod, sourcePath: srcPath, sourceType, transformSource: rawTransformSource, version: srcVersion }) => {
		const transformSource = rawTransformSource ?? 'unknown';
		const durationMs = Math.round(performance.now() - startTime);

		// 6. Build final headers (Cache-Control, debug, playback hints, cache tags)
		const { headers, shouldCache } = buildFinalHeaders({
			transformed, transformSource, sourceType, etag,
			params, originMatch, cacheKey, durationMs, requestId, warnings, skipCache,
		});

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
				transformSource,
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

			// Build source freshness metadata for revalidation on future R2 HITs.
			// Only defined fields are stored (R2 customMetadata values must be strings).
			const r2Meta: Record<string, string> = {
				transformSource,
				sourceType,
				cacheKey,
			};
			if (etag) r2Meta.sourceEtag = etag;
			if (srcLastMod) r2Meta.sourceLastModified = srcLastMod;
			if (srcPath) r2Meta.sourcePath = srcPath;
			if (forceBust) r2Meta.cacheVersion = String(forceVersion);

			// 1. Stream transform output directly to R2
			if (contentLength) {
				const fixedStream = new FixedLengthStream(parseInt(contentLength, 10));
				transformed.body.pipeTo(fixedStream.writable).catch((err) => {
					rlog.error('pipeTo failed in transform R2 store', {
						error: err instanceof Error ? err.message : String(err), path,
					});
				});
				await c.env.VIDEOS.put(r2StoreKey, fixedStream.readable, {
					httpMetadata: { contentType: ct },
					customMetadata: r2Meta,
				});
			} else {
				// No Content-Length — stream directly to R2. R2 accepts ReadableStream
				// and handles sizing internally. Never buffer via arrayBuffer() — transform
				// outputs can exceed the 128MB Worker memory limit.
				rlog.warn('No Content-Length, streaming directly to R2', { path });
				await c.env.VIDEOS.put(r2StoreKey, transformed.body, {
					httpMetadata: { contentType: ct },
					customMetadata: r2Meta,
				});
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

			// Rare: cache.put may not be visible to cache.match immediately.
			// Re-read from R2 (body was consumed by cache.put above).
			rlog.warn('cache.match miss after put, re-reading from R2', { path });
			const r2Reread = await c.env.VIDEOS.get(r2StoreKey);
			if (r2Reread) {
				headers.set('Content-Length', String(r2Reread.size));
				return new Response(r2Reread.body, { status: 200, headers });
			}
			return new Response('Transform stored but unavailable', { status: 502, headers });
		} else {
			// Not cacheable (debug or passthrough) — serve directly
			return new Response(transformed.body, { status: transformed.status, headers });
		}
	});

	// Register signal (void) for coalescing — only for cacheable requests.
	// We register optimistically, then clean up if the response was 202
	// (async container job). 202s produce nothing in cache/R2 for joiners,
	// so coalescing them would just make joiners wait for nothing.
	if (!skipCache) {
		const signal = responsePromise.then((resp) => {
			// Remove coalescer entry for non-cacheable responses (202 pending)
			if (resp.status === 202 || resp.headers.get('X-Transform-Pending') === 'true') {
				coalescer.delete(cacheKey);
			}
		});
		coalescer.set(cacheKey, signal);
		signal.finally(() => coalescer.delete(cacheKey));
	}

	return await responsePromise;
}
