# AGENTS.md

Rewrite of `../video-resizer/` (v1, ~40K lines). Same feature set, cleaner
architecture. Platform improvements do the heavy lifting: `env.MEDIA` binding
replaces cdn-cgi URL construction, Cache API replaces chunked KV, Workers Logs
replaces Pino, Hono replaces hand-rolled routing, Zod 4 replaces Zod 3 + 5
singleton managers. All features carry over: multi-origin, auth (S3/bearer/header),
Akamai param compat, derivatives, responsive sizing, debug UI, config admin.

## Docs -- always check before coding

- Workers: https://developers.cloudflare.com/workers/
- Limits: https://developers.cloudflare.com/workers/platform/limits/
- Media binding: https://developers.cloudflare.com/stream/transform-videos/bindings/
- Media options: https://developers.cloudflare.com/stream/transform-videos/#options
- Node.js compat: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Hono: https://hono.dev/docs/
- Akamai IVM IMQuery: https://techdocs.akamai.com/ivm/docs/imquery
- Akamai IVM derivatives: https://techdocs.akamai.com/ivm/docs/select-specific-derivative
- Akamai IVM test params: https://techdocs.akamai.com/ivm/reference/test-images-on-demand

## What v1 solved, and what v2 eliminates

v1 is 40K lines because `cdn-cgi/media` requires an HTTP URL as input. This forced:

- **`__r2src` loopback hack** (~600 lines): cdn-cgi can't access R2 bindings, so v1
  builds a self-referencing URL, cdn-cgi fetches it, v1 intercepts and serves raw R2.
  **Eliminated** -- `env.MEDIA.input()` accepts a `ReadableStream` directly.
- **cdn-cgi URL construction** (~2400 lines): encoding params as URL path segments,
  building source URLs with auth tokens, param filtering.
  **Eliminated** -- pass options as a JS object to `.transform()` / `.output()`.
- **Chunked KV storage** (~4200 lines): KV 25MB limit forced video chunking with
  manifests, streaming reassembly, range-to-chunk mapping, lock managers, retry logic.
  **Eliminated** -- Cache API has no size limit and handles range requests natively.
- **Akamai/IMQuery translation** (~800 lines across 7 layers): param name/value
  mapping, IMQuery detection, derivative matching, client-hints injection, validation.
  **Simplified** -- consolidate into a single `params/akamai.ts` translation layer
  instead of 7 scattered layers. Same functionality, one place.
- **5 singleton config managers** (~2500 lines): each with getInstance(), Zod schemas,
  KV hot-reload, legacy-to-origin converters.
  **Replaced** with one config schema validated once at startup, passed via Hono context.
- **6 error classes** with parallel enums (OriginError had its own duplicate enum).
  **Replaced** with one `AppError` class + Hono `app.onError`.
- **Dual code paths** (~1500 lines): Origins vs Legacy branching throughout handlers,
  with TransformVideoCommand duplicating strategy logic inline.
  **Eliminated** -- one pipeline using the Media binding.
- **Pino logger** (~500 lines): bundled logging library with category loggers.
  **Eliminated** -- `console.log(JSON.stringify({...}))` with Workers Logs.

---

## Complete parameter reference

### Canonical params (what the system accepts after translation)

All params are parsed once via Zod into a `TransformParams` object.
Derivatives overlay onto this object. The result is immutable.

| Param         | Type   | Range/Values                                | Media Binding                 | Container                 | Notes                            |
| ------------- | ------ | ------------------------------------------- | ----------------------------- | ------------------------- | -------------------------------- |
| `width`       | int    | 10-2000                                     | `.transform({width})`         | ffmpeg `-vf scale=W:-2`   |                                  |
| `height`      | int    | 10-2000                                     | `.transform({height})`        | ffmpeg `-vf scale=-2:H`   |                                  |
| `fit`         | enum   | contain, scale-down, cover                  | `.transform({fit})`           | ffmpeg pad/crop           |                                  |
| `mode`        | enum   | video, frame, spritesheet, audio            | `.output({mode})`             | ffmpeg output flags       |                                  |
| `time`        | string | 0s-10m                                      | `.output({time})`             | ffmpeg `-ss`              |                                  |
| `duration`    | string | 1s-60s (binding), unlimited (container)     | `.output({duration})`         | ffmpeg `-t`               |                                  |
| `audio`       | bool   | true/false                                  | `.output({audio})`            | ffmpeg `-an`/copy         |                                  |
| `format`      | enum   | jpg, png (frame); m4a (audio)               | `.output({format})`           | ffmpeg format             |                                  |
| `filename`    | string | ^[a-zA-Z0-9-_]+\.?[a-zA-Z0-9-_]\*$, max 120 | N/A (response header)         | same                      | Content-Disposition              |
| `derivative`  | string | config key                                  | N/A (resolved before binding) | same                      |                                  |
| `quality`     | string | low, medium, high, auto                     | **NOT in binding**            | ffmpeg `-crf`             | see routing rules below          |
| `compression` | string | low, medium, high, auto                     | **NOT in binding**            | ffmpeg preset             | see routing rules below          |
| `fps`         | float  | >0                                          | **NOT in binding**            | ffmpeg `-r`               | container-only                   |
| `speed`       | float  | >0                                          | **NOT in binding**            | ffmpeg `-filter:v setpts` | container-only                   |
| `rotate`      | float  | any                                         | **NOT in binding**            | ffmpeg `-vf rotate`       | container-only                   |
| `crop`        | string | geometry spec                               | **NOT in binding**            | ffmpeg `-vf crop`         | container-only                   |
| `bitrate`     | string | e.g. 2M                                     | **NOT in binding**            | ffmpeg `-b:v`             | container-only                   |
| `imageCount`  | int    | >0                                          | `.output({imageCount})`       | N/A                       | spritesheet only, new in binding |
| `loop`        | bool   | true/false                                  | **NOT in binding**            | N/A                       | playback hint header only        |
| `autoplay`    | bool   | true/false                                  | **NOT in binding**            | N/A                       | playback hint header only        |
| `muted`       | bool   | true/false                                  | **NOT in binding**            | N/A                       | playback hint header only        |
| `preload`     | enum   | none, metadata, auto                        | **NOT in binding**            | N/A                       | playback hint header only        |

### Akamai/IMQuery param translation

Single translation function in `params/akamai.ts`. Produces a new URLSearchParams.
Explicit canonical params always win over translated Akamai equivalents.

