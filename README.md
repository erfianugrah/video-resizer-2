# video-resizer-2

Cloudflare Worker for on-the-fly video transformation. Resize, clip, extract frames, strip audio — from any origin, cached at the edge.

Rewrite of [video-resizer v1](../video-resizer/) (~40K lines) using the Media Transformations binding, Hono, Zod 4, and Cloudflare Containers. ~3K lines total.

**Live:** https://videos.erfi.io

---

## Quick start

```bash
npm install
npm run dev                   # local dev (requires Docker for containers)
npm run deploy                # deploy to Cloudflare
npm run test:run              # 151 unit tests
npm run test:smoke            # 41 smoke tests against live (12s)
npm run test:smoke:container  # + container async polling (~6min)
npm run check                 # TypeScript strict mode
```

---

## Architecture

### Request flow

```
                            ┌─────────────────────────────┐
                            │      Cloudflare Edge        │
         ┌──────────────────┤  cf-cache-status: HIT?      │
         │  cache hit        │  → serve from edge cache    │
         │                  └──────────┬──────────────────┘
         │                             │ cache miss
         │                  ┌──────────▼──────────────────┐
         │                  │      Worker Middleware       │
         │                  │  via check → config load →  │
         │                  │  cdn-cgi passthrough →       │
         │                  │  non-video passthrough       │
         │                  └──────────┬──────────────────┘
         │                             │
         │                  ┌──────────▼──────────────────┐
         │                  │     Param Resolution        │
         │                  │  Akamai/IMQuery translate →  │
         │                  │  parse canonical params →    │
         │                  │  resolve derivative →        │
         │                  │  responsive sizing           │
         │                  └──────────┬──────────────────┘
         │                             │
         │                  ┌──────────▼──────────────────┐
         │                  │     Origin Matching         │
         │                  │  regex match → capture       │
         │                  │  groups → sources by         │
         │                  │  priority                    │
         │                  └──────────┬──────────────────┘
         │                             │
         │                  ┌──────────▼──────────────────┐
         │                  │  R2 Container Cache Check   │
         │                  │  _container-cache/{key}?    │──── hit ──→ tee → client + cache.put
         │                  └──────────┬──────────────────┘
         │                             │ miss
         │                  ┌──────────▼──────────────────┐
         │                  │  Per-Isolate Coalescing     │
         │                  │  in-flight dedup (LRU)      │──── joined ──→ clone response
         │                  └──────────┬──────────────────┘
         │                             │
         │              ┌──────────────┼──────────────────────┐
         │              │              │                      │
         │    ┌─────────▼────┐  ┌──────▼──────┐  ┌───────────▼───────────┐
         │    │  R2 Source    │  │ Remote/     │  │  Container-Only       │
         │    │  ≤100MB       │  │ Fallback    │  │  params (fps/speed/   │
         │    │  → env.MEDIA  │  │ ≤256MB      │  │  rotate/crop/bitrate) │
         │    │  binding      │  │ → cdn-cgi/  │  │  or source >256MB     │
         │    │              │  │   media      │  │  → FFmpeg Container   │
         │    └──────┬───────┘  └──────┬──────┘  │    DO (async)         │
         │           │                 │          └───────────┬───────────┘
         │           │                 │                      │
         │           │    R2 >100MB    │                      │ async: return
         │           │    → container  │                      │ passthrough,
         │           │    fallback     │                      │ container stores
         │           │                 │                      │ result in R2
         │           ▼                 ▼                      ▼
         │    ┌────────────────────────────────────────────────────────┐
         │    │              Response Processing                      │
         │    │  Cache-Control (per-origin TTL) + Cache-Tag +         │
         │    │  Content-Type correction + Content-Disposition +      │
         │    │  Via + Accept-Ranges + playback hints + debug headers │
         │    └───────────────────────┬────────────────────────────────┘
         │                            │
         │                 ┌──────────▼──────────────────┐
         └─────────────────┤     body.tee()              │
                           │  → client stream            │
                           │  → cache.put (waitUntil)    │
                           │  → D1 analytics (waitUntil) │
                           └─────────────────────────────┘
```

