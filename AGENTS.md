# AGENTS.md

Cloudflare Worker for on-the-fly video transformation. Hono + Zod 4 + Media
Transformations binding + FFmpeg container fallback. ~4K lines, 4 prod deps.

## Key docs — read before coding

- `README.md` — overview, quick start, project structure, bindings, examples
- `SETUP.md` — step-by-step from scratch (resources, D1 schema, secrets, deploy)
- `docs/architecture.md` — request pipeline, three-tier routing, cache layers
- `docs/parameters.md` — all transform params, Akamai/IMQuery translation
- `docs/container.md` — FFmpeg container, queue-based jobs, SSE progress
- `docs/caching.md` — edge + R2 cache, cache keys, range requests, busting
- `docs/configuration.md` — config schema, origins, sources, auth types
- `docs/api.md` — all HTTP endpoints, admin API, SSE, response headers

## External docs — always check before coding

- Workers: https://developers.cloudflare.com/workers/
- Media binding: https://developers.cloudflare.com/stream/transform-videos/bindings/
- Media options: https://developers.cloudflare.com/stream/transform-videos/#options
- R2 API: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- Hono: https://hono.dev/docs/
- Zod 4: import from `zod` (v4) — `z.record(key, val)` two-arg, `.merge()` deprecated
- Akamai IMQuery: https://techdocs.akamai.com/ivm/docs/imquery

## Architecture (brief)

Three-tier transform: R2→binding (≤100MB), remote→cdn-cgi (≤100MiB),
oversized/container-only→FFmpeg Container DO via Queue. Results stored in R2
(global), promoted to edge cache (`caches.default`) per-colo. D1 for analytics
+ job registry. SSE for real-time job progress.

## Directory layout

```
src/
  index.ts              # Hono wiring (~95 lines)
  types.ts, errors.ts   # Env interface, AppError
  log.ts, util.ts       # Structured logging, timingSafeEqual
  config/               # Zod 4 schema + KV hot-reload loader
  middleware/            # via, config, passthrough, auth, error
  handlers/             # admin, transform, jobs (SSE), dashboard, internal
  params/               # schema (parse + Akamai), derivatives, responsive
  transform/            # binding, cdncgi, container (DO + outbound), job types
  sources/              # router, auth (S3/bearer/header), presigned
  cache/                # key, version, coalesce (signal pattern)
  queue/                # consumer + DLQ, jobs-db (D1 CRUD)
  analytics/            # middleware (D1 insert), queries, schema.sql (SSOT)
container/              # Dockerfile + server.mjs (ffmpeg HTTP server)
dashboard/              # Astro + React (AnalyticsTab, JobsTab, DebugTab, shared)
```

## Build / Test

| Command              | Purpose                              |
| -------------------- | ------------------------------------ |
| `npm run dev`        | Local dev (`wrangler dev`)           |
| `npm run deploy`     | Deploy to Cloudflare                 |
| `npm run test:run`   | 186 unit tests (Workers pool)        |
| `npm run test:e2e`   | 92 E2E tests (live HTTP)             |
| `npm run test:browser` | 22 Playwright tests (Chromium)     |
| `npx tsx scripts/smoke.ts` | 84 smoke tests (post-deploy)  |
| `npm run check`      | TypeScript type check                |

Single test: `npx vitest run test/path.spec.ts`
E2E/smoke need `CONFIG_API_TOKEN` env var. Domain configurable via `TEST_BASE_URL`.

## Code style

Single quotes, semicolons, trailing commas (ES5), tabs, 140 width.
Strict TypeScript, ES2022, Bundler resolution. camelCase files, PascalCase types.
JSDoc on exports. Inline comments explain "why".

## Key patterns

**Config:** one Zod 4 schema, validated once at startup, passed via `c.var.config`.
No singletons, no `getInstance()`.

**Params:** parse once from URLSearchParams via Zod. Akamai translation is a pure
function producing new URLSearchParams. `needsContainer()` is pure. Derivative
dims replace explicit params (canonical invariant).

**Cache key:** `{mode}:{path}[:w=][:h=][:t=][:d=][:fit=][:a=][:q=][:c=][:e=][:v=]`.
Includes ALL transform-affecting params. Derivative name excluded (only resolved
dims matter).

**Coalescer:** signal pattern — stores `Promise<void>`, joiners await then read
from cache independently. No `.clone()`, no `.tee()`, no shared Response objects.

**Streams:** never `arrayBuffer()` on large bodies (128MB Worker limit). R2 `put()`
accepts `ReadableStream` directly. `pipeTo()` always has `.catch()`.

**Container outbound:** intercepts all HTTP from container. Callback POSTs →
R2 store. Progress reports → D1 (percent column). Source downloads → HTTPS
(with R2 dedup for concurrent containers).

**Queue consumer:** stateless retry-until-done. Check R2 → dispatch → retry 120s.
No `'failed'` on retryable errors. DLQ consumer marks terminal failures.
D1 `status` only transitions `pending → downloading` on first attempt.

**SSE:** `GET /sse/job/:id` polls D1 every 2s, streams `data: {status, percent}`.
Auto-closes on terminal state. Dashboard uses `EventSource` (auto-reconnect).

## Bindings

MEDIA (Media), VIDEOS (R2), CONFIG (KV), CACHE_VERSIONS (KV), ANALYTICS (D1),
FFMPEG_CONTAINER (DO), TRANSFORM_QUEUE (Queue), ASSETS (Static), CONFIG_API_TOKEN (Secret).

D1 schema: `src/analytics/schema.sql` is the single source of truth.
Init: `npx wrangler d1 execute video-resizer-analytics --remote --file=src/analytics/schema.sql`

## Dependencies

Production: `hono`, `zod` (v4), `aws4fetch`, `@cloudflare/containers`. Four deps.
