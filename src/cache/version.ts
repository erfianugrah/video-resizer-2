/**
 * KV-backed cache version registry.
 *
 * Each source path has a version number. Bumping the version changes the
 * cache key, forcing a re-transform on the next request. This is needed
 * because remote origins are opaque — we can't know when they change.
 *
 * For R2 sources, conditional requests (ETag/If-None-Match) could
 * validate freshness cheaply, but the version approach is simpler and
 * works uniformly across all source types.
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
