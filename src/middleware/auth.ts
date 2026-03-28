/**
 * Admin auth middleware.
 *
 * Validates Bearer token from Authorization header against CONFIG_API_TOKEN secret.
 */
import type { Env } from '../types';
import { AppError } from '../errors';

export function requireAuth(c: { req: { header(name: string): string | undefined }; env: Env }): void {
	const token = c.req.header('Authorization')?.replace('Bearer ', '');
	if (!c.env.CONFIG_API_TOKEN || token !== c.env.CONFIG_API_TOKEN) {
		throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing API token');
	}
}
