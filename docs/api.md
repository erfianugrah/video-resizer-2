# API Reference

## Transform (catch-all)

```
GET /{path}?{params}
```

Transforms the video at `{path}` using the specified params. Returns the transformed video with appropriate Content-Type and caching headers. See [Parameters](parameters.md) for all available params.

### Examples

```bash
# Resize to 1280x720
curl https://your-domain.com/rocky.mp4?width=1280&height=720

# Extract frame at 5s as JPEG
curl https://your-domain.com/rocky.mp4?mode=frame&time=5s&width=640

# Generate spritesheet (20 frames)
curl https://your-domain.com/rocky.mp4?mode=spritesheet&width=160&imageCount=20

# Extract audio only
curl https://your-domain.com/rocky.mp4?mode=audio&duration=30s

# Named preset
curl https://your-domain.com/rocky.mp4?derivative=tablet

# Akamai IMQuery compatible
curl https://your-domain.com/rocky.mp4?impolicy=mobile&imwidth=854
```

### Response headers

| Header | Description |
|--------|-------------|
| `X-Request-ID` | UUID per request |
| `X-Processing-Time-Ms` | Transform duration in ms |
| `X-Transform-Source` | `binding`, `cdn-cgi`, or `container` |
| `X-Origin` | Matched origin name |
| `X-Source-Type` | `r2`, `remote`, or `fallback` |
| `X-Source-Etag` | R2 object etag |
| `X-Derivative` | Resolved derivative name |
| `X-Resolved-Width` / `X-Resolved-Height` | Final dimensions |
| `X-Cache-Key` | Deterministic cache key |
| `X-R2-Cache` | `HIT` if served from R2 persistent store |
| `X-Transform-Pending` | `true` if container async (202 response) |
| `X-Job-Id` | Job ID for queue-based container transforms |
| `X-Playback-Loop` / `Autoplay` / `Muted` / `Preload` | Playback hints |
| `Via` | `video-resizer` (loop prevention) |
| `Cache-Tag` | Tags for purge-by-tag |
| `Cache-Control` | `public, max-age={ttl}` |
| `Accept-Ranges` | `bytes` |

### 202 response (container async)

When the source is too large for edge transform, returns 202 with job info:

```json
{
    "status": "queued",
    "jobId": "video:big_buck_bunny.mov:w=320:c=auto:v=3",
    "message": "Video is being transformed. Retry shortly.",
    "path": "/big_buck_bunny.mov",
    "sse": "https://your-domain.com/sse/job/video%3Abig_buck_bunny..."
}
```

## Debug

```
GET /{path}?debug=view
```

Returns JSON diagnostics instead of video. Includes resolved params, matched origin, capture groups, config summary, container routing decision.

```
GET /{path}?debug
```

Bypasses edge cache, forces fresh transform. All `X-*` debug headers are present.

## Admin endpoints

All require `Authorization: Bearer {CONFIG_API_TOKEN}`.

### Config

```
GET  /admin/config              # Retrieve current config
POST /admin/config              # Upload new config (Zod validated)
```

### Cache

```
POST /admin/cache/bust          # Bump version for a path
     Body: { "path": "/rocky.mp4" }
     Response: { "ok": true, "path": "/rocky.mp4", "version": 3 }
```

### Analytics

```
GET /admin/analytics?hours=24           # Summary stats
GET /admin/analytics/errors?hours=24&limit=50  # Recent errors
```

Summary response:
```json
{
    "summary": {
        "total": 1234,
        "success": 1200,
        "errors": 34,
        "cacheHits": 800,
        "cacheHitRate": 0.648,
        "avgLatencyMs": 450,
        "p50LatencyMs": 120,
        "p95LatencyMs": 2500,
        "byStatus": [{ "status": 200, "count": 1150 }],
        "byOrigin": [{ "origin": "standard", "count": 1234 }],
        "byDerivative": [{ "derivative": "tablet", "count": 500 }],
        "byTransformSource": [{ "source": "cdn-cgi", "count": 900 }],
        "byErrorCode": [{ "error_code": "MEDIA_ERROR_9402", "count": 5 }]
    },
    "_meta": { "hours": 24, "sinceMs": 1774627200000, "ts": 1774713600000 }
}
```

