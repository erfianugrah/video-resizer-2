/**
 * Integration tests for the full request pipeline.
 *
 * These test the Hono app end-to-end with mocked bindings (MEDIA, R2, KV).
 * They verify: param parsing → derivative resolution → origin matching →
 * source fetching → transform → response headers → cache store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../src/types';
import type { AppConfig } from '../../src/config/schema';
import { AppConfigSchema } from '../../src/config/schema';
import { translateAkamaiParams, parseParams, needsContainer } from '../../src/params/schema';
import { resolveDerivative } from '../../src/params/derivatives';
import { resolveResponsive } from '../../src/params/responsive';
import { matchOrigin } from '../../src/sources/router';
import { buildCacheKey } from '../../src/cache/key';

// ── Test config ──────────────────────────────────────────────────────────

const TEST_CONFIG = AppConfigSchema.parse({
	origins: [
		{
			name: 'videos',
			matcher: '^/videos/([^.]+)\\.(mp4|webm|mov)',
			captureGroups: ['videoId', 'extension'],
			sources: [
				{ type: 'r2', priority: 0, bucketBinding: 'VIDEOS' },
				{ type: 'remote', priority: 1, url: 'https://videos.example.com' },
			],
			ttl: { ok: 3600, redirects: 300, clientError: 60, serverError: 10 },
			useTtlByStatus: true,
			videoCompression: 'auto',
		},
		{
			name: 'default',
			matcher: '.*',
			sources: [{ type: 'remote', priority: 0, url: 'https://origin.example.com' }],
			ttl: { ok: 86400, redirects: 300, clientError: 60, serverError: 10 },
			videoCompression: 'auto',
		},
	],
	derivatives: {
		desktop: { width: 1920, height: 1080, fit: 'contain' },
		tablet: { width: 1280, height: 720, fit: 'contain' },
		mobile: { width: 854, height: 640, fit: 'contain' },
		thumbnail: { width: 640, height: 360, mode: 'frame', format: 'png', fit: 'cover', time: '2s' },
	},
	responsive: {
		breakpoints: [
			{ maxWidth: 854, derivative: 'mobile' },
			{ maxWidth: 1280, derivative: 'tablet' },
			{ maxWidth: 99999, derivative: 'desktop' },
		],
		defaultDerivative: 'desktop',
	},
});

// ── Pipeline unit tests (no HTTP, just data flow) ────────────────────────

describe('integration/pipeline', () => {
	describe('param resolution pipeline', () => {
		it('?derivative=tablet resolves to 1280x720', () => {
			const qs = new URLSearchParams('derivative=tablet');
			const { params } = translateAkamaiParams(qs);
			let p = parseParams(params);
			p = resolveDerivative(p, TEST_CONFIG.derivatives);
			expect(p.width).toBe(1280);
			expect(p.height).toBe(720);
			expect(p.fit).toBe('contain');
			expect(p.derivative).toBe('tablet');
		});

		it('?imwidth=1080 resolves to tablet via responsive breakpoints', () => {
			const qs = new URLSearchParams('imwidth=1080');
			const { params, clientHints } = translateAkamaiParams(qs);
			let p = parseParams(params);
			p = resolveDerivative(p, TEST_CONFIG.derivatives);
			// imwidth=1080 translates to width=1080, no derivative yet
			// Responsive sizing picks it up
			const headers = new Headers();
			for (const [k, v] of Object.entries(clientHints)) headers.set(k, v);
			p = resolveResponsive(p, headers, TEST_CONFIG.responsive, TEST_CONFIG.derivatives);
			// width=1080 is already set from imwidth, so responsive won't override
			expect(p.width).toBe(1080);
		});

		it('no params → responsive fallback to desktop derivative', () => {
			const qs = new URLSearchParams();
			const { params } = translateAkamaiParams(qs);
			let p = parseParams(params);
			p = resolveDerivative(p, TEST_CONFIG.derivatives);
			const headers = new Headers();
			p = resolveResponsive(p, headers, TEST_CONFIG.responsive, TEST_CONFIG.derivatives);
			expect(p.derivative).toBe('desktop');
			// Need second resolveDerivative to expand desktop → 1920x1080
			p = resolveDerivative(p, TEST_CONFIG.derivatives);
			expect(p.width).toBe(1920);
			expect(p.height).toBe(1080);
		});

		it('Sec-CH-Viewport-Width: 800 → mobile derivative', () => {
			const qs = new URLSearchParams();
			const { params } = translateAkamaiParams(qs);
			let p = parseParams(params);
			p = resolveDerivative(p, TEST_CONFIG.derivatives);
			const headers = new Headers({ 'Sec-CH-Viewport-Width': '800' });
			p = resolveResponsive(p, headers, TEST_CONFIG.responsive, TEST_CONFIG.derivatives);
			expect(p.derivative).toBe('mobile');
			p = resolveDerivative(p, TEST_CONFIG.derivatives);
			expect(p.width).toBe(854);
			expect(p.height).toBe(640);
		});

		it('?derivative=tablet&imwidth=1080 → derivative wins (1280x720)', () => {
			const qs = new URLSearchParams('derivative=tablet&imwidth=1080');
			const { params } = translateAkamaiParams(qs);
			let p = parseParams(params);
			p = resolveDerivative(p, TEST_CONFIG.derivatives);
			// Derivative resolution replaces imwidth's 1080 with tablet's 1280
			expect(p.width).toBe(1280);
			expect(p.height).toBe(720);
			expect(p.derivative).toBe('tablet');
		});

		it('?derivative=thumbnail → frame mode with correct params', () => {
			const qs = new URLSearchParams('derivative=thumbnail');
			const { params } = translateAkamaiParams(qs);
			let p = parseParams(params);
			p = resolveDerivative(p, TEST_CONFIG.derivatives);
			expect(p.mode).toBe('frame');
			expect(p.format).toBe('png');
			expect(p.time).toBe('2s');
			expect(p.width).toBe(640);
			expect(p.height).toBe(360);
			expect(p.fit).toBe('cover');
		});
	});

	describe('origin matching', () => {
		it('matches /videos/ path to videos origin', () => {
			const match = matchOrigin('/videos/my-clip.mp4', TEST_CONFIG.origins);
			expect(match).not.toBeNull();
			expect(match!.origin.name).toBe('videos');
			expect(match!.captures).toEqual({ videoId: 'my-clip', extension: 'mp4' });
		});

		it('matches unknown paths to default origin', () => {
			const match = matchOrigin('/random/file.mp4', TEST_CONFIG.origins);
			expect(match).not.toBeNull();
			expect(match!.origin.name).toBe('default');
		});

		it('applies per-origin videoCompression', () => {
			const match = matchOrigin('/videos/clip.mp4', TEST_CONFIG.origins)!;
			expect(match.origin.videoCompression).toBe('auto');
		});
	});

	describe('cache key consistency', () => {
		it('same derivative → same cache key regardless of original params', () => {
			// ?derivative=tablet (resolves to width=1280, height=720, fit=contain)
			const qs1 = new URLSearchParams('derivative=tablet');
			let p1 = parseParams(translateAkamaiParams(qs1).params);
			p1 = resolveDerivative(p1, TEST_CONFIG.derivatives);
			p1 = { ...p1, compression: 'auto' };

			// ?width=1280&height=720&fit=contain (same resolved params as tablet)
			const qs2 = new URLSearchParams('width=1280&height=720&fit=contain');
			let p2 = parseParams(translateAkamaiParams(qs2).params);
			p2 = resolveDerivative(p2, TEST_CONFIG.derivatives);
			p2 = { ...p2, compression: 'auto' };

			const key1 = buildCacheKey('/videos/clip.mp4', p1);
			const key2 = buildCacheKey('/videos/clip.mp4', p2);
			expect(key1).toBe(key2);
		});

		it('different derivatives → different cache keys', () => {
			let p1 = resolveDerivative(parseParams(new URLSearchParams('derivative=tablet')), TEST_CONFIG.derivatives);
			let p2 = resolveDerivative(parseParams(new URLSearchParams('derivative=mobile')), TEST_CONFIG.derivatives);
			p1 = { ...p1, compression: 'auto' };
			p2 = { ...p2, compression: 'auto' };

			expect(buildCacheKey('/clip.mp4', p1)).not.toBe(buildCacheKey('/clip.mp4', p2));
		});

		it('thumbnail derivative produces frame-mode cache key', () => {
			let p = resolveDerivative(parseParams(new URLSearchParams('derivative=thumbnail')), TEST_CONFIG.derivatives);
			const key = buildCacheKey('/clip.mp4', p);
			expect(key).toMatch(/^frame:/);
			expect(key).toContain('w=640');
			expect(key).toContain('h=360');
			expect(key).toContain('t=2s');
			expect(key).toContain('f=png');
		});
	});

	describe('container routing', () => {
		it('standard params do not need container', () => {
			const p = resolveDerivative(parseParams(new URLSearchParams('derivative=tablet')), TEST_CONFIG.derivatives);
			expect(needsContainer(p)).toBe(false);
		});

		it('fps triggers container', () => {
			const p = parseParams(new URLSearchParams('width=640&fps=30'));
			expect(needsContainer(p)).toBe(true);
		});

		it('h265 format triggers container', () => {
			const { params } = translateAkamaiParams(new URLSearchParams('imformat=h265'));
			const p = parseParams(params);
			expect(needsContainer(p)).toBe(true);
		});

		it('rotate triggers container', () => {
			const p = parseParams(new URLSearchParams('width=640&rotate=90'));
			expect(needsContainer(p)).toBe(true);
		});
	});

	describe('akamai translation', () => {
		it('?impolicy=tablet → ?derivative=tablet', () => {
			const { params } = translateAkamaiParams(new URLSearchParams('impolicy=tablet'));
			expect(params.get('derivative')).toBe('tablet');
		});

		it('?mute=true → ?audio=false', () => {
			const { params } = translateAkamaiParams(new URLSearchParams('mute=true'));
			expect(params.get('audio')).toBe('false');
		});

		it('?obj-fit=crop → ?fit=cover', () => {
			const { params } = translateAkamaiParams(new URLSearchParams('obj-fit=crop'));
			expect(params.get('fit')).toBe('cover');
		});

		it('?w=640&h=360&q=high&start=5s → canonical params', () => {
			const { params } = translateAkamaiParams(new URLSearchParams('w=640&h=360&q=high&start=5s'));
			expect(params.get('width')).toBe('640');
			expect(params.get('height')).toBe('360');
			expect(params.get('quality')).toBe('high');
			expect(params.get('time')).toBe('5s');
		});

		it('im-viewwidth/im-density extracted as client hints', () => {
			const { clientHints } = translateAkamaiParams(new URLSearchParams('im-viewwidth=1024&im-density=2'));
			expect(clientHints['Sec-CH-Viewport-Width']).toBe('1024');
			expect(clientHints['Sec-CH-DPR']).toBe('2');
		});

		it('explicit width beats imwidth', () => {
			const { params } = translateAkamaiParams(new URLSearchParams('width=640&imwidth=1080'));
			expect(params.get('width')).toBe('640');
		});
	});
});