### Three-tier transform routing

| Tier | Source | Size Limit | Method | Latency | Worker Memory |
|------|--------|-----------|--------|---------|---------------|
| 1 | R2 | ≤100MB | `env.MEDIA.input(stream)` | ~2-10s | Stream only |
| 2 | Remote/Fallback | ≤256MB | `cdn-cgi/media` URL fetch | ~3-15s | Zero |
| 3 | Any | >256MB or container-only params | FFmpeg Container DO | ~60-120s (async) | Zero |

Tier 1 streams from R2 directly into the Media binding — no HTTP subrequest needed.
Tier 2 constructs a cdn-cgi/media URL and lets the edge handle both fetch and transform — video bytes never enter Worker memory.
Tier 3 fires an async FFmpeg job in a container DO, returns a passthrough immediately, and stores the result in R2 for the next request.

### Container async flow

```
Request 1 (cache miss, >256MB)
  → Worker fires container job (waitUntil)
  → Returns raw passthrough to client (X-Transform-Pending: true, not cached)

Container (background):
  → Downloads source via HTTPS (enableInternet=true, 4 vCPU, 12 GiB RAM)
  → Streams to disk via pipeline() (no OOM)
  → Runs ffmpeg with os.availableParallelism() threads
  → stat() output for Content-Length
  → Streams output to callback via http:// (outbound handler intercepts)
  → Outbound handler stores in R2 (_container-cache/{cacheKey})

Request 2 (cache miss, R2 hit):
  → Worker finds result in R2
  → tee() → client + cache.put
  → cf-cache-status: HIT on subsequent requests
```

### Dedup stack

| Layer | Scope | What it deduplicates |
|-------|-------|---------------------|
| Edge cache (`caches.default`) | Per-colo | All requests — `cf-cache-status: HIT` |
| R2 container cache | Global | Container results across colos |
| `RequestCoalescer` (in-memory LRU) | Per-isolate | Concurrent requests in same isolate |
| DO `jobInFlight` flag | Global per-transform | Container async jobs (same params hash = same DO) |

---

## URL Parameters

### Transform params

| Param | Type | Range/Values | Example | Notes |
|-------|------|-------------|---------|-------|
| `width` | int | 10-2000 | `?width=1280` | |
| `height` | int | 10-2000 | `?height=720` | |
| `fit` | enum | contain, cover, scale-down | `?fit=cover` | |
| `mode` | enum | video, frame, spritesheet, audio | `?mode=frame` | |
| `time` | string | 0s-10m | `?time=5s` | Seek offset |
| `duration` | string | 1s-60s (binding), unlimited (container) | `?duration=10s` | |
| `audio` | bool | true/false | `?audio=false` | Strip audio track |
| `format` | enum | jpg, png (frame); m4a (audio) | `?format=png` | |
| `filename` | string | alphanumeric, max 120 | `?filename=clip` | Content-Disposition |
| `derivative` | string | config key | `?derivative=tablet` | Named preset |
| `quality` | enum | low, medium, high, auto | `?quality=high` | Container CRF |
| `compression` | enum | low, medium, high, auto | `?compression=low` | Container preset |
| `fps` | float | >0 | `?fps=24` | Container only |
| `speed` | float | >0 | `?speed=2` | Container only |
| `rotate` | float | any | `?rotate=90` | Container only |
| `crop` | string | geometry | `?crop=640:480:0:0` | Container only |
| `bitrate` | string | e.g. 2M | `?bitrate=2M` | Container only |
| `imageCount` | int | >0 | `?imageCount=10` | Spritesheet only |
| `loop` | bool | true/false | `?loop=true` | Playback hint header |
| `autoplay` | bool | true/false | `?autoplay=true` | Playback hint header |
| `muted` | bool | true/false | `?muted=true` | Playback hint header |
| `preload` | enum | none, metadata, auto | `?preload=auto` | Playback hint header |
| `debug` | any | `view` for JSON diagnostics | `?debug=view` | Skips cache |

