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
 */
import type { Env } from '../types';
import type { JobMessage } from '../transform/job';
import { buildContainerInstanceKey } from '../transform/container';
import { updateJobStatus, completeJob, failJob } from '../queue/jobs-db';
import * as log from '../log';

function toCallbackUrl(zoneHost: string, path: string): string {
	return `http://${zoneHost}${path}`;
}

export async function handleQueue(
	batch: MessageBatch<JobMessage>,
	env: Env,
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
				if (env.ANALYTICS) completeJob(env.ANALYTICS, job.jobId, r2Head.size);
				continue;
			}

			// 2. Dispatch to container
			if (!env.FFMPEG_CONTAINER) {
				log.error('Queue: FFMPEG_CONTAINER binding missing');
				message.ack(); // Can't process without container — don't retry forever
				if (env.ANALYTICS) failJob(env.ANALYTICS, job.jobId, 'FFMPEG_CONTAINER binding missing');
				continue;
			}

			const params = job.params as Record<string, unknown>;
			const instanceKey = buildContainerInstanceKey(job.origin, job.path, params as any);
			const zoneHost = new URL(job.requestUrl).host;
			const callbackUrl = toCallbackUrl(
				zoneHost,
				`/internal/container-result?path=${encodeURIComponent(job.path)}&cacheKey=${encodeURIComponent(job.callbackCacheKey)}&requestUrl=${encodeURIComponent(job.requestUrl)}&jobId=${encodeURIComponent(job.jobId)}`,
			);

			const container = env.FFMPEG_CONTAINER.get(
				env.FFMPEG_CONTAINER.idFromName(instanceKey),
			);

			// Update D1 status
			if (env.ANALYTICS) updateJobStatus(env.ANALYTICS, job.jobId, 'downloading');

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
				// Container accepted. Retry in 120s to check R2 for result.
				// Container needs: download (~30-120s) + ffmpeg (~60-300s) + R2 put (~5s).
				message.retry({ delaySeconds: 120 });
				log.info('Queue: dispatched, will check R2 in 120s', {
					jobId: job.jobId,
					attempt: message.attempts,
				});
			} else {
				const body = await resp.text().catch(() => '');
				log.warn('Queue: container rejected', { jobId: job.jobId, status: resp.status, body: body.slice(0, 200) });
				message.retry({ delaySeconds: 30 });
				if (env.ANALYTICS) updateJobStatus(env.ANALYTICS, job.jobId, 'failed');
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			log.error('Queue: job error', { jobId: job.jobId, error: errorMsg, attempt: message.attempts });
			message.retry({ delaySeconds: 60 });
			if (env.ANALYTICS) failJob(env.ANALYTICS, job.jobId, errorMsg);
		}
	}
}
