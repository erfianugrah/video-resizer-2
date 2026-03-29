# Fixes Plan

Verified issues from codebase review, cross-checked against Cloudflare docs,
aws4fetch source code, and Workers runtime APIs. Each fix is scoped, with file
locations and the exact change required. Ordered by severity.

**API verification notes (2026-03-29):**
- R2 `put()` accepts `ReadableStream` directly — no `FixedLengthStream` required.
  `FixedLengthStream` is only needed to set `Content-Length` on a *Response* header.
  Confirmed via CF docs: `await env.MY_BUCKET.put(key, request.body)`.
- `Response.clone()` internally tees the body. Once body is locked/consumed,
  `.clone()` throws `TypeError`. Cache-backed responses (from `cache.match()`)
  are re-readable, but live-stream responses are not.
- `ReadableStream.tee()` is lazy — it only buffers data when one branch is read
  faster than the other. But it cannot be called twice on the same stream (the
  stream becomes locked after the first tee). Multiple concurrent `.tee()` callers
  on the same stream will race and crash.
- `aws4fetch` with `signQuery: true` unconditionally overwrites `X-Amz-Date`,
  `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-SignedHeaders`, and
  `X-Amz-Security-Token` on the URL search params (verified at
  `node_modules/aws4fetch/dist/aws4fetch.esm.mjs:104-123`). Only `X-Amz-Expires`
  is preserved (line 118: `if (!params.has('X-Amz-Expires'))`).
- Workers 128MB memory limit. `arrayBuffer()` on a container output (which exists
  precisely for >100MB files) is a guaranteed OOM. The no-Content-Length path must
  stream, never buffer.

---

## 1. Cache key missing video-mode params

**Severity:** High — data correctness bug. Two requests with different `time`,
`duration`, `fit`, or `audio` values produce identical cache keys in video mode,
returning wrong cached results.

**File:** `src/cache/key.ts:52-55`

**Current code (lines 37-56):**
```typescript
switch (mode) {
  case 'frame':
    if (params.time) key += `:t=${params.time}`;
    if (params.format) key += `:f=${params.format}`;
    break;
  case 'spritesheet':
    if (params.time) key += `:t=${params.time}`;
    if (params.duration) key += `:d=${params.duration}`;
    if (params.imageCount) key += `:ic=${params.imageCount}`;
    break;
  case 'audio':
    if (params.time) key += `:t=${params.time}`;
    if (params.duration) key += `:d=${params.duration}`;
    if (params.format) key += `:f=${params.format}`;
    break;
  default: // video
    if (params.quality) key += `:q=${params.quality}`;
    if (params.compression) key += `:c=${params.compression}`;
    break;
}
```

**Fix:** Add `time`, `duration`, `fit`, and `audio` to the video (default) case.
Also add `fit` to `frame` and `spritesheet` since it affects visual output.

```typescript
default: // video
  if (params.time) key += `:t=${params.time}`;
  if (params.duration) key += `:d=${params.duration}`;
  if (params.fit) key += `:fit=${params.fit}`;
  if (params.audio !== undefined) key += `:a=${params.audio}`;
  if (params.quality) key += `:q=${params.quality}`;
  if (params.compression) key += `:c=${params.compression}`;
  break;
```

And add `fit` to frame/spritesheet cases. Audio doesn't affect those modes.

**Tests to update:** `test/cache/key.spec.ts` — add cases for video mode with
time, duration, fit, audio params producing distinct keys.

---

## 2. Unauthenticated `/internal/r2-source` endpoint

**Severity:** High — exposes arbitrary R2 objects to unauthenticated requests.

**File:** `src/handlers/internal.ts:85-112`

The Hono route `GET /internal/r2-source` is publicly accessible. The container
outbound handler (`container.ts:254`) intercepts the same path for container
traffic, so the Hono route only serves direct external requests — with no auth.

**Fix:** Add auth check at the top of `getR2Source`. Use `requireAuth(c)` (same
as admin routes). Container requests go through the outbound handler and never
hit this route, so adding auth won't break the container.

```typescript
export async function getR2Source(c: HonoContext) {
  requireAuth(c);
  // ... rest unchanged
}
```

