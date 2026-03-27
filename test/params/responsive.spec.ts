import { describe, it, expect } from 'vitest';
import { resolveResponsive } from '../../src/params/responsive';
import type { TransformParams } from '../../src/params/schema';
import type { AppConfig } from '../../src/config/schema';

const responsive: NonNullable<AppConfig['responsive']> = {
	breakpoints: [
		{ maxWidth: 854, derivative: 'mobile' },
		{ maxWidth: 1280, derivative: 'tablet' },
		{ maxWidth: 99999, derivative: 'desktop' },
	],
	defaultDerivative: 'desktop',
};

const derivatives: AppConfig['derivatives'] = {
	mobile: { width: 854, height: 480 },
	tablet: { width: 1280, height: 720 },
	desktop: { width: 1920, height: 1080 },
};

describe('params/responsive', () => {
	it('returns params unchanged when width is already set', () => {
		const params: TransformParams = { width: 640, height: 360 };
		const headers = new Headers();
		const result = resolveResponsive(params, headers, responsive, derivatives);
		expect(result.width).toBe(640);
		expect(result.height).toBe(360);
		expect(result.derivative).toBeUndefined();
	});

	it('returns params unchanged when derivative is already set', () => {
		const params: TransformParams = { derivative: 'tablet' };
		const headers = new Headers();
		const result = resolveResponsive(params, headers, responsive, derivatives);
		expect(result.derivative).toBe('tablet');
	});

	it('uses Sec-CH-Viewport-Width to pick derivative', () => {
		const params: TransformParams = {};
		const headers = new Headers({ 'Sec-CH-Viewport-Width': '1024' });
		const result = resolveResponsive(params, headers, responsive, derivatives);
		// 1024 <= 1280, matches tablet
		expect(result.derivative).toBe('tablet');
	});

	it('uses Width header as fallback', () => {
		const params: TransformParams = {};
		const headers = new Headers({ Width: '800' });
		const result = resolveResponsive(params, headers, responsive, derivatives);
		// 800 <= 854, matches mobile
		expect(result.derivative).toBe('mobile');
	});

	it('uses CF-Device-Type header', () => {
		const params: TransformParams = {};
		const headers = new Headers({ 'CF-Device-Type': 'mobile' });
		const result = resolveResponsive(params, headers, responsive, derivatives);
		expect(result.derivative).toBe('mobile');
	});

	it('uses CF-Device-Type tablet', () => {
		const params: TransformParams = {};
		const headers = new Headers({ 'CF-Device-Type': 'tablet' });
		const result = resolveResponsive(params, headers, responsive, derivatives);
		expect(result.derivative).toBe('tablet');
	});

	it('defaults to desktop for CF-Device-Type desktop', () => {
		const params: TransformParams = {};
		const headers = new Headers({ 'CF-Device-Type': 'desktop' });
		const result = resolveResponsive(params, headers, responsive, derivatives);
		expect(result.derivative).toBe('desktop');
	});

	it('falls back to defaultDerivative when no hints available', () => {
		const params: TransformParams = {};
		const headers = new Headers();
		const result = resolveResponsive(params, headers, responsive, derivatives);
		expect(result.derivative).toBe('desktop');
	});

	it('returns params unchanged when responsive config is not provided', () => {
		const params: TransformParams = {};
		const headers = new Headers({ 'Sec-CH-Viewport-Width': '800' });
		const result = resolveResponsive(params, headers, undefined, derivatives);
		expect(result.derivative).toBeUndefined();
		expect(result.width).toBeUndefined();
	});

	it('applies DPR scaling to viewport width for breakpoint matching', () => {
		const params: TransformParams = { dpr: 2 };
		const headers = new Headers({ 'Sec-CH-Viewport-Width': '400' });
		// Effective width = 400 * 2 = 800, <= 854 matches mobile
		const result = resolveResponsive(params, headers, responsive, derivatives);
		expect(result.derivative).toBe('mobile');
	});

	it('uses Sec-CH-DPR header when dpr param not set', () => {
		const params: TransformParams = {};
		const headers = new Headers({ 'Sec-CH-Viewport-Width': '400', 'Sec-CH-DPR': '2' });
		// Effective width = 400 * 2 = 800, <= 854 matches mobile
		const result = resolveResponsive(params, headers, responsive, derivatives);
		expect(result.derivative).toBe('mobile');
	});
});
