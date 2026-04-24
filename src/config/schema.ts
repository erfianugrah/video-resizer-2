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

/** Per-status Cache-Control overrides. Full header value strings. */
const CacheControlSchema = z.object({
	/** Cache-Control for 2xx responses. Default: `public, max-age={ttl.ok}` */
	ok: z.string().optional(),
	/** Cache-Control for 3xx responses. Default: `public, max-age={ttl.redirects}` */
	redirects: z.string().optional(),
	/** Cache-Control for 4xx responses. Default: `public, max-age={ttl.clientError}` */
	clientError: z.string().optional(),
	/** Cache-Control for 5xx responses. Default: `public, max-age={ttl.serverError}` */
	serverError: z.string().optional(),
});

const OriginSchema = z.object({
	name: z.string().min(1),
	matcher: z.string().min(1),
	captureGroups: z.array(z.string()).optional(),
	sources: z.array(SourceSchema).min(1),
	// Per-origin transform defaults
	quality: z.string().optional(),
	videoCompression: z.string().optional(),
	// Caching
	ttl: TtlSchema.optional(),
	useTtlByStatus: z.boolean().optional(),
	cacheTags: z.array(z.string()).optional(),
	/** Per-status Cache-Control header overrides. When set, takes precedence
	 *  over the auto-generated `public, max-age={ttl}` for that status range.
	 *  Example: `{ ok: "public, max-age=86400, s-maxage=604800, stale-while-revalidate=3600" }` */
	cacheControl: CacheControlSchema.optional(),
});

// ── Derivative ───────────────────────────────────────────────────────────

const DerivativeSchema = z.object({
	width: z.number().int().min(10).max(8192).optional(),
	height: z.number().int().min(10).max(8192).optional(),
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

// ── Container ────────────────────────────────────────────────────────────

const ContainerQualityPresetSchema = z.object({
	crf: z.number().int().min(0).max(51),
	preset: z.string(),
});

const ContainerSchema = z.object({
	enabled: z.boolean().default(false),
	maxInputSize: z.number().positive().default(6 * 1024 * 1024 * 1024), // 6 GiB
	maxOutputForCache: z.number().positive().default(2 * 1024 * 1024 * 1024), // 2 GiB
	timeoutMs: z.number().positive().default(600_000), // 10 min
	quality: z.record(z.string(), ContainerQualityPresetSchema).default({
		low: { crf: 28, preset: 'fast' },
		medium: { crf: 23, preset: 'medium' },
		high: { crf: 18, preset: 'medium' },
	}),
	sleepAfter: z.string().default('5m'),
	maxInstances: z.number().int().positive().default(5),
});

// ── Top-level config ─────────────────────────────────────────────────────

export const AppConfigSchema = z.object({
	version: z.string().optional(),
	origins: z.array(OriginSchema).min(1),
	derivatives: z.record(z.string(), DerivativeSchema).default({}),
	responsive: ResponsiveSchema.optional(),
	passthrough: PassthroughSchema.default({ enabled: true, formats: ['mp4', 'webm', 'mov'] }),
	container: ContainerSchema.optional(),
	/** cdn-cgi/media input size limit in bytes. Default 100 MiB. Accounts with
	 *  higher limits (e.g. 256 MiB) can increase this to avoid unnecessary
	 *  container routing for mid-size remote sources. */
	cdnCgiSizeLimit: z.number().positive().default(100 * 1024 * 1024),
	/** Media binding input size limit in bytes. Default 100 MiB. Sources larger
	 *  than this are routed to the container (sync or async). */
	bindingSizeLimit: z.number().positive().default(100 * 1024 * 1024),
	/** Threshold above which a container transform is queued async (fire-and-
	 *  forget, SSE progress) instead of streamed through the sync container
	 *  path. Default 256 MiB. The sync path buffers source bytes through the
	 *  DO, so large inputs should go async to avoid memory pressure. */
	asyncContainerThreshold: z.number().positive().default(256 * 1024 * 1024),
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
