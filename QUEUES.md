# Queue-Based Container Transform Architecture

## Problem Statement

The current container transform path is fragile:

1. **Deploys kill running containers** — rolling updates send SIGTERM/SIGKILL to in-flight ffmpeg jobs. A 725MB transcode that takes 2 minutes is lost if a deploy happens during processing.
2. **No retry on failure** — if the container crashes, OOMs, or times out, the job is gone. The user must manually retry.
3. **No visibility** — user gets 202 and must blind-poll. No progress feedback, no ETA, no queue position.
4. **No ordering/fairness** — concurrent requests spawn concurrent container DOs. 8 simultaneous transforms of the same 725MB file each download it independently.
5. **Fire-and-forget** — `waitUntil` can be cancelled by the runtime. Long-running container jobs rely on the DO staying alive, which conflicts with deploy rollouts.
6. **Duration format bug** — discovered during testing: ffmpeg doesn't understand "5m" format, needed `parseDuration()`. This class of bug is hard to catch without durable job tracking.

## Proposed Architecture

### Overview

```
Client Request (>100 MiB or container params)
  → Worker enqueues job to Cloudflare Queue
  → Returns 202 with jobId
  → Client connects WebSocket to TransformJobDO for progress
  → Queue consumer picks up job
  → Consumer starts container via FFmpegContainer DO
  → Container downloads source, runs ffmpeg
  → Progress events stream via WebSocket to connected clients
  → Result stored in R2
  → Job marked complete in TransformJobDO
  → Next client request → R2 HIT → cache.put → cache.match → serve
```

### Components

| Component | Type | Responsibility |
|-----------|------|----------------|
| **Transform Handler** | Worker (existing) | Detects container-needed, enqueues job, returns 202 |
| **TRANSFORM_QUEUE** | Cloudflare Queue | Durable message delivery with retries + dead letter |
| **TransformJobDO** | Durable Object | Job state machine + WebSocket progress hub |
| **FFmpegContainer** | Container DO (existing) | Runs ffmpeg, streams output to R2 via outbound handler |
| **Dashboard** | Astro/React (existing) | Shows queue depth, active jobs, progress, history |

### Why Cloudflare Queues

| Feature | Current (fire-and-forget) | Queue-based |
|---------|--------------------------|-------------|
| Deploy safety | Jobs killed on deploy | Messages survive deploys, auto-retry |
| Retry on failure | None | `max_retries: 3` + dead letter queue |
| Concurrency control | Uncontrolled (`max_instances: 5`) | `max_concurrency: 2` on consumer |
| Ordering | Race conditions | FIFO within queue |
| Visibility | None (202 + blind poll) | Job state in DO + WebSocket progress |
| Message retention | None | 4 days default (configurable up to 14) |
| Backpressure | None | Queue depth grows, consumer scales |
| Cost | Container idle time | Pay per message ($0.40/M operations) |

### Why NOT just Queues (why we also need the TransformJobDO)

Queues handle durable delivery, but they don't provide:
- **Job state tracking** — "is this job pending/downloading/transcoding/done/failed?"
- **WebSocket connections** — real-time progress to connected clients
- **Dedup** — preventing the same transform from being queued twice
- **Result caching** — knowing when a result is ready without polling R2

The TransformJobDO is the **job supervisor** that wraps the queue message lifecycle.

---

## Detailed Design

### 1. Job Submission (Producer)

When the transform handler detects a container-needed path (>100 MiB, container-only params, or cdn-cgi 9402 error):

```typescript
// In transform handler
const jobId = buildCacheKey(path, params, version, etag); // deterministic
const jobMessage = {
  jobId,
  path,
  params: sanitizeParams(params),
  sourceUrl,        // HTTPS URL the container will fetch
  callbackCacheKey, // R2 key for storing result
  requestUrl,       // original user request URL (for cache.match key)
  origin: originMatch.origin.name,
  sourceType,
  etag,
  version,
  createdAt: Date.now(),
};

// Check if job already exists (dedup via DO)
const jobDO = env.TRANSFORM_JOB.get(env.TRANSFORM_JOB.idFromName(jobId));
const status = await jobDO.getStatus();

if (status === 'complete') {
  // Result in R2 — serve it (existing R2 HIT path)
}

if (status === 'pending' || status === 'processing') {
  // Already queued/running — return 202 with WebSocket URL
  return new Response(JSON.stringify({
    status: 'processing',
    jobId,
    ws: `wss://${zoneHost}/ws/job/${jobId}`,
  }), { status: 202, headers: { 'Retry-After': '10' } });
}

