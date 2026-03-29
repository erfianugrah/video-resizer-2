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
		},
	],
	derivatives: {
		desktop: { width: 1920, height: 1080 },
		tablet: { width: 1280, height: 720 },
		mobile: { width: 854, height: 640 },
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

		// The KV config has a nested structure — extract the video config parts
		const kvConfig = raw as Record<string, unknown>;

		// Build the config object from KV structure
		const configInput: Record<string, unknown> = {};

		// Origins can be at root.origins or root.video.origins
		if (kvConfig.origins) {
			const originsObj = kvConfig.origins as Record<string, unknown>;
			configInput.origins = originsObj.items ?? originsObj;
		} else if (kvConfig.video && (kvConfig.video as Record<string, unknown>).origins) {
			const videoOrigins = (kvConfig.video as Record<string, unknown>).origins as Record<string, unknown>;
			configInput.origins = videoOrigins.items ?? videoOrigins;
		}

		// Derivatives
		if (kvConfig.derivatives) {
			configInput.derivatives = kvConfig.derivatives;
		} else if (kvConfig.video && (kvConfig.video as Record<string, unknown>).derivatives) {
			configInput.derivatives = (kvConfig.video as Record<string, unknown>).derivatives;
		}

		// Responsive
		if (kvConfig.responsive) {
			configInput.responsive = kvConfig.responsive;
		} else if (kvConfig.video && (kvConfig.video as Record<string, unknown>).responsive) {
			configInput.responsive = (kvConfig.video as Record<string, unknown>).responsive;
		}

		// Passthrough
		if (kvConfig.passthrough) {
			configInput.passthrough = kvConfig.passthrough;
		} else if (kvConfig.video && (kvConfig.video as Record<string, unknown>).passthrough) {
			configInput.passthrough = (kvConfig.video as Record<string, unknown>).passthrough;
		}

		// Container
		if (kvConfig.container) {
			configInput.container = kvConfig.container;
		} else if (kvConfig.video && (kvConfig.video as Record<string, unknown>).container) {
			configInput.container = (kvConfig.video as Record<string, unknown>).container;
		}

		// Version
		if (kvConfig.version) {
			configInput.version = kvConfig.version;
		}

		// Size limits
		if (kvConfig.cdnCgiSizeLimit !== undefined) {
			configInput.cdnCgiSizeLimit = kvConfig.cdnCgiSizeLimit;
		} else if (kvConfig.video && (kvConfig.video as Record<string, unknown>).cdnCgiSizeLimit !== undefined) {
			configInput.cdnCgiSizeLimit = (kvConfig.video as Record<string, unknown>).cdnCgiSizeLimit;
		}

		if (kvConfig.bindingSizeLimit !== undefined) {
			configInput.bindingSizeLimit = kvConfig.bindingSizeLimit;
		} else if (kvConfig.video && (kvConfig.video as Record<string, unknown>).bindingSizeLimit !== undefined) {
			configInput.bindingSizeLimit = (kvConfig.video as Record<string, unknown>).bindingSizeLimit;
		}

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
