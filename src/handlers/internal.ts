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
import { requireAuth } from '../middleware/auth';
import * as log from '../log';

type HonoContext = Context<{ Bindings: Env; Variables: Variables }>;

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
	await requireAuth(c);
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
