/**
 * Cache API helpers.
 *
 * Uses caches.default so the standard Cloudflare Purge API (purge by URL,
 * purge by tag, purge everything) works without any special handling.
 */
import * as log from '../log';

export async function cacheLookup(request: Request): Promise<Response | null> {
	const cached = await caches.default.match(request);
	if (cached) {
		log.info('cache.match HIT', { url: request.url, status: cached.status });
	}
	return cached ?? null;
}

export async function cacheStore(request: Request | string, response: Response): Promise<void> {
	const url = typeof request === 'string' ? request : request.url;
	log.debug('cache.put', {
		url,
		status: response.status,
		contentType: response.headers.get('Content-Type'),
		cacheControl: response.headers.get('Cache-Control'),
	});
	await caches.default.put(request, response);
}

export async function cacheDelete(request: Request | string): Promise<boolean> {
	return caches.default.delete(request);
}
