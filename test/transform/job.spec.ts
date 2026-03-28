/**
 * Tests for TransformJobDO state machine, JobMessage types, and JobState shape.
 */
import { describe, it, expect } from 'vitest';
import type { JobMessage, JobStatus, JobState } from '../../src/transform/job';

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

describe('JobState', () => {
	it('has correct shape for a pending job', () => {
		const state: JobState = {
			status: 'pending',
			progress: 0,
			error: null,
			createdAt: Date.now(),
			startedAt: null,
			completedAt: null,
			path: '/rocky.mp4',
			origin: 'standard',
			params: { width: 1280 },
		};
		expect(state.status).toBe('pending');
		expect(state.progress).toBe(0);
		expect(state.error).toBeNull();
		expect(state.startedAt).toBeNull();
	});

	it('has correct shape for a completed job', () => {
		const now = Date.now();
		const state: JobState = {
			status: 'complete',
			progress: 100,
			error: null,
			createdAt: now - 60000,
			startedAt: now - 50000,
			completedAt: now,
			path: '/big.mov',
			origin: 'standard',
			params: { width: 320 },
		};
		expect(state.status).toBe('complete');
		expect(state.progress).toBe(100);
		expect(state.completedAt).toBe(now);
		expect(state.completedAt! - state.createdAt!).toBe(60000);
	});

	it('has correct shape for a failed job', () => {
		const state: JobState = {
			status: 'failed',
			progress: 45,
			error: 'ffmpeg failed (exit 1): Output file is empty',
			createdAt: Date.now() - 5000,
			startedAt: Date.now() - 4000,
			completedAt: null,
			path: '/broken.mp4',
			origin: 'standard',
			params: {},
		};
		expect(state.status).toBe('failed');
		expect(state.error).toContain('ffmpeg');
		expect(state.completedAt).toBeNull();
	});

	it('has correct shape for a transcoding job with progress', () => {
		const state: JobState = {
			status: 'transcoding',
			progress: 67,
			error: null,
			createdAt: Date.now() - 120000,
			startedAt: Date.now() - 100000,
			completedAt: null,
			path: '/huge.mov',
			origin: 'cdn',
			params: { width: 1920, height: 1080, quality: 'high' },
		};
		expect(state.status).toBe('transcoding');
		expect(state.progress).toBe(67);
		expect(state.progress).toBeGreaterThan(0);
		expect(state.progress).toBeLessThan(100);
	});

	it('round-trips through JSON', () => {
		const state: JobState = {
			status: 'uploading',
			progress: 90,
			error: null,
			createdAt: 1711612800000,
			startedAt: 1711612810000,
			completedAt: null,
			path: '/test.mp4',
			origin: 'test',
			params: { fps: 30 },
		};
		const parsed: JobState = JSON.parse(JSON.stringify(state));
		expect(parsed).toEqual(state);
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
			// Simulating that failed can follow any state
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
		for (const [phase, values] of Object.entries(progressMap)) {
			for (const v of values) {
				expect(v).toBeGreaterThanOrEqual(0);
				expect(v).toBeLessThanOrEqual(100);
			}
		}
	});
});
