# Configuration

## Overview

Configuration is stored in KV (`CONFIG` namespace) under the key `worker-config`. Loaded once per request with a 5-minute in-memory cache. Validated with Zod 4 on upload.

Upload via admin API:
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d @config.json \
    https://your-domain.com/admin/config
```

Retrieve:
```bash
curl -H "Authorization: Bearer $TOKEN" \
    https://your-domain.com/admin/config
```

## Schema

### Top-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | string (optional) | — | Config version identifier |
| `origins` | Origin[] (min 1) | *required* | Array of origin definitions |
| `derivatives` | Record<string, Derivative> | `{}` | Named transform presets |
| `responsive` | Responsive (optional) | — | Auto-sizing from client signals |
| `passthrough` | Passthrough | `{ enabled: true, formats: ['mp4','webm','mov'] }` | Which extensions to process |
| `container` | Container (optional) | — | FFmpeg container settings |
| `cdnCgiSizeLimit` | number | 104857600 (100 MiB) | Max input for cdn-cgi edge transform |
| `bindingSizeLimit` | number | 104857600 (100 MiB) | Max input for env.MEDIA binding |
| `asyncContainerThreshold` | number | 268435456 (256 MiB) | Above this, container transforms go async (queue + SSE) to avoid DO memory pressure |

### Origin

```typescript
{
    name: string,              // Unique identifier
    matcher: string,           // Regex pattern (tested against request path)
    captureGroups?: string[],  // Named groups from regex match
    sources: Source[],         // Priority-ordered source list (min 1)
    quality?: string,          // Per-origin default quality
    videoCompression?: string, // Per-origin default compression
    ttl?: {                    // Per-origin cache TTL by status range (used to generate
        ok: number,            //   Cache-Control: public, max-age={ttl} when cacheControl
        redirects: number,     //   is not set for that status range)
        clientError: number,
        serverError: number
    },
    cacheControl?: {           // Full Cache-Control header per status range.
        ok?: string,           //   Overrides ttl-based generation. Supports all
        redirects?: string,    //   directives: s-maxage, stale-while-revalidate,
        clientError?: string,  //   no-store, private, etc.
        serverError?: string
    },
    useTtlByStatus?: boolean,
    cacheTags?: string[]       // Custom tags for purge-by-tag
}
```

### Source types

**R2:**
```json
{ "type": "r2", "bucketBinding": "VIDEOS", "priority": 0 }
```

**Remote:**
```json
{ "type": "remote", "url": "https://your-origin.com", "priority": 1 }
```

**Fallback:**
```json
{ "type": "fallback", "url": "https://backup.example.com", "priority": 2 }
```

### Auth (on any source)

```json
{ "type": "aws-s3", "accessKeyVar": "AWS_KEY", "secretKeyVar": "AWS_SECRET", "region": "us-east-1", "service": "s3", "sessionTokenVar": "AWS_SESSION_TOKEN" }
{ "type": "bearer", "tokenVar": "SOURCE_TOKEN" }
{ "type": "header", "headers": { "X-Custom-Auth": "secret-value" } }
```

`service` and `sessionTokenVar` are optional on `aws-s3` auth. Auth is configured as an `auth` field on any source object.

Auth env var values are read from Worker env at runtime (`envRecord[accessKeyVar]`).

### Derivative

```json
{
    "width": 1280, "height": 720,
    "mode": "video",
    "fit": "contain",
    "quality": "high",
    "compression": "medium",
    "time": "0s",
    "duration": "30s",
    "format": "mp4",
    "audio": true
}
```

All fields optional. Only specified fields override the request params.
Width/height range: 10–8192. Duration >60s triggers container routing.

**Note**: Avoid putting `duration` on video derivatives unless you specifically want to cap clip length. A derivative with `duration: "5m"` forces every request through the container path (>60s triggers `needsContainer`), even for sources the binding could handle.

### Responsive

```json
{
    "breakpoints": [
        { "maxWidth": 854, "derivative": "mobile" },
        { "maxWidth": 1280, "derivative": "tablet" },
        { "maxWidth": 1920, "derivative": "desktop" }
    ],
    "defaultDerivative": "desktop"
}
```

### Container

```json
{
    "enabled": true,
    "maxInputSize": 6442450944,
    "maxOutputForCache": 2147483648,
    "timeoutMs": 600000,
    "quality": {
        "low": { "crf": 28, "preset": "fast" },
        "medium": { "crf": 23, "preset": "medium" },
        "high": { "crf": 18, "preset": "medium" }
    },
    "sleepAfter": "5m",
    "maxInstances": 5
}
```

## Example config

```json
{
    "origins": [
        {
            "name": "standard",
            "matcher": "^/([^.]+)\\.(mp4|webm|mov)",
            "captureGroups": ["videoId", "extension"],
            "sources": [
                { "type": "remote", "priority": 0, "url": "https://your-origin.com" },
                { "type": "r2", "priority": 1, "bucketBinding": "VIDEOS" }
            ],
            "ttl": { "ok": 86400, "redirects": 300, "clientError": 60, "serverError": 10 },
            "cacheControl": {
                "ok": "public, max-age=86400, s-maxage=86400",
                "redirects": "public, max-age=300",
                "clientError": "public, max-age=60",
                "serverError": "no-store"
            },
            "videoCompression": "auto",
            "cacheTags": ["video-cdn"]
        }
    ],
    "derivatives": {
        "desktop":   { "width": 1920, "height": 1080, "fit": "contain" },
        "tablet":    { "width": 1280, "height": 720, "fit": "contain" },
        "mobile":    { "width": 854, "height": 640, "fit": "contain" },
        "thumbnail": { "width": 640, "height": 360, "mode": "frame", "format": "png", "fit": "cover", "time": "2s" }
    },
    "responsive": {
        "breakpoints": [
            { "maxWidth": 854, "derivative": "mobile" },
            { "maxWidth": 1280, "derivative": "tablet" },
            { "maxWidth": 99999, "derivative": "desktop" }
        ],
        "defaultDerivative": "desktop"
    },
    "passthrough": { "enabled": true, "formats": ["mp4", "webm", "mov"] },
    "container": { "enabled": true }
}
```

## Deployment setup

### Prerequisites

```bash
# Create queues
npx wrangler queues create video-transform-jobs
npx wrangler queues create video-transform-dlq

# Set secret
npx wrangler secret put CONFIG_API_TOKEN
```

### Bindings (wrangler.jsonc)

All bindings are in `wrangler.jsonc`. After changing bindings, regenerate types:

```bash
npx wrangler types
```

### Initial config upload

After first deploy, upload the config:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d @config.json \
    https://your-domain.com/admin/config
```

### D1 tables

Created automatically by the weekly cron cleanup. For first deploy, run manually:

```bash
npx wrangler d1 execute video-resizer-analytics --remote --file src/analytics/schema.sql
```

The `transform_jobs` table is created by the cleanup SQL or can be created manually:

```bash
npx wrangler d1 execute video-resizer-analytics --remote --command "CREATE TABLE IF NOT EXISTS transform_jobs (...)"
```
