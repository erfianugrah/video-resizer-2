# Container & Queue

## When the container is used

1. **Container-only params**: fps, speed, rotate, crop, bitrate, codec selection (h265/vp9)
2. **Duration > 60s**: binding cap is 60s, container has no limit
3. **Oversized input**: binding limit 100MB, cdn-cgi limit 100 MiB, container handles up to 6 GiB
4. **MediaError fallback**: when binding throws, falls back to container
5. **cdn-cgi 9402 error**: origin too large for edge transform

## Container specs

| Setting | Value |
|---------|-------|
| Image | `node:22-slim` + ffmpeg |
| vCPU | 4 |
| Memory | 12,288 MiB |
| Disk | 20,000 MB |
| Max instances | 5 |
| Sleep after | 15 minutes |
| Internet | enabled (direct HTTPS for source downloads) |

## Container endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/transform` | POST | Synchronous: stream source in body, receive transformed output |
| `/transform-async` | POST | Async: stream source + X-Callback-Url header, respond 202 |
| `/transform-url` | POST | Async URL-based: container fetches source directly by URL |
| `/health` | GET | Health check |

## Queue-based job pipeline

Container transforms are dispatched via Cloudflare Queue for durability.

```
Client Request (>100 MiB or container-only params)
  -> Transform handler enqueues job to TRANSFORM_QUEUE
  -> Returns 202 with jobId and SSE URL
  -> Registers job in D1 (transform_jobs table)

Queue Consumer (stateless, retry-until-done):
  -> Check R2 for existing result -> ack if found (done)
  -> Dispatch to FFmpegContainer DO via /transform-url
  -> Retry in 120s to check R2 again
  -> After max_retries (10), message goes to DLQ

FFmpegContainer DO:
  -> Downloads source via HTTPS (or R2 via /internal/r2-source)
  -> Streams to disk via pipeline() (no OOM on 725MB+)
  -> Runs ffmpeg with all available CPU cores
  -> Reports progress via /internal/job-progress -> D1 percent update
  -> Streams output to callback via outbound handler
  -> Outbound handler stores result in R2 (_transformed/{cacheKey})

Next Client Request:
  -> R2 HIT -> tee to edge cache + serve
  -> D1 job status updated to 'complete'
```

### Queue configuration

```jsonc
{
    "queues": {
        "producers": [{ "binding": "TRANSFORM_QUEUE", "queue": "video-transform-jobs" }],
        "consumers": [{
            "queue": "video-transform-jobs",
            "max_batch_size": 1,
            "max_batch_timeout": 5,
            "max_retries": 10,
            "max_concurrency": 2,
            "dead_letter_queue": "video-transform-dlq"
        }]
    }
}
```

### 202 response shape

```json
{
    "status": "queued",
    "jobId": "video:big_buck_bunny_1080p.mov:w=320:c=auto:v=3",
    "message": "Video is being transformed. Retry shortly.",
    "path": "/big_buck_bunny_1080p.mov",
    "sse": "https://your-domain.com/sse/job/video%3Abig_buck_bunny..."
}
```

Headers: `Retry-After: 10`, `X-Transform-Pending: true`, `X-Job-Id: {jobId}`

## Job tracking (D1 + SSE)

D1 is the sole source of truth for job state. The `transform_jobs` table stores status and percent progress. The SSE endpoint (`GET /sse/job/:id`) polls D1 every 2s and streams updates to the dashboard.

State machine:
```
pending -> downloading -> transcoding -> uploading -> complete
                                                   -> failed
```

Progress is reported by the container via ffmpeg stderr parsing (`time=HH:MM:SS` lines), written to D1 via the outbound handler, and streamed to clients via SSE.

Schema: see `src/analytics/schema.sql` (single source of truth). Includes `percent` column for progress tracking.

## Source dedup

The container outbound handler caches remote source downloads in R2 under `_source-cache/{path}`. Uses `body.tee()` to stream to both the container and R2 simultaneously. A second container requesting the same 725MB file gets it from R2 instantly instead of re-downloading.

## Container ffmpeg features

- **Dynamic thread count**: `os.availableParallelism()` (up to 4 on max instance)
- **Fast seeking**: `-ss` before `-i` for input seeking
- **Even dimensions**: odd widths/heights rounded down for libx264
- **Forced 8-bit output**: `-pix_fmt yuv420p` after `-c:v libx264`. Without this,
  10-bit sources (HEVC Main 10) produce H.264 High 10 profile which most mobile
  and web decoders cannot play. See `docs/transform-audit.md` for details.
