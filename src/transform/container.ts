/**
 * FFmpeg container transform.
 *
 * For transforms the Media binding can't handle:
 *   - fps, speed, rotate, crop, bitrate
 *   - h265/vp9 codecs
 *   - duration > 60s
 *   - input > 100MB (binding limit, though account may override)
 *
 * The container runs ffmpeg and exposes HTTP endpoints:
 *   POST /transform       — sync: send source, receive output
 *   POST /transform-async — async: send source + callbackUrl, 202 response
 *   POST /transform-url   — async: container fetches source by URL
 *   GET  /health          — health check
 *
 * The Worker routes to the container via Durable Object binding.
 *
 * IMPORTANT: Containers can only intercept HTTP traffic (not HTTPS).
 * All outbound HTTP from the container is proxied through the `outbound`
 * handler below, which calls `fetch(request)` in the Worker runtime —
 * giving the container full internet access for source downloads and
 * callback POSTs. The container server.mjs must use http:// URLs.
 */
import { Container, ContainerProxy } from '@cloudflare/containers';
import type { TransformParams } from '../params/schema';
import { AppError } from '../errors';
import * as log from '../log';

// ContainerProxy must be exported from the Worker entry point for outbound
// handlers to work. Re-exported here; index.ts re-exports it.
export { ContainerProxy };

/**
 * FFmpegContainer — extends the CF Container class.
 * Exported so it can be registered as a Durable Object in wrangler.jsonc.
 *
 * The static `outbound` handler intercepts ALL outbound HTTP requests from
 * the container and proxies them through the Worker runtime. This is needed
 * because:
 *   1. The container's callback POST to /internal/container-result must
 *      reach our Worker, not the public internet.
 *   2. The container's source fetch (e.g. from videos.erfi.dev) needs
 *      internet access, which only the Worker runtime provides.
 *   3. Containers only intercept HTTP, not HTTPS — but the Worker's
 *      fetch() handles TLS automatically.
 */
export class FFmpegContainer extends Container {
	defaultPort = 8080;
	// Must exceed the longest possible job: 725MB download (~30s) + ffmpeg transcode (~5min).
	// If no requests arrive at the DO for this duration, the container is killed.
	sleepAfter = '15m';

	override onStart() {
		log.info('FFmpeg container started');
		// Monitor the container lifecycle — log exits and errors
		this.ctx.container?.monitor()
			.then(() => log.info('FFmpeg container exited cleanly'))
			.catch((err: unknown) => log.error('FFmpeg container monitor error', {
				error: err instanceof Error ? err.message : String(err),
			}));
	}

	override onStop() {
		log.info('FFmpeg container stopped');
	}

