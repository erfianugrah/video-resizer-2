import { describe, it, expect, vi } from 'vitest';
import { applyAuth } from '../../src/sources/auth';

describe('sources/auth', () => {
	describe('bearer', () => {
		it('adds Authorization header with bearer token from env', async () => {
			const url = 'https://example.com/video.mp4';
			const env = { MY_TOKEN: 'secret-token-123' } as Record<string, unknown>;
			const auth = { type: 'bearer' as const, tokenVar: 'MY_TOKEN' };

			const req = await applyAuth(url, auth, env);
			expect(req.headers.get('Authorization')).toBe('Bearer secret-token-123');
			expect(req.url).toBe(url);
		});

		it('throws if token var not found in env', async () => {
			const env = {} as Record<string, unknown>;
			const auth = { type: 'bearer' as const, tokenVar: 'MISSING' };
			await expect(applyAuth('https://example.com/video.mp4', auth, env)).rejects.toThrow('MISSING');
		});
	});

	describe('header', () => {
		it('adds custom headers', async () => {
			const url = 'https://example.com/video.mp4';
			const env = {} as Record<string, unknown>;
			const auth = { type: 'header' as const, headers: { 'X-API-Key': 'key123', 'X-Custom': 'val' } };

			const req = await applyAuth(url, auth, env);
			expect(req.headers.get('X-API-Key')).toBe('key123');
			expect(req.headers.get('X-Custom')).toBe('val');
		});
	});

	describe('aws-s3', () => {
		it('creates a signed request', async () => {
			const url = 'https://my-bucket.s3.us-east-1.amazonaws.com/video.mp4';
			const env = {
				AWS_KEY: 'AKIAIOSFODNN7EXAMPLE',
				AWS_SECRET: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
			} as Record<string, unknown>;
			const auth = {
				type: 'aws-s3' as const,
				accessKeyVar: 'AWS_KEY',
				secretKeyVar: 'AWS_SECRET',
				region: 'us-east-1',
			};

			const req = await applyAuth(url, auth, env);
			// aws4fetch adds Authorization header with AWS Signature V4
			expect(req.headers.get('Authorization')).toContain('AWS4-HMAC-SHA256');
			expect(req.headers.get('x-amz-date')).toBeTruthy();
		});

		it('throws if access key var missing', async () => {
			const env = { AWS_SECRET: 'secret' } as Record<string, unknown>;
			const auth = {
				type: 'aws-s3' as const,
				accessKeyVar: 'MISSING_KEY',
				secretKeyVar: 'AWS_SECRET',
				region: 'us-east-1',
			};
			await expect(applyAuth('https://example.com/v.mp4', auth, env)).rejects.toThrow('MISSING_KEY');
		});
	});

	describe('no auth', () => {
		it('returns plain request when auth is undefined', async () => {
			const req = await applyAuth('https://example.com/video.mp4', undefined, {});
			expect(req.headers.get('Authorization')).toBeNull();
		});
	});
});
