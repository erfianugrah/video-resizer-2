/**
 * Admin auth middleware.
 *
 * Validates auth via:
 *   1. Bearer token from Authorization header (API clients, scripts)
 *   2. Session cookie from dashboard login (browser)
 *
 * Uses timing-safe comparison to prevent timing attacks.
 * Session cookie logic lives in `../session` (shared with dashboard handler).
 */
import type { Env } from '../types';
import { AppError } from '../errors';
import { timingSafeEqual } from '../util';
import { getCookie, validateSession, SESSION_COOKIE_NAME } from '../session';

/**
 * Require admin authentication — accepts Bearer token OR valid session cookie.
 * Throws AppError(401) if neither is valid.
 */
export async function requireAuth(c: { req: { raw: Request; header(name: string): string | undefined }; env: Env }): Promise<void> {
	if (!c.env.CONFIG_API_TOKEN) {
		throw new AppError(401, 'UNAUTHORIZED', 'CONFIG_API_TOKEN not configured');
	}

	// 1. Try Bearer token (API clients, scripts)
	const bearer = c.req.header('Authorization')?.replace('Bearer ', '');
	if (bearer && timingSafeEqual(bearer, c.env.CONFIG_API_TOKEN)) {
		return;
	}

	// 2. Try session cookie (dashboard browser sessions)
	const sessionCookie = getCookie(c.req.raw, SESSION_COOKIE_NAME);
	if (sessionCookie && await validateSession(sessionCookie, c.env.CONFIG_API_TOKEN)) {
		return;
	}

	throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing API token');
}