| Akamai Param    | Canonical Param | Value Translation                            | Notes                                               |
| --------------- | --------------- | -------------------------------------------- | --------------------------------------------------- |
| `imwidth`       | `width`         | direct                                       | primary IMQuery param; used for derivative matching |
| `imheight`      | `height`        | direct                                       | used with imwidth for derivative matching           |
| `imref`         | consumed        | parsed as `key=value,key=value`              | used for derivative matching context, not forwarded |
| `impolicy`      | `derivative`    | direct                                       | Akamai "policy" = our "derivative"                  |
| `imformat`      | `format`        | `h264`->`mp4`, `h265`/`vp9`->container route | codec selection; h265/vp9 need container            |
| `imdensity`     | `dpr`           | direct                                       | pixel density multiplier                            |
| `im-viewwidth`  | responsive      | sets `Sec-CH-Viewport-Width` hint            | not a transform param                               |
| `im-viewheight` | responsive      | sets `Viewport-Height` hint                  | not a transform param                               |
| `im-density`    | responsive      | sets `Sec-CH-DPR` hint                       | not a transform param                               |
| `w`             | `width`         | direct                                       | shorthand                                           |
| `h`             | `height`        | direct                                       | shorthand                                           |
| `q`             | `quality`       | direct                                       | shorthand                                           |
| `f`             | `format`        | direct                                       | shorthand                                           |
| `obj-fit`       | `fit`           | `crop`->`cover`, `fill`->`contain`           | value mapping                                       |
| `start`         | `time`          | direct                                       |                                                     |
| `dur`           | `duration`      | direct                                       |                                                     |
| `mute`          | `audio`         | **inverted**: `mute=true` -> `audio=false`   |                                                     |
| `bitrate`       | `bitrate`       | direct                                       |                                                     |
| `fps`           | `fps`           | direct                                       |                                                     |
| `speed`         | `speed`         | direct                                       |                                                     |
| `crop`          | `crop`          | direct                                       |                                                     |
| `rotate`        | `rotate`        | direct                                       |                                                     |
| `dpr`           | `dpr`           | direct                                       |                                                     |

### Media binding vs container routing decision

The transform handler decides at runtime whether to use `env.MEDIA` or the
FFmpeg container based on the resolved params:

```
needsContainer = (
  params.fps       != null ||   // binding has no fps control
  params.speed     != null ||   // binding has no speed control
  params.rotate    != null ||   // binding has no rotation
  params.crop      != null ||   // binding only has fit:cover for cropping
  params.bitrate   != null ||   // binding has no bitrate control
  params.codec     == 'h265' || // binding outputs H.264 only
  params.codec     == 'vp9'  || // binding outputs H.264 only
  params.duration exceeds 60s   // binding cap is 60s
);
```

When `needsContainer` is true, route to the FFmpeg container DO. When false,
use `env.MEDIA` (faster, cheaper, no container cold start).

The container is also used as a **fallback** when the Media binding throws
`MediaError` for oversized inputs (>100MB via binding, but the container
handles up to 6 GiB with account-level overrides).

---

## What v2 keeps

### Multi-origin routing with priority fallback

Origins config: array of origins, each with `name`, `matcher` (regex), `captureGroups`,
and `sources[]` sorted by priority. First matching origin wins, then sources are tried
in priority order until one succeeds. This is source-fetching logic, independent of
how transformation is invoked.

### Source types and auth

Three source types: `r2` (direct binding), `remote` (HTTP), `fallback` (HTTP + bg cache).
Auth types actually implemented: `aws-s3` (signed headers via `aws4fetch`), `bearer`,
`header` (custom headers). v1 also declared `token`/`basic`/`query` in schema but never
implemented them -- v2 only defines what's implemented.

### Per-origin config (actively used fields only)

v1's origin schema had 21 fields; only 10 were consumed at runtime. v2 keeps:

- `name`, `matcher`, `captureGroups`, `sources[]` -- routing
- `ttl` (ok/redirects/clientError/serverError), `useTtlByStatus` -- per-origin caching
- `quality`, `videoCompression` -- per-origin transform defaults
- `processPath` -- passthrough flag
- `cacheTags` -- per-origin cache purge tags (was dead config in v1; wire it in v2)
  v2 drops 11 fields that were defined but never consumed: `derivatives` (per-origin),
  `responsiveSelection`, `multiResolution`, `accessControl`, `contentModeration`,
  `streaming`, `dimensionRatio`, `formatMapping`, `metadata`, `transformOptions` (dup),
  `Source.cacheControl`, `Source.resolutionPathTemplate`, `Source.headers`.

### Derivatives (named presets)

`?derivative=mobile` bundles width/height/quality/etc. Core caching strategy -- maps
infinite possible dimensions to a finite preset set. Configured globally + overridable
per-origin in v2 (was global-only in v1 despite schema support).

**Critical invariant**: derivative dimensions are always canonical. When a derivative is
specified, its width/height/quality/etc. _replace_ any explicit params. Raw `imwidth`
values are used only for derivative _selection_ (finding the closest match), never for
the actual transform or cache key. This prevents the v1 KV key mismatch bug.

### IMQuery derivative matching

`?imwidth=1080` -> find closest derivative via breakpoint mapping -> `tablet` (1280x720).
Width-only uses breakpoint ranges. Width+height uses Euclidean distance with aspect
ratio weighting. Matching happens in `params/akamai.ts`, result is a `derivative` name
that feeds into the standard derivative resolution path.

### Responsive sizing

Client Hints (`Sec-CH-Viewport-Width`, `DPR`) + `CF-Device-Type` header cascade for
auto dimensions when no explicit params. Applied after derivative resolution -- only
fills in missing dimensions, never overrides derivative values.

Detection priority:

1. Client Hints headers (`Sec-CH-Viewport-Width`, `Sec-CH-DPR`, `Width`)
2. `CF-Device-Type` header (mobile/tablet/desktop)
3. User-Agent parsing (fallback)

Network-aware: `ECT`, `Downlink`, `Sec-CH-Save-Data` headers can downgrade quality.

### Caching

**Cache API** as primary transformed-result cache (replaces chunked KV).
No size limit, native range request support, `cache.delete()` for invalidation.

**Cache busting is still needed.** The Media binding caches input assets internally
(confirmed: "improved caching of the input asset"). Both the binding's internal
cache and our Cache API layer can go stale when the source video changes:

- **R2**: we can detect changes via ETag / last-modified on the R2 object
- **Remote/fallback HTTP**: the external origin can change the video at any time
  with no notification. We have no way to know without checking.