### Akamai/IMQuery compatibility

Full Akamai Image & Video Manager parameter translation. Explicit canonical params always win over translated Akamai equivalents.

| Akamai Param | Canonical | Value Translation |
|-------------|-----------|-------------------|
| `imwidth` | `width` | Direct; triggers derivative matching |
| `imheight` | `height` | Direct; used with imwidth for matching |
| `impolicy` | `derivative` | Akamai "policy" = derivative |
| `imformat` | `format` | `h264`→`mp4`; `h265`/`vp9`→container |
| `imdensity` | `dpr` | Pixel density multiplier |
| `imref` | consumed | Parsed as `key=value,key=value` for derivative context |
| `im-viewwidth` | — | Sets `Sec-CH-Viewport-Width` hint |
| `im-viewheight` | — | Sets `Viewport-Height` hint |
| `im-density` | — | Sets `Sec-CH-DPR` hint |
| `w` | `width` | Shorthand |
| `h` | `height` | Shorthand |
| `q` | `quality` | Shorthand |
| `f` | `format` | Shorthand |
| `obj-fit` | `fit` | `crop`→`cover`, `fill`→`contain` |
| `start` | `time` | Shorthand |
| `dur` | `duration` | Shorthand |
| `mute` | `audio` | **Inverted**: `mute=true` → `audio=false` |
| `dpr` | `dpr` | Direct passthrough |
| `fps`, `speed`, `crop`, `rotate`, `bitrate` | same | Direct passthrough |

### Derivatives (named presets)

`?derivative=mobile` (or `?impolicy=mobile`) bundles width/height/quality/etc into a single name. Core caching strategy — maps infinite possible dimensions to a finite preset set.

**Critical invariant**: derivative dimensions are canonical. When a derivative is resolved, its properties _replace_ any explicit params. Raw `imwidth` values are used only for derivative _selection_ (finding the closest match), never for the actual transform or cache key.

### Responsive sizing

When no explicit dimensions are provided, auto-sizing fills them in from client signals:

1. Client Hints headers (`Sec-CH-Viewport-Width`, `Sec-CH-DPR`, `Width`)
2. `CF-Device-Type` header (mobile/tablet/desktop)
3. User-Agent parsing (fallback)
4. Network-aware: `ECT`, `Downlink`, `Sec-CH-Save-Data` can downgrade quality

---

## Multi-origin routing

Origins are configured as an array, each with a regex `matcher`, `captureGroups`, and `sources[]` sorted by priority. First matching origin wins, then sources are tried in priority order until one succeeds.

### Source types

| Type | How it works | Auth |
|------|-------------|------|
| `r2` | `bucket.get(key)` → ReadableStream | None needed |
| `remote` | HTTP fetch with optional auth | aws-s3, bearer, header |
| `fallback` | Lower priority HTTP, same as remote | aws-s3, bearer, header |

### Auth types

| Type | How it works |
|------|-------------|
| `aws-s3` | Presigned URLs via `aws4fetch` (cached in KV with auto-refresh) |
| `bearer` | `Authorization: Bearer {token}` from env var |
| `header` | Custom header name + value from env var |

---

## Caching

### Cache layers

1. **Edge cache** (`caches.default`): per-colo, handles range requests natively, Cache-Tag for purge-by-tag
2. **R2 persistent store** (`_transformed/{cacheKey}`): global, survives cache eviction and cross-colo requests — all transform results (binding, cdn-cgi, container) are stored here
3. **KV version registry** (`CACHE_VERSIONS`): per-path version number for manual cache busting

On every successful transform, the body is three-way tee'd: client + edge cache.put + R2 put. Subsequent requests check edge cache first, then R2, then transform fresh.

### Cache key

Deterministic, built from resolved params (after derivative resolution):

