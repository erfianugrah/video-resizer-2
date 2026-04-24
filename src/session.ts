/**
 * Shared HMAC session cookie utilities.
 *
 * Cookie format: `expiryTimestampMs.sigHexSha256`
 *   - Signature is HMAC-SHA256(expiry, apiToken)
 *   - Expiry guards against indefinite reuse (24h default)
 *   - Timing-safe comparison prevents timing attacks
 *
 * Used by `middleware/auth.ts` (validate incoming requests) and
 * `handlers/dashboard.ts` (issue cookies on login).
 */
import { timingSafeEqual } from './util';

/** Default session lifetime (24 hours). */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Cookie name used for the session. */
export const SESSION_COOKIE_NAME = 'vr2_session';

/** Derive an HMAC-SHA256 key from the API token. */
async function getHmacKey(token: string): Promise<CryptoKey> {
	const encoder = new TextEncoder();
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(token),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
}

/**
 * Create a signed session cookie value.
 * Format: `{expiryMs}.{sigHex}` where sigHex is HMAC-SHA256(expiryMs, token).
 */
export async function createSession(token: string, ttlMs: number = SESSION_TTL_MS): Promise<string> {
	const expiry = Date.now() + ttlMs;
	const key = await getHmacKey(token);
	const encoder = new TextEncoder();
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(String(expiry)));
	const sigHex = [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${expiry}.${sigHex}`;
}

/**
 * Validate a session cookie value.
 * Returns true if signature matches and expiry is in the future.
 */
export async function validateSession(cookieValue: string, token: string): Promise<boolean> {
	const parts = cookieValue.split('.');
	if (parts.length !== 2) return false;

	const [expiryStr, sigHex] = parts;
	const expiry = parseInt(expiryStr, 10);
	if (isNaN(expiry) || expiry < Date.now()) return false;

	const key = await getHmacKey(token);
	const encoder = new TextEncoder();
	const expectedSig = await crypto.subtle.sign('HMAC', key, encoder.encode(expiryStr));
	const expectedHex = [...new Uint8Array(expectedSig)].map((b) => b.toString(16).padStart(2, '0')).join('');

	return timingSafeEqual(sigHex, expectedHex);
}

/** Parse a specific cookie from the Cookie header. */
export function getCookie(req: Request, name: string): string | null {
	const header = req.headers.get('Cookie');
	if (!header) return null;
	const match = header.split(';').find((c) => c.trim().startsWith(`${name}=`));
	return match ? match.split('=').slice(1).join('=').trim() : null;
}

/**
 * Build a Set-Cookie header for the session.
 * `path` defaults to `/admin` — restrict the cookie to the admin surface.
 */
export function sessionCookieHeader(
	value: string,
	maxAgeSec: number,
	name: string = SESSION_COOKIE_NAME,
	path: string = '/admin',
): string {
	return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`;
}
