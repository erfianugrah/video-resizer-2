/**
 * Config loader.
 *
 * Loads config from KV (hot-reload), validates with Zod, returns typed config.
 * Falls back to a minimal default config if KV is unavailable.
 */
import { AppConfigSchema, type AppConfig } from './schema';

/** Default config used when KV has no config or parsing fails. */
const DEFAULT_CONFIG: AppConfig = AppConfigSchema.parse({
	origins: [
		{
			name: 'default',
			matcher: '.*',
			sources: [{ type: 'remote', url: 'https://localhost', priority: 0 }],
			ttl: { ok: 86400, redirects: 300, clientError: 60, serverError: 10 },
			cacheControl: {
				ok: 'public, max-age=86400, s-maxage=86400',
				redirects: 'public, max-age=300',
				clientError: 'public, max-age=60',
				serverError: 'no-store',
			},
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

/** In-memory cache to avoid re-reading KV on every request. */
let cachedConfig: AppConfig | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 300_000; // 5 minutes

/**
 * Load and validate config from KV, with in-memory caching.
 * Falls back to DEFAULT_CONFIG if KV unavailable or invalid.
 */
export async function loadConfig(kv: KVNamespace | undefined): Promise<AppConfig> {
	// Return cached if fresh
	if (cachedConfig && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
		return cachedConfig;
	}

	if (!kv) {
		return DEFAULT_CONFIG;
	}

	try {
		const raw = await kv.get('worker-config', 'json');
		if (!raw || typeof raw !== 'object') {
			return DEFAULT_CONFIG;
		}

		// The KV config has a nested structure — extract the video config parts.
		// Every field may be at root.X or root.video.X (legacy nesting).
		const kvConfig = raw as Record<string, unknown>;
		const video = kvConfig.video as Record<string, unknown> | undefined;

		/** Read a field from root.X, falling back to root.video.X. */
		const pick = (key: string): unknown => kvConfig[key] ?? video?.[key];

		// Origins may be wrapped as `{items: [...]}` (legacy shape) — unwrap if so.
		const rawOrigins = pick('origins') as Record<string, unknown> | unknown[] | undefined;
		const origins = Array.isArray(rawOrigins)
			? rawOrigins
			: (rawOrigins as Record<string, unknown> | undefined)?.items ?? rawOrigins;

		const configInput: Record<string, unknown> = {
			...(origins !== undefined && { origins }),
			...(pick('derivatives') !== undefined && { derivatives: pick('derivatives') }),
			...(pick('responsive') !== undefined && { responsive: pick('responsive') }),
			...(pick('passthrough') !== undefined && { passthrough: pick('passthrough') }),
			...(pick('container') !== undefined && { container: pick('container') }),
			...(kvConfig.version !== undefined && { version: kvConfig.version }),
			...(pick('cdnCgiSizeLimit') !== undefined && { cdnCgiSizeLimit: pick('cdnCgiSizeLimit') }),
			...(pick('bindingSizeLimit') !== undefined && { bindingSizeLimit: pick('bindingSizeLimit') }),
			...(pick('asyncContainerThreshold') !== undefined && { asyncContainerThreshold: pick('asyncContainerThreshold') }),
		};

		const result = AppConfigSchema.safeParse(configInput);
		if (result.success) {
			cachedConfig = result.data;
			cacheTimestamp = Date.now();
			return cachedConfig;
		}

		console.log(
			JSON.stringify({
				level: 'warn',
				msg: 'KV config validation failed, using defaults',
				errors: result.error.issues.slice(0, 5),
				ts: Date.now(),
			}),
		);
		return DEFAULT_CONFIG;
	} catch (err) {
		console.log(
			JSON.stringify({
				level: 'error',
				msg: 'Failed to load config from KV',
				error: err instanceof Error ? err.message : String(err),
				ts: Date.now(),
			}),
		);
		return DEFAULT_CONFIG;
	}
}

/** Reset the config cache (useful for tests and admin config updates). */
export function resetConfigCache(): void {
	cachedConfig = null;
	cacheTimestamp = 0;
}
