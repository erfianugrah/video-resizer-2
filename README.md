# video-resizer-2

Video transformation service on Cloudflare Workers. Accepts video URLs, applies transforms (resize, crop, extract frames, spritesheets, audio extraction), and serves cached results with range request support.

Rewrite of video-resizer v1 (~40K lines) using the Media Transformations binding, Hono, Zod 4, and Cloudflare Containers. ~4K lines.

## Quick start

```bash
npm install
npm run dev                   # local dev (wrangler dev)
npm run deploy                # deploy to Cloudflare
npm run test:run              # 186 unit/integration tests
npm run test:e2e              # 92 E2E tests against live deployment
npm run test:browser          # 22 Playwright browser tests
npx tsx scripts/smoke.ts      # 84 smoke tests against live
npm run check                 # TypeScript strict mode
```

See [SETUP.md](SETUP.md) for detailed setup from scratch.

## Architecture

Three-tier transform pipeline:

| Tier | Source | Size Limit | Method | Latency |
|------|--------|-----------|--------|---------|
| 1 | R2 | <=100MB | `env.MEDIA.input(stream)` binding | ~2-10s |
| 2 | Remote/Fallback | <=100 MiB | `cdn-cgi/media` URL (edge, zero Worker memory) | ~3-15s |
| 3 | Any | >100 MiB or container-only params | FFmpeg Container DO via Cloudflare Queue | ~60-300s (async) |

Container transforms are queue-based: enqueue -> consumer dispatches to container -> container stores result in R2 -> next request serves from R2. Jobs survive deploys.

```
Request
  -> Edge cache (cf-cache-status: HIT)
  -> R2 persistent store (_transformed/{key})
  -> Request coalescing (per-isolate signal-based dedup)
  -> Source resolution (R2 binding / remote HTTP / fallback)
  -> Transform (binding / cdn-cgi / container queue)
  -> Response (stream -> R2 + edge cache + D1 analytics)
```

## Project structure

```
src/
  index.ts                    # Hono app wiring (routes + middleware + exports)
  types.ts, errors.ts, log.ts # Core types, error class, structured logging
  util.ts                     # Shared utilities (timingSafeEqual)
  config/                     # Zod 4 schema + KV hot-reload loader
  middleware/                  # via, config, passthrough, auth, error
  handlers/                   # admin, transform, jobs, dashboard, internal
  params/                     # param parsing, Akamai translation, derivatives, responsive
  transform/                  # Media binding, cdn-cgi, FFmpeg container + job types
  sources/                    # origin routing, auth (S3/bearer/header), presigned URLs
  cache/                      # cache keys, version registry, request coalescing
  queue/                      # Queue consumer, DLQ consumer, D1 job registry
  analytics/                  # D1 analytics middleware + aggregation queries + schema.sql
container/
  Dockerfile                  # node:22-slim + ffmpeg
  server.mjs                  # HTTP server: /transform, /transform-url, /health
dashboard/
  src/components/             # Dashboard.tsx, AnalyticsTab, JobsTab, DebugTab, shared
scripts/
  smoke.ts                    # Standalone smoke test (84 checks)
test/                         # 186 unit + 92 E2E + 22 browser tests
```

## Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `MEDIA` | Media Transformations | Video transform binding |
| `VIDEOS` | R2 Bucket | Source videos + transform cache + source cache |
| `CONFIG` | KV | Worker configuration |
| `CACHE_VERSIONS` | KV | Cache version registry for manual busting |
| `ANALYTICS` | D1 | Request analytics + job registry (schema.sql) |
| `FFMPEG_CONTAINER` | Container DO | FFmpeg transforms (4 vCPU, 12GB RAM, 20GB disk) |
| `TRANSFORM_QUEUE` | Queue | Durable job dispatch with retry + DLQ |
| `ASSETS` | Static Assets | Dashboard UI |
| `CONFIG_API_TOKEN` | Secret | Bearer token for admin endpoints |

## Dependencies

4 production dependencies: `hono`, `zod` (v4), `aws4fetch`, `@cloudflare/containers`.

## Transform examples

```bash
# Resize video
curl https://your-domain.com/video.mp4?width=640&height=360

# Named derivative preset
curl https://your-domain.com/video.mp4?derivative=tablet

# Extract frame as JPEG
curl https://your-domain.com/video.mp4?mode=frame&time=5s&width=320

# Extract audio
curl https://your-domain.com/video.mp4?mode=audio&duration=30s

# Spritesheet
curl https://your-domain.com/video.mp4?mode=spritesheet&duration=10s&imageCount=10

# Akamai/IMQuery compatibility
curl https://your-domain.com/video.mp4?imwidth=1280&impolicy=tablet

# Debug diagnostics
curl https://your-domain.com/video.mp4?derivative=tablet&debug=view
```

## Admin API

All admin endpoints require `Authorization: Bearer <CONFIG_API_TOKEN>`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/config` | GET | Retrieve current config |
| `/admin/config` | POST | Upload new config (Zod validated) |
| `/admin/cache/bust` | POST | Bust cache for a path `{"path": "/video.mp4"}` |
| `/admin/analytics` | GET | Analytics summary `?hours=24` |
| `/admin/analytics/errors` | GET | Recent errors `?hours=24&limit=50` |
| `/admin/jobs` | GET | Container job list `?hours=24&active=true&filter=text` |
| `/admin/dashboard` | GET | Dashboard UI (cookie auth) |
| `/sse/job/:id` | GET | SSE progress stream for a container job |
