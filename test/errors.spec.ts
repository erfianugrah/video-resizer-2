import { describe, it, expect } from 'vitest';
import { AppError } from '../src/errors';

describe('AppError', () => {
	it('creates an error with status, code, and message', () => {
		const err = new AppError(404, 'NOT_FOUND', 'Video not found');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(AppError);
		expect(err.status).toBe(404);
		expect(err.code).toBe('NOT_FOUND');
		expect(err.message).toBe('Video not found');
	});

	it('defaults to status 500 for internal errors', () => {
		const err = new AppError(500, 'INTERNAL', 'Something broke');
		expect(err.status).toBe(500);
	});

	it('carries optional details', () => {
		const err = new AppError(400, 'INVALID_PARAMS', 'Bad width', { width: -1 });
		expect(err.details).toEqual({ width: -1 });
	});

	it('has a name of AppError', () => {
		const err = new AppError(500, 'INTERNAL', 'fail');
		expect(err.name).toBe('AppError');
	});

	it('serializes to JSON', () => {
		const err = new AppError(422, 'VALIDATION', 'Invalid', { field: 'width' });
		const json = err.toJSON();
		expect(json).toEqual({
			error: {
				code: 'VALIDATION',
				message: 'Invalid',
				details: { field: 'width' },
			},
		});
	});

	it('serializes without details when none provided', () => {
		const err = new AppError(500, 'INTERNAL', 'fail');
		const json = err.toJSON();
		expect(json).toEqual({
			error: {
				code: 'INTERNAL',
				message: 'fail',
			},
		});
	});
});
