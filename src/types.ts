/**
 * Shared types for Worker bindings and Hono context.
 */
import type { MediaBinding } from './transform/binding';

/** Worker environment bindings. */
export interface Env {
	MEDIA: MediaBinding;
	VIDEOS: R2Bucket;
	CONFIG: KVNamespace;
	CACHE_VERSIONS: KVNamespace;

	ASSETS?: Fetcher;
	ANALYTICS?: D1Database;

	// Secrets (set via wrangler secret)
	CONFIG_API_TOKEN?: string;

	// Container (optional)
	FFMPEG_CONTAINER?: DurableObjectNamespace;
}
