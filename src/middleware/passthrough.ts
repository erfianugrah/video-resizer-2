/**
 * Passthrough middleware.
 *
 * Two checks:
 * 1. CDN-CGI passthrough — /cdn-cgi/ paths are internal Cloudflare paths,
 *    pass them through to avoid loops when we make cdn-cgi/media subrequests.
 * 2. Non-video passthrough — extensions not in the whitelist pass through
 *    untransformed. Admin/internal paths are exempted (handled by route handlers).
 */
import type { Context, Next } from 'hono';
import type { Env, Variables } from '../types';
import * as log from '../log';

export async function cdnCgiPassthrough(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
	if (new URL(c.req.url).pathname.startsWith('/cdn-cgi/')) {
		return fetch(c.req.raw);
	}
	await next();
}

export async function nonVideoPassthrough(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
	const pathname = new URL(c.req.url).pathname;
	if (pathname.startsWith('/admin/') || pathname.startsWith('/internal/') || pathname.startsWith('/ws/')) {
		await next();
		return;
	}
	const ext = pathname.split('.').pop()?.toLowerCase();
	if (ext && c.get('config').passthrough.enabled && !c.get('config').passthrough.formats.includes(ext)) {
		log.info('Passthrough', { ext });
		return fetch(c.req.raw);
	}
	await next();
}
