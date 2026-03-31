# Architecture

## Request pipeline

```
Client Request
  |
  v
Cloudflare Edge
  |-- cf-cache-status: HIT? -> serve from edge cache (0.1s)
  |
  v
Worker Middleware Pipeline
  |-- Via header loop check (prevent recursive cdn-cgi subrequests)
  |-- Config load (KV with 5-min in-memory cache)
  |-- CDN-CGI passthrough (/cdn-cgi/ paths pass through)
  |-- Non-video passthrough (non-whitelisted extensions pass through)
  |
  v
Param Resolution
  |-- Akamai/IMQuery translation (impolicy -> derivative, imformat -> format, etc.)
  |-- IMQuery breakpoint matching (imwidth/imheight -> derivative via breakpoints)
  |-- Parse canonical params (Zod validation with warnings for invalid values)
  |-- Resolve derivative (named preset overlays width/height/quality/etc.)
  |-- Responsive sizing (Client Hints / CF-Device-Type / User-Agent cascade)
  |
  v
Origin Matching
  |-- Regex match path against configured origins (first match wins)
  |-- Extract capture groups (videoId, extension, etc.)
  |-- Sort sources by priority
  |
  v
Cache Lookup (Workers run BEFORE cache — CDN cache is only checked via fetch())
  |-- 1. cache.match() — checks local data-center cache (same store as CDN edge)
  |     On custom domains, CDN may also serve HIT before Worker runs (cf-cache-status: HIT)
  |-- 2. R2 persistent store (_transformed/{cacheKey}) -> validate source freshness -> cache.put + serve
  |     R2 HITs are validated: stored etag/last-modified compared against current source.
  |     Stale R2 results are discarded and re-transformed.
  |-- 3. Request coalescing (in-memory LRU) -> join in-flight transform
  |
  v
Source Resolution + Transform
  |-- Container-only params + R2 (<=256MB) -> FFmpeg container (sync)
  |-- Container-only params + R2 (>256MB) -> FFmpeg container (async via queue)
  |-- Container-only params + remote (<=256MB) -> FFmpeg container (sync)
  |-- Container-only params + remote (>256MB) -> FFmpeg container (async via queue)
  |-- R2 source (<=100MB) -> env.MEDIA binding
  |-- R2 source (100-256MB) -> FFmpeg container (sync, streamed through DO)
  |-- R2 source (>256MB) -> FFmpeg container (async via queue, container fetches directly)
  |-- Remote source (<=100 MiB) -> cdn-cgi/media URL
  |-- Remote source (>100 MiB) -> FFmpeg container via queue
  |-- Binding fallback (MEDIA_ERROR + >256MB) -> FFmpeg container (async via queue)
  |
  v
Response Processing
  |-- Content-Type correction (audio/mp4, image/jpeg, image/png)
  |-- Cache-Control (per-origin TTL by status code)
  |-- Cache-Tag (derivative, origin, mode tags for purge-by-tag)
  |-- Debug headers (X-Request-ID, X-Processing-Time-Ms, X-Cache-Key, X-R2-Stored, etc.)
  |-- Debug requests: Cache-Control: no-store (prevents CDN caching of debug responses)
  |-- Playback hints (X-Playback-Loop/Autoplay/Muted/Preload)
  |
  v
Storage + Serve
  |-- Stream transform output to R2 (FixedLengthStream for known sizes)
  |-- Read back from R2, put into edge cache
  |-- Serve via cache.match (handles Range headers natively)
  |-- D1 analytics insert (fire-and-forget via waitUntil)
```

## Three-tier transform routing

### Tier 1: Media binding (`env.MEDIA`)

For R2 sources up to 100MB. Streams the R2 object directly into the binding — no HTTP subrequest, no Worker memory pressure. The binding handles resize, crop, frame extraction, spritesheets, and audio extraction.

```typescript
const result = env.MEDIA.input(r2Object.body)
    .transform({ width, height, fit })
    .output({ mode, time, duration, format, audio, imageCount });
const response = await result.response();
```

