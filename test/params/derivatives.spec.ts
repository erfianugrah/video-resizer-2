import { describe, it, expect } from 'vitest';
import { resolveDerivative } from '../../src/params/derivatives';
import type { TransformParams } from '../../src/params/schema';
import type { AppConfig } from '../../src/config/schema';

const derivatives: AppConfig['derivatives'] = {
	mobile: { width: 854, height: 480, quality: 'low' },
	tablet: { width: 1280, height: 720, quality: 'medium' },
	desktop: { width: 1920, height: 1080, quality: 'high' },
	thumbnail: { width: 320, height: 180, mode: 'frame', format: 'jpg', time: '2s' },
};

describe('params/derivatives', () => {
	it('applies derivative dimensions and properties', () => {
		const params: TransformParams = { derivative: 'tablet' };
		const resolved = resolveDerivative(params, derivatives);
		expect(resolved.width).toBe(1280);
		expect(resolved.height).toBe(720);
		expect(resolved.quality).toBe('medium');
		expect(resolved.derivative).toBe('tablet');
	});

	it('returns params unchanged when no derivative specified', () => {
		const params: TransformParams = { width: 640, height: 360 };
		const resolved = resolveDerivative(params, derivatives);
		expect(resolved.width).toBe(640);
		expect(resolved.height).toBe(360);
		expect(resolved.derivative).toBeUndefined();
	});

	it('returns params unchanged when derivative not found', () => {
		const params: TransformParams = { derivative: 'nonexistent', width: 640 };
		const resolved = resolveDerivative(params, derivatives);
		expect(resolved.width).toBe(640);
		// Unknown derivative is cleared
		expect(resolved.derivative).toBeUndefined();
	});

	it('derivative properties override explicit params', () => {
		// If you ask for ?derivative=tablet&width=1080, the derivative wins.
		// This is THE fix for the v1 KV key mismatch bug.
		const params: TransformParams = { derivative: 'tablet', width: 1080 };
		const resolved = resolveDerivative(params, derivatives);
		expect(resolved.width).toBe(1280);
		expect(resolved.height).toBe(720);
	});

	it('applies mode override from derivative', () => {
		const params: TransformParams = { derivative: 'thumbnail' };
		const resolved = resolveDerivative(params, derivatives);
		expect(resolved.mode).toBe('frame');
		expect(resolved.format).toBe('jpg');
		expect(resolved.time).toBe('2s');
		expect(resolved.width).toBe(320);
		expect(resolved.height).toBe(180);
	});

	it('preserves params not defined in derivative', () => {
		const params: TransformParams = { derivative: 'mobile', filename: 'clip', time: '5s' };
		const resolved = resolveDerivative(params, derivatives);
		expect(resolved.filename).toBe('clip');
		// time is not set in mobile derivative, so explicit value survives
		expect(resolved.time).toBe('5s');
		expect(resolved.width).toBe(854);
	});
});
