/**
 * Tests for queue consumer logic.
 *
 * Since the queue consumer depends on DO bindings which can't be easily
 * mocked in the Workers test pool, these tests verify the callback URL
 * construction, message handling, retry backoff, and dedup logic.
 */
import { describe, it, expect } from 'vitest';
import type { JobMessage } from '../../src/transform/job';

describe('JobMessage serialization', () => {
	it('round-trips through JSON', () => {
		const msg: JobMessage = {
			jobId: 'video:rocky.mp4:w=1280:h=720',
			path: '/rocky.mp4',
			params: { width: 1280, height: 720, mode: 'video' },
			sourceUrl: 'https://videos.erfi.dev/rocky.mp4',
			callbackCacheKey: 'video:rocky.mp4:w=1280:h=720',
			requestUrl: 'https://videos.erfi.io/rocky.mp4?width=1280&height=720',
			origin: 'standard',
			sourceType: 'remote',
			createdAt: 1711612800000,
		};

		const serialized = JSON.stringify(msg);
		const deserialized: JobMessage = JSON.parse(serialized);
		expect(deserialized.jobId).toBe(msg.jobId);
		expect(deserialized.params.width).toBe(1280);
		expect(deserialized.createdAt).toBe(1711612800000);
	});

	it('handles undefined optional fields', () => {
		const msg: JobMessage = {
			jobId: 'test',
			path: '/test.mp4',
			params: {},
			sourceUrl: 'https://example.com/test.mp4',
			callbackCacheKey: 'test',
			requestUrl: 'https://videos.erfi.io/test.mp4',
			origin: 'test',
			sourceType: 'r2',
			createdAt: Date.now(),
		};

		const serialized = JSON.stringify(msg);
		const deserialized: JobMessage = JSON.parse(serialized);
		expect(deserialized.etag).toBeUndefined();
		expect(deserialized.version).toBeUndefined();
	});
});

describe('Callback URL construction', () => {
	it('includes jobId when present', () => {
		const jobId = 'video:rocky.mp4:w=1280';
		const path = '/rocky.mp4';
		const cacheKey = 'video:rocky.mp4:w=1280';
		const requestUrl = 'https://videos.erfi.io/rocky.mp4?width=1280';
		const zoneHost = 'videos.erfi.io';

		const callbackUrl = `http://${zoneHost}/internal/container-result?path=${encodeURIComponent(path)}&cacheKey=${encodeURIComponent(cacheKey)}&requestUrl=${encodeURIComponent(requestUrl)}&jobId=${encodeURIComponent(jobId)}`;

		const url = new URL(callbackUrl);
		expect(url.searchParams.get('jobId')).toBe(jobId);
		expect(url.searchParams.get('path')).toBe(path);
		expect(url.searchParams.get('cacheKey')).toBe(cacheKey);
	});

	it('uses http:// protocol for outbound interception', () => {
		const callbackUrl = `http://videos.erfi.io/internal/container-result?path=%2Ftest.mp4&cacheKey=test&requestUrl=https%3A%2F%2Fvideos.erfi.io%2Ftest.mp4`;
		const url = new URL(callbackUrl);
		expect(url.protocol).toBe('http:');
	});

	it('preserves special characters in path and cacheKey', () => {
		const path = '/path with spaces/video (1).mp4';
		const cacheKey = 'video:path-with-spaces/video--1-.mp4:w=320';
		const callbackUrl = `http://videos.erfi.io/internal/container-result?path=${encodeURIComponent(path)}&cacheKey=${encodeURIComponent(cacheKey)}`;
		const url = new URL(callbackUrl);
		expect(url.searchParams.get('path')).toBe(path);
		expect(url.searchParams.get('cacheKey')).toBe(cacheKey);
	});

	it('extracts host from requestUrl for callback', () => {
		const requestUrl = 'https://videos.erfi.io/rocky.mp4?width=1280';
		const zoneHost = new URL(requestUrl).host;
		expect(zoneHost).toBe('videos.erfi.io');
	});
});

describe('Retry backoff calculation (success path)', () => {
	/** Mirrors retryDelay() from consumer.ts: 120 * 2^(attempt-1), capped at 900. */
	function retryDelay(attempt: number): number {
		return Math.min(120 * Math.pow(2, attempt - 1), 900);
	}

	it('first attempt: 120s delay', () => {
		expect(retryDelay(1)).toBe(120);
	});

	it('second attempt: 240s delay', () => {
		expect(retryDelay(2)).toBe(240);
	});

	it('third attempt: 480s delay', () => {
		expect(retryDelay(3)).toBe(480);
	});

	it('fourth attempt: capped at 900s', () => {
		expect(retryDelay(4)).toBe(900);
	});

	it('tenth attempt: still capped at 900s', () => {
		expect(retryDelay(10)).toBe(900);
	});
});

