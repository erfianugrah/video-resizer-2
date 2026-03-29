import { describe, it, expect } from 'vitest';
import { buildCacheKey } from '../../src/cache/key';
import type { TransformParams } from '../../src/params/schema';

describe('cache/key', () => {
	it('builds a key from path and dimensions', () => {
		const params: TransformParams = { width: 640, height: 360 };
		const key = buildCacheKey('/videos/test.mp4', params);
		expect(key).toBe('video:videos/test.mp4:w=640:h=360');
	});

	it('strips leading slashes from path', () => {
		const params: TransformParams = { width: 640 };
		const key = buildCacheKey('///videos/test.mp4', params);
		expect(key).toBe('video:videos/test.mp4:w=640');
	});

	it('includes mode when not video', () => {
		const params: TransformParams = { mode: 'frame', width: 320, height: 180, time: '2s', format: 'jpg' };
		const key = buildCacheKey('/test.mp4', params);
		expect(key).toBe('frame:test.mp4:w=320:h=180:t=2s:f=jpg');
	});

	it('includes video-specific params', () => {
		const params: TransformParams = { width: 1280, height: 720, quality: 'medium', compression: 'auto' };
		const key = buildCacheKey('/test.mp4', params);
		expect(key).toBe('video:test.mp4:w=1280:h=720:q=medium:c=auto');
	});

	it('includes spritesheet params', () => {
		const params: TransformParams = { mode: 'spritesheet', width: 640, time: '0s', duration: '10s' };
		const key = buildCacheKey('/test.mp4', params);
		expect(key).toBe('spritesheet:test.mp4:w=640:t=0s:d=10s');
	});

	it('includes audio params', () => {
		const params: TransformParams = { mode: 'audio', time: '0s', duration: '30s' };
		const key = buildCacheKey('/test.mp4', params);
		expect(key).toBe('audio:test.mp4:t=0s:d=30s');
	});

	it('omits undefined fields', () => {
		const params: TransformParams = { width: 640 };
		const key = buildCacheKey('/test.mp4', params);
		expect(key).toBe('video:test.mp4:w=640');
	});

	it('produces identical keys for the same inputs', () => {
		const params: TransformParams = { width: 1280, height: 720, derivative: 'tablet', compression: 'auto' };
		const key1 = buildCacheKey('/big_buck_bunny.mov', params);
		const key2 = buildCacheKey('/big_buck_bunny.mov', params);
		expect(key1).toBe(key2);
	});

	it('ignores derivative name in key (dimensions are canonical)', () => {
		// The derivative name is NOT part of the key — only the resolved
		// dimensions matter. This ensures ?derivative=tablet and
		// ?width=1280&height=720 produce the same key.
		const withDerivative: TransformParams = { width: 1280, height: 720, derivative: 'tablet' };
		const withoutDerivative: TransformParams = { width: 1280, height: 720 };
		expect(buildCacheKey('/test.mp4', withDerivative)).toBe(buildCacheKey('/test.mp4', withoutDerivative));
	});

	it('appends version when provided', () => {
		const params: TransformParams = { width: 640 };
		const key = buildCacheKey('/test.mp4', params, 3);
		expect(key).toBe('video:test.mp4:w=640:v=3');
	});

	it('sanitizes spaces and special chars in path', () => {
		const params: TransformParams = { width: 640 };
		const key = buildCacheKey('/my videos/test file.mp4', params);
		expect(key).toMatch(/^video:my-videos\/test-file\.mp4:w=640$/);
	});

	it('appends etag prefix when provided', () => {
		const params: TransformParams = { width: 640 };
		const key = buildCacheKey('/test.mp4', params, undefined, 'abcdef1234567890');
		expect(key).toBe('video:test.mp4:w=640:e=abcdef12');
	});

	it('different etags produce different keys', () => {
		const params: TransformParams = { width: 640 };
		const key1 = buildCacheKey('/test.mp4', params, undefined, 'aaaa1111');
		const key2 = buildCacheKey('/test.mp4', params, undefined, 'bbbb2222');
		expect(key1).not.toBe(key2);
	});

	it('includes both etag and version when provided', () => {
		const params: TransformParams = { width: 640 };
		const key = buildCacheKey('/test.mp4', params, 5, 'abcdef12');
		expect(key).toBe('video:test.mp4:w=640:e=abcdef12:v=5');
	});

	it('includes imageCount in spritesheet cache key', () => {
		const params: TransformParams = { mode: 'spritesheet', width: 640, time: '0s', duration: '10s', imageCount: 5 };
		const key = buildCacheKey('/test.mp4', params);
		expect(key).toBe('spritesheet:test.mp4:w=640:t=0s:d=10s:ic=5');
	});

	it('different imageCount produces different spritesheet cache keys', () => {
		const params5: TransformParams = { mode: 'spritesheet', width: 640, imageCount: 5 };
		const params10: TransformParams = { mode: 'spritesheet', width: 640, imageCount: 10 };
		expect(buildCacheKey('/test.mp4', params5)).not.toBe(buildCacheKey('/test.mp4', params10));
	});

	// Fix 1: video mode must include time, duration, fit, audio
	it('includes time and duration in video mode cache key', () => {
		const params: TransformParams = { width: 1280, time: '5s', duration: '10s' };
		const key = buildCacheKey('/test.mp4', params);
		expect(key).toContain(':t=5s');
		expect(key).toContain(':d=10s');
	});

	it('different time values produce different video cache keys', () => {
		const a: TransformParams = { width: 640, time: '5s' };
		const b: TransformParams = { width: 640, time: '30s' };
		expect(buildCacheKey('/test.mp4', a)).not.toBe(buildCacheKey('/test.mp4', b));
	});

	it('different duration values produce different video cache keys', () => {
		const a: TransformParams = { width: 640, duration: '5s' };
		const b: TransformParams = { width: 640, duration: '30s' };
		expect(buildCacheKey('/test.mp4', a)).not.toBe(buildCacheKey('/test.mp4', b));
	});

	it('includes fit in video mode cache key', () => {
		const params: TransformParams = { width: 1280, height: 720, fit: 'cover' };
		const key = buildCacheKey('/test.mp4', params);
		expect(key).toContain(':fit=cover');
	});

	it('different fit values produce different video cache keys', () => {
		const a: TransformParams = { width: 1280, height: 720, fit: 'cover' };
		const b: TransformParams = { width: 1280, height: 720, fit: 'contain' };
		expect(buildCacheKey('/test.mp4', a)).not.toBe(buildCacheKey('/test.mp4', b));
	});

	it('includes audio in video mode cache key', () => {
		const withAudio: TransformParams = { width: 640, audio: true };
		const noAudio: TransformParams = { width: 640, audio: false };
		expect(buildCacheKey('/test.mp4', withAudio)).toContain(':a=true');
		expect(buildCacheKey('/test.mp4', noAudio)).toContain(':a=false');
		expect(buildCacheKey('/test.mp4', withAudio)).not.toBe(buildCacheKey('/test.mp4', noAudio));
	});

	it('includes fit in frame mode cache key', () => {
		const params: TransformParams = { mode: 'frame', width: 320, time: '2s', format: 'jpg', fit: 'cover' };
		const key = buildCacheKey('/test.mp4', params);
		expect(key).toContain(':fit=cover');
	});

	it('includes fit in spritesheet mode cache key', () => {
		const params: TransformParams = { mode: 'spritesheet', width: 640, time: '0s', duration: '10s', fit: 'cover' };
		const key = buildCacheKey('/test.mp4', params);
		expect(key).toContain(':fit=cover');
	});
});