---

## 3. `pipeTo()` without await or `.catch()`

**Severity:** High — unhandled promise rejection if stream errors.

**Files and lines:**
- `src/transform/container.ts:225` — outbound handler R2 store
- `src/transform/container.ts:314` — outbound handler source dedup
- `src/handlers/transform.ts:794` — transform handler R2 store

**Verified:** Cannot `await pipeTo()` because the `r2.put()` on the readable
end drives backpressure — they must run concurrently. `pipeTo` is correctly
left un-awaited, but it MUST have `.catch()` to prevent unhandled rejection.

`container.ts:314` already has `.catch(() => {})` — but it silently swallows
errors. Should at minimum log.

**Fix:** Add `.catch()` with logging to all three locations:

```typescript
// container.ts:225
body.pipeTo(fixedStream.writable).catch((err) => {
  log.error('pipeTo failed in container outbound', {
    error: err instanceof Error ? err.message : String(err),
  });
});

// container.ts:314 — replace silent swallow with logging
stream2.pipeTo(fixed.writable).catch((err) => {
  log.warn('Source dedup pipeTo failed', {
    error: err instanceof Error ? err.message : String(err),
  });
});

// transform.ts:794
transformed.body.pipeTo(fixedStream.writable).catch((err) => {
  log.error('pipeTo failed in transform R2 store', {
    error: err instanceof Error ? err.message : String(err),
  });
});
```

---

## 4. Container OOM on large outputs without Content-Length

**Severity:** High — `new Response(body).arrayBuffer()` at `container.ts:228`
loads entire output into Worker memory. Container outputs can be hundreds of MB.
The whole point of the container is handling files too large for Worker memory
(>100MB up to 6 GiB). Buffering via `arrayBuffer()` defeats this entirely.

**File:** `src/transform/container.ts:218-230`

**Verified:** R2 `put()` accepts `ReadableStream` directly per CF docs:
`await env.MY_BUCKET.put(key, request.body)`. No `FixedLengthStream` required.
`FixedLengthStream` only matters for setting `Content-Length` on Response/Request
headers — R2 handles stream sizing internally without loading into Worker memory.

**Fix:** When Content-Length is missing, pass the body stream directly to R2.
Remove the `arrayBuffer()` fallback entirely:

```typescript
if (contentLength) {
  const fixedStream = new FixedLengthStream(parseInt(contentLength, 10));
  body.pipeTo(fixedStream.writable).catch((err) =>
    log.error('pipeTo failed', { error: err instanceof Error ? err.message : String(err) })
  );
  await r2.put(r2Key, fixedStream.readable, r2Metadata);
} else {
  // No Content-Length — stream directly to R2. R2 accepts ReadableStream
  // and handles sizing internally (no Worker memory buffering).
  // Container server.mjs always sends Content-Length via stat(), so this
  // path is purely defensive.
  log.warn('Container callback missing Content-Length, streaming directly to R2', { r2Key });
  await r2.put(r2Key, body, r2Metadata);
}
```

**Same pattern for `transform.ts:791-810`:** The no-Content-Length fallback at
line 803-809 currently skips R2 and uses edge-cache-only. This should also
stream directly to R2:

```typescript
} else {
  // No Content-Length — stream directly to R2 (R2 accepts ReadableStream)
  log.warn('No Content-Length, streaming directly to R2', { path });
  await c.env.VIDEOS.put(r2StoreKey, transformed.body, {
    httpMetadata: { contentType: ct },
    customMetadata: { transformSource: ..., sourceType, cacheKey },
  });
}
```

Then read back from R2 (which now knows the size) to populate edge cache,
same as the Content-Length path.

---

## 5. Coalescer uses `.clone()` — eliminate entirely, use cache reads

**Severity:** Medium — `.clone()` on a consumed Response body throws TypeError.
The cacheable path is *probably* safe (response from `cache.match()` is
cache-backed), but non-cacheable paths (debug, pending passthrough) wrap live
streams and will crash.

**File:** `src/cache/coalesce.ts:51`, `src/handlers/transform.ts:362-366, 833`