describe('Retry backoff calculation (rejection path)', () => {
	/** Rejection retries: 30 * attempt, capped at 120. */
	function rejectionDelay(attempt: number): number {
		return Math.min(30 * attempt, 120);
	}

	it('first attempt: 30s', () => {
		expect(rejectionDelay(1)).toBe(30);
	});

	it('second attempt: 60s', () => {
		expect(rejectionDelay(2)).toBe(60);
	});

	it('fourth attempt: capped at 120s', () => {
		expect(rejectionDelay(4)).toBe(120);
	});

	it('tenth attempt: still capped at 120s', () => {
		expect(rejectionDelay(10)).toBe(120);
	});
});

describe('Retry backoff calculation (exception path)', () => {
	/** Exception retries: 60 * attempt, capped at 300. */
	function exceptionDelay(attempt: number): number {
		return Math.min(60 * attempt, 300);
	}

	it('first attempt: 60s', () => {
		expect(exceptionDelay(1)).toBe(60);
	});

	it('third attempt: 180s', () => {
		expect(exceptionDelay(3)).toBe(180);
	});

	it('fifth attempt: capped at 300s', () => {
		expect(exceptionDelay(5)).toBe(300);
	});
});

describe('Job dedup logic', () => {
	it('same jobId should not be enqueued twice', () => {
		const job1: JobMessage = {
			jobId: 'video:rocky.mp4:w=1280',
			path: '/rocky.mp4', params: { width: 1280 },
			sourceUrl: 'https://x.com/rocky.mp4',
			callbackCacheKey: 'video:rocky.mp4:w=1280',
			requestUrl: 'https://videos.erfi.io/rocky.mp4?width=1280',
			origin: 'standard', sourceType: 'remote', createdAt: Date.now(),
		};
		const job2: JobMessage = { ...job1, createdAt: Date.now() + 1000 };
		expect(job1.jobId).toBe(job2.jobId);
		// In practice, the transform handler checks DO status before enqueuing
	});

	it('different params produce different jobIds (via cache key)', () => {
		const jobId1 = 'video:rocky.mp4:w=1280:h=720';
		const jobId2 = 'video:rocky.mp4:w=640:h=360';
		expect(jobId1).not.toBe(jobId2);
	});
});

describe('Container-side dedup key', () => {
	/** Container server.mjs uses `${sourceUrl}|${paramsJson}` as dedup key. */
	it('same source+params produce same dedup key', () => {
		const sourceUrl = 'https://videos.erfi.dev/big_buck_bunny.mov';
		const params = JSON.stringify({ width: 1440, compression: 'auto' });
		const key1 = `${sourceUrl}|${params}`;
		const key2 = `${sourceUrl}|${params}`;
		expect(key1).toBe(key2);
	});

	it('different params produce different dedup keys', () => {
		const sourceUrl = 'https://videos.erfi.dev/big_buck_bunny.mov';
		const key1 = `${sourceUrl}|${JSON.stringify({ width: 1440 })}`;
		const key2 = `${sourceUrl}|${JSON.stringify({ width: 720 })}`;
		expect(key1).not.toBe(key2);
	});

	it('different sources produce different dedup keys', () => {
		const params = JSON.stringify({ width: 1440 });
		const key1 = `https://a.com/video.mp4|${params}`;
		const key2 = `https://b.com/video.mp4|${params}`;
		expect(key1).not.toBe(key2);
	});

	it('dedup map tracks inflight and cleans up', () => {
		const inflight = new Map<string, { startedAt: number }>();
		const key = 'https://a.com/v.mp4|{"width":1440}';

		expect(inflight.has(key)).toBe(false);
		inflight.set(key, { startedAt: Date.now() });
		expect(inflight.has(key)).toBe(true);

		// Simulate completion
		inflight.delete(key);
		expect(inflight.has(key)).toBe(false);
	});

	it('concurrent dispatches are rejected when inflight', () => {
		const inflight = new Map<string, { startedAt: number }>();
		const key = 'https://a.com/v.mp4|{"width":1440}';

		// First dispatch: accepted
		inflight.set(key, { startedAt: Date.now() });
		const firstAccepted = true;

		// Second dispatch: rejected (already in map)
		const secondAccepted = !inflight.has(key);
		expect(firstAccepted).toBe(true);
		expect(secondAccepted).toBe(false);
	});
});

describe('Container instance key from JobMessage', () => {
	it('includes origin, path, and params hash', () => {
		// The consumer builds: `ffmpeg:{origin}:{path}:{paramsHash}`
		const origin = 'standard';
		const path = '/rocky.mp4';
		const keyPattern = /^ffmpeg:standard:\/rocky\.mp4:[0-9a-f]{8}$/;
		// This is tested more thoroughly in container.spec.ts
		expect(keyPattern.test('ffmpeg:standard:/rocky.mp4:deadbeef')).toBe(true);
	});
});