- **Source streaming**: `pipeline()` to disk, not `arrayBuffer()` (prevents OOM)
- **Output streaming**: `createReadStream()` + explicit Content-Length from `stat()`
- **Spritesheet**: `fps=1,tile=COLSxROWS` filter, imageCount defaults to 20, output as JPEG

### Quality and compression

`quality` and `compression` are **independent controls** in the container:

- **`quality`** = visual quality (CRF value). Lower CRF = better quality, larger file.
- **`compression`** = encoding effort (`-preset`). Higher compression = slower encode, smaller file at same CRF.

Both are no-ops for the binding and cdn-cgi tiers (those tiers have no quality/compression controls).

| `quality` | CRF |
|-----------|-----|
| low | 28 |
| medium | 23 |
| high | 18 |
| auto | 23 |

| `compression` | FFmpeg `-preset` | Effect |
|---------------|-----------------|--------|
| low | ultrafast | Fast encode, larger file |
| medium | medium | Balanced |
| high | slow | Slow encode, smaller file |
| auto | medium | Balanced |

## Outbound handler

The `FFmpegContainer.outbound` static handler intercepts ALL outbound HTTP from the container:

| Path | Method | Action |
|------|--------|--------|
| `/internal/job-progress` | GET | Update D1 status + percent progress |
| `/internal/container-result` | POST | Store result in R2, update D1 status |
| `/internal/r2-source` | GET | Serve R2 object via binding (for R2-only sources) |
| Everything else (GET, >1MB) | GET | Proxy via fetch() with source dedup (R2 cache) |
| Everything else | * | Proxy via fetch() with http->https upgrade |

## D1 status safety

- **UPSERT guards**: `registerJob` ON CONFLICT preserves terminal statuses (`complete`, `failed`). A queue retry will not reset a completed or deleted job back to `pending`.
- **Transition guards**: All D1 update statements (`updateJobStatus`, `updateJobProgress`, `completeJob`, `failJob`) include `WHERE status NOT IN ('complete', 'failed')` to prevent backward transitions.
- **`completeJob`/`failJob` awaited inline**: In the container outbound handler, `completeJob()` and `failJob()` are awaited inline (not fire-and-forget via `waitUntil`). Both include one retry on transient D1 failure. This ensures the D1 status update commits before the isolate terminates. Progress updates (`updateJobProgress`, `updateJobStatus`) remain `waitUntil` since they're non-critical.

## Dashboard auth

The dashboard uses cookie-based session auth (HMAC-signed, 24h expiry). Admin API endpoints (`/admin/*`) accept both:
1. **Bearer token** in `Authorization` header (API clients, scripts, tests)
2. **Session cookie** (`vr2_session`) set at login (browser dashboard)

The dashboard no longer requires a separate API token input — the login screen sets the cookie, and all API calls use `credentials: 'same-origin'`.

The active tab is persisted in the URL hash (`#jobs`, `#debug`) so page refresh stays on the same tab.

## Design lessons

- **Don't ack on 202**: container accepting (202) != done. Ack only after R2 result confirmed.
- **No 'failed' on retryable errors**: consumer only marks `'failed'` via DLQ (all retries exhausted). Avoids status oscillation (failed→downloading→failed).
- **`require()` in ESM crashes silently**: `server.mjs` must use `import` at top, not `require()` in functions.
- **Edge cache hides D1 updates**: add D1 status updates in all serve paths (edge HIT, R2 HIT, fresh transform).
- **Never `arrayBuffer()` on container output**: use `ReadableStream` directly to R2 `put()`. Container outputs can be hundreds of MB.
- **Await critical D1 writes inline**: `completeJob` and `failJob` in the outbound handler must be awaited (not `waitUntil`) because the isolate may die before `waitUntil` commits. Use `waitUntil` only for non-critical writes (progress, analytics).
- **DLQ must check R2 before marking failed**: The container may have completed but D1 wasn't updated. The DLQ consumer now checks R2 first and marks `complete` if the result exists.
- **Container-only path must check source size**: When `needsContainer` is true AND the source is >256MB, the async queue path must be used. Previously the sync container path streamed 725MB through the DO and timed out.
- **Coalescer excludes 202 responses**: Async container jobs return 202 which produces nothing in cache/R2 for coalescer joiners. The coalescer now removes entries for 202 responses and has a 60s safety timeout.
- **`max_batch_timeout: 0` may break delivery**: use `5` instead.
