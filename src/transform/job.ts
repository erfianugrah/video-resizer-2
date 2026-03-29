/**
 * Job types for the container transform queue.
 *
 * Previously this file contained TransformJobDO (a Durable Object with
 * WebSocket Hibernation API). That was removed in favor of D1 + SSE:
 * - D1 stores job state including percent progress
 * - SSE endpoint streams progress to the dashboard
 * - No extra DO binding needed
 */

/** Job state machine phases. */
export type JobStatus = 'pending' | 'downloading' | 'transcoding' | 'uploading' | 'complete' | 'failed';

/** Message shape enqueued to TRANSFORM_QUEUE. */
export interface JobMessage {
	jobId: string;
	path: string;
	params: Record<string, unknown>;
	sourceUrl: string;
	callbackCacheKey: string;
	requestUrl: string;
	origin: string;
	sourceType: string;
	etag?: string;
	version?: number;
	createdAt: number;
}
