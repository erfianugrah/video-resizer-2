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
  -> Returns 202 with jobId and WebSocket URL
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
  -> Reports progress via /internal/job-progress -> TransformJobDO -> WebSocket
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
    "ws": "wss://videos.erfi.io/ws/job/video%3Abig_buck_bunny..."
}
```

Headers: `Retry-After: 10`, `X-Transform-Pending: true`, `X-Job-Id: {jobId}`

## Job tracking (TransformJobDO)

Durable Object per unique transform (keyed by cache key). Manages job lifecycle and WebSocket connections using the Hibernation API (sleeps between progress updates, no billing while idle).

State machine:
```
(none) -> pending -> downloading -> transcoding -> uploading -> complete
                                                             -> failed
```

Default status is `'none'` (not `'pending'`) -- this is critical. A brand new DO must be distinguishable from a submitted job to avoid false dedup.

### WebSocket progress

Clients connect to `wss://{host}/ws/job/{jobId}` for real-time updates:

```json
{ "status": "transcoding", "progress": 45 }
{ "status": "complete", "progress": 100 }
```

Progress is reported by the container via ffmpeg stderr parsing (`time=HH:MM:SS` lines), scaled to 10-85% range during transcoding.

## D1 job registry

The `transform_jobs` table enables dashboard job discovery (DOs don't have a "list all instances" API).

```sql
CREATE TABLE transform_jobs (
    job_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    origin TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    params_json TEXT,
    source_url TEXT,
    source_type TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    output_size INTEGER
);
```

Status updates: registered on enqueue, updated to `downloading` by consumer, updated to `complete` on edge cache HIT / R2 HIT / container callback.

## Source dedup

The container outbound handler caches remote source downloads in R2 under `_source-cache/{path}`. Uses `body.tee()` to stream to both the container and R2 simultaneously. A second container requesting the same 725MB file gets it from R2 instantly instead of re-downloading.

## Container ffmpeg features

- **Dynamic thread count**: `os.availableParallelism()` (up to 4 on max instance)
- **Fast seeking**: `-ss` before `-i` for input seeking
- **Even dimensions**: odd widths/heights rounded down for libx264
- **Source streaming**: `pipeline()` to disk, not `arrayBuffer()` (prevents OOM)
- **Output streaming**: `createReadStream()` + explicit Content-Length from `stat()`
- **Spritesheet**: `fps=1,tile=COLSxROWS` filter, imageCount defaults to 20, output as JPEG

### Quality presets

| Preset | CRF | FFmpeg Preset |
|--------|-----|---------------|
| low | 28 | fast |
| medium | 23 | medium |
| high | 18 | medium |

## Outbound handler

The `FFmpegContainer.outbound` static handler intercepts ALL outbound HTTP from the container:

| Path | Method | Action |
|------|--------|--------|
| `/internal/job-progress` | GET | Forward progress to TransformJobDO + update D1 |
| `/internal/container-result` | POST | Store result in R2, update D1 + TransformJobDO |
| `/internal/r2-source` | GET | Serve R2 object via binding (for R2-only sources) |
| Everything else (GET, >1MB) | GET | Proxy via fetch() with source dedup (R2 cache) |
| Everything else | * | Proxy via fetch() with http->https upgrade |

## Design lessons

- **Don't ack on 202**: container accepting (202) != done. Ack only after R2 result confirmed.
- **DO default state matters**: `status: 'none'` not `'pending'`. Any overlap with valid job states causes false dedup.
- **`require()` in ESM crashes silently**: `server.mjs` must use `import` at top, not `require()` in functions.
- **Edge cache hides D1 updates**: add D1 status updates in all serve paths (edge HIT, R2 HIT, fresh transform).
- **WebSocket refs, not state**: store connections in `useRef` to avoid React re-render loops.
- **`max_batch_timeout: 0` may break delivery**: use `5` instead.
