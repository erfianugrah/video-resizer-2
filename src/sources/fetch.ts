/**
 * Source stream fetching.
 *
 * Given a matched origin and its sorted sources, tries each source in priority
 * order until one returns a ReadableStream. R2 uses the binding directly;
 * remote/fallback fetches over HTTP with optional auth.
 */
import type { Origin, Source } from '../config/schema';
import { applyAuth } from './auth';
import { sortedSources, resolveSourcePath } from './router';
import { AppError } from '../errors';

/** Result of fetching a source stream. */
export interface SourceStream {
	stream: ReadableStream<Uint8Array>;
	contentType: string;
	contentLength: number | null;
	source: Source;
	resolvedPath: string;
}

/**
 * Fetch a video source stream, trying sources in priority order.
 *
 * @param origin Matched origin config
 * @param path Request path
 * @param captures Regex capture groups from origin match
 * @param env Worker environment bindings
 * @returns Source stream + metadata
 * @throws AppError if all sources fail
 */
export async function fetchSource(
	origin: Origin,
	path: string,
	captures: Record<string, string>,
	env: Record<string, unknown>,
): Promise<SourceStream> {
	const sources = sortedSources(origin);
	const errors: string[] = [];

	for (const source of sources) {
		try {
			const resolved = resolveSourcePath(source, path, captures);
			const result = await fetchSingleSource(source, resolved, env);
			if (result) {
				return { ...result, source, resolvedPath: resolved };
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

async function fetchSingleSource(
	source: Source,
	resolvedPath: string,
	env: Record<string, unknown>,
): Promise<Omit<SourceStream, 'source' | 'resolvedPath'> | null> {
	if (source.type === 'r2') {
		return fetchR2(source.bucketBinding, resolvedPath, env);
	}

	// remote or fallback — HTTP fetch
	const request = await applyAuth(resolvedPath, source.auth, env);
	const response = await fetch(request);

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${source.type}: ${resolvedPath}`);
	}

	if (!response.body) {
		throw new Error(`Empty body from ${source.type}: ${resolvedPath}`);
	}

	return {
		stream: response.body,
		contentType: response.headers.get('Content-Type') ?? 'video/mp4',
		contentLength: parseInt(response.headers.get('Content-Length') ?? '0', 10) || null,
	};
}

async function fetchR2(
	bucketBinding: string,
	objectKey: string,
	env: Record<string, unknown>,
): Promise<Omit<SourceStream, 'source' | 'resolvedPath'> | null> {
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
	};
}