v1 solved this with a KV-based version registry (`VIDEO_CACHE_KEY_VERSIONS` namespace)
that appended `?v=N` to cdn-cgi URLs. v2 needs a simpler approach:

- **Cache key includes a version component** (from KV or config)
- **Per-origin TTL controls** how long we trust the cache before re-transforming
- **Explicit purge** via admin API or `cache.delete()` for on-demand invalidation
- For R2 sources, **conditional requests** (If-None-Match) can validate freshness
  cheaply before re-transforming

The version registry shrinks from ~370 lines to a simple KV get/put, but the concept
persists because remote origins are opaque -- we can't know when they change.

### Request coalescing

Single-flight dedup for concurrent identical transforms. Key built from origin +
resolved path + canonical params hash. In-flight map is a BoundedLRUMap (max 500
entries, 5-min TTL). Concurrent requests join the existing Promise; response is
`.clone()`-d for each joiner.

### Range request handling

Video players need 206 partial content for seeking. With Cache API as the primary
cache, range requests are handled natively -- Cache API stores the full response and
CF edge serves byte ranges from it. No manual range-to-chunk mapping needed.

For uncached responses, the transform handler returns the full response; the cache
middleware stores it via `waitUntil`, and CF edge handles the range extraction.

### Response processing

- **Content-Type correction**: force `audio/mp4` for audio mode, `image/jpeg` for
  frame mode, etc. The Media binding's `.contentType()` method provides this.
- **Content-Disposition**: `?filename=clip` -> `Content-Disposition: inline; filename="clip"`
- **Cache-Control**: `public, max-age={ttl}` from per-origin TTL config, status-aware
- **Cache-Tag**: path segments + derivative name for purge-by-tag
- **Accept-Ranges: bytes** on all media responses
- **Playback hints**: `loop`, `autoplay`, `muted`, `preload` -> custom headers only
  (these are HTML attributes, not transform params -- passed through for client use)

### Error handling

One `AppError` class with status, code, message, details. Hono `app.onError` catches
all and returns structured JSON. Media binding errors (`MediaError` with numeric `code`)
are caught and mapped to `AppError`.

Error recovery strategies (from v1, simplified):

1. **Duration limit retry**: if binding rejects duration, extract max from error, retry
2. **Alternative source retry**: on 404/fetch failure, try next source in priority list
3. **Container fallback**: on MediaError for oversized input, route to FFmpeg container
4. **Raw passthrough**: last resort, serve untransformed source with appropriate headers

### Other essential features

- **Via header loop prevention** -- check `Via` header for our service name
- **Non-video passthrough** -- non-whitelisted extensions pass through untransformed
- **CDN-CGI path passthrough** -- requests already on `/cdn-cgi/` pass through
- **Config admin API** -- `POST/GET /admin/config` with Bearer auth
- **Debug UI** -- Astro+React dashboard via Static Assets binding
- **Presigned URL caching** -- AWS S3 presigned URLs cached in KV, auto-refreshed

---

## Container FFmpeg fallback

The FFmpeg container handles transformations the Media binding cannot:

### When container is used

1. **Advanced params**: fps, speed, rotate, crop, bitrate, codec selection
2. **Duration > 60s**: binding cap is 60s, container has no limit
3. **Oversized input**: binding limit is 100MB, container handles up to 6 GiB
4. **MediaError fallback**: when binding throws, fall back to container
5. **Codec transcoding**: h265/vp9 output (binding outputs H.264 only)

### Container architecture

- `FFmpegContainer extends Container` Durable Object
- Docker image with ffmpeg, exposed on port 8080
- Instance key: `ffmpeg:{originName}:{path}`
- `sleepAfter`: configurable (default 5m), container sleeps after inactivity
- `maxInstances`: configurable (default 5)

### Container endpoints

- `POST /transform` -- synchronous: send source, receive transformed output
- `POST /transform-and-callback` -- async: send source + callbackUrl, container
  POSTs result to callback when done

### Quality presets (container)

```
low:    { crf: 28, preset: 'fast' }
medium: { crf: 23, preset: 'medium' }
high:   { crf: 18, preset: 'medium' }
```

### Callback pattern (async container)

1. Transform handler detects container-only params or oversized source
2. Fires `POST /transform-and-callback` to container DO with:
   - `sourceUrl`: R2 path or HTTP URL
   - Transform params (width, height, fps, etc.)
   - `callbackUrl`: `https://{origin}/internal/container-result?path=...&cacheKey=...`
3. Returns raw source as immediate passthrough response to client
4. Container transcodes asynchronously, POSTs result to callback
5. Callback handler stores in Cache API for future requests

### Container config schema

```typescript
container: {
  enabled: boolean,           // default false
  maxInputSize: number,       // default 6 GiB
  maxOutputForCache: number,  // default 2 GiB
  timeoutMs: number,          // default 600000 (10 min)
  quality: Record<string, { crf: number, preset: string }>,
  sleepAfter: string,         // default '5m'
  maxInstances: number,       // default 5
}
```

---

## v2 architecture

### Hono for routing and middleware

```typescript
import { Hono } from 'hono';
type Bindings = { MEDIA: MediaTransformations; VIDEOS: R2Bucket; CONFIG: KVNamespace; ASSETS: Fetcher };
const app = new Hono<{ Bindings: Bindings }>();

app.use('*', configMiddleware); // load config from KV, validate Zod 4
app.get('/admin/config', authMiddleware, configHandler);
app.post('/admin/config', authMiddleware, configHandler);
app.post('/internal/container-result', containerCallbackHandler);
app.get('*', parseParams, resolveSource, cacheMiddleware, transformHandler);
app.onError(errorHandler);
export default app;
```

### Directory structure

