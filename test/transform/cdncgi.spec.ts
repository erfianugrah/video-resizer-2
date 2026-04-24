/**
 * Tests for cdn-cgi/media URL construction.
 * Pure string-building functions — no Hono, no bindings needed.
 */
import { describe, it, expect } from 'vitest';
import { buildCdnCgiUrl, addVersionToSourceUrl } from '../../src/transform/cdncgi';
import type { TransformParams } from '../../src/params/schema';

const zoneHost = 'videos.erfi.io';
const source = 'https://cdn.example.com/video.mp4';

describe('addVersionToSourceUrl', () => {
	it('returns source unchanged when version is undefined', () => {
		expect(addVersionToSourceUrl(source)).toBe(source);
	});

	it('returns source unchanged when version is 1', () => {
		expect(addVersionToSourceUrl(source, 1)).toBe(source);
	});

	it('returns source unchanged when version is 0', () => {
		expect(addVersionToSourceUrl(source, 0)).toBe(source);
	});

	it('appends v param when version > 1', () => {
		const result = addVersionToSourceUrl(source, 2);
		expect(result).toBe('https://cdn.example.com/video.mp4?v=2');
	});

	it('adds v to existing query params', () => {
		const result = addVersionToSourceUrl('https://cdn.example.com/video.mp4?foo=bar', 3);
		// URL normalization may reorder — just assert both params present
		expect(result).toContain('foo=bar');
		expect(result).toContain('v=3');
	});

	it('preserves presigned AWS URLs unchanged', () => {
		const presigned = 'https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc123&X-Amz-Expires=3600';
		expect(addVersionToSourceUrl(presigned, 5)).toBe(presigned);
	});

	it('falls back gracefully for unparseable URLs', () => {
		// URL constructor accepts most things; test manual-append path via edge case
		const weird = 'not-a-url';
		const result = addVersionToSourceUrl(weird, 2);
		expect(result).toContain('v=2');
	});
});

describe('buildCdnCgiUrl', () => {
	it('builds URL with no params', () => {
		const url = buildCdnCgiUrl(zoneHost, source, {} as TransformParams);
		expect(url).toBe('https://videos.erfi.io/cdn-cgi/media//https://cdn.example.com/video.mp4');
	});

	it('includes width and height', () => {
		const url = buildCdnCgiUrl(zoneHost, source, { width: 1280, height: 720 } as TransformParams);
		expect(url).toContain('width=1280');
		expect(url).toContain('height=720');
	});

	it('includes mode', () => {
		const url = buildCdnCgiUrl(zoneHost, source, { mode: 'frame' } as TransformParams);
		expect(url).toContain('mode=frame');
	});

	it('joins options with comma', () => {
		const url = buildCdnCgiUrl(zoneHost, source, {
			width: 640,
			height: 360,
			fit: 'contain',
		} as TransformParams);
		// Extract the options segment: /cdn-cgi/media/{options}/{source}
		const match = url.match(/\/cdn-cgi\/media\/([^/]*)\//);
		expect(match).not.toBeNull();
		const opts = match![1];
		expect(opts.split(',').sort()).toEqual(['fit=contain', 'height=360', 'width=640']);
	});

	it('appends version to source URL when > 1', () => {
		const url = buildCdnCgiUrl(zoneHost, source, {} as TransformParams, 3);
		expect(url).toContain('v=3');
	});

	it('does not append version when 1 or undefined', () => {
		const url = buildCdnCgiUrl(zoneHost, source, {} as TransformParams, 1);
		expect(url).not.toContain('v=1');
	});

	it('includes time, duration, format for frame/spritesheet modes', () => {
		const url = buildCdnCgiUrl(zoneHost, source, {
			mode: 'frame',
			time: '5s',
			format: 'jpg',
		} as TransformParams);
		expect(url).toContain('mode=frame');
		expect(url).toContain('time=5s');
		expect(url).toContain('format=jpg');
	});

	it('serializes audio=false explicitly', () => {
		const url = buildCdnCgiUrl(zoneHost, source, { audio: false } as TransformParams);
		expect(url).toContain('audio=false');
	});
});