```
{mode}:{path}[:w={width}][:h={height}][:mode-specific-params][:e={etag}][:v={version}]
```

Same derivative always produces the same key regardless of how it was triggered (`?derivative=tablet` vs `?impolicy=tablet` vs `?imwidth=1280`).

### Cache busting

- **R2 sources**: R2 object etag included in cache key — automatic busting when source changes
- **Remote sources**: KV-backed version number — manual bust via `POST /admin/cache/bust`
- **Purge by tag**: `Cache-Tag` header with derivative, origin, mode tags

---

## Container (FFmpeg)

For transforms the Media binding can't handle:

| Feature | Binding | Container |
|---------|---------|-----------|
| Width/height/fit | Yes | Yes |
| Time/duration (≤60s) | Yes | Yes |
| Duration >60s | No | Yes |
| FPS, speed | No | Yes |
| Rotate, crop | No | Yes |
| Bitrate control | No | Yes |
| Codec (h265, vp9) | No | Yes |
| Input >100MB | No | Yes (up to 20GB disk) |

### Container specs

- **Instance type**: custom `{ vcpu: 4, memory_mib: 12288, disk_mb: 20000 }` (max)
- **Image**: `node:22-slim` + ffmpeg
- **Threads**: `os.availableParallelism()` (up to 4)
- **Source download**: `pipeline()` stream to disk (no OOM)
- **Output**: `createReadStream()` + explicit Content-Length from `stat()`
- **Even dimensions**: odd widths/heights rounded down for libx264
- **Fast seeking**: `-ss` before `-i`

### Container endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/transform` | POST | Sync: stream source in, receive output |
| `/transform-async` | POST | Async: stream source + callbackUrl, 202 |
| `/transform-url` | POST | Async URL-based: container fetches source directly |
| `/health` | GET | Health check |

### Quality presets

| Preset | CRF | FFmpeg Preset |
|--------|-----|---------------|
| low | 28 | fast |
| medium | 23 | medium |
| high | 18 | medium |

### Outbound handler

Containers only intercept HTTP traffic (not HTTPS). The `FFmpegContainer.outbound` handler intercepts all HTTP from the container:

- `POST /internal/container-result` → stores transcoded output in R2 via `FixedLengthStream`
- `GET /internal/r2-source` → serves raw R2 objects via binding (for R2-only sources)
- Everything else → `fetch()` with http→https upgrade

Source downloads use HTTPS directly (not intercepted — `enableInternet=true`).

---

## Admin API

