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
 *   GET  /health          — health check
 *
 * The Worker routes to the container via Durable Object binding.
 */
import { Container } from '@cloudflare/containers';
import type { TransformParams } from '../params/schema';
import { AppError } from '../errors';
import * as log from '../log';

/**
 * FFmpegContainer — extends the CF Container class.
 * Exported so it can be registered as a Durable Object in wrangler.jsonc.
 */
export class FFmpegContainer extends Container {
	defaultPort = 8080;
	sleepAfter = '5m';

	override onStart() {
		log.info('FFmpeg container started');
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
