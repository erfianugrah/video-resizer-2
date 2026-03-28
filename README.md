# video-resizer-2

Video transformation service on Cloudflare Workers. Accepts video URLs, applies transforms (resize, crop, extract frames, spritesheets, audio extraction), and serves cached results with range request support.

Rewrite of [video-resizer v1](../video-resizer/) (~40K lines) using the Media Transformations binding, Hono, Zod 4, and Cloudflare Containers. ~4K lines.

**Live:** https://videos.erfi.io

## Quick start

```bash
npm install
npm run dev                   # local dev (wrangler dev)
npm run deploy                # deploy to Cloudflare
npm run test:run              # 180 unit/integration tests
npm run test:e2e              # 74 E2E tests against live deployment
npm run test:browser          # 22 Playwright browser tests
npm run test:smoke            # 64 smoke tests against live
npm run check                 # TypeScript strict mode
```

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
  -> Request coalescing (per-isolate LRU dedup)
  -> Source resolution (R2 binding / remote HTTP / fallback)
  -> Transform (binding / cdn-cgi / container queue)
  -> Response (tee -> client + R2 + edge cache + D1 analytics)
```

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | Request pipeline, three-tier routing, container async flow, dedup stack |
| [Parameters](docs/parameters.md) | All transform params, Akamai/IMQuery translation, derivatives, responsive sizing |
| [Container & Queue](docs/container.md) | FFmpeg container, queue-based job pipeline, progress tracking, source dedup |
| [Caching](docs/caching.md) | Edge + R2 cache layers, cache keys, range requests, cache busting |
| [Configuration](docs/configuration.md) | Config schema, origins, sources, auth types, deployment setup |
| [API Reference](docs/api.md) | All HTTP endpoints, admin API, WebSocket, response headers |

## Project structure

```
src/
  index.ts                    # Hono app wiring (routes + middleware + exports)
  types.ts, errors.ts, log.ts # Core types, error class, structured logging
  config/                     # Zod 4 schema + KV hot-reload loader
  middleware/                  # via, config, passthrough, auth, error
  handlers/                   # admin, transform, jobs, dashboard, internal
  params/                     # param parsing, Akamai translation, derivatives, responsive
  transform/                  # Media binding, cdn-cgi, FFmpeg container + job DO
  sources/                    # origin routing, auth (S3/bearer/header), presigned URLs
  cache/                      # cache keys, edge store, version registry, request coalescing
  analytics/                  # D1 analytics middleware + aggregation queries
  queue/                      # Queue consumer + D1 job registry
container/
  Dockerfile                  # node:22-slim + ffmpeg
  server.mjs                  # HTTP server: /transform, /transform-url, /health
dashboard/
  src/components/Dashboard.tsx # React: Analytics, Jobs, Debug tabs
scripts/
  smoke.ts                    # Standalone smoke test (64 checks)
test/                         # 180 unit + 74 E2E + 22 browser tests
```

## Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `MEDIA` | Media Transformations | Video transform binding |
| `VIDEOS` | R2 Bucket | Source videos + transform cache + source cache |
| `CONFIG` | KV | Worker configuration |
| `CACHE_VERSIONS` | KV | Cache version registry for manual busting |
| `ANALYTICS` | D1 | Request analytics + job registry |
| `FFMPEG_CONTAINER` | Container DO | FFmpeg transforms (4 vCPU, 12GB RAM, 20GB disk) |
| `TRANSFORM_JOB` | Durable Object | Job state machine + WebSocket progress |
| `TRANSFORM_QUEUE` | Queue | Durable job dispatch with retry + DLQ |
| `ASSETS` | Static Assets | Dashboard UI |
| `CONFIG_API_TOKEN` | Secret | Bearer token for admin endpoints |

## Dependencies

4 production dependencies: `hono`, `zod` (v4), `aws4fetch`, `@cloudflare/containers`.
