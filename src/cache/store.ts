/**
 * Cache API — following the exact pattern from CF's own examples.
 *
 * match(request) and put(request, response.clone()) use the same request.
 * Range/If-None-Match headers on the request flow through automatically.
 */
import * as log from '../log';

export async function cacheLookup(request: Request): Promise<Response | null> {
	const cached = await caches.default.match(request);
	if (cached) {
		log.info('cache.match HIT', {
			url: request.url,
			status: cached.status,
			contentType: cached.headers.get('Content-Type'),
		});
	}
	return cached ?? null;
}

export async function cacheStore(request: Request, response: Response): Promise<void> {
	log.debug('cache.put', {
		url: request.url,
		status: response.status,
		contentType: response.headers.get('Content-Type'),
		cacheControl: response.headers.get('Cache-Control'),
	});
	await caches.default.put(request, response);
}