	override onError(error: unknown) {
		log.error('FFmpeg container error', {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Outbound handler: intercepts ALL HTTP requests from the container.
 *
 * Routes requests based on URL path:
 *   /internal/container-result  -> store in Cache API via bindings (callback)
 *   /internal/r2-source         -> serve R2 object via bindings
 *   everything else             -> proxy via fetch() (source downloads, etc.)
 *
 * This avoids hardcoding any domain — the container passes the zone host
 * in the URL, and we match on path prefix only. The catch-all `outbound`
 * handler sees every HTTP request regardless of destination host.
 */
(FFmpegContainer as any).outbound = async (request: Request, env: any, _ctx: any) => {
	const url = new URL(request.url);

	log.info('Container outbound', {
		method: request.method,
		url: request.url,
	});

	// ── Callback: POST /internal/container-result ─────────────────────
	if (request.method === 'POST' && url.pathname === '/internal/container-result') {
		const path = url.searchParams.get('path');
		const cacheKey = url.searchParams.get('cacheKey');
		const requestUrl = url.searchParams.get('requestUrl');

		if (!path || !cacheKey) {
			log.error('Container callback missing params', { path, cacheKey });
			return new Response(JSON.stringify({ ok: false, error: 'missing params' }), { status: 400 });
		}

		const isError = request.headers.get('X-Transform-Error') === 'true';
		if (isError) {
			const errBody = await request.text().catch(() => '');
			// Log the tail of the error — that's where ffmpeg's actual error message is
			log.error('Container async transform failed', { cacheKey, path, errorTail: errBody.slice(-1500) });
			return new Response(JSON.stringify({ ok: false, error: 'transform failed' }), { status: 200 });
		}

		const body = request.body;
		if (!body) {
			log.error('Container callback empty body', { path });
			return new Response(JSON.stringify({ ok: false, error: 'empty body' }), { status: 400 });
		}

		const contentType = request.headers.get('Content-Type') ?? 'video/mp4';
		const contentLength = request.headers.get('Content-Length');

		const headers = new Headers();
		headers.set('Content-Type', contentType);
		if (contentLength) headers.set('Content-Length', contentLength);
		headers.set('Cache-Control', 'public, max-age=86400');
		headers.set('Accept-Ranges', 'bytes');
		headers.set('Via', 'video-resizer');
		headers.set('X-Transform-Source', 'container');

		const cacheResponse = new Response(body, { status: 200, headers });
		const cache = caches.default;
		// Use the original user request URL so cache.match() finds it later.
		// Fall back to https://{host}{path} if requestUrl wasn't provided.
		const cacheUrl = requestUrl || `https://${url.host}${path}`;
		const cacheRequest = new Request(cacheUrl, { method: 'GET' });

		await cache.put(cacheRequest, cacheResponse);
		log.info('Container result cached via outbound handler', {
			cacheKey, path, cacheUrl, contentType,
			contentLength: contentLength ?? 'unknown',
		});

		return new Response(JSON.stringify({ ok: true, cached: true }), {
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// ── R2 source: GET /internal/r2-source ────────────────────────────
	if (request.method === 'GET' && url.pathname === '/internal/r2-source') {
		const key = url.searchParams.get('key');
		const bucketBinding = url.searchParams.get('bucket') ?? 'VIDEOS';
		if (!key) {
			return new Response(JSON.stringify({ error: 'missing key' }), { status: 400 });
		}
		const bucket = (env as Record<string, unknown>)[bucketBinding] as R2Bucket | undefined;
		if (!bucket) {
			return new Response(JSON.stringify({ error: `bucket ${bucketBinding} not found` }), { status: 500 });
		}
		const object = await bucket.get(key);
		if (!object) {
			return new Response(JSON.stringify({ error: `object ${key} not found` }), { status: 404 });
		}
		log.info('Serving R2 source via outbound handler', { key, size: object.size });
		return new Response(object.body, {
			headers: {
				'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
				'Content-Length': String(object.size),
			},
		});
	}

	// ── Everything else: proxy through Worker runtime ─────────────────
	// Upgrade http:// to https:// before fetching. The container sends
	// http:// because that's all the outbound handler can intercept, but
	// the actual remote server expects HTTPS (and would 301 redirect).
	const upgraded = new Request(request.url.replace(/^http:\/\//, 'https://'), request);
	return fetch(upgraded);
};

/**
 * Transform via FFmpeg container (synchronous path).
 *
 * Sends the source stream + params to the container's /transform endpoint.
 * The container runs ffmpeg and returns the transformed output.
 *
 * @param containerBinding The FFMPEG_CONTAINER Durable Object namespace
 * @param sourceStream Source video ReadableStream
 * @param params Transform params
 * @param instanceKey Unique key for container instance routing (e.g. origin:path)
 * @returns Transformed Response
 */
export async function transformViaContainer(
	containerBinding: DurableObjectNamespace,
	sourceStream: ReadableStream<Uint8Array>,
	params: TransformParams,
	instanceKey: string,
): Promise<Response> {
	const stub = containerBinding.get(containerBinding.idFromName(instanceKey));

	log.info('Container transform', { instanceKey, params: sanitizeParams(params) });

	const response = await stub.fetch('http://container/transform', {
		method: 'POST',
		headers: {
			'X-Transform-Params': JSON.stringify(sanitizeParams(params)),
			'Content-Type': 'application/octet-stream',
		},
		body: sourceStream,
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new AppError(502, 'CONTAINER_ERROR', `Container transform failed: ${response.status}`, {
			status: response.status,
			body: body.slice(0, 500),
		});
	}

	return response;
}

/**
 * Transform via FFmpeg container (async path with callback).
 *
 * Sends the source to the container, which processes it asynchronously
 * and POSTs the result to the callback URL.
 *
 * @returns 202 response (processing started)
 */
export async function transformViaContainerAsync(
	containerBinding: DurableObjectNamespace,
	sourceStream: ReadableStream<Uint8Array>,
	params: TransformParams,
	instanceKey: string,
	callbackUrl: string,
): Promise<Response> {
	const stub = containerBinding.get(containerBinding.idFromName(instanceKey));

	log.info('Container async transform', { instanceKey, callbackUrl });

	const response = await stub.fetch('http://container/transform-async', {
		method: 'POST',
		headers: {
			'X-Transform-Params': JSON.stringify(sanitizeParams(params)),
			'X-Callback-Url': callbackUrl,
			'Content-Type': 'application/octet-stream',
		},
		body: sourceStream,
	});

	return response;
}

/**
 * Transform via URL-based container endpoint.
 *
 * Instead of streaming the source through the DO, passes the source URL
 * to the container which fetches it directly. Essential for large files
 * (>256MB) where streaming through DO would timeout.
 *
 * @param containerBinding The FFMPEG_CONTAINER DO namespace
 * @param sourceUrl URL the container should fetch the source from
 * @param params Transform params
 * @param instanceKey Unique key for container instance routing
 * @param callbackUrl URL to POST the result to (async mode)
 * @returns 202 response (processing started)
 */
export async function transformViaContainerUrl(
	containerBinding: DurableObjectNamespace,
	sourceUrl: string,
	params: TransformParams,
	instanceKey: string,
	callbackUrl: string,
): Promise<Response> {
	const stub = containerBinding.get(containerBinding.idFromName(instanceKey));

	log.info('Container URL transform (async)', { instanceKey, sourceUrl, callbackUrl });

	const response = await stub.fetch('http://container/transform-url', {
		method: 'POST',
		headers: {
			'X-Transform-Params': JSON.stringify(sanitizeParams(params)),
			'X-Source-Url': sourceUrl,
			'X-Callback-Url': callbackUrl,
		},
	});

	return response;
}

/**
 * Build a deterministic container DO instance key.
 *
 * Each unique (origin, path, params) combination gets its own DO instance
 * to prevent transforms with different params from colliding on the same
 * container. The hash covers all transform-affecting params (not playback
 * hints or metadata like filename/derivative name).
 *
 * Format: `ffmpeg:{origin}:{path}:{paramsHash}`
 */
export function buildContainerInstanceKey(
	originName: string,
	path: string,
	params: TransformParams,
): string {
	// Include only transform-affecting params in the hash
	const hashInput = [
		params.width,
		params.height,
		params.fit,
		params.mode,
		params.time,
		params.duration,
		params.audio,
		params.format,
		params.quality,
		params.compression,
		params.fps,
		params.speed,
		params.rotate,
		params.crop,
		params.bitrate,
		params.imageCount,
	]
		.map((v) => (v === undefined ? '' : String(v)))
		.join(':');

	// Simple FNV-1a 32-bit hash — fast, deterministic, good distribution
	let hash = 0x811c9dc5;
	for (let i = 0; i < hashInput.length; i++) {
		hash ^= hashInput.charCodeAt(i);
		hash = (hash * 0x01000193) >>> 0;
	}
	const hashHex = hash.toString(16).padStart(8, '0');

	return `ffmpeg:${originName}:${path}:${hashHex}`;
}

function sanitizeParams(params: TransformParams): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}
