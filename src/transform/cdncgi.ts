/**
 * cdn-cgi/media transform for remote/fallback HTTP sources.
 *
 * Instead of fetching the remote source into the Worker's 128MB memory and
 * piping it through env.MEDIA, we construct a cdn-cgi/media URL that tells
 * Cloudflare's edge to fetch + transform directly. This:
 *
 *   - Avoids Worker memory pressure (critical at 128MB limit)
 *   - Supports the account's 256MB input limit (vs binding's 100MB default)
 *   - Leverages Cloudflare's internal edge caching of cdn-cgi results
 *
 * URL format: https://{zone}/cdn-cgi/media/{options}/{sourceUrl}
 *
 * The source URL may include `?v={version}` for cache busting. Presigned
 * AWS URLs are left unmodified (changing them would invalidate the signature).
 */
import type { TransformParams } from '../params/schema';

/**
 * Build the comma-separated options string from TransformParams.
 * Only includes params that cdn-cgi/media supports.
 */
function buildOptions(params: TransformParams): string {
	const parts: string[] = [];

	if (params.mode) parts.push(`mode=${params.mode}`);
	if (params.width) parts.push(`width=${params.width}`);
	if (params.height) parts.push(`height=${params.height}`);
	if (params.fit) parts.push(`fit=${params.fit}`);
	if (params.time) parts.push(`time=${params.time}`);
	if (params.duration) parts.push(`duration=${params.duration}`);
	if (params.format) parts.push(`format=${params.format}`);
	if (params.audio !== undefined) parts.push(`audio=${params.audio}`);
	if (params.imageCount) parts.push(`imageCount=${params.imageCount}`);

	return parts.join(',');
}

/**
 * Append a cache-busting version param to a source URL.
 * Version 1 = no param (clean URL). Presigned URLs are left untouched.
 */
export function addVersionToSourceUrl(sourceUrl: string, version?: number): string {
	if (!version || version <= 1) return sourceUrl;
	// Skip AWS presigned URLs — modifying them invalidates the signature
	if (sourceUrl.includes('X-Amz-Signature=')) return sourceUrl;

	try {
		const parsed = new URL(sourceUrl);
		parsed.searchParams.set('v', String(version));
		return parsed.toString();
	} catch {
		// Fallback: append manually
		const sep = sourceUrl.includes('?') ? '&' : '?';
		return `${sourceUrl}${sep}v=${version}`;
	}
}

/**
 * Build the full cdn-cgi/media URL.
 */
export function buildCdnCgiUrl(
	zoneHost: string,
	sourceUrl: string,
	params: TransformParams,
	version?: number,
): string {
	const options = buildOptions(params);
	const versionedSource = addVersionToSourceUrl(sourceUrl, version);
	return `https://${zoneHost}/cdn-cgi/media/${options}/${versionedSource}`;
}

/**
 * Transform a remote video via cdn-cgi/media.
 *
 * @param zoneHost The hostname of our zone (e.g. "videos.erfi.io")
 * @param sourceUrl Full HTTP(S) URL of the source video
 * @param params Resolved transform params
 * @param version Cache version for busting (optional)
 * @returns Response from cdn-cgi/media
 */
export async function transformViaCdnCgi(
	zoneHost: string,
	sourceUrl: string,
	params: TransformParams,
	version?: number,
): Promise<Response> {
	const url = buildCdnCgiUrl(zoneHost, sourceUrl, params, version);
	// Use fetch with cf.cacheTtl to leverage edge caching of the transform result
	return fetch(url, {
		cf: { cacheTtl: 86400 },
	});
}
