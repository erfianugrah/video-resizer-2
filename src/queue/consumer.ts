/**
 * Queue consumer — processes container transform jobs from TRANSFORM_QUEUE.
 *
 * Simple retry-until-done pattern:
 *   1. Check R2 for existing result → ack if found
 *   2. Dispatch to container (async, returns 202)
 *   3. Retry in 120s to check R2 again
 *   4. After max_retries (10), message goes to DLQ
 *
 * The container downloads the source, runs ffmpeg, and POSTs the result
 * to /internal/container-result which stores it in R2. The queue just
 * ensures the dispatch eventually happens, even after deploys kill containers.
 *
 * No DO status checks, no premature acks. Stateless and idempotent.
 *
 * Status transitions:
 *   pending → downloading (first attempt only, not on retries)
 *   downloading/transcoding/uploading → (driven by container progress reports)
 *   → complete (R2 result found)
 *   → failed (terminal: binding missing, max retries exhausted via DLQ)
 *   Non-terminal retry errors do NOT set 'failed' — they keep the current status.
 */
import type { Env } from '../types';
import type { JobMessage } from '../transform/job';
import { buildContainerInstanceKey } from '../transform/container';
import { updateJobStatus, completeJob, failJob } from '../queue/jobs-db';
import * as log from '../log';

/**
 * Compute retry delay with exponential backoff.
 * Attempt 1 → 120s, 2 → 240s, 3 → 480s, capped at 900s (15min).
 * Large transcodes (700MB 1080p→1440p) can take 10-20min — a flat 120s
 * retry caused 5-10 concurrent ffmpeg processes that stalled the container.
 */
function retryDelay(attempt: number): number {
	return Math.min(120 * Math.pow(2, attempt - 1), 900);
}

function toCallbackUrl(zoneHost: string, path: string): string {
	return `http://${zoneHost}${path}`;
}