```
src/
  index.ts                    # Hono app wiring only (70 lines): middleware + routes + export
  errors.ts                   # AppError class
  log.ts                      # Structured JSON logging for Workers Logs
  types.ts                    # Shared types: Env, Variables, App
  middleware/
    via.ts                    # Via header loop prevention
    config.ts                 # Load config from KV, set c.var.config
    passthrough.ts            # CDN-CGI passthrough + non-video extension check
    auth.ts                   # Bearer token auth for admin routes
    error.ts                  # app.onError: AppError + D1 analytics logging
  handlers/
    admin.ts                  # GET/POST /admin/config, POST /admin/cache/bust,
                              #   GET /admin/analytics, GET /admin/analytics/errors
    internal.ts               # POST /internal/container-result (async callback),
                              #   GET /internal/r2-source (raw R2 for container)
    transform.ts              # GET * — main transform pipeline (~530 lines):
                              #   params → derivative → responsive → origin → cache →
                              #   coalesce → source → transform → headers → tee → cache.put
  config/
    schema.ts                 # Single Zod 4 schema: origins, derivatives, cache, etc.
    loader.ts                 # Load from KV/env, validate, return typed config
  params/
    schema.ts                 # Zod 4 schema: canonical param definitions + validation
                              #   + Akamai/IMQuery translation + needsContainer()
    derivatives.ts            # Named presets lookup + application
    responsive.ts             # Client Hints / CF-Device-Type auto-sizing
  transform/
    binding.ts                # env.MEDIA pipeline: input -> transform -> output
    cdncgi.ts                 # cdn-cgi/media URL construction + fetch
    container.ts              # FFmpegContainer DO class + sync/async/URL-based clients
                              #   + buildContainerInstanceKey (FNV-1a hash)
  sources/
    router.ts                 # Match path -> origin -> try sources by priority
    fetch.ts                  # Two-tier source resolution (R2 stream / remote URL)
    auth.ts                   # Auth impls: aws-s3 (aws4fetch), bearer, header
    presigned.ts              # Presigned URL generation + KV caching
  cache/
    key.ts                    # Deterministic cache key from path + resolved params
    store.ts                  # caches.default helpers (match/put/delete)
    version.ts                # KV-backed version get/bump/set/delete
    coalesce.ts               # Single-flight request dedup (BoundedLRUMap)
  analytics/
    middleware.ts             # Log every request outcome to D1 (waitUntil)
    queries.ts                # Aggregation SQL for admin API
    schema.sql                # D1 table DDL (also used by weekly cron)
container/
  Dockerfile                  # node:22-slim + ffmpeg
  server.mjs                  # HTTP server: /transform, /transform-url, /health
```

### Design principles

**Middleware pipeline, not nested ifs.** Each middleware does one thing. The final
handler is thin: get stream, pick strategy, call binding, return.

**One file per concern.** New param = `params/schema.ts` + relevant strategy.
New mode = one strategy file + factory case. New source = one file in `sources/`.
New auth = one case in `sources/auth.ts`. Cache key auto-derives from params.

**No singletons.** Config on `c.var.config`. No `getInstance()`.

**Params are the Zod schema.** Single source of truth for param names, types,
ranges. Parse once, validated object flows everywhere.

**Derivative dimensions are canonical.** When a derivative is resolved, its
properties _replace_ explicit params. The cache key uses only the final resolved
values. This prevents the v1 key mismatch bug by construction.

### Extending

**New param** (e.g., `rotation`): `params/schema.ts` + strategy + routing rule. Done.
**New mode** (e.g., `gif`): `transform/strategies/gif.ts` + factory + schema enum. Done.
**New source** (e.g., GCS): `sources/gcs.ts` + router case + config schema. Done.
**New auth** (e.g., OAuth2): `sources/auth.ts` case + config schema. Done.
**New codec** (e.g., AV1): routing rule -> container, + ffmpeg args. Done.

---

## Media binding API

```typescript
// .input() — accepts ReadableStream<Uint8Array>
// .transform() — optional, resize/crop: { width, height, fit }
// .output() — mode + extraction options
// Result methods: .response(), .media(), .contentType()

const result = env.MEDIA.input(stream)
	.transform({ width, height, fit }) // optional (skip for audio)
	.output({ mode, time, duration, format, audio, imageCount });
await result.response(); // Response (ready to return/cache)
await result.media(); // ReadableStream<Uint8Array>
await result.contentType(); // string (e.g., 'video/mp4')
```

### Binding-supported options

**`.transform()`** (all optional):

- `width`: 10-2000 pixels
- `height`: 10-2000 pixels
- `fit`: `contain` | `cover` | `scale-down`

**`.output()`**:

- `mode`: `video` | `frame` | `spritesheet` | `audio`
- `time`: start timestamp string (e.g., `"2s"`, `"1m"`). Default `"0s"`.
- `duration`: output duration string (e.g., `"5s"`). Max 60s.
- `imageCount`: number of frames in spritesheet
- `format`: `jpg` | `png` (frame mode), `m4a` (audio mode)
- `audio`: boolean, include audio in video mode. Default `true`.
- `filename`: sets Content-Disposition header

### NOT in the binding (require container)

- quality, compression, crf — binding auto-optimizes
- fps, speed, bitrate — no rate control
- rotate, crop (arbitrary) — only fit:cover for center-crop
- codec selection (h265, vp9, av1) — binding outputs H.264 only
- duration > 60s — binding cap
- input > 100MB — binding cap (account overrides may raise this)

### Errors

`MediaError` extends `Error` with numeric `code`. Thrown at `.input()` (account limits)
or `.output()` (invalid params, unsupported format).

### Caching

NOT auto-cached. Must use Cache API explicitly.

### Limits

- Input: max 100MB, max 10 min duration
- Output: max 60s duration
- Dimensions: 10-2000px
- Format: H.264/AAC MP4 input recommended; animated GIF also works

### Local dev

`"remote": true` required in wrangler.jsonc. No local simulation.

---

## v1 feature parity checklist

Every feature from v1 must be accounted for in v2. Checked = implemented or
consciously eliminated (with rationale).

### URL parameters

- [ ] `width`, `height`, `fit` — binding `.transform()`
- [ ] `mode` (video/frame/spritesheet/audio) — binding `.output()`
- [ ] `time`, `duration` — binding `.output()`
- [ ] `audio` (true/false) — binding `.output()`
- [ ] `format` (jpg/png/m4a) — binding `.output()`
- [ ] `filename` — response Content-Disposition header
- [ ] `derivative` — resolved before binding, canonical dims
- [ ] `quality` (low/medium/high/auto) — container CRF; no-op for binding
- [ ] `compression` (low/medium/high/auto) — container preset; no-op for binding
- [ ] `fps` — container only
- [ ] `speed` — container only
- [ ] `rotate` — container only
- [ ] `crop` — container only
- [ ] `bitrate` — container only
- [ ] `loop`, `autoplay`, `muted`, `preload` — pass as response headers
- [ ] `debug` — triggers debug UI / skips cache
- [ ] `imageCount` — NEW in binding (v1 used columns/rows for spritesheets)

### Akamai/IMQuery translation

