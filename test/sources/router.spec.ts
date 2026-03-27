import { describe, it, expect } from 'vitest';
import { matchOrigin, resolveSourcePath } from '../../src/sources/router';
import type { Origin } from '../../src/config/schema';

const origins: Origin[] = [
	{
		name: 'videos',
		matcher: '^/videos/([a-zA-Z0-9-_]+)(?:\\.(mp4|webm|mov))?$',
		captureGroups: ['id', 'ext'],
		sources: [
			{ type: 'r2', bucketBinding: 'VIDEOS', priority: 0 },
			{ type: 'remote', url: 'https://cdn.example.com', priority: 1 },
		],
	},
	{
		name: 'standard',
		matcher: '.*',
		sources: [{ type: 'remote', url: 'https://origin.example.com', priority: 0 }],
	},
];

describe('sources/router', () => {
	describe('matchOrigin', () => {
		it('matches first origin by regex', () => {
			const match = matchOrigin('/videos/my-clip.mp4', origins);
			expect(match).not.toBeNull();
			expect(match!.origin.name).toBe('videos');
			expect(match!.captures).toEqual({ id: 'my-clip', ext: 'mp4' });
		});

		it('matches catch-all when specific patterns fail', () => {
			const match = matchOrigin('/other/path.mp4', origins);
			expect(match).not.toBeNull();
			expect(match!.origin.name).toBe('standard');
		});

		it('returns null when no origins match', () => {
			const match = matchOrigin('/test', [
				{ name: 'specific', matcher: '^/videos/', sources: [{ type: 'remote', url: 'https://x.com', priority: 0 }] },
			]);
			expect(match).toBeNull();
		});

		it('extracts named capture groups', () => {
			const match = matchOrigin('/videos/abc123.mov', origins);
			expect(match!.captures).toEqual({ id: 'abc123', ext: 'mov' });
		});

		it('handles paths without extension', () => {
			const match = matchOrigin('/videos/abc123', origins);
			expect(match!.origin.name).toBe('videos');
			expect(match!.captures.id).toBe('abc123');
		});
	});

	describe('resolveSourcePath', () => {
		it('builds remote URL from origin source URL + path', () => {
			const source = { type: 'remote' as const, url: 'https://cdn.example.com', priority: 0 };
			const result = resolveSourcePath(source, '/videos/my-clip.mp4', {});
			expect(result).toBe('https://cdn.example.com/videos/my-clip.mp4');
		});

		it('uses path directly for R2 sources (strips leading slash)', () => {
			const source = { type: 'r2' as const, bucketBinding: 'VIDEOS', priority: 0 };
			const result = resolveSourcePath(source, '/videos/my-clip.mp4', {});
			expect(result).toBe('videos/my-clip.mp4');
		});

		it('substitutes capture groups in URL templates', () => {
			const source = { type: 'remote' as const, url: 'https://cdn.example.com/media/$1', priority: 0 };
			const result = resolveSourcePath(source, '/videos/my-clip.mp4', { id: 'my-clip', ext: 'mp4' });
			expect(result).toBe('https://cdn.example.com/media/my-clip');
		});
	});
});
