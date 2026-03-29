/**
 * Admin auth middleware.
 *
 * Validates Bearer token from Authorization header against CONFIG_API_TOKEN secret.
 * Uses timing-safe comparison to prevent timing attacks.
 */
import type { Env } from '../types';
import { AppError } from '../errors';
import { timingSafeEqual } from '../util';

export function requireAuth(c: { req: { header(name: string): string | undefined }; env: Env }): void {
	const token = c.req.header('Authorization')?.replace('Bearer ', '');
	if (!c.env.CONFIG_API_TOKEN || !token || !timingSafeEqual(token, c.env.CONFIG_API_TOKEN)) {
		throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing API token');
	}
}