export async function handleQueue(
	batch: MessageBatch<JobMessage>,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	for (const message of batch.messages) {
		const job = message.body;

		try {
			log.info('Queue consumer', {
				jobId: job.jobId,
				attempt: message.attempts,
				path: job.path,
			});

			// 1. Check R2 for existing result — idempotent completion check
			const r2Key = `_transformed/${job.callbackCacheKey}`;
			const r2Head = await env.VIDEOS.head(r2Key);
			if (r2Head) {
				message.ack();
				log.info('Queue: result already in R2', { jobId: job.jobId, size: r2Head.size });
				if (env.ANALYTICS) ctx.waitUntil(completeJob(env.ANALYTICS, job.jobId, r2Head.size));
				continue;
			}

			// 2. Dispatch to container
			if (!env.FFMPEG_CONTAINER) {
				log.error('Queue: FFMPEG_CONTAINER binding missing');
				message.ack(); // Can't process without container — don't retry forever
				if (env.ANALYTICS) ctx.waitUntil(failJob(env.ANALYTICS, job.jobId, 'FFMPEG_CONTAINER binding missing'));
				continue;
			}

			const params = job.params as Record<string, unknown>;
			const instanceKey = buildContainerInstanceKey(job.origin, job.path, params as any);
			const zoneHost = new URL(job.requestUrl).host;
		// Build callback URL with source freshness metadata for R2 storage.
			// Keep param names compact (srcEtag, srcLM, srcPath, srcType, cacheVer)
			// to stay within URL length limits.
			let cbQuery = `/internal/container-result?path=${encodeURIComponent(job.path)}&cacheKey=${encodeURIComponent(job.callbackCacheKey)}&requestUrl=${encodeURIComponent(job.requestUrl)}&jobId=${encodeURIComponent(job.jobId)}`;
			if (job.etag) cbQuery += `&srcEtag=${encodeURIComponent(job.etag)}`;
			if (job.sourceLastModified) cbQuery += `&srcLM=${encodeURIComponent(job.sourceLastModified)}`;
			if (job.sourcePath) cbQuery += `&srcPath=${encodeURIComponent(job.sourcePath)}`;
			if (job.sourceType) cbQuery += `&srcType=${encodeURIComponent(job.sourceType)}`;
			if (job.version && job.version > 1) cbQuery += `&cacheVer=${job.version}`;
			const callbackUrl = toCallbackUrl(zoneHost, cbQuery);

			const container = env.FFMPEG_CONTAINER.get(
				env.FFMPEG_CONTAINER.idFromName(instanceKey),
			);

			// Only transition pending → downloading on first attempt.
			// Don't overwrite in-progress status (transcoding/uploading) on retries —
			// the container progress reports drive those transitions.
			if (env.ANALYTICS && message.attempts <= 1) {
				ctx.waitUntil(updateJobStatus(env.ANALYTICS, job.jobId, 'downloading'));
			}

			const resp = await container.fetch('http://container/transform-url', {
				method: 'POST',
				headers: {
					'X-Transform-Params': JSON.stringify(params),
					'X-Source-Url': job.sourceUrl,
					'X-Callback-Url': callbackUrl,
					'X-Job-Id': job.jobId,
				},
			});

			if (resp.status === 202 || resp.ok) {
				// Container accepted. Retry with backoff to check R2 for result.
				// Container needs: download (~30-120s) + ffmpeg (~60-1200s) + R2 put (~5s).
				// Backoff avoids re-dispatching to a container already transcoding.
				const delay = retryDelay(message.attempts);
				message.retry({ delaySeconds: delay });
				log.info('Queue: dispatched, will check R2', {
					jobId: job.jobId,
					attempt: message.attempts,
					retryInSeconds: delay,
				});
			} else {
				const body = await resp.text().catch(() => '');
				log.warn('Queue: container rejected', { jobId: job.jobId, status: resp.status, body: body.slice(0, 200) });
				// Don't mark 'failed' — this is a retryable error. The container may
				// have been starting up or the DO was busy. Keep current D1 status.
				message.retry({ delaySeconds: Math.min(30 * message.attempts, 120) });
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			log.error('Queue: job error', { jobId: job.jobId, error: errorMsg, attempt: message.attempts });
			// Don't mark 'failed' on retryable exceptions. The DLQ consumer
			// handles terminal failure when all retries are exhausted.
			message.retry({ delaySeconds: Math.min(60 * message.attempts, 300) });
		}
	}
}

/**
 * DLQ consumer — handles messages that exhausted all retries.
 * Marks jobs as terminal 'failed' in D1.
 */
/**
 * DLQ consumer — handles messages that exhausted all retries.
 *
 * Checks R2 before marking failed — the container may have completed
 * but D1 wasn't updated (e.g. D1 was down during all retry windows).
 * Only marks 'failed' if R2 genuinely has no result.
 */
export async function handleDLQ(
	batch: MessageBatch<JobMessage>,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	for (const message of batch.messages) {
		const job = message.body;

		// Check R2 first — result may exist even though retries exhausted
		const r2Key = `_transformed/${job.callbackCacheKey}`;
		const r2Head = await env.VIDEOS.head(r2Key).catch(() => null);
		if (r2Head) {
			log.info('DLQ: result found in R2, marking complete', {
				jobId: job.jobId, size: r2Head.size,
			});
			if (env.ANALYTICS) {
				ctx.waitUntil(completeJob(env.ANALYTICS, job.jobId, r2Head.size));
			}
			message.ack();
			continue;
		}

		log.error('DLQ: job exhausted all retries', {
			jobId: job.jobId,
			path: job.path,
			attempts: message.attempts,
		});
		if (env.ANALYTICS) {
			ctx.waitUntil(failJob(env.ANALYTICS, job.jobId, `Exhausted all retries after ${message.attempts} attempts`));
		}
		message.ack();
	}
}