// New job — enqueue
await env.TRANSFORM_QUEUE.send(jobMessage);
await jobDO.submit(jobMessage);

return new Response(JSON.stringify({
  status: 'queued',
  jobId,
  ws: `wss://${zoneHost}/ws/job/${jobId}`,
}), { status: 202, headers: { 'Retry-After': '10' } });
```

### 2. TransformJobDO (Job Supervisor)

A Durable Object per unique transform (keyed by `jobId = cacheKey`). Manages the job lifecycle and WebSocket connections for progress.

**State machine:**

```
                    submit()
  (none) ──────────────────────► PENDING
                                    │
                           queue consumer picks up
                                    │
                                    ▼
                               DOWNLOADING
                                    │
                           source fetched to disk
                                    │
                                    ▼
                              TRANSCODING ──────► progress % via WebSocket
                                    │
                              ffmpeg complete
                                    │
                                    ▼
                               UPLOADING
                                    │
                           R2 put complete
                                    │
                                    ▼
                               COMPLETE
                                    │
                           (or at any point)
                                    │
                                    ▼
                                FAILED ──────► retry via dead letter queue
```

**API:**

```typescript
class TransformJobDO extends DurableObject {
  // State persisted in SQLite storage
  private status: 'pending' | 'downloading' | 'transcoding' | 'uploading' | 'complete' | 'failed';
  private progress: number; // 0-100
  private error: string | null;
  private createdAt: number;
  private startedAt: number | null;
  private completedAt: number | null;
  private jobMessage: JobMessage | null;

