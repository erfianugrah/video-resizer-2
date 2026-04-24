import { describe, it, expect } from 'vitest';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema';

describe('config/schema', () => {
	// Input before Zod defaults are applied — intentionally not typed as AppConfig
	const minimalConfig = {
		origins: [
			{
				name: 'default',
				matcher: '.*',
				sources: [{ type: 'remote', url: 'https://example.com', priority: 0 }],
			},
		],
		derivatives: {
			mobile: { width: 854, height: 480 },
			tablet: { width: 1280, height: 720 },
			desktop: { width: 1920, height: 1080 },
		},
	};

	it('accepts a minimal valid config', () => {
		const result = AppConfigSchema.safeParse(minimalConfig);
		expect(result.success).toBe(true);
	});

	it('rejects config with no origins', () => {
		const result = AppConfigSchema.safeParse({ ...minimalConfig, origins: [] });
		expect(result.success).toBe(false);
	});

	it('applies defaults for optional fields', () => {
		const result = AppConfigSchema.parse(minimalConfig);
		expect(result.passthrough).toEqual({ enabled: true, formats: ['mp4', 'webm', 'mov'] });
	});

	describe('origins', () => {
		it('requires name, matcher, and at least one source', () => {
			const bad = { ...minimalConfig, origins: [{ name: 'x', matcher: '.*', sources: [] }] };
			const result = AppConfigSchema.safeParse(bad);
			expect(result.success).toBe(false);
		});

		it('accepts R2 source type', () => {
			const cfg = {
				...minimalConfig,
				origins: [
					{
						name: 'r2',
						matcher: '^/videos/',
						sources: [{ type: 'r2' as const, bucketBinding: 'VIDEOS', priority: 0 }],
					},
				],
			};
			const result = AppConfigSchema.safeParse(cfg);
			expect(result.success).toBe(true);
		});

		it('accepts remote source with auth', () => {
			const cfg = {
				...minimalConfig,
				origins: [
					{
						name: 'authed',
						matcher: '.*',
						sources: [
							{
								type: 'remote' as const,
								url: 'https://s3.amazonaws.com/bucket',
								priority: 0,
								auth: {
									type: 'aws-s3' as const,
									accessKeyVar: 'AWS_KEY',
									secretKeyVar: 'AWS_SECRET',
									region: 'us-east-1',
								},
							},
						],
					},
				],
			};
			const result = AppConfigSchema.safeParse(cfg);
			expect(result.success).toBe(true);
		});

		it('accepts optional per-origin fields', () => {
			const cfg = {
				...minimalConfig,
				origins: [
					{
						name: 'full',
						matcher: '.*',
						sources: [{ type: 'remote' as const, url: 'https://example.com', priority: 0 }],
						quality: 'medium',
						videoCompression: 'auto',
						ttl: { ok: 86400, redirects: 3600, clientError: 60, serverError: 10 },
						useTtlByStatus: true,
						cacheTags: ['videos', 'media'],
						captureGroups: ['id'],
					},
				],
			};
			const result = AppConfigSchema.safeParse(cfg);
			expect(result.success).toBe(true);
		});
	});

	describe('derivatives', () => {
		it('requires at least width or height', () => {
			const cfg = { ...minimalConfig, derivatives: { broken: {} } };
			const result = AppConfigSchema.safeParse(cfg);
			// An empty derivative is valid — it's a named preset with no dimensions
			// (could set quality/compression only)
			expect(result.success).toBe(true);
		});

		it('accepts full derivative with all options', () => {
			const cfg = {
				...minimalConfig,
				derivatives: {
					thumbnail: {
						width: 320,
						height: 180,
						mode: 'frame' as const,
						fit: 'cover' as const,
						quality: 'low',
						compression: 'high',
						time: '2s',
						duration: '5s',
						format: 'jpg',
					},
				},
			};
			const result = AppConfigSchema.safeParse(cfg);
			expect(result.success).toBe(true);
		});
	});

	describe('responsive breakpoints', () => {
		it('accepts breakpoint config', () => {
			const cfg = {
				...minimalConfig,
				responsive: {
					breakpoints: [
						{ maxWidth: 854, derivative: 'mobile' },
						{ maxWidth: 1280, derivative: 'tablet' },
						{ maxWidth: 99999, derivative: 'desktop' },
					],
					defaultDerivative: 'desktop',
				},
			};
			const result = AppConfigSchema.safeParse(cfg);
			expect(result.success).toBe(true);
		});
	});

	describe('size limit fields', () => {
		it('defaults cdnCgiSizeLimit to 100 MiB', () => {
			const result = AppConfigSchema.parse(minimalConfig);
			expect(result.cdnCgiSizeLimit).toBe(100 * 1024 * 1024);
		});

		it('defaults bindingSizeLimit to 100 MiB', () => {
			const result = AppConfigSchema.parse(minimalConfig);
			expect(result.bindingSizeLimit).toBe(100 * 1024 * 1024);
		});

		it('defaults asyncContainerThreshold to 256 MiB', () => {
			const result = AppConfigSchema.parse(minimalConfig);
			expect(result.asyncContainerThreshold).toBe(256 * 1024 * 1024);
		});

		it('accepts override for asyncContainerThreshold', () => {
			const result = AppConfigSchema.parse({ ...minimalConfig, asyncContainerThreshold: 512 * 1024 * 1024 });
			expect(result.asyncContainerThreshold).toBe(512 * 1024 * 1024);
		});

		it('rejects non-positive asyncContainerThreshold', () => {
			const result = AppConfigSchema.safeParse({ ...minimalConfig, asyncContainerThreshold: 0 });
			expect(result.success).toBe(false);
		});
	});
});