- [ ] `imwidth` -> derivative matching -> `width`
- [ ] `imheight` -> derivative matching -> `height`
- [ ] `imref` -> consumed for derivative context
- [ ] `impolicy` -> `derivative`
- [ ] `imformat` -> `format` (h264 passthrough; h265/vp9 -> container)
- [ ] `imdensity` -> `dpr` (responsive sizing)
- [ ] `im-viewwidth`, `im-viewheight`, `im-density` -> client hint injection
- [ ] `w`, `h`, `q`, `f`, `obj-fit`, `start`, `dur`, `mute`, `dpr` shorthands
- [ ] `fps`, `speed`, `crop`, `rotate`, `bitrate` shorthands

### Source types

- [ ] R2 direct binding (ReadableStream from bucket.get)
- [ ] Remote HTTP (fetch with optional auth)
- [ ] Fallback HTTP (lower priority, bg cache in Cache API)

### Auth

- [ ] AWS S3 presigned URLs via `aws4fetch`
- [ ] Bearer token from env var
- [ ] Custom header auth
- [ ] Presigned URL caching in KV with auto-refresh

### Caching

- [ ] Cache API as primary cache (replaces chunked KV)
- [ ] Deterministic cache key from resolved params (derivative canonical dims)
- [ ] Cache version management (KV-backed, for busting)
- [ ] Per-origin TTL (ok/redirects/clientError/serverError)
- [ ] Cache-Tag headers for purge-by-tag
- [ ] Cache bypass on `?debug`

### Middleware / interceptors

- [ ] Request coalescing (single-flight dedup)
- [ ] Range request handling (native via Cache API)
- [ ] Via header loop prevention
- [ ] Non-video passthrough (extension whitelist)
- [ ] CDN-CGI path passthrough (if still needed — may not be with binding)

### Error handling

- [ ] AppError + Hono onError
- [ ] MediaError catch -> AppError mapping
- [ ] Duration limit retry (extract max from error, retry)
- [ ] Alternative source retry (next source in priority list)
- [ ] Container fallback on oversized input
- [ ] Raw passthrough as last resort

### Container FFmpeg

- [ ] Proactive routing for container-only params
- [ ] Reactive fallback on MediaError
- [ ] Sync transform endpoint
- [ ] Async callback pattern (transform-and-callback)
- [ ] Container result callback handler (`/internal/container-result`)
- [ ] Quality presets (low/medium/high CRF+preset)

### Admin

- [ ] `GET /admin/config` — retrieve config from KV
- [ ] `POST /admin/config` — upload config to KV with Zod validation
- [ ] Bearer token auth

### Debug UI

- [ ] `?debug=view` triggers debug page from ASSETS binding
- [ ] Diagnostics injection: params, cache status, origin, timing, errors
- [ ] Debug response headers when debug enabled

### Response processing

- [ ] Content-Type correction (audio/mp4, image/jpeg, etc.)
- [ ] Content-Disposition from filename param
- [ ] Cache-Control headers (per-origin TTL, status-aware)
- [ ] Cache-Tag headers
- [ ] Accept-Ranges: bytes
- [ ] Playback hint headers (loop, autoplay, muted, preload)

### Config system

- [ ] Single Zod 4 schema (replaces 5 singleton managers)
- [ ] KV hot-reload with TTL-based freshness check
- [ ] Config passed via Hono context (no singletons)
- [ ] Origins + derivatives + responsive + passthrough + cache + container

### Analytics dashboard (D1)

- [ ] D1 database binding (`ANALYTICS`)
- [ ] Schema: `transform_log` table (ts, path, origin, status, mode, derivative, duration_ms, cache_hit, source_type, error_code)
- [ ] Middleware: log every request outcome to D1 (non-blocking via `waitUntil`)
- [ ] Weekly cron: `DROP TABLE` + recreate to keep D1 lean (7-day rolling window)
- [ ] `GET /admin/analytics` — JSON summary: success/failure counts, by status code, by origin, by derivative, p50/p95 latency
- [ ] `GET /admin/analytics/errors` — recent errors with path, status, error code
- [ ] Dashboard page in debug UI (served from ASSETS)

---

## Analytics dashboard — D1 design

### Purpose

Track transform success/failure rates, latency, cache hit ratios, and error
patterns. D1 is the right fit: SQL queries for aggregation, no external deps,
free tier generous (5M reads/day, 100K writes/day).

### D1 schema

```sql
CREATE TABLE IF NOT EXISTS transform_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,              -- Unix ms
  path     TEXT NOT NULL,                  -- request path
  origin   TEXT,                           -- matched origin name
  status   INTEGER NOT NULL,              -- HTTP response status
  mode     TEXT,                           -- video/frame/spritesheet/audio
  derivative TEXT,                         -- resolved derivative name
  duration_ms INTEGER,                     -- total request processing time
  cache_hit INTEGER NOT NULL DEFAULT 0,    -- 1=Cache API hit, 0=miss
  transform_source TEXT,                   -- 'binding', 'container', 'passthrough'
  source_type TEXT,                        -- 'r2', 'remote', 'fallback'
  error_code TEXT,                         -- AppError code or MediaError code
  bytes    INTEGER                         -- response content-length
);

CREATE INDEX IF NOT EXISTS idx_log_ts ON transform_log(ts);
CREATE INDEX IF NOT EXISTS idx_log_status ON transform_log(status);
```

### Write path

Middleware wraps every request. On response (both success and error), inserts
one row into `transform_log` via `ctx.waitUntil()`. The insert is fire-and-forget
— never blocks the response.

```typescript
// In analytics middleware (simplified)
ctx.waitUntil(
	env.ANALYTICS.prepare(
		'INSERT INTO transform_log (ts, path, origin, status, mode, derivative, duration_ms, cache_hit, transform_source, source_type, error_code, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	)
		.bind(Date.now(), path, origin, status, mode, derivative, durationMs, cacheHit, transformSource, sourceType, errorCode, bytes)
		.run(),
);
```

### Read path (admin API)

`GET /admin/analytics` returns aggregated stats. Bearer auth required (same as config API).

```typescript
// Summary query
SELECT
  COUNT(*) as total,
  SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) as success,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors,
  SUM(cache_hit) as cache_hits,
  AVG(duration_ms) as avg_latency_ms,
  -- Group by status code
  status, COUNT(*) as count
FROM transform_log
WHERE ts > ?  -- last 24h / 7d
GROUP BY status
ORDER BY count DESC;
```

Additional breakdowns:

