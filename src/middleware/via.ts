/**
 * Via header loop prevention.
 *
 * If the request already has a `Via: video-resizer` header, it's a loop
 * (our own subrequest coming back). Pass it through to origin to avoid
 * infinite recursion.
 */
import type { Context, Next } from 'hono';
import type { Env, Variables } from '../types';
import * as log from '../log';

export async function viaMiddleware(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
	if ((c.req.header('via') ?? '').includes('video-resizer')) {
		log.debug('Via loop detected');
		return fetch(c.req.raw);
	}
	c.set('startTime', performance.now());
	await next();
}