  // WebSocket connections (hibernation-safe)
  // Clients connect to get real-time progress updates

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for progress streaming
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      // Send current status immediately
      pair[1].send(JSON.stringify({ status: this.status, progress: this.progress }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // REST API for status
    if (url.pathname.endsWith('/status')) {
      return Response.json({
        status: this.status,
        progress: this.progress,
        error: this.error,
        createdAt: this.createdAt,
        startedAt: this.startedAt,
        completedAt: this.completedAt,
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // Called by producer when enqueuing
  async submit(job: JobMessage) {
    this.status = 'pending';
    this.jobMessage = job;
    this.createdAt = job.createdAt;
    await this.ctx.storage.put('job', job);
    await this.ctx.storage.put('status', 'pending');
    this.broadcast({ status: 'pending' });
  }

  // Called by queue consumer when starting
  async start() {
    this.status = 'downloading';
    this.startedAt = Date.now();
    await this.ctx.storage.put('status', 'downloading');
    this.broadcast({ status: 'downloading' });
  }

  // Called by container (via outbound handler) to report progress
  async updateProgress(phase: string, percent: number) {
    this.status = phase as any;
    this.progress = percent;
    await this.ctx.storage.put('status', phase);
    await this.ctx.storage.put('progress', percent);
    this.broadcast({ status: phase, progress: percent });
  }

  // Called when R2 put completes
  async complete() {
    this.status = 'complete';
    this.progress = 100;
    this.completedAt = Date.now();
    await this.ctx.storage.put('status', 'complete');
    this.broadcast({ status: 'complete', progress: 100 });
    // Close all WebSocket connections after sending completion
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(1000, 'Job complete');
    }
  }

  // Called on failure
  async fail(error: string) {
    this.status = 'failed';
    this.error = error;
    await this.ctx.storage.put('status', 'failed');
    await this.ctx.storage.put('error', error);
    this.broadcast({ status: 'failed', error });
  }

  // Broadcast to all connected WebSocket clients
  private broadcast(data: object) {
    const msg = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  // Hibernation WebSocket handlers
  async webSocketMessage(ws: WebSocket, message: string) {
    // Client can request current status
    if (message === 'status') {
      ws.send(JSON.stringify({
        status: this.status,
        progress: this.progress,
        error: this.error,
      }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    ws.close(code);
  }
}
```

### 3. Queue Consumer

The same Worker acts as both producer and consumer. The `queue()` handler processes batches:

```typescript
export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<JobMessage>, env: Env) {
    for (const message of batch.messages) {
      const job = message.body;

      try {
        // Get job DO and mark as started
        const jobDO = env.TRANSFORM_JOB.get(env.TRANSFORM_JOB.idFromName(job.jobId));
        await jobDO.start();

        // Start container transform
        const instanceKey = `ffmpeg:${job.origin}:${job.path}:${fnv1aHash(job.params)}`;
        const container = env.FFMPEG_CONTAINER.get(env.FFMPEG_CONTAINER.idFromName(instanceKey));

        const resp = await container.fetch('http://container/transform-url', {
          method: 'POST',
          headers: {
            'X-Transform-Params': JSON.stringify(job.params),
            'X-Source-Url': job.sourceUrl,
            'X-Callback-Url': `http://${zoneHost}/internal/container-result?...`,
            'X-Job-Id': job.jobId,
          },
        });

        if (resp.status === 202) {
          // Container accepted — it will call back when done
          // The message is acked automatically when queue() returns without throwing
          message.ack();
        } else {
          // Container rejected — retry
          message.retry({ delaySeconds: 30 });
          await jobDO.fail(`Container returned ${resp.status}`);
        }
      } catch (err) {
        // Retry with backoff
        message.retry({ delaySeconds: 60 });
        const jobDO = env.TRANSFORM_JOB.get(env.TRANSFORM_JOB.idFromName(job.jobId));
        await jobDO.fail(err instanceof Error ? err.message : String(err));
      }
    }
  },

  async scheduled(controller, env, ctx) { /* weekly D1 cleanup */ },
};
```

### 4. Container Progress Reporting

The container server can report progress by parsing ffmpeg's stderr output:

```javascript
// In container/server.mjs processUrlTransform()
const ffmpegProc = spawn('ffmpeg', args);

// Parse stderr for progress
ffmpegProc.stderr.on('data', (chunk) => {
  const line = chunk.toString();
  // ffmpeg outputs: "time=00:05:30.25 ..."
  const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  if (timeMatch && totalDuration) {
    const currentSec = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
    const percent = Math.round((currentSec / totalDuration) * 100);
    // Report progress to Worker via HTTP (outbound handler intercepts)
    fetch(`http://${callbackHost}/internal/job-progress?jobId=${jobId}&phase=transcoding&percent=${percent}`)
      .catch(() => {}); // fire-and-forget
  }
});
```

The Worker's outbound handler routes `/internal/job-progress` to the TransformJobDO:

```typescript
if (url.pathname === '/internal/job-progress') {
  const jobId = url.searchParams.get('jobId');
  const phase = url.searchParams.get('phase');
  const percent = parseInt(url.searchParams.get('percent') ?? '0', 10);
  const jobDO = env.TRANSFORM_JOB.get(env.TRANSFORM_JOB.idFromName(jobId));
  await jobDO.updateProgress(phase, percent);
  return new Response('ok');
}
```

### 5. WebSocket Client (Dashboard)

The dashboard connects via WebSocket to get real-time progress:

```typescript
// In dashboard Debug tab or a new "Jobs" tab
const ws = new WebSocket(`wss://videos.erfi.io/ws/job/${jobId}`);
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data = { status: 'transcoding', progress: 45 }
  updateProgressBar(data.progress);
  updateStatusLabel(data.status);
};
```

### 6. Dashboard Queue View

New "Jobs" tab in the dashboard showing:

| Column | Description |
|--------|-------------|
| Job ID | Truncated cache key |
| Path | `/big_buck_bunny_1080p.mov` |
| Params | `w=320, fit=cover` |
| Status | pending / downloading / transcoding / uploading / complete / failed |
| Progress | 0-100% bar |
| Created | timestamp |
| Duration | elapsed time |
| Size | output size (when complete) |
| Actions | Cancel / Retry |

The dashboard polls `/admin/jobs` (REST) for the list, and connects WebSocket per active job for real-time progress.

---

## Wrangler Configuration

```jsonc
{
  // Existing bindings...

  // New: Queue
  "queues": {
    "producers": [
      { "binding": "TRANSFORM_QUEUE", "queue": "video-transform-jobs" }
    ],
    "consumers": [
      {
        "queue": "video-transform-jobs",
        "max_batch_size": 1,           // Process one job at a time
        "max_batch_timeout": 0,        // Don't wait for batches
        "max_retries": 3,              // Retry up to 3 times
        "max_concurrency": 2,          // Max 2 concurrent consumers
        "dead_letter_queue": "video-transform-dlq"
      }
    ]
  },

  // New: Job supervisor DO
  "durable_objects": {
    "bindings": [
      { "name": "FFMPEG_CONTAINER", "class_name": "FFmpegContainer" },
      { "name": "TRANSFORM_JOB", "class_name": "TransformJobDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FFmpegContainer"] },
    { "tag": "v2", "new_sqlite_classes": ["TransformJobDO"] }
  ]
}
```

---

## Migration Plan

### Phase 1: Queue + Job DO (no WebSocket yet)

1. Create Cloudflare Queue `video-transform-jobs` + dead letter queue `video-transform-dlq`
2. Implement `TransformJobDO` with SQLite state storage
3. Replace direct container dispatch with queue enqueue
4. Queue consumer dispatches to existing FFmpegContainer
5. Container callback updates TransformJobDO status
6. Transform handler checks TransformJobDO status before R2

**Validation:** Smoke test with container polling should pass. Jobs survive deploys.

### Phase 2: WebSocket Progress

1. Add WebSocket support to TransformJobDO (hibernation API)
2. Add `/ws/job/:id` route to Worker
3. Container reports ffmpeg progress via outbound handler
4. Dashboard connects WebSocket for active jobs

**Validation:** Dashboard shows real-time progress bar during 725MB transcode.

### Phase 3: Dashboard Queue View

1. Add `/admin/jobs` REST endpoint (list active/recent jobs from DO storage)
2. Add "Jobs" tab to dashboard
3. Job table with progress bars, status, actions
4. WebSocket connections per active job for live updates

**Validation:** Full visibility into all container transforms.

### Phase 4: Advanced Features

1. Job cancellation (signal container to SIGTERM)
2. Priority queues (fast-track small files)
3. Rate limiting per origin
4. Cost tracking (container runtime per job)
5. Notification on completion (webhook to external service)

---

## Pricing Estimate

For a typical workload of ~100 container transforms per day:

| Component | Usage | Cost |
|-----------|-------|------|
| Queue operations | 100 jobs × 3 ops (write/read/delete) = 300/day | ~$0 (1M free/month) |
| Dead letter queue | ~5 failed/day × 3 ops | ~$0 |
| TransformJobDO | 100 instances × ~5 min active | ~$0.01/day |
| FFmpegContainer | 100 jobs × ~2 min × standard-4 | ~$0.50/day |
| R2 storage | ~50 GB transformed video | ~$0.75/month |
| **Total** | | **~$15/month** |

---

## Key Decisions

### Why `max_batch_size: 1`?

Each container transform is a long-running job (30s-5min). Processing them in batches of 1 means each queue message = one container job. The consumer acks the message after dispatching to the container (not after ffmpeg completes), so the queue consumer is free quickly.

### Why `max_concurrency: 2`?

Limits concurrent container starts. The container itself has `max_instances: 5`, but we don't want 5 concurrent 725MB downloads saturating the container's network. 2 concurrent is a good balance.

### Why separate TransformJobDO from FFmpegContainer?

FFmpegContainer is a Container DO — it manages the Docker container lifecycle (start, stop, sleepAfter). TransformJobDO is a regular DO that manages job state and WebSocket connections. Mixing these responsibilities would make the FFmpegContainer too complex and would prevent clean hibernation of WebSocket connections.

### Why not Cloudflare Workflows?

Workflows would work for orchestrating the multi-step process (enqueue → download → transcode → upload → notify). However:
- Workflows are newer and less battle-tested
- Queues + DOs give more control over WebSocket progress
- The current architecture already uses DOs, so adding a Job DO is incremental
- Workflows don't natively support WebSocket connections for progress

If Workflows add WebSocket/progress support, they could replace the TransformJobDO + Queue combo.

### Why Hibernation WebSocket API?

The Hibernation API allows the TransformJobDO to sleep while clients are connected. This is critical because:
- A job might take 5 minutes. The DO shouldn't be billed for 5 minutes of idle time between progress updates.
- Multiple clients might connect to the same job. Hibernation handles this efficiently.
- If the DO is evicted, WebSocket connections survive. When a progress update arrives, the DO wakes up and broadcasts.

---

## References

- [Kent C. Dodds: Offloading FFmpeg with Cloudflare](https://kentcdodds.com/blog/offloading-ffmpeg-with-cloudflare) — Queue + Container + callback pattern
- [VideoToBe: How We Process Video with Cloudflare Containers](https://videotobe.com/blog/how-we-process-video-with-cloudflare-containers) — FUSE mounts, `ctx.waitUntil(container.monitor())`
- [Cloudflare Queues docs](https://developers.cloudflare.com/queues/)
- [Cloudflare Containers docs](https://developers.cloudflare.com/containers/)
- [Durable Objects WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/)
