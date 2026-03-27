/**
 * Single Zod 4 schema for the entire application config.
 *
 * One schema, one parse, one validated object that flows through
 * the entire request via Hono context. No singletons.
 */
import { z } from 'zod';

// ── Auth ─────────────────────────────────────────────────────────────────

const AwsS3AuthSchema = z.object({
	type: z.literal('aws-s3'),
	accessKeyVar: z.string(),
	secretKeyVar: z.string(),
	region: z.string(),
	service: z.string().optional(),
	sessionTokenVar: z.string().optional(),
});

const BearerAuthSchema = z.object({
	type: z.literal('bearer'),
	tokenVar: z.string(),
});

const HeaderAuthSchema = z.object({
	type: z.literal('header'),
	headers: z.record(z.string(), z.string()),
});

const AuthSchema = z.union([AwsS3AuthSchema, BearerAuthSchema, HeaderAuthSchema]);

// ── Sources ──────────────────────────────────────────────────────────────

const R2SourceSchema = z.object({
	type: z.literal('r2'),
	bucketBinding: z.string(),
	priority: z.number().int().min(0),
	auth: AuthSchema.optional(),
});

const RemoteSourceSchema = z.object({
	type: z.literal('remote'),
	url: z.string(),
	priority: z.number().int().min(0),
	auth: AuthSchema.optional(),
});

const FallbackSourceSchema = z.object({
	type: z.literal('fallback'),
	url: z.string(),
	priority: z.number().int().min(0),
	auth: AuthSchema.optional(),
});

const SourceSchema = z.union([R2SourceSchema, RemoteSourceSchema, FallbackSourceSchema]);

// ── TTL ──────────────────────────────────────────────────────────────────

const TtlSchema = z.object({
	ok: z.number().positive(),
	redirects: z.number().positive(),
	clientError: z.number().min(0),
	serverError: z.number().min(0),
});

// ── Origin ───────────────────────────────────────────────────────────────

const OriginSchema = z.object({
	name: z.string().min(1),
	matcher: z.string().min(1),
	captureGroups: z.array(z.string()).optional(),
	processPath: z.boolean().optional(),
	sources: z.array(SourceSchema).min(1),
	// Per-origin transform defaults
	quality: z.string().optional(),
	videoCompression: z.string().optional(),
	// Caching
	ttl: TtlSchema.optional(),
	useTtlByStatus: z.boolean().optional(),
	cacheTags: z.array(z.string()).optional(),
});

// ── Derivative ───────────────────────────────────────────────────────────

const DerivativeSchema = z.object({
	width: z.number().int().min(10).max(2000).optional(),
	height: z.number().int().min(10).max(2000).optional(),
	mode: z.enum(['video', 'frame', 'spritesheet', 'audio']).optional(),
	fit: z.enum(['contain', 'scale-down', 'cover']).optional(),
	quality: z.string().optional(),
	compression: z.string().optional(),
	time: z.string().optional(),
	duration: z.string().optional(),
	format: z.string().optional(),
	audio: z.boolean().optional(),
});

// ── Responsive ───────────────────────────────────────────────────────────

const BreakpointSchema = z.object({
	maxWidth: z.number().positive(),
	derivative: z.string(),
});

const ResponsiveSchema = z.object({
	breakpoints: z.array(BreakpointSchema),
	defaultDerivative: z.string(),
});

// ── Passthrough ──────────────────────────────────────────────────────────

const PassthroughSchema = z.object({
	enabled: z.boolean(),
	formats: z.array(z.string()),
});

// ── Top-level config ─────────────────────────────────────────────────────

export const AppConfigSchema = z.object({
	version: z.string().optional(),
	origins: z.array(OriginSchema).min(1),
	derivatives: z.record(z.string(), DerivativeSchema).default({}),
	responsive: ResponsiveSchema.optional(),
	passthrough: PassthroughSchema.default({ enabled: true, formats: ['mp4', 'webm', 'mov'] }),
});

/** Validated application config. Immutable after parse. */
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** A single origin definition. */
export type Origin = z.infer<typeof OriginSchema>;

/** A single source within an origin. */
export type Source = z.infer<typeof SourceSchema>;

/** Auth config for a source. */
export type AuthConfig = z.infer<typeof AuthSchema>;

/** A named derivative preset. */
export type Derivative = z.infer<typeof DerivativeSchema>;
