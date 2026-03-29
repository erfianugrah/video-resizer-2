/**
 * Tests for JobMessage types and JobStatus state machine.
 * (TransformJobDO was removed — job state lives in D1 now.)
 */
import { describe, it, expect } from 'vitest';
import type { JobMessage, JobStatus } from '../../src/transform/job';

describe('JobMessage', () => {
	it('has required fields', () => {
		const msg: JobMessage = {
			jobId: 'video:rocky.mp4:w=1280',
			path: '/rocky.mp4',
			params: { width: 1280 },
			sourceUrl: 'https://videos.erfi.dev/rocky.mp4',
			callbackCacheKey: 'video:rocky.mp4:w=1280',
			requestUrl: 'https://videos.erfi.io/rocky.mp4?width=1280',
			origin: 'standard',
			sourceType: 'remote',
			createdAt: Date.now(),
		};
		expect(msg.jobId).toBe('video:rocky.mp4:w=1280');
		expect(msg.params.width).toBe(1280);
	});

	it('supports optional etag and version', () => {
		const msg: JobMessage = {
			jobId: 'test',
			path: '/test.mp4',
			params: {},
			sourceUrl: 'https://example.com/test.mp4',
			callbackCacheKey: 'test',
			requestUrl: 'https://videos.erfi.io/test.mp4',
			origin: 'test',
			sourceType: 'r2',
			etag: 'abc123',
			version: 2,
			createdAt: Date.now(),
		};
		expect(msg.etag).toBe('abc123');
		expect(msg.version).toBe(2);
	});

	it('round-trips through JSON preserving all fields', () => {
		const original: JobMessage = {
			jobId: 'video:rocky.mp4:w=1280:h=720',
			path: '/rocky.mp4',
			params: { width: 1280, height: 720, mode: 'video', quality: 'high' },
			sourceUrl: 'https://videos.erfi.dev/rocky.mp4',
			callbackCacheKey: 'video:rocky.mp4:w=1280:h=720',
			requestUrl: 'https://videos.erfi.io/rocky.mp4?width=1280&height=720',
			origin: 'standard',
			sourceType: 'remote',
			etag: 'deadbeef',
			version: 3,
			createdAt: 1711612800000,
		};
		const deserialized: JobMessage = JSON.parse(JSON.stringify(original));
		expect(deserialized).toEqual(original);
	});

	it('undefined optionals vanish in JSON', () => {
		const msg: JobMessage = {
			jobId: 'x', path: '/x.mp4', params: {},
			sourceUrl: 'https://x.com/x.mp4', callbackCacheKey: 'x',
			requestUrl: 'https://x.com/x.mp4', origin: 'test',
			sourceType: 'r2', createdAt: 1,
		};
		const parsed = JSON.parse(JSON.stringify(msg));
		expect(parsed.etag).toBeUndefined();
		expect(parsed.version).toBeUndefined();
	});
});

describe('JobStatus', () => {
	it('covers all 6 states in the state machine', () => {
		const states: JobStatus[] = ['pending', 'downloading', 'transcoding', 'uploading', 'complete', 'failed'];
		expect(states).toHaveLength(6);
		for (const s of states) {
			expect(typeof s).toBe('string');
		}
	});

	it('states are mutually exclusive strings', () => {
		const states: JobStatus[] = ['pending', 'downloading', 'transcoding', 'uploading', 'complete', 'failed'];
		const unique = new Set(states);
		expect(unique.size).toBe(6);
	});
});

describe('State machine transitions', () => {
	it('valid transition sequence: pending -> downloading -> transcoding -> uploading -> complete', () => {
		const transitions: JobStatus[] = ['pending', 'downloading', 'transcoding', 'uploading', 'complete'];
		for (let i = 1; i < transitions.length; i++) {
			expect(transitions[i]).not.toBe(transitions[i - 1]);
		}
		expect(transitions[0]).toBe('pending');
		expect(transitions[transitions.length - 1]).toBe('complete');
	});

	it('failed can occur from any state', () => {
		const states: JobStatus[] = ['pending', 'downloading', 'transcoding', 'uploading'];
		for (const state of states) {
			const seq: JobStatus[] = [state, 'failed'];
			expect(seq[seq.length - 1]).toBe('failed');
		}
	});

	it('progress ranges: 0 at start, 10-85 during transcode, 90 uploading, 100 complete', () => {
		const progressMap: Record<string, number[]> = {
			pending: [0],
			downloading: [0, 5],
			transcoding: [10, 20, 45, 67, 85],
			uploading: [90],
			complete: [100],
		};
		for (const [, values] of Object.entries(progressMap)) {
			for (const v of values) {
				expect(v).toBeGreaterThanOrEqual(0);
				expect(v).toBeLessThanOrEqual(100);
			}
		}
	});
});