### Tier 2: cdn-cgi/media

For remote HTTP sources up to 100 MiB. Constructs a `cdn-cgi/media` URL with transform options encoded as path segments. The Cloudflare edge fetches the source and transforms it — video bytes never enter Worker memory.

```
https://your-domain.com/cdn-cgi/media/width=1280,height=720,fit=contain/https://your-origin.com/rocky.mp4
```

### Tier 3: FFmpeg container

For sources >100MB, duration >60s, or params the binding can't handle (fps, speed, rotate, crop, bitrate, h265/vp9 codecs). Runs in a Cloudflare Container DO with 4 vCPU, 12GB RAM, 20GB disk.

Container transforms are dispatched via Cloudflare Queue for durability (survives deploys). See [Container & Queue](container.md).

## Routing decision

```typescript
needsContainer = (
    params.fps       != null ||
    params.speed     != null ||
    params.rotate    != null ||
    params.crop      != null ||
    params.bitrate   != null ||
    params.codec     == 'h265' ||
    params.codec     == 'vp9'  ||
    params.duration exceeds 60s
);
```

When `needsContainer` is true or the source exceeds the binding/cdn-cgi size limits, the request routes to the container tier. All container paths check source size: files >256MB always use the async queue path (container fetches directly via URL) to avoid streaming large files through the DO and hitting Worker memory/timeout limits.

## Dedup stack

| Layer | Scope | What it deduplicates |
|-------|-------|---------------------|
| Edge cache (`caches.default`) | Per data center | Local data-center cache (same store as CDN). Workers run before cache; `cache.match()`/`cache.put()` are direct API calls. No tiered caching via Cache API. |
| R2 persistent store | Global | Transform results across all colos. Each R2 object stores source etag/last-modified metadata for freshness validation. |
| `RequestCoalescer` (in-memory LRU) | Per-isolate | Concurrent identical transforms in same Worker invocation. 60s safety timeout prevents stuck entries from blocking forever. 202 responses are excluded (they produce nothing for joiners). |
| Container DO `jobInFlight` flag | Per-transform (global) | Duplicate async container dispatches |
| Queue consumer R2 check | Global | Container retries after result already stored |
| Source cache (`_source-cache/`) | Global | Multiple containers downloading same source file |

## Error recovery

| Strategy | Trigger | Action |
|----------|---------|--------|
| Duration limit retry | Binding rejects duration | Extract max from error, re-fetch R2, retry with capped duration |
| Alternative source retry | Source 404/5xx | Try next source in priority order |
| Container fallback (reactive) | Binding MediaError | Re-fetch from R2, route to FFmpeg container |
| Container fallback (proactive) | Source >100MB or container-only params | Route directly to container |
| cdn-cgi 9402 fallback | cdn-cgi origin too large error | Route to container |
| Raw passthrough | All transforms fail | Serve untransformed source (`x-transform-source: passthrough`) |
| cdn-cgi passthrough detection | cdn-cgi returns raw source size | Detected via Content-Length match, falls to next source |

## Codec output behavior

The binding and cdn-cgi APIs have no controls for H.264 profile, level, pixel
format, or color space. These are determined entirely by Cloudflare's encoder.
The container uses ffmpeg with explicit codec settings.

See `docs/transform-audit.md` for full ffprobe data across all paths.

| Path | Profile | Level | Bit depth | Color space | Notes |
|------|---------|-------|-----------|-------------|-------|
| binding | Always High | Always 5.2 | 8-bit | None emitted | Level 5.2 regardless of resolution (CF bug) |
| cdn-cgi | Always High | Auto (1.0–4.0) | Usually 8-bit | Preserved from source | Intermittent 10-bit from HEVC Main 10 sources |
| container | High | Auto (ffmpeg) | 8-bit (forced) | ffmpeg default | `-pix_fmt yuv420p` forces 8-bit |