**Why not `.tee()` in the coalescer either:** `ReadableStream.tee()` locks the
stream after the first call. If two joiners both call `.get()` concurrently,
their `.then()` callbacks both fire on the same resolved Response. The first
callback tees the body successfully; the second finds the body already locked
and throws. Mutating `entry.promise` to hold the other tee branch doesn't help
because both callbacks received the *same* original Response reference. This is
a fundamentally broken pattern for N concurrent joiners.

**Correct approach — signal coalescer + independent cache reads:**

The coalescer should NOT store or return Response objects at all. Instead:
1. Store a `Promise<void>` that signals "transform is complete and stored".
2. Joiners await the signal, then do their own `cache.match()` to get an
   independent Response with its own body stream. No clone, no tee.
3. Skip coalescing entirely for non-cacheable requests (`skipCache`).

This works because the transform handler already stores results in R2 +
edge cache before the promise resolves. By the time a joiner's `await`
resumes, the result is in cache.

**Changes to `src/cache/coalesce.ts`:**
```typescript
interface Entry {
  promise: Promise<void>;  // signals completion, not a Response
  createdAt: number;
}

export class RequestCoalescer {
  // ...
  /** Check if a transform is in-flight for this key. */
  get(key: string): Promise<void> | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return entry.promise;
  }

  /** Register an in-flight transform. */
  set(key: string, promise: Promise<void>): void {
    if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, { promise, createdAt: Date.now() });
  }
  // delete() and size unchanged
}
```

**Changes to `src/handlers/transform.ts`:**
```typescript
// Line 362-366: skip coalescing for non-cacheable, await signal + cache.match
if (!skipCache) {
  const inflight = coalescer.get(coalesceKey);
  if (inflight) {
    rlog.info('Coalesced — waiting for in-flight transform', { path, coalesceKey });
    await inflight;
    // Transform is done and stored — read from cache independently
    const cached = await cache.match(cacheReq);
    if (cached) {
      rlog.info('Coalesced cache HIT', { path });
      cached.headers.set('X-Request-ID', requestId);
      return cached;
    }
    // Rare: cache.match miss right after put (propagation delay).
    // Check R2 fallback — the R2 check at line 282 will handle it
    // on the next iteration. Fall through to do own transform.
    rlog.warn('Coalesced cache miss after signal', { path });
  }
}

// Line 833-834: register signal (void), not response
if (!skipCache) {
  const signal = responsePromise.then(() => {});  // void signal
  coalescer.set(coalesceKey, signal);
  signal.finally(() => coalescer.delete(coalesceKey));
}
return await responsePromise;
```

No `.clone()`, no `.tee()`, no shared Response objects. Each request gets
its own independent body stream from cache. Memory is bounded to exactly
one body stream per request.

---

## 6. Admin auth not timing-safe

**Severity:** Medium — standard string comparison leaks token bytes via timing.

**File:** `src/middleware/auth.ts:11`

**Fix:** Use constant-time comparison. The `timingSafeEqual` pattern already
exists in `src/handlers/dashboard.ts:23-33`. Extract it to a shared utility
and use in both places.

```typescript
// src/middleware/auth.ts
import { timingSafeEqual } from '../util';

export function requireAuth(c: { ... }): void {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!c.env.CONFIG_API_TOKEN || !token || !timingSafeEqual(token, c.env.CONFIG_API_TOKEN)) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing API token');
  }
}
```

Create `src/util.ts` with `timingSafeEqual` extracted from `dashboard.ts`.

---

## 7. Config loader drops `cdnCgiSizeLimit` / `bindingSizeLimit`

**Severity:** Medium — admin API round-trip broken for these fields.

**File:** `src/config/loader.ts:63-105`

**Fix:** Add extraction blocks for both fields, matching the existing pattern:

