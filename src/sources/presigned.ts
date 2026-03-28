/**
 * Presigned URL generation + KV caching.
 *
 * For S3 sources accessed via cdn-cgi/media, we need presigned URLs with
 * auth in query parameters (cdn-cgi won't forward Authorization headers).
 *
 * aws4fetch's AwsClient.sign() produces a Request with headers-based auth,
 * but S3 also supports query-string-based presigning via the Signature V4
 * query string method. We construct this manually.
 *
 * Presigned URLs are cached in KV with a TTL slightly shorter than the
 * URL's expiry to avoid serving expired URLs.
 */
import { AwsClient } from 'aws4fetch';
import * as log from '../log';

const DEFAULT_EXPIRES_SECONDS = 3600; // 1 hour
const KV_TTL_BUFFER_SECONDS = 300; // 5 min buffer before expiry

/**
 * Get or generate a presigned URL for an S3 source.
 *
 * Checks KV cache first; generates and caches if missing.
 *
 * @param kv KV namespace for caching (CACHE_VERSIONS or dedicated)
 * @param sourceUrl The S3 URL to presign
 * @param auth S3 auth config
 * @param env Environment bindings for credentials
 * @param expiresSeconds How long the presigned URL should be valid
 */
export async function getPresignedUrl(
	kv: KVNamespace | undefined,
	sourceUrl: string,
	auth: { accessKeyVar: string; secretKeyVar: string; region: string; service?: string; sessionTokenVar?: string },
	env: Record<string, unknown>,
	expiresSeconds: number = DEFAULT_EXPIRES_SECONDS,
): Promise<string> {
	const cacheKey = `presigned:${sourceUrl}`;

	// Check KV cache
	if (kv) {
		const cached = await kv.get(cacheKey);
		if (cached) {
			log.debug('Presigned URL cache HIT', { url: sourceUrl });
			return cached;
		}
	}

	// Generate presigned URL
	const presigned = await generatePresignedUrl(sourceUrl, auth, env, expiresSeconds);

	// Cache in KV with TTL shorter than the URL's expiry
	if (kv) {
		const kvTtl = Math.max(60, expiresSeconds - KV_TTL_BUFFER_SECONDS);
		await kv.put(cacheKey, presigned, { expirationTtl: kvTtl }).catch((err) => {
			log.error('Failed to cache presigned URL', {
				error: err instanceof Error ? err.message : String(err),
			});
		});
		log.debug('Presigned URL cached', { url: sourceUrl, ttl: kvTtl });
	}

	return presigned;
}

/**
 * Generate an S3 presigned URL using aws4fetch.
 *
 * aws4fetch.sign() creates a Request with auth in headers. For presigned
 * URLs, we need auth in query params. We use the standard AWS SigV4 query
 * string approach: sign a request with `X-Amz-*` query params.
 */
async function generatePresignedUrl(
	sourceUrl: string,
	auth: { accessKeyVar: string; secretKeyVar: string; region: string; service?: string; sessionTokenVar?: string },
	env: Record<string, unknown>,
	expiresSeconds: number,
): Promise<string> {
	const accessKeyId = getEnvString(env, auth.accessKeyVar);
	const secretAccessKey = getEnvString(env, auth.secretKeyVar);
	const sessionToken = auth.sessionTokenVar ? (env[auth.sessionTokenVar] as string | undefined) : undefined;

	const client = new AwsClient({
		accessKeyId,
		secretAccessKey,
		sessionToken,
		region: auth.region,
		service: auth.service ?? 's3',
	});

	// aws4fetch.sign() with the special AWS query-string presigning approach.
	// We add X-Amz-Expires to the URL, then sign it. aws4fetch will put
	// the signature in the Authorization header, but we can also construct
	// the query string version.
	const url = new URL(sourceUrl);
	const now = new Date();
	const dateStamp = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 8);
	const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
	const credential = `${accessKeyId}/${dateStamp}/${auth.region}/${auth.service ?? 's3'}/aws4_request`;

	url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
	url.searchParams.set('X-Amz-Credential', credential);
	url.searchParams.set('X-Amz-Date', amzDate);
	url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
	url.searchParams.set('X-Amz-SignedHeaders', 'host');
	if (sessionToken) {
		url.searchParams.set('X-Amz-Security-Token', sessionToken);
	}

	// Sign the request — aws4fetch will compute the signature
	const signed = await client.sign(url.toString(), {
		method: 'GET',
		aws: { signQuery: true },
	});

	// The signed request URL now contains X-Amz-Signature in query params
	return signed.url;
}

function getEnvString(env: Record<string, unknown>, key: string): string {
	const value = env[key];
	if (typeof value !== 'string' || !value) {
		throw new Error(`Environment variable '${key}' not found or empty`);
	}
	return value;
}
