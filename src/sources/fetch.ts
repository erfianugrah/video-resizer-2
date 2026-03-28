/**
 * Source resolution and fetching.
 *
 * Two-tier approach based on source type:
 *   - R2: fetch the stream directly (for env.MEDIA binding)
 *   - Remote/fallback: resolve the source URL (for cdn-cgi/media — no fetch)
 *
 * Sources within an origin are tried in priority order (lower = higher priority).
 */
import type { Origin, Source } from '../config/schema';
import { applyAuth } from './auth';
import { sortedSources, resolveSourcePath } from './router';
import { AppError } from '../errors';

// ── Result types ─────────────────────────────────────────────────────────

/** R2 source: we have the actual stream + etag. */
export interface R2SourceResult {
	type: 'r2';
	stream: ReadableStream<Uint8Array>;
	contentType: string;
	contentLength: number | null;
	etag: string;
	source: Source;
	resolvedPath: string;
}

/** Remote/fallback source: we have the URL, no stream (cdn-cgi will fetch it). */
export interface RemoteSourceResult {
	type: 'remote' | 'fallback';
	/** The full HTTP(S) URL cdn-cgi/media should fetch from. */
	sourceUrl: string;
	source: Source;
	resolvedPath: string;
}

export type SourceResult = R2SourceResult | RemoteSourceResult;

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Resolve a video source, trying sources in priority order.
 *
 * For R2 sources, fetches the stream immediately (needed for env.MEDIA).
 * For remote/fallback, resolves the URL without fetching (cdn-cgi does the fetch).
 *
 * @throws AppError if all sources fail
 */
export async function resolveSource(
	origin: Origin,
	path: string,
	captures: Record<string, string>,
	env: Record<string, unknown>,
): Promise<SourceResult> {
	const sources = sortedSources(origin);
	const errors: string[] = [];

	for (const source of sources) {
		try {
			const resolved = resolveSourcePath(source, path, captures);

			if (source.type === 'r2') {
				const r2 = await fetchR2(source.bucketBinding, resolved, env);
				if (r2) return { type: 'r2', ...r2, source, resolvedPath: resolved };
			} else {
				// remote or fallback — resolve the URL, don't fetch
				// For auth, we need to build the authenticated URL
				const authenticatedUrl = await resolveAuthenticatedUrl(resolved, source.auth, env);
				return {
					type: source.type as 'remote' | 'fallback',
					sourceUrl: authenticatedUrl,
					source,
					resolvedPath: resolved,
				};
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${source.type}(p${source.priority}): ${msg}`);
			continue;
		}
	}

	throw new AppError(502, 'ALL_SOURCES_FAILED', `All sources failed for origin '${origin.name}'`, {
		origin: origin.name,
		path,
		errors,
	});
}

/**
 * Legacy: fetch a source stream directly (used when we need the body in-Worker,
 * e.g. for the Media binding with R2, or as a fallback).
 */
export async function fetchSourceStream(
	origin: Origin,
	path: string,
	captures: Record<string, string>,
	env: Record<string, unknown>,
): Promise<R2SourceResult> {
	const sources = sortedSources(origin);
	const errors: string[] = [];

	for (const source of sources) {
		try {
			const resolved = resolveSourcePath(source, path, captures);

			if (source.type === 'r2') {
				const r2 = await fetchR2(source.bucketBinding, resolved, env);
				if (r2) return { type: 'r2', ...r2, source, resolvedPath: resolved };
			} else {
				// For stream fetching of remote sources, actually fetch
				const request = await applyAuth(resolved, source.auth, env);
				const response = await fetch(request);
				if (!response.ok) throw new Error(`HTTP ${response.status} from ${source.type}: ${resolved}`);
				if (!response.body) throw new Error(`Empty body from ${source.type}: ${resolved}`);

				return {
					type: 'r2', // Treat as stream result regardless of actual source
					stream: response.body,
					contentType: response.headers.get('Content-Type') ?? 'video/mp4',
					contentLength: parseInt(response.headers.get('Content-Length') ?? '0', 10) || null,
					etag: response.headers.get('ETag') ?? '',
					source,
					resolvedPath: resolved,
				};
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${source.type}(p${source.priority}): ${msg}`);
			continue;
		}
	}

	throw new AppError(502, 'ALL_SOURCES_FAILED', `All sources failed for origin '${origin.name}'`, {
		origin: origin.name,
		path,
		errors,
	});
}

// ── Internal ─────────────────────────────────────────────────────────────

async function fetchR2(
	bucketBinding: string,
	objectKey: string,
	env: Record<string, unknown>,
): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string; contentLength: number | null; etag: string } | null> {
	const bucket = env[bucketBinding] as R2Bucket | undefined;
	if (!bucket) {
		throw new Error(`R2 binding '${bucketBinding}' not available`);
	}

	const object = await bucket.get(objectKey);
	if (!object) {
		throw new Error(`R2 object not found: ${objectKey}`);
	}

	return {
		stream: object.body,
		contentType: object.httpMetadata?.contentType ?? 'video/mp4',
		contentLength: object.size,
		etag: object.etag,
	};
}

/**
 * Resolve an authenticated URL for a remote source.
 * For bearer/header auth, the URL itself doesn't change — auth is in headers.
 * But cdn-cgi/media doesn't forward custom headers to the source, so:
 *   - AWS S3: use presigned URLs (auth in query params — cdn-cgi will pass them)
 *   - Bearer/header: the URL stays as-is (works if source is public or has
 *     other auth like presigned params)
 *
 * TODO: For bearer/header auth sources, we may need to generate a presigned
 * proxy URL or use the binding path instead of cdn-cgi.
 */
async function resolveAuthenticatedUrl(
	url: string,
	auth: Source['auth'],
	env: Record<string, unknown>,
): Promise<string> {
	if (!auth) return url;

	if (auth.type === 'aws-s3') {
		// For S3, presigned URL generation is handled by the caller
		// (index.ts uses getPresignedUrl() with KV caching).
		// Fallback: return the base URL (works for public S3 buckets).
		return url;
	}

	// Bearer/header auth: cdn-cgi won't forward these headers to the source.
	// Return the URL as-is — only works for public or pre-authed sources.
	return url;
}
