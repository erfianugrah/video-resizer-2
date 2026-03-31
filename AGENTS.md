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
dashboard/              # Astro + React + Radix UI + CVA (Lovelace design system)
  src/components/ui/    # Primitives: Button, Card, Badge, Table, Tabs, Skeleton, Input
  src/lib/              # cn(), typography tokens (T), format helpers, color maps
```

## Build / Test

| Command                       | Purpose                          |
| ----------------------------- | -------------------------------- |
| `npm run dev`                 | Local dev (`wrangler dev`)       |
| `npm run deploy`              | Build dashboard + deploy         |
| `npm run check`               | TypeScript type check (`tsc`)    |
| `npm run test:run`            | All unit tests (Workers pool)    |
| `npm run test:e2e`            | E2E tests (live HTTP)            |
| `npm run test:browser`        | Playwright tests (Chromium)      |
| `npm run test:smoke`          | Smoke tests (post-deploy)        |
| `npm run test:smoke:container`| Container smoke tests            |

**Single test file:** `npx vitest run test/path.spec.ts`
**Single test by name:** `npx vitest run -t "test name pattern"`
**Watch mode:** `npx vitest test/path.spec.ts`

E2E/smoke need `CONFIG_API_TOKEN` env var. Domain configurable via `TEST_BASE_URL`.

## Code style

- **Formatting:** tabs for indentation, 140 char line width, single quotes,
  semicolons, trailing commas (ES5).
- **TypeScript:** strict mode, ES2022 target, Bundler module resolution.
  `noEmit` — types checked but never compiled (Wrangler bundles).
- **File naming:** camelCase (`cacheKey.ts`). PascalCase for types/interfaces.
- **JSDoc:** required on all exported functions/types. Inline comments explain
  "why", not "what".
- **No default exports** except the Worker entry (`src/index.ts`).

### Imports

- Use `import type` for type-only imports: `import type { Env } from './types'`.
- Group imports: external packages first, then internal modules, blank line
  between groups. Named imports only (no `import *` except `import * as log`).
- Zod v4: always `import { z } from 'zod'` — never import from `zod/v4` or
  `zod/lib`. Use two-arg `z.record(keySchema, valSchema)`. No `.merge()`.

### Error handling

- Throw `AppError(status, code, message, details?)` for all expected errors.
  Hono's `app.onError` catches and returns JSON — no per-handler try/catch.
- Machine-readable `code` uses SCREAMING_SNAKE: `'INVALID_PARAMS'`,
  `'SOURCE_NOT_FOUND'`, `'TRANSFORM_FAILED'`.
- Never swallow errors silently. Log unexpected errors via `log.error()`.

### Types

- Hono app type: `Hono<{ Bindings: Env; Variables: Variables }>`.
- Handler context provides `c.env` (bindings) and `c.var` (middleware vars).
- Config accessed via `c.var.config` (set by `configMiddleware`).
- Prefer `interface` for object shapes, `type` for unions/intersections.

## Key patterns

**Config:** one Zod 4 schema, validated once at startup, passed via `c.var.config`.
No singletons, no `getInstance()`.

**Params:** parse once from URLSearchParams via Zod. Akamai translation is a pure
function producing new URLSearchParams. `needsContainer()` is pure. Derivative
dims replace explicit params (canonical invariant).

**Cache key:** `{mode}:{path}[:w=][:h=][:t=][:d=][:fit=][:a=][:q=][:c=][:fps=][:spd=][:rot=][:crop=][:br=]`.
No version or etag in key — source freshness validated via R2 metadata on every
HIT. Container-only params (fps, speed, rotate, crop, bitrate) included when
present. KV version appended only on manual force-bust. Derivative name excluded
(only resolved dims matter).

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
Dev: `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, `@playwright/test`,
`typescript` (v6), `vitest` (~3.2), `wrangler` (v4).
