/**
 * Config middleware.
 *
 * Loads config from KV (with 5-min in-memory cache) and sets it on c.var.config.
 */
import type { Context, Next } from 'hono';
import type { Env, Variables } from '../types';
import { loadConfig } from '../config/loader';

export async function configMiddleware(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
	c.set('config', await loadConfig(c.env.CONFIG));
	await next();
}
