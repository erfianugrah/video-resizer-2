/**
 * Admin auth middleware.
 *
 * Validates auth via:
 *   1. Bearer token from Authorization header (API clients, scripts)
 *   2. Session cookie from dashboard login (browser)
 *
 * Uses timing-safe comparison to prevent timing attacks.
 */
import type { Env } from '../types';
import { AppError } from '../errors';
import { timingSafeEqual } from '../util';

/** Parse a specific cookie from the Cookie header. */
function getCookie(req: Request, name: string): string | null {
	const header = req.headers.get('Cookie');
	if (!header) return null;
	const match = header.split(';').find((c) => c.trim().startsWith(`${name}=`));
	return match ? match.split('=').slice(1).join('=').trim() : null;
}

/** Validate the HMAC-signed session cookie (same logic as dashboard.ts). */
async function validateSessionCookie(cookieValue: string, apiToken: string): Promise<boolean> {
	const parts = cookieValue.split('.');
	if (parts.length !== 2) return false;

	const [expiryStr, sigHex] = parts;
	const expiry = parseInt(expiryStr, 10);
	if (isNaN(expiry) || expiry < Date.now()) return false;

	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(apiToken),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
	const expectedSig = await crypto.subtle.sign('HMAC', key, encoder.encode(expiryStr));
	const expectedHex = [...new Uint8Array(expectedSig)].map((b) => b.toString(16).padStart(2, '0')).join('');

	return timingSafeEqual(sigHex, expectedHex);
}

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
	const sessionCookie = getCookie(c.req.raw, 'vr2_session');
	if (sessionCookie && await validateSessionCookie(sessionCookie, c.env.CONFIG_API_TOKEN)) {
		return;
	}

	throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing API token');
}