All endpoints require `Authorization: Bearer {CONFIG_API_TOKEN}`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/config` | GET | Retrieve current config |
| `/admin/config` | POST | Upload new config (Zod 4 validated) |
| `/admin/cache/bust` | POST | Bump cache version for a path |
| `/admin/analytics` | GET | Request summary (`?hours=24`) |
| `/admin/analytics/errors` | GET | Recent errors (`?hours=24&limit=50`) |

### Analytics (D1)

Every request outcome is logged to D1 via `waitUntil` (non-blocking). Weekly cron drops and recreates the table for a 7-day rolling window.

Fields: `ts`, `path`, `origin`, `status`, `mode`, `derivative`, `duration_ms`, `cache_hit`, `transform_source`, `source_type`, `error_code`, `bytes`.

### Dashboard

`/admin/dashboard` — Astro + React + Tailwind v4 dashboard with two tabs:

- **Analytics**: stat cards (total requests, success, errors, cache hit rate), latency metrics (avg, p50, p95), breakdown tables (by status, origin, derivative, transform source), recent errors table with time range selector
- **Debug**: test any URL with live param resolution, origin matching, response headers, timing, cache status

Auth: HMAC-SHA256 signed session cookie (HttpOnly, Secure, SameSite=Strict, 24h expiry). Login page validates token against `CONFIG_API_TOKEN` with timing-safe comparison.

```bash
npm run dashboard:build  # rebuild Astro static output
npm run dashboard:dev    # local Astro dev server
```

---

## Debug

### `?debug=view`

Returns JSON diagnostics instead of video:

```json
{
  "diagnostics": {
    "requestId": "uuid",
    "path": "/rocky.mp4",
    "params": { "derivative": "tablet", "width": 1280, "height": 720 },
    "origin": { "name": "standard", "sources": [...], "ttl": {...} },
    "captures": { "videoId": "rocky", "extension": "mp4" },
    "config": { "derivatives": ["desktop","tablet","mobile","thumbnail"] },
    "needsContainer": false,
    "resolvedWidth": 1280,
    "resolvedHeight": 720
  }
}
```

### Response headers (on every request)

| Header | Description |
|--------|-------------|
| `X-Request-ID` | Unique UUID per request |
| `X-Processing-Time-Ms` | Total transform time |
| `X-Transform-Source` | `binding`, `cdn-cgi`, or `container` |
| `X-Origin` | Matched origin name |
| `X-Source-Type` | `r2`, `remote`, or `fallback` |
| `X-Source-Etag` | R2 object etag (if applicable) |
| `X-Derivative` | Resolved derivative name |
| `X-Resolved-Width` | Final width after derivative/responsive |
| `X-Resolved-Height` | Final height |
| `X-Cache-Key` | Deterministic cache key |
| `X-Transform-Pending` | `true` if container async passthrough |
| `X-Playback-*` | Loop, Autoplay, Muted, Preload hints |
| `Via` | `video-resizer` (loop prevention) |
| `Cache-Tag` | Purge-by-tag tags |

---

## Error handling

| Strategy | When | What happens |
|----------|------|--------------|
| Duration limit retry | Binding rejects duration | Extract max from error, retry with capped duration |
| Alternative source retry | Source 404/5xx | Try next source in priority order |
| Container fallback | Binding MediaError | Re-fetch from R2, route to container |
| Raw passthrough | All transforms fail | Serve untransformed source with appropriate headers |

All errors return structured JSON via `AppError`:

```json
{ "error": { "code": "NO_MATCHING_ORIGIN", "message": "No origin matched: /path" } }
```

---

## Config

Stored in KV (`CONFIG` namespace), loaded with 5-min in-memory cache, Zod 4 validated on upload via `POST /admin/config`.

```jsonc
{
  "origins": [
    {
      "name": "standard",
      "matcher": "^/([^.]+)\\.(mp4|webm|mov)",
      "captureGroups": ["videoId", "extension"],
      "sources": [
        { "type": "remote", "priority": 0, "url": "https://videos.erfi.dev" },
        { "type": "r2", "priority": 1, "bucketBinding": "VIDEOS" }
      ],
      "ttl": { "ok": 86400, "redirects": 300, "clientError": 60, "serverError": 10 },
      "cacheTags": ["video-cdn"]
    }
  ],
  "derivatives": {
    "desktop":   { "width": 1920, "height": 1080, "fit": "contain", "duration": "5m" },
    "tablet":    { "width": 1280, "height": 720, "fit": "contain", "duration": "5m" },
    "mobile":    { "width": 854, "height": 640, "fit": "contain", "duration": "5m" },
    "thumbnail": { "width": 640, "height": 360, "mode": "frame", "format": "png", "time": "0s" }
  },
  "responsive": {
    "breakpoints": [
      { "maxWidth": 854, "derivative": "mobile" },
      { "maxWidth": 1280, "derivative": "tablet" },
      { "maxWidth": 1920, "derivative": "desktop" }
    ],
    "defaultDerivative": "desktop"
  },
  "passthrough": { "enabled": true, "formats": ["mp4", "webm", "mov"] },
  "container": { "enabled": true }
}
```

---

## Project structure

```
src/
  index.ts                    # Hono app wiring (70 lines)
  errors.ts                   # AppError class
  log.ts                      # Structured JSON logging (Workers Logs)
  types.ts                    # Env, Variables, App types
  middleware/
    via.ts                    # Via header loop prevention
    config.ts                 # KV config load → c.var.config
    passthrough.ts            # CDN-CGI + non-video extension check
    auth.ts                   # Bearer token auth for admin routes
    error.ts                  # app.onError → AppError + D1 analytics
  handlers/
    admin.ts                  # Config CRUD, cache bust, analytics
    internal.ts               # Container callback, R2 source endpoint
    transform.ts              # Main transform pipeline (~530 lines)
  config/
    schema.ts                 # Zod 4 schema (origins, derivatives, etc.)
    loader.ts                 # KV hot-reload with 5-min TTL
  params/
    schema.ts                 # Canonical params + Akamai translation + needsContainer()
    derivatives.ts            # Named preset resolution
    responsive.ts             # Client Hints / CF-Device-Type auto-sizing
  transform/
    binding.ts                # env.MEDIA pipeline
    cdncgi.ts                 # cdn-cgi/media URL construction + fetch
    container.ts              # FFmpegContainer DO + outbound handler + client functions
  sources/
    router.ts                 # Origin matching, capture groups, source path resolution
    fetch.ts                  # Two-tier source resolution
    auth.ts                   # AWS S3 (aws4fetch), bearer, header
    presigned.ts              # S3 presigned URL generation + KV caching
  cache/
    key.ts                    # Deterministic cache key
    store.ts                  # caches.default helpers
    version.ts                # KV-backed version get/bump/set/delete
    coalesce.ts               # Per-isolate request dedup (BoundedLRU)
  analytics/
    middleware.ts             # D1 insert via waitUntil
    queries.ts                # Aggregation SQL for admin API
    schema.sql                # D1 table DDL
