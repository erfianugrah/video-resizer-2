/**
 * Tests for container instance key generation.
 *
 * Verifies that different transform params produce different DO instance keys
 * (preventing the collision bug where concurrent transforms of the same file
 * with different params would share a single container instance).
 */
import { describe, it, expect } from 'vitest';
import { buildContainerInstanceKey } from '../../src/transform/container';
import { parseParams } from '../../src/params/schema';

describe('buildContainerInstanceKey', () => {
	const origin = 'standard';
	const path = '/rocky.mp4';

	it('includes origin, path, and hash', () => {
		const params = parseParams(new URLSearchParams('width=1280'));
		const key = buildContainerInstanceKey(origin, path, params);
		expect(key).toMatch(/^ffmpeg:standard:\/rocky\.mp4:[0-9a-f]{8}$/);
	});

	it('same params produce same key', () => {
		const p1 = parseParams(new URLSearchParams('width=1280&height=720'));
		const p2 = parseParams(new URLSearchParams('width=1280&height=720'));
		expect(buildContainerInstanceKey(origin, path, p1)).toBe(
			buildContainerInstanceKey(origin, path, p2),
		);
	});

	it('different width produces different key', () => {
		const p1 = parseParams(new URLSearchParams('width=1280'));
		const p2 = parseParams(new URLSearchParams('width=640'));
		expect(buildContainerInstanceKey(origin, path, p1)).not.toBe(
			buildContainerInstanceKey(origin, path, p2),
		);
	});

	it('different mode produces different key', () => {
		const p1 = parseParams(new URLSearchParams('mode=video&width=1280'));
		const p2 = parseParams(new URLSearchParams('mode=frame&width=1280'));
		expect(buildContainerInstanceKey(origin, path, p1)).not.toBe(
			buildContainerInstanceKey(origin, path, p2),
		);
	});

	it('different fps produces different key', () => {
		const p1 = parseParams(new URLSearchParams('fps=24'));
		const p2 = parseParams(new URLSearchParams('fps=30'));
		expect(buildContainerInstanceKey(origin, path, p1)).not.toBe(
			buildContainerInstanceKey(origin, path, p2),
		);
	});

	it('different duration produces different key', () => {
		const p1 = parseParams(new URLSearchParams('duration=5s'));
		const p2 = parseParams(new URLSearchParams('duration=10s'));
		expect(buildContainerInstanceKey(origin, path, p1)).not.toBe(
			buildContainerInstanceKey(origin, path, p2),
		);
	});

	it('ignores non-transform params (filename, derivative name, playback hints)', () => {
		const p1 = parseParams(new URLSearchParams('width=1280&filename=clip'));
		const p2 = parseParams(new URLSearchParams('width=1280&filename=video'));
		// filename is not a transform param, but it's not in the hash either
		// so both should produce the same key (only transform-affecting params matter)
		const key1 = buildContainerInstanceKey(origin, path, p1);
		const key2 = buildContainerInstanceKey(origin, path, p2);
		expect(key1).toBe(key2);
	});

	it('different origin produces different key', () => {
		const params = parseParams(new URLSearchParams('width=1280'));
		expect(buildContainerInstanceKey('origin-a', path, params)).not.toBe(
			buildContainerInstanceKey('origin-b', path, params),
		);
	});

	it('different path produces different key', () => {
		const params = parseParams(new URLSearchParams('width=1280'));
		expect(buildContainerInstanceKey(origin, '/a.mp4', params)).not.toBe(
			buildContainerInstanceKey(origin, '/b.mp4', params),
		);
	});
});