```typescript
// After the container block (line 100):
if (kvConfig.cdnCgiSizeLimit !== undefined) {
  configInput.cdnCgiSizeLimit = kvConfig.cdnCgiSizeLimit;
} else if (kvConfig.video && (kvConfig.video as Record<string, unknown>).cdnCgiSizeLimit !== undefined) {
  configInput.cdnCgiSizeLimit = (kvConfig.video as Record<string, unknown>).cdnCgiSizeLimit;
}

if (kvConfig.bindingSizeLimit !== undefined) {
  configInput.bindingSizeLimit = kvConfig.bindingSizeLimit;
} else if (kvConfig.video && (kvConfig.video as Record<string, unknown>).bindingSizeLimit !== undefined) {
  configInput.bindingSizeLimit = (kvConfig.video as Record<string, unknown>).bindingSizeLimit;
}
```

---

## 8. `parseDurationSeconds` regex matches `ms` as minutes

**Severity:** Medium — `10ms` → 600 seconds; `1h30m` drops hours.

**File:** `src/params/schema.ts:260-271`

**Fix:** Add negative lookahead for `s` after `m`, and add hour support:

```typescript
function parseDurationSeconds(duration: string): number {
  let total = 0;
  const hourMatch = duration.match(/(\d+(?:\.\d+)?)h/);
  const minMatch = duration.match(/(\d+(?:\.\d+)?)m(?!s)/);  // negative lookahead: don't match 'ms'
  const secMatch = duration.match(/(\d+(?:\.\d+)?)s/);
  if (hourMatch) total += parseFloat(hourMatch[1]) * 3600;
  if (minMatch) total += parseFloat(minMatch[1]) * 60;
  if (secMatch) total += parseFloat(secMatch[1]);
  if (!hourMatch && !minMatch && !secMatch) {
    const n = parseFloat(duration);
    if (Number.isFinite(n)) total = n;
  }
  return total;
}
```

**Tests to add:** `test/params/schema.spec.ts` — verify `10ms` → 0 (not 600),
`1h30m` → 5400, `1h` → 3600, `90s` → 90, `1m30s` → 90.

---

## 9. `transform_jobs` table never cleaned up

**Severity:** Medium — table grows unboundedly.

**File:** `src/analytics/middleware.ts:68-103`

**Fix:** Add `DROP TABLE IF EXISTS transform_jobs;` before the
`CREATE TABLE IF NOT EXISTS transform_jobs` block:

```sql
DROP TABLE IF EXISTS transform_log;
CREATE TABLE IF NOT EXISTS transform_log ( ... );
...
DROP TABLE IF EXISTS transform_jobs;
CREATE TABLE IF NOT EXISTS transform_jobs ( ... );
...
```

---

## 10. Container `jobInFlight` never reset on success

**Severity:** Medium — DO is single-use for 15 min after job completion.

**File:** `src/transform/container.ts:84-101`

**Fix:** Reset `jobInFlight` when the outbound handler receives a successful
callback (line 238 area). The outbound handler already knows the job is done
at that point, but it can't access the DO instance's private field.

Better approach: have the DO's `fetch()` override detect the callback response
and reset the flag. Or simpler: just don't dedup at the DO level — the queue
consumer already handles dedup (checks R2 for existing results). Remove the
`jobInFlight` logic entirely:

```typescript
// container.ts:84-101 — simplify to just forward
override async fetch(request: Request): Promise<Response> {
  return super.fetch(request);
}
```

The queue consumer's R2 check (`consumer.ts`) is the real dedup mechanism.
The DO-level dedup was added as belt-and-suspenders but causes more harm
(15-min lockout) than good.

---

## 11. WebSocket header case-sensitive

**Severity:** Medium

**File:** `src/handlers/jobs.ts:28`

**Fix:**
```typescript
if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
```

---

## 12. `X-Transform-Source` header incorrect for container

**Severity:** Medium — reports `binding` or `cdn-cgi` based on source type,
even when the container did the transform.

**File:** `src/handlers/transform.ts:726`

**Fix:** Track the actual transform method, not just the source type. Add a
`transformSource` variable alongside `sourceType` in the transform promise:

In the transform promise (line 378 area), add `let transformSource = 'unknown'`.
Set it to `'container'` when container handles it (lines 407, 486, 499),
`'binding'` when binding handles it (line 491), `'cdn-cgi'` when cdn-cgi
handles it (line 572 area). Return it alongside `sourceType` from the promise.