container/
  Dockerfile                  # node:22-slim + ffmpeg
  server.mjs                  # HTTP server with /transform, /transform-url, /health
scripts/
  smoke.ts                    # Standalone smoke test (41 checks, tail log capture)
test/
  *.spec.ts                   # 151 unit tests (vitest + workers pool)
  e2e/live.spec.ts            # E2E tests against live deployment
```

---

## Bindings

| Binding | Type | Resource |
|---------|------|----------|
| `MEDIA` | Media | Media Transformations binding |
| `VIDEOS` | R2 Bucket | `videos` — source videos + container cache |
| `CONFIG` | KV | Worker config |
| `CACHE_VERSIONS` | KV | Cache version management |
| `ANALYTICS` | D1 | `video-resizer-analytics` |
| `FFMPEG_CONTAINER` | Durable Object | FFmpegContainer class |
| `CONFIG_API_TOKEN` | Secret | Bearer token for admin endpoints |

---

## Testing

```bash
npm run test:run              # 151 unit tests (vitest + @cloudflare/vitest-pool-workers)
npm run test:smoke            # 41 smoke tests against live deployment (12s)
npm run test:smoke:container  # + container async polling with tail (~6min)
npm run test:e2e              # vitest E2E suite (46 tests, 60s timeout)
npm run check                 # TypeScript strict (tsc --noEmit)
```

### Smoke test

`scripts/smoke.ts` — standalone TypeScript, no test framework. Tests every transform param, Akamai translation, caching (MISS→HIT), range requests, response headers, error cases, large file transforms. With `--container` flag, polls for async container callback with `wrangler tail` log capture on failure.

```bash
npx tsx scripts/smoke.ts                  # 41 tests
npx tsx scripts/smoke.ts --container      # + container polling
npx tsx scripts/smoke.ts --only cache     # filter by name
```

---

## Dependencies

4 production dependencies:

| Package | Version | Purpose |
|---------|---------|---------|
| `hono` | ^4.12.9 | HTTP routing + middleware |
| `zod` | ^4.3.6 | Config + param validation |
| `aws4fetch` | ^1.0.20 | AWS S3 presigned URLs |
| `@cloudflare/containers` | ^0.2.0 | Container DO base class |
