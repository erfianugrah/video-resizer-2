/**
 * KV-backed cache version registry — manual force-bust override.
 *
 * Source freshness is now validated automatically via etag/last-modified
 * metadata stored on R2 transform results. This module provides a manual
 * force-bust mechanism for cases where automatic revalidation isn't enough
 * (e.g. CDN cache purge, emergency invalidation).
 *
 * When version > 1, the version is stored in R2 customMetadata on the
 * transform result. On R2 HIT, if the stored version doesn't match the
 * current KV version, the result is treated as stale and re-transformed.
 *
 * Version is NOT part of the cache key — the key is purely path + params.
 *
 * KV key: `v:{path}` → version number (integer string)
 */

/** Get the current cache version for a path. Returns 1 if unset. */
export async function getVersion(kv: KVNamespace, path: string): Promise<number> {
	const raw = await kv.get(`v:${path}`);
	if (!raw) return 1;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Bump the cache version for a path. Returns the new version. */
export async function bumpVersion(kv: KVNamespace, path: string): Promise<number> {
	const current = await getVersion(kv, path);
	const next = current + 1;
	await kv.put(`v:${path}`, String(next));
	return next;
}

/** Set the cache version for a path to a specific value. */
export async function setVersion(kv: KVNamespace, path: string, version: number): Promise<void> {
	await kv.put(`v:${path}`, String(version));
}

/** Delete the version entry (resets to default version 1). */
export async function deleteVersion(kv: KVNamespace, path: string): Promise<void> {
	await kv.delete(`v:${path}`);
}
