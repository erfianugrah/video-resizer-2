/**
 * Tests for transform/binding error code extraction.
 *
 * The binding throws errors with various shapes — numeric `.code` property
 * (MediaError), "MEDIA_TRANSFORMATION_ERROR {n}" message pattern, or a plain
 * Error. Verify each path produces the right AppError wrapping.
 */
import { describe, it, expect } from 'vitest';
import { transformViaBinding, type MediaBinding } from '../../src/transform/binding';
import { AppError } from '../../src/errors';
import type { TransformParams } from '../../src/params/schema';

/** A MediaBinding that throws a given error on .input(). */
function bindingThatThrows(err: unknown): MediaBinding {
	return {
		input: () => {
			throw err;
		},
	};
}

/** Minimal stream for params — never consumed since binding throws immediately. */
function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
}

const basicParams = { width: 640, height: 360 } as TransformParams;

describe('transformViaBinding error handling', () => {
	it('wraps MediaError with numeric code as AppError MEDIA_ERROR_{code}', async () => {
		const mediaErr = Object.assign(new Error('transform failed'), { code: 9402 });
		const binding = bindingThatThrows(mediaErr);

		await expect(transformViaBinding(binding, emptyStream(), basicParams)).rejects.toThrow(AppError);

		try {
			await transformViaBinding(binding, emptyStream(), basicParams);
		} catch (e) {
			expect(e).toBeInstanceOf(AppError);
			const app = e as AppError;
			expect(app.status).toBe(502);
			expect(app.code).toBe('MEDIA_ERROR_9402');
			expect(app.message).toBe('transform failed');
			expect(app.details?.mediaErrorCode).toBe(9402);
		}
	});

	it('wraps MEDIA_TRANSFORMATION_ERROR message pattern with AppError MEDIA_ERROR_{code}', async () => {
		const msgErr = new Error('MEDIA_TRANSFORMATION_ERROR 415: Unsupported input format');
		const binding = bindingThatThrows(msgErr);

		try {
			await transformViaBinding(binding, emptyStream(), basicParams);
			expect.fail('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(AppError);
			const app = e as AppError;
			expect(app.status).toBe(502);
			expect(app.code).toBe('MEDIA_ERROR_415');
			expect(app.details?.mediaErrorCode).toBe(415);
		}
	});

	it('rethrows plain Error without wrapping if no code or pattern match', async () => {
		const plainErr = new Error('totally unexpected');
		const binding = bindingThatThrows(plainErr);

		try {
			await transformViaBinding(binding, emptyStream(), basicParams);
			expect.fail('should have thrown');
		} catch (e) {
			expect(e).toBe(plainErr);
			expect(e).not.toBeInstanceOf(AppError);
		}
	});

	it('sanitizes params into AppError details (strips undefined)', async () => {
		const mediaErr = Object.assign(new Error('bad'), { code: 400 });
		const binding = bindingThatThrows(mediaErr);
		const paramsWithUndefined = { width: 640, height: undefined, mode: 'video' } as TransformParams;

		try {
			await transformViaBinding(binding, emptyStream(), paramsWithUndefined);
			expect.fail('should have thrown');
		} catch (e) {
			const app = e as AppError;
			expect(app.details?.params).toEqual({ width: 640, mode: 'video' });
		}
	});
});