- By origin: `GROUP BY origin`
- By derivative: `GROUP BY derivative`
- By transform source: `GROUP BY transform_source`
- By error code (errors only): `WHERE status >= 400 GROUP BY error_code`
- Latency percentiles: `ORDER BY duration_ms` with manual p50/p95 calc

### Weekly cron cleanup

Cron trigger runs once per week. Drops and recreates the table to prevent
unbounded D1 growth. 7-day rolling window is sufficient for operational
visibility; longer-term analytics belong in Workers Analytics Engine or
external systems.

```typescript
// In scheduled() handler
async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
  if (controller.cron === '0 0 * * 0') {  // Sunday midnight UTC
    await env.ANALYTICS.exec(`
      DROP TABLE IF EXISTS transform_log;
      CREATE TABLE IF NOT EXISTS transform_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        path TEXT NOT NULL,
        origin TEXT,
        status INTEGER NOT NULL,
        mode TEXT,
        derivative TEXT,
        duration_ms INTEGER,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        transform_source TEXT,
        source_type TEXT,
        error_code TEXT,
        bytes INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_log_ts ON transform_log(ts);
      CREATE INDEX IF NOT EXISTS idx_log_status ON transform_log(status);
    `);
    console.log(JSON.stringify({ level: 'info', msg: 'Weekly analytics cleanup completed', ts: Date.now() }));
  }
}
```

### Wrangler config additions

```jsonc
{
	"d1_databases": [{ "binding": "ANALYTICS", "database_name": "video-resizer-analytics", "database_id": "..." }],
	"triggers": {
		"crons": ["0 0 * * 0"], // Every Sunday at midnight UTC
	},
}
```

### Hono export pattern (fetch + scheduled)

Since Hono owns `fetch`, export both handlers:

```typescript
export default {
	fetch: app.fetch,
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		// Weekly D1 cleanup
	},
};
```

### Directory structure addition

```
src/
  analytics/
    middleware.ts   # Log every request outcome to D1
    queries.ts      # Aggregation queries for admin API
    schema.sql      # D1 table creation SQL (also used by cron)
  admin/
    analytics.ts    # GET /admin/analytics, GET /admin/analytics/errors
```

---

## Zod 4

Import from `zod` (version `^4.0.0`). Key API notes:

- `z.record(keySchema, valueSchema)` -- two-arg form required (unlike v3 one-arg)
- `z.interface()` for proper key-optionality alongside `z.object()`
- String formats top-level: `z.email()`, `z.uuid()`, `z.url()`
- Unified `error` param replaces `message`/`invalid_type_error`/`required_error`
- `.merge()` deprecated -> `a.extend(b.shape)`
- `.refine()` mixes with `.min()` etc. (no ZodEffects issue)
- `z.toJSONSchema()` built-in
- `zod/mini` available (~2KB gzipped) if bundle size matters
- `.catch(fallback)` for graceful degradation on invalid input

## Workers Logs

`console.log()` with JSON objects. Auto-indexed by Workers Logs.
`"observability": { "enabled": true }` in wrangler.jsonc. 256KB/invocation.

Structured log helper:

```typescript
function log(level: string, msg: string, data?: Record<string, unknown>) {
	console.log(JSON.stringify({ level, msg, ...data, ts: Date.now() }));
}
```

## Debug UI

`?debug=view` returns a JSON diagnostics response (no full Astro dashboard yet):

```json
{
  "diagnostics": {
    "requestId": "uuid",
    "path": "/rocky.mp4",
    "params": { "derivative": "tablet", "width": 1280, "height": 720 },
    "origin": { "name": "standard", "sources": [...], "ttl": {...} },
    "captures": { "videoId": "rocky", "extension": "mp4" },
    "config": { "derivatives": ["desktop","tablet","mobile","thumbnail"], ... },
    "needsContainer": false,
    "resolvedWidth": 1280,
    "resolvedHeight": 720
  }
}
```

Debug headers on every response:

- `X-Request-ID` — unique UUID per request
- `X-Processing-Time-Ms` — total transform time
- `X-Transform-Source` — `binding` or `cdn-cgi`
- `X-Origin`, `X-Source-Type`, `X-Source-Etag`
- `X-Derivative`, `X-Resolved-Width`, `X-Resolved-Height`
- `X-Cache-Key` — deterministic cache key
- `cf-cache-status` — set by Cloudflare edge (HIT/MISS/DYNAMIC)

## Build / Lint / Test

| Command              | Purpose                                        |
| -------------------- | ---------------------------------------------- |
| `npm run dev`        | Local dev (`wrangler dev`)                     |
| `npm run deploy`     | Deploy to Cloudflare                           |
| `npm test`           | Vitest (watch mode)                            |
| `npm run test:run`   | Vitest single run (142 unit tests)             |
| `npm run test:e2e`   | E2E tests against live `videos.erfi.io` (46)   |
| `npm run check`      | TypeScript type check                          |
| `npx wrangler types` | Regen types after binding changes              |

Single test: `npx vitest run test/path.spec.ts`
By name: `npx vitest run -t "pattern"`

## Code style

**Formatting**: single quotes, semicolons, trailing commas (ES5), 140 width, tabs.
**TypeScript**: strict, ES2022, Bundler resolution, no emit.
**Naming**: camelCase files, PascalCase classes/types (no prefix), UPPER_SNAKE constants.
**Imports**: local first, then external. Named exports. `index.ts` barrels.
**Testing**: Vitest + `@cloudflare/vitest-pool-workers` for unit, plain Vitest for E2E.
**Docs**: JSDoc on exports. Inline comments explain "why".

## Dependencies

Production: `hono`, `zod` (v4), `aws4fetch`, `@cloudflare/containers`. Four deps.

## Bindings (wrangler.jsonc)

```jsonc
{
	"media": { "binding": "MEDIA" },
	"r2_buckets": [{ "binding": "VIDEOS", "bucket_name": "videos" }],
	"kv_namespaces": [
		{ "binding": "CONFIG", "id": "96e2e31372ac424699539b1bca50b18f" },
		{ "binding": "CACHE_VERSIONS", "id": "548a5f4f87824d758542ace666293216" },
	],
	"d1_databases": [
		{ "binding": "ANALYTICS", "database_name": "video-resizer-analytics", "database_id": "69625b4d-21b1-40f0-a370-be81c12c5fb5" },
	],
	"containers": [
		{ "class_name": "FFmpegContainer", "image": "./container/Dockerfile", "max_instances": 5, "instance_type": "standard-1" },
	],
	"durable_objects": {
		"bindings": [{ "name": "FFMPEG_CONTAINER", "class_name": "FFmpegContainer" }],
	},
	"observability": { "enabled": true },
	"triggers": { "crons": ["0 0 * * sun"] },
	"routes": [{ "pattern": "videos.erfi.io", "custom_domain": true }],
}
```

