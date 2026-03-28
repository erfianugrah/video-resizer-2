/**
 * Shared types for Worker bindings and Hono context.
 */
import type { Hono } from 'hono';
import type { MediaBinding } from './transform/binding';
import type { AppConfig } from './config/schema';

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

	// Queue-based container transforms (optional)
	TRANSFORM_QUEUE?: Queue;
	TRANSFORM_JOB?: DurableObjectNamespace;
}

/** Hono context variables set by middleware. */
export type Variables = {
	config: AppConfig;
	startTime: number;
};

/** Fully-typed Hono app type used across all handlers/middleware. */
export type App = Hono<{ Bindings: Env; Variables: Variables }>;
