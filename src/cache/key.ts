/**
 * Deterministic cache key generation.
 *
 * The cache key is built from the resolved TransformParams — after derivative
 * resolution and responsive sizing. This means the same derivative always
 * produces the same key, regardless of which raw imwidth triggered it.
 *
 * The derivative *name* is intentionally excluded from the key. Only the
 * resolved dimensions matter: ?derivative=tablet (→ 1280x720) and
 * ?width=1280&height=720 produce identical keys.
 *
 * Version is NOT part of the cache key. Freshness is validated by comparing
 * source etag/last-modified metadata stored on the R2 transform result against
 * the current source. This eliminates orphan R2 objects on version bumps and
 * provides automatic revalidation when R2 or remote sources change.
 *
 * KV CACHE_VERSIONS still exists as a manual force-bust override — if a
 * version > 1 exists, it's stored in R2 customMetadata and compared on HIT.
 *
 * This function is pure — no config lookups, no side effects.
 *
 * IMPORTANT: This is the single source of truth for cache keys. Compute the
 * key ONCE per request (after params resolve) and reuse it everywhere — edge
 * cache, R2 lookup, coalescer, container jobs, response.
 */
import type { TransformParams } from '../params/schema';

/**
 * Build a deterministic cache key from path and resolved transform params.
 *
 * Format: `{mode}:{path}[:w={width}][:h={height}][:...params]`
 *
 * @param path Request path
 * @param params Resolved transform params (derivative already applied)
 */
export function buildCacheKey(path: string, params: TransformParams): string {
	const normalizedPath = path.replace(/^\/+/, '');
	const mode = params.mode ?? 'video';

	let key = `${mode}:${normalizedPath}`;

	// Dimensions — always from resolved params (derivative already applied)
	if (params.width) key += `:w=${params.width}`;
	if (params.height) key += `:h=${params.height}`;

	// Mode-specific params
	switch (mode) {
		case 'frame':
			if (params.time) key += `:t=${params.time}`;
			if (params.format) key += `:f=${params.format}`;
			if (params.fit) key += `:fit=${params.fit}`;
			break;
		case 'spritesheet':
			if (params.time) key += `:t=${params.time}`;
			if (params.duration) key += `:d=${params.duration}`;
			if (params.imageCount) key += `:ic=${params.imageCount}`;
			if (params.fit) key += `:fit=${params.fit}`;
			break;
		case 'audio':
			if (params.time) key += `:t=${params.time}`;
			if (params.duration) key += `:d=${params.duration}`;
			if (params.format) key += `:f=${params.format}`;
			break;
		default: // video
			if (params.time) key += `:t=${params.time}`;
			if (params.duration) key += `:d=${params.duration}`;
			if (params.fit) key += `:fit=${params.fit}`;
			if (params.audio !== undefined) key += `:a=${params.audio}`;
			if (params.quality) key += `:q=${params.quality}`;
			if (params.compression) key += `:c=${params.compression}`;
			break;
	}

	// Container-only params — affect the output, must be in the key.
	// These are mode-independent (apply to video/audio transforms via ffmpeg).
	if (params.fps) key += `:fps=${params.fps}`;
	if (params.speed) key += `:spd=${params.speed}`;
	if (params.rotate != null) key += `:rot=${params.rotate}`;
	if (params.crop) key += `:crop=${params.crop}`;
	if (params.bitrate) key += `:br=${params.bitrate}`;

	// Sanitize: replace spaces and invalid chars, preserve slashes and structure
	return key.replace(/[^\w:/=.*-]/g, '-');
}
