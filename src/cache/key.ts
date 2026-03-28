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
 * This function is pure — no config lookups, no side effects.
 */
import type { TransformParams } from '../params/schema';

/**
 * Build a deterministic cache key from path and resolved transform params.
 *
 * Format: `{mode}:{path}[:w={width}][:h={height}][:...params][:e={etag}][:v={version}]`
 *
 * @param path Request path
 * @param params Resolved transform params (derivative already applied)
 * @param version KV-backed version number for manual cache busting (remote sources)
 * @param etag R2 object etag for automatic cache busting (R2 sources)
 */
export function buildCacheKey(path: string, params: TransformParams, version?: number, etag?: string): string {
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
			break;
		case 'spritesheet':
			if (params.time) key += `:t=${params.time}`;
			if (params.duration) key += `:d=${params.duration}`;
			if (params.imageCount) key += `:ic=${params.imageCount}`;
			break;
		case 'audio':
			if (params.time) key += `:t=${params.time}`;
			if (params.duration) key += `:d=${params.duration}`;
			if (params.format) key += `:f=${params.format}`;
			break;
		default: // video
			if (params.quality) key += `:q=${params.quality}`;
			if (params.compression) key += `:c=${params.compression}`;
			break;
	}

	// R2 etag for automatic cache busting — short hash to keep key compact
	if (etag) key += `:e=${etag.slice(0, 8)}`;

	// KV version for manual cache busting (remote sources)
	if (version && version > 1) key += `:v=${version}`;

	// Sanitize: replace spaces and invalid chars, preserve slashes and structure
	return key.replace(/[^\w:/=.*-]/g, '-');
}