### Jobs

```
GET  /admin/jobs?hours=24&limit=50       # List recent jobs
GET  /admin/jobs?active=true             # List active (non-terminal) jobs
GET  /admin/jobs?filter=bunny            # Text search on path/jobId/status
POST /admin/jobs/retry                   # Retry/delete/clear stuck jobs
```

#### Retry a single stuck job

Resets D1 status to `pending`, cleans partial R2 result, re-enqueues to `TRANSFORM_QUEUE`.

```bash
curl -X POST https://your-domain.com/admin/jobs/retry \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"jobId": "video:big_buck_bunny.mov:w=1440:c=auto"}'
```

Response: `{ "ok": true, "reset": true, "jobId": "...", "requeued": true }`

#### Clear all stale jobs

Resets all non-terminal jobs older than N minutes back to `pending`.

```bash
curl -X POST https://your-domain.com/admin/jobs/retry \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"staleMinutes": 30}'
```

Response: `{ "ok": true, "resetCount": 3, "staleMinutes": 30 }`

#### Delete a job

Removes the job from D1 and cleans any partial R2 result.

```bash
curl -X POST https://your-domain.com/admin/jobs/retry \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"jobId": "...", "delete": true}'
```

Response: `{ "ok": true, "deleted": true, "jobId": "..." }`

Job response:
```json
{
    "jobs": [{
        "job_id": "video:big_buck_bunny.mov:w=320:c=auto:v=3",
        "path": "/big_buck_bunny.mov",
        "origin": "standard",
        "status": "transcoding",
        "percent": 45,
        "params": { "width": 320, "compression": "auto" },
        "source_type": "remote",
        "created_at": 1774713000000,
        "started_at": 1774713010000,
        "completed_at": null,
        "source_url": "https://your-origin.com/big_buck_bunny.mov",
        "error": null,
        "output_size": null
    }],
    "_meta": { "ts": 1774713600000, "hours": 24, "active": false, "filter": null }
}
```

## SSE (real-time job progress)

```
GET /sse/job/{jobId}
```

Server-Sent Events stream for real-time progress. Polls D1 every 2s, streams updates, auto-closes on terminal state. Dashboard uses `EventSource` (auto-reconnect built in).

Events from server:
```
data: {"status":"downloading","percent":0}
data: {"status":"transcoding","percent":45}
data: {"status":"uploading","percent":90}
data: {"status":"complete","percent":100}
data: {"status":"failed","error":"ffmpeg failed..."}
data: {"status":"not_found","jobId":"nonexistent-id"}
```

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`.

## Dashboard

```
GET  /admin/dashboard           # Dashboard UI (Astro + React)
POST /admin/dashboard/login     # Token validation + session cookie
```

Three tabs:
- **Analytics**: stat cards, latency metrics, breakdown tables, error log
- **Jobs**: active jobs with live status, recent jobs table, filter/search
- **Debug**: URL tester with diagnostics + response headers

Auth: HMAC-SHA256 signed session cookie (24h expiry, HttpOnly, Secure, SameSite=Strict).

## Error responses

All errors return structured JSON:

```json
{ "error": { "code": "NO_MATCHING_ORIGIN", "message": "No origin matched: /path" } }
{ "error": { "code": "UNAUTHORIZED", "message": "Invalid or missing API token" } }
{ "error": { "code": "INTERNAL", "message": "Internal server error" } }
```

Errors with details (e.g., validation failures) include a `details` field:

```json
{ "error": { "code": "INVALID_CONFIG", "message": "Config validation failed", "details": { "errors": [...] } } }
```

## Internal endpoints

Not intended for external use. Called by container outbound handler.

```
GET  /internal/r2-source?key=...&bucket=VIDEOS   # Auth required
```
