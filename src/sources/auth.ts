/**
 * Source authentication.
 *
 * Creates authenticated Request objects for different auth strategies.
 * Each strategy reads credentials from environment variables (never hardcoded).
 *
 * Pure functions — no global state, no singletons.
 */
import { AwsClient } from 'aws4fetch';
import type { AuthConfig } from '../config/schema';
import { AppError } from '../errors';

/**
 * Apply authentication to a source URL, returning an authenticated Request.
 *
 * @param url Source URL to fetch
 * @param auth Auth config (or undefined for no auth)
 * @param env Environment variables (secrets are stored here)
 * @returns Authenticated Request ready to fetch()
 */
export async function applyAuth(url: string, auth: AuthConfig | undefined, env: Record<string, unknown>): Promise<Request> {
	if (!auth) {
		return new Request(url);
	}

	switch (auth.type) {
		case 'bearer':
			return applyBearerAuth(url, auth, env);
		case 'header':
			return applyHeaderAuth(url, auth);
		case 'aws-s3':
			return applyAwsS3Auth(url, auth, env);
		default: {
			const _exhaustive: never = auth;
			throw new AppError(500, 'UNKNOWN_AUTH_TYPE', `Unknown auth type: ${(auth as any).type}`);
		}
	}
}

function getEnvString(env: Record<string, unknown>, key: string): string {
	const value = env[key];
	if (typeof value !== 'string' || !value) {
		throw new AppError(500, 'AUTH_CONFIG_ERROR', `Environment variable '${key}' not found or empty`);
	}
	return value;
}

function applyBearerAuth(url: string, auth: { type: 'bearer'; tokenVar: string }, env: Record<string, unknown>): Request {
	const token = getEnvString(env, auth.tokenVar);
	return new Request(url, {
		headers: { Authorization: `Bearer ${token}` },
	});
}

function applyHeaderAuth(url: string, auth: { type: 'header'; headers: Record<string, string> }): Request {
	return new Request(url, {
		headers: auth.headers,
	});
}

async function applyAwsS3Auth(
	url: string,
	auth: {
		type: 'aws-s3';
		accessKeyVar: string;
		secretKeyVar: string;
		region: string;
		service?: string;
		sessionTokenVar?: string;
	},
	env: Record<string, unknown>,
): Promise<Request> {
	const accessKeyId = getEnvString(env, auth.accessKeyVar);
	const secretAccessKey = getEnvString(env, auth.secretKeyVar);
	const sessionToken = auth.sessionTokenVar ? getEnvString(env, auth.sessionTokenVar) : undefined;

	const client = new AwsClient({
		accessKeyId,
		secretAccessKey,
		sessionToken,
		region: auth.region,
		service: auth.service ?? 's3',
	});

	return client.sign(url, { method: 'GET' });
}