Run `npx wrangler types` after any binding change.

## Current state (2026-03-27)

### Deployed on videos.erfi.io

Full three-tier transform pipeline live:
`via check → cdn-cgi passthrough → config (KV) → admin/internal routes →
non-video passthrough → Akamai translation → param parse → derivative resolve →
responsive sizing → origin match → debug=view diagnostics → cache lookup →
request coalescing → source resolution → transform (binding/cdn-cgi/container) →
response headers → tee body → client + cache.put + D1 analytics`

**Three-tier transform routing:**
- R2 sources (≤100MB) → `env.MEDIA.input(stream)` binding
- Remote sources (≤256MB) → `cdn-cgi/media` URL (edge transform, zero Worker memory)
- Oversized (>256MB) or container-only params → FFmpeg container DO
- Source fallback chain: if one tier fails, falls through to next source

**Cache working on `videos.erfi.io`:**
- `caches.default` with `body.tee()` (memory-safe at 128MB limit)
- `cf-cache-status: HIT` on second request (~0.1s vs ~9s)
- Range requests → 206 Partial Content with Content-Range
- Cache-Tag for purge-by-tag via Cloudflare API
- R2 etag in cache key (automatic busting), KV version for remote (manual busting)

**Note:** Cache did NOT work on `cdn.erfi.dev` — zone-level Bot Management or cache
rules were silently preventing `caches.default` from storing. Switched to `videos.erfi.io`.

### Live test results

```
rocky.mp4?derivative=tablet    → MISS 9s, HIT 0.1s (1280x720 video)
rocky.mp4?derivative=thumbnail → MISS 2.5s, HIT 0.1s (640x360 PNG frame)
rocky.mp4?impolicy=mobile      → Akamai translation → 854x640 video
erfi-135kg.mp4?derivative=thumbnail → 232MB source, frame in 11s via R2 binding
erfi-135kg.mp4?width=320&duration=5s → 232MB, 5s clip in 20s via R2 binding
big_buck_bunny_1080p.mov       → 725MB, async container (passthrough in 285ms + bg job)
Range: bytes=0-999             → 206, content-range: bytes 0-999/5216059
```

### Bindings (production)

| Binding            | Type          | Resource                              |
| ------------------ | ------------- | ------------------------------------- |
| `MEDIA`            | Media         | Media Transformations binding         |
| `VIDEOS`           | R2 Bucket     | `videos` (725MB + 232MB + 40MB)      |
| `CONFIG`           | KV            | `96e2e31372ac424699539b1bca50b18f`    |
| `CACHE_VERSIONS`   | KV            | `548a5f4f87824d758542ace666293216`    |
| `ANALYTICS`        | D1            | `video-resizer-analytics`             |
| `FFMPEG_CONTAINER` | Durable Object| FFmpegContainer (container DO)        |
| `CONFIG_API_TOKEN` | Secret        | Bearer token for admin endpoints      |

### Test commands

```bash
# Live transform
curl -s "https://videos.erfi.io/rocky.mp4?derivative=tablet" -o /dev/null -w "%{http_code} %{time_total}s\n"

# Debug diagnostics
curl -s "https://videos.erfi.io/rocky.mp4?derivative=tablet&debug=view" | jq .

# Cache bust
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"path":"/rocky.mp4"}' "https://videos.erfi.io/admin/cache/bust"

# Analytics
curl -s -H "Authorization: Bearer $TOKEN" "https://videos.erfi.io/admin/analytics?hours=24" | jq .

# Tail logs
npx wrangler tail --format json

# Run tests
npm run test:run    # 142 unit tests
npm run test:e2e    # 46 E2E tests (live HTTP)

# Deploy
npx wrangler deploy

# Check R2 contents
rclone ls erfi:videos/
```

---

## Implementation progress

### Completed (142 unit tests + 46 E2E tests, all passing)

**Core pipeline:**
- [x] `src/index.ts` — Hono app, full middleware pipeline, three-tier transform routing
- [x] `src/errors.ts` — AppError class (6 tests)
- [x] `src/log.ts` — Structured JSON logging for Workers Logs
- [x] `src/types.ts` — Env bindings interface (MEDIA, VIDEOS, CONFIG, ANALYTICS, FFMPEG_CONTAINER)

**Config:**
- [x] `src/config/schema.ts` — Zod 4 schema: origins, derivatives, responsive, passthrough, container (10 tests)
- [x] `src/config/loader.ts` — KV hot-reload, 5-min TTL, v1 nested format compat

**Params:**
- [x] `src/params/schema.ts` — All canonical params, Akamai/IMQuery translation, `needsContainer()`, `parseImRef()` (44 tests)
- [x] `src/params/derivatives.ts` — Derivative resolution, canonical dims invariant (6 tests)
- [x] `src/params/responsive.ts` — Client Hints / CF-Device-Type auto-sizing (11 tests)

**Sources:**
- [x] `src/sources/router.ts` — Origin matching, capture groups, source path resolution (8 tests)
- [x] `src/sources/auth.ts` — AWS S3 (aws4fetch), bearer, header auth (6 tests)
- [x] `src/sources/fetch.ts` — Two-tier source resolution (R2 stream / remote URL)
- [x] `src/sources/presigned.ts` — S3 presigned URL generation + KV caching

**Transform:**
- [x] `src/transform/binding.ts` — env.MEDIA pipeline with MediaError catch (both `code` property and message pattern)
- [x] `src/transform/cdncgi.ts` — cdn-cgi/media URL construction + fetch with version busting
- [x] `src/transform/container.ts` — FFmpegContainer DO class + sync/async transform client
- [x] `container/Dockerfile` — node:22-slim + ffmpeg
- [x] `container/server.mjs` — HTTP server: /transform (sync), /transform-async (callback), /health

**Cache:**
- [x] `src/cache/key.ts` — Deterministic key with etag, version, imageCount (16 tests)
- [x] `src/cache/store.ts` — caches.default helpers (match/put/delete)
- [x] `src/cache/version.ts` — KV-backed get/bump/set/delete (8 tests)
- [x] `src/cache/coalesce.ts` — BoundedLRU request dedup (5 tests)