Use `transformSource` at line 726 instead of the source-type-based ternary.

---

## 13. Dead code removal

**Severity:** Low — cleanup.

### `src/sources/fetch.ts` — REMOVE

Truly dead. `resolveSource` and `fetchSourceStream` are never imported.
The transform handler reimplements all source resolution inline with
more sophisticated logic (container routing, presigned URLs, HEAD checks).
No tests reference it.

### `src/cache/store.ts` — REMOVE

Truly dead. `cacheLookup`, `cacheStore`, `cacheDelete` are never imported.
The transform handler and container outbound handler both use
`caches.default` directly. No tests reference it.

### `src/handlers/internal.ts:postContainerResult` — REMOVE

Effectively dead. The container outbound handler (`container.ts:148`)
intercepts `POST /internal/container-result` before it reaches the Hono
router. The Hono route (`index.ts:69`) is unreachable. The outbound handler
stores in R2 (correct approach); this handler stores in Cache API (stale
approach). Remove the function and its route registration.

Keep `getR2Source` in the same file (it's also shadowed by the outbound
handler for container requests, but it serves as a documented public
endpoint — now with auth from fix #2).

### `src/sources/presigned.ts:95-108` — SIMPLIFY

**Verified against aws4fetch source** (`node_modules/aws4fetch/dist/aws4fetch.esm.mjs`):
- Line 105: `params.set('X-Amz-Date', this.datetime)` — **overwrites** our manual date
- Line 121: `params.set('X-Amz-Algorithm', ...)` — **overwrites**
- Line 122: `params.set('X-Amz-Credential', ...)` — **overwrites**
- Line 123: `params.set('X-Amz-SignedHeaders', ...)` — **overwrites**
- Line 106-107: `params.set('X-Amz-Security-Token', ...)` — **overwrites** if present
- Line 118: `if (!params.has('X-Amz-Expires'))` — **preserved** (only param that matters)

The manual params at lines 96-108 are dead code. Worse, the `amzDate` at
line 98 has a bug (`.slice(0, 15)` drops the last second digit), and the
manual `credential` at line 99 creates a midnight-boundary race: the manual
`dateStamp` from `new Date()` on line 96 could differ from aws4fetch's
internal `new Date()` at line 97 by crossing a UTC day boundary.

Remove the dead manual params. Keep only `X-Amz-Expires`:

```typescript
const url = new URL(sourceUrl);
url.searchParams.set('X-Amz-Expires', String(expiresSeconds));

const signed = await client.sign(url.toString(), {
  method: 'GET',
  aws: { signQuery: true },
});
return signed.url;
```

### Empty directories — REMOVE

- `src/admin/` — empty, admin handlers are in `handlers/admin.ts`
- `src/debug/` — empty, debug logic is inline in `handlers/transform.ts`
- `src/transform/strategies/` — empty, never populated

### `src/analytics/schema.sql` — UPDATE

Missing `transform_jobs` table. Update to match `CLEANUP_SQL` in
`middleware.ts`, or remove entirely (the CLEANUP_SQL is the real schema).

---

## 14. Log data field override

**Severity:** Low

**File:** `src/log.ts:11`

**Fix:** Spread `data` before base fields so `level`/`msg`/`ts` can't be
overridden:

```typescript
console.log(JSON.stringify({ ...data, level, msg, ts: Date.now() }));
```

---

## 15. Queue-to-container job lifecycle is broken

**Severity:** High — the entire job status pipeline is unreliable. D1 status
oscillates, stale detection is wrong, queue exhaustion is silent.

### 15a. Consumer marks D1 `'failed'` then retries (status oscillation)

**File:** `src/queue/consumer.ts:91-96, 97-101`

When the container rejects (non-202) or the consumer throws, D1 is set to
`'failed'` (with `completed_at`), but `message.retry()` re-enqueues it. Next
retry overwrites D1 to `'downloading'` (line 71). Dashboard sees:
`failed → downloading → failed → downloading...`

**Fix:** Don't set `'failed'` on retryable errors. Reserve `'failed'` for
terminal states only. Use a new status like `'retrying'` for intermediate
failures, or simply don't update D1 status on retry:

```typescript
// On non-202: retry without marking failed
message.retry({ delaySeconds: 30 });
// Only set 'failed' if this is the last retry
if (message.attempts >= 10) {
  failJob(env.ANALYTICS, job.jobId, `Container rejected after ${message.attempts} attempts`);
} else {
  updateJobStatus(env.ANALYTICS, job.jobId, 'retrying');
}
```

### 15b. Consumer resets status to `'downloading'` on every retry

**File:** `src/queue/consumer.ts:71`

Every consumer invocation calls `updateJobStatus(…, 'downloading')` before
dispatching, even if the container is mid-transcode from a previous dispatch.
The container's `jobInFlight` dedup returns 202 ("already_processing"), but
D1 already says `'downloading'` again.

**Fix:** Only set `'downloading'` on the first attempt, or check current D1
status before overwriting. Better: let the container progress reports drive
D1 status. The consumer should only set `'downloading'` if the current status
is `'pending'`:

```typescript
// Only transition pending → downloading (not transcoding → downloading)
if (env.ANALYTICS) {
  env.ANALYTICS.prepare(
    `UPDATE transform_jobs SET status = 'downloading' WHERE job_id = ? AND status = 'pending'`
  ).bind(job.jobId).run().catch(() => {});
}
```

### 15c. DLQ messages are silently dropped

**File:** `wrangler.jsonc` — `dead_letter_queue: "video-transform-dlq"`

When a message exhausts all 10 retries, it goes to the DLQ. There is no
consumer for the DLQ. The D1 job status stays at whatever the last retry
set it to (`'downloading'` or `'retrying'`), never transitioning to `'failed'`.
The job just... disappears from the queue.

**Fix:** Add a DLQ consumer that marks jobs as `'failed'` in D1:

```typescript
// In index.ts, add a second queue handler or handle DLQ in the same consumer
// by checking message metadata. Alternatively, add the DLQ as a second
// consumer binding and handle it:
async queue(batch: MessageBatch, env: Env) {
  if (batch.queue === 'video-transform-dlq') {
    for (const msg of batch.messages) {
      const job = msg.body as JobMessage;
      failJob(env.ANALYTICS, job.jobId, 'Exhausted all retries (DLQ)');
      msg.ack();
    }
    return;
  }
  // ... existing consumer logic
}
```

### 15d. Stale detection is hardcoded and wrong

**File:** `src/handlers/jobs.ts:57-62`

The 20-min threshold (`STALE_MS = 20 * 60_000`) assumes `max_retries(10) ×
120s = 20min`. But retry delays vary (30s, 60s, 120s), and a 725MB video job
legitimately takes 5-7 minutes of actual processing plus 2-3 retry delays.
A job enqueued 21 minutes ago but actively transcoding gets marked stale.

Worse, staleness checks `created_at`, not last activity. The schema has
`started_at` but it's unused in the staleness check.

**Also:** Staleness is a D1 mutation triggered by every `GET /admin/jobs` poll.
The dashboard polls every 10s, so this UPDATE fires 6×/min per viewer.

**Fix:** Remove the server-side staleness mutation entirely. Instead:
1. Add an `updated_at` column to `transform_jobs` that gets set on every
   status change (consumer retry, progress report, completion, failure).
2. Compute staleness client-side in the dashboard based on `updated_at` vs
   `Date.now()`. Show `'stale'` as a UI-only label for jobs not updated in
   the last N minutes (configurable, not hardcoded).
3. For actual terminal detection, rely on the DLQ consumer (fix 15c) to
   mark truly failed jobs.

---

## 16. Dashboard UI overhaul — Jobs tab

**Severity:** Medium — the Jobs UI is not usable in its current state.

Refer to `/home/erfi/gatekeeper/dashboard` for UI patterns: Lovelace color
palette, `T` typography system, CVA + shadcn/ui components, structured
badge/card/table patterns.

**File:** `dashboard/src/components/Dashboard.tsx` (651 lines, monolithic)

### 16a. Filter doesn't work properly (fetch storm on keystroke)

**Lines 435-441:** `filter` is a `useCallback` dependency. Every keystroke
recreates the callback, triggers `useEffect` cleanup + re-run, fires an
immediate API call. Typing "pending" = 7 rapid D1 queries + 7 staleness
mutations.

**Fix:** Add debounce (300ms) on filter input. Use a `debouncedFilter` value
for the API call, keep `filter` for the input display:

```typescript
const [filter, setFilter] = useState('');
const [debouncedFilter, setDebouncedFilter] = useState('');
useEffect(() => {
  const timer = setTimeout(() => setDebouncedFilter(filter), 300);
  return () => clearTimeout(timer);
}, [filter]);
// Use debouncedFilter in fetchJobs useCallback deps
```

### 16b. No status filter presets

The filter input only supports free-text search. There are no quick-filter
buttons for common queries (e.g., "active only", "failed only", "stale").

**Fix:** Add tab-style filter buttons (gatekeeper pattern) above the table:
`All (N) | Active (N) | Complete (N) | Failed (N) | Stale (N)`.
Counts come from the already-fetched job list (client-side filtering).

### 16c. Active cards lack progress bars

`JobCard` (lines 565-608) shows elapsed time but no percent progress despite
the `TransformJobDO` broadcasting percent via WebSocket. The dashboard has
zero WebSocket code — AGENTS.md says it was implemented then apparently
removed.

**Fix:** Reconnect WebSocket for active jobs. For each active job, open a
WS connection to `/ws/job/{id}`. Display percent progress bar in the card.
Use `useRef` for connections (not state) to avoid re-render storms per
AGENTS.md lesson learned. Close connections when jobs complete.

### 16d. Job table data is sparse and hard to read

From the screenshots: Size shows `—` for most jobs, Duration shows `—`,
params are comma-separated raw text. No visual hierarchy.

**Fix (per gatekeeper patterns):**
- Use `T.tableCellMono` (monospace font-data class) for params, sizes, durations
- Format params as badge pills instead of raw comma-separated text
- Show human-readable sizes (`37.0 MB`) and durations (`4m 18s`) —
  some of this already works for complete jobs but `—` for in-progress is unhelpful
- For in-progress jobs, show elapsed time instead of `—`
- Add expandable rows (gatekeeper pattern) with full job detail (source URL,
  cache key, error message, retry count)

### 16e. Monolithic 651-line component

The entire dashboard (Analytics + Jobs + Debug tabs) is one component.

**Fix:** Split into separate components:
- `AnalyticsTab.tsx` — stat cards, breakdown charts, error table
- `JobsTab.tsx` — filter bar, active cards, recent table
- `DebugTab.tsx` — URL tester
- `Dashboard.tsx` — tab shell, auth, shared state

---

## 17. Dashboard UI — Analytics tab

**Severity:** Low-Medium — data is present but not usable.

### 17a. "Recent Errors" table is noisy

From the screenshot: The errors table shows `/admin/jobs` 401 UNAUTHORIZED,
`/ws/job/test-job-id` 426 UPGRADE_REQUIRED, `/admin/config` 401 repeatedly.
These are E2E test artifacts and admin probes, not real transform errors.
They dominate the view and hide actual issues.

**Fix:** Filter out admin/internal paths from the errors display by default.
Only show errors for transform paths (the `GET *` catch-all route).
Add a toggle "Show admin errors" for debugging.

### 17b. Analytics bars have no labels on hover

The bar charts (By Status, By Origin, By Derivative, By Transform Source)
show counts but have no tooltips or percentage labels.

**Fix:** Add percentage labels next to counts: `200  ████████  1317 (85.4%)`.
Use gatekeeper's `CHART_TOOLTIP_STYLE` pattern for recharts tooltips.

### 17c. No time-series chart

The analytics tab shows aggregate numbers but no trend over time. There's
no way to see if errors spiked at a particular hour or if latency degraded.

**Fix:** Add a simple time-series chart (requests/hour or latency/hour)
using the existing D1 data grouped by hour. Use recharts `AreaChart` per
gatekeeper pattern.
