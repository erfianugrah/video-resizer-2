# Caching

## Cache layers

| Layer | Scope | Purpose | TTL |
|-------|-------|---------|-----|
| Edge cache (`caches.default`) | Per data center | Same store accessed by both CDN and Worker Cache API. Data-center-local only (no tiered caching via Cache API). | Per-origin TTL config |
| R2 persistent store (`_transformed/`) | Global | Survives edge eviction, cross-colo availability | Permanent until busted |
| KV version registry (`CACHE_VERSIONS`) | Global | Optional manual force-bust (not in default cache key) | Permanent |
| R2 source cache (`_source-cache/`) | Global | Container source dedup (multiple transforms of same file) | Permanent |

### How Cloudflare Workers interact with cache

**Workers run BEFORE the cache.** The CDN cache is only consulted when the Worker
calls `fetch()`. When using `caches.default` (the Cache API), you're doing a direct
programmatic lookup against the same local data-center cache store that `fetch()` uses.

Key points from the Cloudflare docs:
- `caches.default` is the same cache shared with `fetch` requests (local data center only)
- `cache.put()` stores responses in the **local data center only** (no tiered caching)
- `cache.match()` with a Range header returns automatic 206 if the stored response has `Content-Length`
- `cache.put()` throws on 206 responses — always store the full 200
- Cache API is a **no-op on `*.workers.dev`** — only works on custom domains

## Flow

On every successful transform:

1. **Transform output -> R2**: streamed via `FixedLengthStream` (zero buffering when Content-Length known)
2. **R2 -> cache.put**: read back from R2, put into local data-center cache with full headers
3. **cache.match -> client**: `cache.match` with the original request (carries Range header for automatic 206)
4. **D1 analytics**: fire-and-forget via `waitUntil`

On subsequent requests:

1. **Worker runs**, calls `cache.match()` against local data-center cache. If HIT, serves directly.
   (On custom domains, the CDN may also serve from edge cache before the Worker runs —
   `cf-cache-status: HIT` means the Worker was bypassed entirely.)
2. **Cache MISS, R2 HIT** -> Worker reads R2 object, validates source freshness (stored etag/last-modified vs current source). If fresh, `cache.put` for next time, serves via `cache.match` for range support. If stale, discards R2 result and falls through to full transform. D1 job status updated to `complete`.
3. **R2 MISS** -> full transform pipeline

### Why cache.put then cache.match?

The Worker stores the full response via `cache.put`, then immediately calls `cache.match`
with the **original client request** (which may include a `Range` header). This lets the
Cache API handle range extraction automatically — returning 206 with `Content-Range`
without manual byte math. This is the documented pattern for serving range requests from
Workers.

## Cache key

Deterministic, built from resolved params (after derivative resolution):

```
{mode}:{path}[:w={width}][:h={height}][:mode-specific-params][:container-params]
```

### Mode-specific segments

| Mode | Extra segments |
|------|---------------|
| video | `:q={quality}:c={compression}` |
| frame | `:t={time}:f={format}` |
| spritesheet | `:t={time}:d={duration}:ic={imageCount}` |
| audio | `:t={time}:d={duration}:f={format}` |

### Container-only param segments

When present, these are appended to the cache key:

`:fps={fps}:spd={speed}:rot={rotate}:crop={crop}:br={bitrate}`

### Key properties

- **Derivative name excluded**: only resolved dimensions matter. `?derivative=tablet` and `?width=1280&height=720` produce identical keys.
- **No version or etag in key**: source freshness is validated at serve time via R2 metadata (stored source etag/last-modified compared against current source). This eliminates key mismatches between storage and lookup paths.
- **Container-only params included**: fps, speed, rotate, crop, and bitrate are part of the cache key when present, ensuring different container transforms produce distinct cache entries.
- **Sanitized**: spaces and special chars replaced, slashes preserved.

## Cache busting

### Automatic (source freshness validation)

R2 transform objects store the source's etag and last-modified timestamp as custom metadata. On every R2 HIT, these values are compared against the current source. If the source has changed, the stale R2 result is discarded and the transform is re-executed. This provides automatic cache invalidation without embedding version/etag in the cache key.

### Manual force-bust (KV CACHE_VERSIONS)

The `CACHE_VERSIONS` KV binding is optional and used only for manual force-busting. When a version is set for a path, it is appended to the cache key (`:v={version}`), causing immediate cache misses on all existing entries. This is useful for forcing re-transforms when the source hasn't changed (e.g., after a config change).

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"path":"/rocky.mp4"}' \
    https://your-domain.com/admin/cache/bust
```

Sets a KV version for that path. The version is appended to the cache key only when present, causing misses on all prior entries for that path.

### Purge by tag

All responses include `Cache-Tag` headers:
- `derivative:{name}` — purge all transforms for a derivative
- `origin:{name}` — purge all transforms from an origin
- `mode:{mode}` — purge all frame/audio/spritesheet extractions
- Per-origin custom tags from config

Use the Cloudflare Cache Purge API to purge by tag (Enterprise plan required for tag-based purge).

## Range requests

Range requests are handled natively by the Cache API. The Worker stores the full response via `cache.put`, and `cache.match` with a Range header automatically returns 206 Partial Content with the correct `Content-Range` header.

```
GET /rocky.mp4?derivative=tablet
Range: bytes=0-999

HTTP/1.1 206 Partial Content
Content-Range: bytes 0-999/5216059
Content-Length: 1000
```

`Accept-Ranges: bytes` is set on all media responses.

## Per-origin TTL

TTL is configurable per-origin in the config, with separate values for different response status ranges:

```json
{
    "ttl": {
        "ok": 86400,         // 200-299: 24 hours
        "redirects": 300,     // 300-399: 5 minutes
        "clientError": 60,    // 400-499: 1 minute
        "serverError": 10     // 500-599: 10 seconds
    }
}
```

Sets `Cache-Control: public, max-age={ttl}` on every response.

## Headers stripped before caching

- `Set-Cookie` — would prevent caching
- `Vary: *` — would prevent caching