**Analytics:**
- [x] `src/analytics/middleware.ts` — D1 insert via waitUntil (cache hits + transform completions + errors)
- [x] `src/analytics/queries.ts` — Summary aggregation (totals, hit rate, p50/p95, by status/origin/derivative/source)
- [x] `src/analytics/schema.sql` — D1 table DDL

**Admin:**
- [x] `GET /admin/config` — retrieve config with auth
- [x] `POST /admin/config` — upload config with Zod validation
- [x] `POST /admin/cache/bust` — bump version for a path
- [x] `GET /admin/analytics` — summary with `?hours=N`
- [x] `GET /admin/analytics/errors` — recent errors with `?hours=N&limit=N`
- [x] `POST /internal/container-result` — async container callback handler

**Tests:**
- [x] `test/` — 11 unit test files, 142 tests (Vitest + Workers pool)
- [x] `test/e2e/live.spec.ts` — 46 E2E tests (Vitest + Node, live HTTP to videos.erfi.io)
- [x] `vitest.config.ts` — Workers pool config (excludes E2E)
- [x] `vitest.e2e.config.ts` — Node config for E2E (60s timeout)

**Error recovery:**
- [x] Duration limit retry (extract max from MediaError, re-fetch R2, retry)
- [x] Alternative source retry (for-loop over sorted sources with fallback)
- [x] Container fallback (reactive: binding fails → container; proactive: size > 100MB → container)
- [x] Raw passthrough as last resort (serve untransformed source)
- [x] Raw passthrough detection (cdn-cgi returns raw source when transforms not enabled)

**Container async (725MB+ files):**
- [x] URL-based async endpoint (`/transform-url`) — container fetches source directly
- [x] Worker returns immediate passthrough (285ms, `X-Transform-Pending: true`)
- [x] Passthrough responses NOT cached (prevents stale raw source in cache)
- [x] Callback URL includes original request URL for correct cache key placement
- [x] Container accepts jobs (202), starts downloading + ffmpeg in background

**Logging:**
- [x] Breadcrumb-style tracing — every log line includes `requestId` UUID
- [x] Scoped `rlog` logger in transform handler, covers entire request lifecycle
- [x] Error handler logs include `path` for correlation
- [x] D1 analytics logs cache hits, transform completions, and error responses

**Response processing:**
- [x] Content-Type correction (audio/mp4, image/jpeg, image/png)
- [x] Content-Disposition from filename param
- [x] Cache-Control (per-origin TTL, status-aware)
- [x] Cache-Tag (derivative, origin, mode, per-origin tags)
- [x] Playback hint headers (X-Playback-Loop/Autoplay/Muted/Preload)
- [x] Accept-Ranges: bytes
- [x] Via: video-resizer (loop prevention)
- [x] Set-Cookie and Vary: * stripping before cache.put

### Remaining

- [ ] **Debug UI frontend** — Astro+React dashboard from ASSETS binding.
      `?debug=view` JSON diagnostics works as lightweight replacement.
- [ ] **Container video transcoding E2E verification** — test large video output
      stored in cache and served with range requests. Frame extraction is confirmed
      working end-to-end.

### Fixed (previously remaining)

- [x] **Container callback completion** — fixed 4 bugs in the async callback loop:
      1. Container output file path mismatch — `handleTransform` and `handleTransformAsync`
         read from `.mp4` path even for frame/audio modes; now use `findOutputFile()`.
      2. Self-referencing URL loop — R2-only sources used `https://{zone}/{path}` as the
         container fetch URL, which would hit our own transform pipeline. Now uses
         `/internal/r2-source?key=...` endpoint that serves raw R2 objects.
      3. Cache key method mismatch — callback handler created a bare `new Request(url)`,
         while the Cache API only stores GET responses. Now explicitly sets `method: 'GET'`.
      4. Temp file cleanup — `handleTransform` and `handleTransformAsync` now clean up
         alternative output extensions (.png, .jpg, .m4a, .webm).
- [x] **Container DO instance key collision** — each unique (origin, path, params)
      combination now gets its own DO instance via `buildContainerInstanceKey()` which
      hashes transform-affecting params with FNV-1a. 9 unit tests verify correctness.
- [x] **Extract index.ts** — 777 lines split into 5 middleware files + 3 handler files.
      `index.ts` is now 70 lines of wiring only. 151 unit tests passing.

### Known flaws (to fix)

**Container video output not verified in cache:** Frame extraction (26KB JPEG) from
big_buck_bunny was confirmed working end-to-end (container downloaded 725MB, extracted
frame, POSTed to callback, cached, served from cache). But video transcoding output
(which could be 50-200MB) has NOT been verified stored and served from Cache API with
range requests. The concern: Cache API has a 512MB per-entry limit (should be fine),
but the container needs enough disk to hold both the 725MB input and the output
simultaneously, and the callback POST needs to transfer the full output through CF.

**Passthrough caching race:** When the first request returns a raw passthrough
(`X-Transform-Pending: true`), subsequent requests before the container finishes may
also get passthrough. With `shouldCache` skip for pending responses, these don't cache
the raw source. But the CDN edge cache (`cf-cache-status`) is separate from Worker
`caches.default` — the CDN may cache the passthrough response independently. This
means the CDN could serve stale passthrough even after the container result is cached
in `caches.default`. The Worker's `cache.match()` runs before CDN serves, so it should
find the container result — but CDN behavior at the edge is not fully controllable.

**Container `standard-1` resource limits:** The `standard-1` instance type provides
limited disk. Downloading a 725MB file + running ffmpeg (which creates temp files)
may exceed available disk. If the container runs out of disk, ffmpeg fails silently
and the callback either doesn't fire or sends an error. Consider `standard-2` or
higher for production use with files > 500MB.

**cdn-cgi/media allowed origins:** Media Transformations on erfi.io requires source
origins to be whitelisted in the CF dashboard (Stream → Transformations → Sources).
Currently `videos.erfi.dev` is added. Any new remote source domains need to be added
manually or set to "any origin".

### Done (previously remaining)

- [x] **Enable Media Transformations on erfi.io zone** — enabled, cdn-cgi/media working.
      `videos.erfi.dev` added to allowed origins. Remote sources (≤256MB) now transform
      at the edge via cdn-cgi (zero Worker memory). Verified: rocky.mp4 frame in 0.27s,
      tablet video in 6.5s, erfi-135kg 1280x720 30s clip in 15.6s — all via cdn-cgi.
