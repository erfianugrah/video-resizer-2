# Setup Guide

Step-by-step setup for video-resizer-2 from scratch.

## Prerequisites

- Node.js >= 22
- npm
- Cloudflare account with **Workers Paid plan** (required for Durable Objects, Queues, D1)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) v4+ (`npm i -g wrangler`)
- Docker Desktop (for building the FFmpeg container image)
- A **custom domain** on Cloudflare (the Cache API is a no-op on `*.workers.dev`)

## 1. Clone and install

```bash
git clone <repo-url>
cd video-resizer-2
npm install
```

## 2. Create Cloudflare resources

Each command prints an ID — save them for step 3.

### R2 Bucket

```bash
npx wrangler r2 bucket create videos
```

### KV Namespaces

```bash
npx wrangler kv namespace create CONFIG
# -> id: <CONFIG_KV_ID>

npx wrangler kv namespace create CACHE_VERSIONS
# -> id: <CACHE_VERSIONS_KV_ID>
```

### D1 Database

```bash
npx wrangler d1 create video-resizer-analytics
# -> database_id: <D1_DATABASE_ID>
```

### Queues

```bash
npx wrangler queues create video-transform-jobs
npx wrangler queues create video-transform-dlq
```

## 3. Configure wrangler.jsonc

Replace the placeholder IDs with your actual values. Below is the complete
template — every binding, the container DO, queue consumers, and cron trigger:

```jsonc
{
    "$schema": "node_modules/wrangler/config-schema.json",
    "name": "video-resizer-2",
    "main": "src/index.ts",
    "compatibility_date": "2026-03-10",
    "compatibility_flags": ["nodejs_compat"],   // Required for Container + aws4fetch
    "account_id": "<your-account-id>",
    "workers_dev": false,                       // Custom domain only (Cache API doesn't work on *.workers.dev)

    // ── Static assets (dashboard UI) ─────────────────────────────────
    "assets": {
        "directory": "./dashboard/dist",
        "binding": "ASSETS"
    },

    // ── Observability ────────────────────────────────────────────────
    "observability": {
        "enabled": true,
        "logs": { "invocation_logs": true }
    },

    // ── Media Transformations binding ────────────────────────────────
    // Requires enabling Media Transformations on your zone (step 7)
    "media": { "binding": "MEDIA" },

    // ── R2 ───────────────────────────────────────────────────────────
    "r2_buckets": [
        { "binding": "VIDEOS", "bucket_name": "videos" }
    ],

    // ── KV ───────────────────────────────────────────────────────────
    "kv_namespaces": [
        { "binding": "CONFIG", "id": "<CONFIG_KV_ID>" },
        { "binding": "CACHE_VERSIONS", "id": "<CACHE_VERSIONS_KV_ID>" }
    ],

    // ── D1 ───────────────────────────────────────────────────────────
    "d1_databases": [
        {
            "binding": "ANALYTICS",
            "database_name": "video-resizer-analytics",
            "database_id": "<D1_DATABASE_ID>"
        }
    ],

    // ── Custom domain route ──────────────────────────────────────────
    // IMPORTANT: Cache API requires a custom domain. *.workers.dev won't cache.
    "routes": [
        { "pattern": "your-domain.com", "custom_domain": true }
    ],

    // ── Cron trigger (weekly D1 cleanup) ─────────────────────────────
    "triggers": {
        "crons": ["0 0 * * sun"]
    },

    // ── FFmpeg Container ─────────────────────────────────────────────
    // Builds from container/Dockerfile. Requires Docker Desktop running.
    "containers": [
        {
            "class_name": "FFmpegContainer",
            "image": "./container/Dockerfile",
            "max_instances": 5,
            "instance_type": { "vcpu": 4, "memory_mib": 12288, "disk_mb": 20000 }
        }
    ],

    // ── Durable Objects ──────────────────────────────────────────────
    "durable_objects": {
        "bindings": [
            { "name": "FFMPEG_CONTAINER", "class_name": "FFmpegContainer" }
        ]
    },

    // ── DO Migrations ────────────────────────────────────────────────
    // These track the Durable Object schema history. Keep all entries.
    "migrations": [
        { "tag": "v1", "new_sqlite_classes": ["FFmpegContainer"] },
        { "tag": "v2", "new_sqlite_classes": ["TransformJobDO"] },
        { "tag": "v3", "deleted_classes": ["TransformJobDO"] }
    ],

    // ── Queues ───────────────────────────────────────────────────────
    "queues": {
        "producers": [
            { "binding": "TRANSFORM_QUEUE", "queue": "video-transform-jobs" }
        ],
        "consumers": [
            {
                "queue": "video-transform-jobs",
                "max_batch_size": 1,          // Process one job at a time per consumer
                "max_retries": 10,            // 10 retries before DLQ
                "max_batch_timeout": 5,
                "max_concurrency": 2,         // Max 2 concurrent consumers
                "dead_letter_queue": "video-transform-dlq"
            },
            {
                "queue": "video-transform-dlq",
                "max_batch_size": 10,
                "max_retries": 0              // DLQ consumer marks terminal failure, no further retries
            }
        ]
    }
}
```

### Bindings reference

| Binding | Type | Purpose |
|---------|------|---------|
| `MEDIA` | Media Transformations | Video transform binding (R2 sources <=100MB) |
| `VIDEOS` | R2 Bucket | Source videos + transform cache (`_transformed/`) + source cache (`_source-cache/`) |
| `CONFIG` | KV | Worker configuration (JSON, Zod-validated) |
| `CACHE_VERSIONS` | KV | Optional manual force-bust (version appended to cache key only when set) |
| `ANALYTICS` | D1 | Request analytics (`transform_log`) + job registry (`transform_jobs`) |
| `FFMPEG_CONTAINER` | Container DO | FFmpeg transforms (4 vCPU, 12GB RAM, 20GB disk) |
| `TRANSFORM_QUEUE` | Queue Producer | Durable job dispatch for container transforms |
| `ASSETS` | Static Assets | Dashboard UI (Astro build output) |
| `CONFIG_API_TOKEN` | Secret | Bearer token for admin endpoints + dashboard login |

## 4. Initialize D1 schema

The schema is defined in `src/analytics/schema.sql` (single source of truth).
Creates both the `transform_log` (analytics) and `transform_jobs` (container job registry) tables:

```bash
npx wrangler d1 execute video-resizer-analytics --remote --file=src/analytics/schema.sql
```

Verify:
```bash
npx wrangler d1 execute video-resizer-analytics --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
# Should show: transform_log, transform_jobs
```

## 5. Set secrets

```bash
# Admin API token — used for /admin/* endpoints and dashboard login.
# Choose a strong random value (e.g. openssl rand -hex 32).
npx wrangler secret put CONFIG_API_TOKEN
```

## 6. Upload initial config

**Option A: Seed KV directly** (before first deploy):

```bash
npx wrangler kv key put --namespace-id=<CONFIG_KV_ID> "worker-config" '{
  "origins": [
    {
      "name": "default",
      "matcher": ".*",
      "sources": [
        { "type": "r2", "bucketBinding": "VIDEOS", "priority": 0 },
        { "type": "remote", "url": "https://your-origin.com", "priority": 1 }
      ],
      "ttl": { "ok": 86400, "redirects": 300, "clientError": 60, "serverError": 10 }
    }
  ],
  "derivatives": {
    "desktop":   { "width": 1920, "height": 1080 },
    "tablet":    { "width": 1280, "height": 720 },
    "mobile":    { "width": 854, "height": 640 },
    "thumbnail": { "width": 640, "height": 360, "mode": "frame", "format": "png", "time": "2s" }
  },
  "responsive": {
    "breakpoints": [
      { "maxWidth": 854, "derivative": "mobile" },
      { "maxWidth": 1280, "derivative": "tablet" },
      { "maxWidth": 99999, "derivative": "desktop" }
    ],
    "defaultDerivative": "desktop"
  },
  "container": { "enabled": true }
}'
```

**Option B: Admin API** (after first deploy — Zod-validates the config):

```bash
curl -X POST \
  -H "Authorization: Bearer $CONFIG_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @config.json \
  https://your-domain.com/admin/config
```

See `docs/configuration.md` for the full schema reference.

## 7. Enable Media Transformations

In the Cloudflare dashboard:

1. Go to **Stream** > **Transformations**
2. Enable **Media Transformations** on your zone
3. Under **Sources**, add any remote origin domains your config references (or select "Any origin")

Without this, the `MEDIA` binding and `cdn-cgi/media` requests will fail for remote sources.

> **Note**: The binding works for R2 sources without any dashboard configuration.
> "Sources" only matters for cdn-cgi remote transforms.

## 8. Build dashboard and deploy

```bash
# Ensure Docker Desktop is running (needed for FFmpeg container image build)
npm run deploy
```

`npm run deploy` runs the dashboard build automatically, then deploys everything:
- Worker code + static dashboard assets
- FFmpeg container image (built via Docker, pushed to CF registry)
- Queue consumers (including DLQ)
- Cron trigger (weekly D1 cleanup)

First deploy output should show:
```
Deployed video-resizer-2 triggers
  your-domain.com (custom domain)
  schedule: 0 0 * * sun
  Producer for video-transform-jobs
  Consumer for video-transform-jobs
  Consumer for video-transform-dlq
```

## 9. Verify

```bash
# Health check — should return your video
curl -s "https://your-domain.com/video.mp4?width=640" -o /dev/null -w "HTTP %{http_code}, %{size_download} bytes\n"

# Debug diagnostics — shows resolved params, matched origin, routing decision
curl -s "https://your-domain.com/video.mp4?debug=view" | jq .diagnostics

# Admin analytics
curl -s -H "Authorization: Bearer $CONFIG_API_TOKEN" \
  "https://your-domain.com/admin/analytics?hours=1" | jq .summary

# Dashboard (opens login page, enter your CONFIG_API_TOKEN)
open https://your-domain.com/admin/dashboard

# Container health — trigger a container transform
curl -s "https://your-domain.com/video.mp4?mode=spritesheet&width=160&imageCount=10" \
  -o spritesheet.jpg -w "HTTP %{http_code}\n"
```

## 10. Run tests

```bash
# Unit tests (runs in Workers vitest pool, no deploy needed)
npm run test:run

# E2E tests (requires live deployment + CONFIG_API_TOKEN env var)
CONFIG_API_TOKEN=your-token npm run test:e2e

# Smoke tests (post-deploy, 84 checks)
CONFIG_API_TOKEN=your-token npx tsx scripts/smoke.ts

# Playwright browser tests
CONFIG_API_TOKEN=your-token npx playwright test

# Container smoke tests (slow ~6min, tests 725MB+ async path)
CONFIG_API_TOKEN=your-token npx tsx scripts/smoke.ts --container
```

## Upload videos to R2

```bash
# Single file via wrangler
npx wrangler r2 object put videos/my-video.mp4 --file=./my-video.mp4

# Bulk upload via rclone (install rclone first, configure R2 remote)
rclone copy ./videos/ r2:videos/ --progress
```

## Updating

After code changes:

```bash
npm run deploy                    # Redeploy Worker + container + dashboard
```

After schema changes:

```bash
npx wrangler d1 execute video-resizer-analytics --remote --file=src/analytics/schema.sql
```

After config changes:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @config.json https://your-domain.com/admin/config
```

## Troubleshooting

### "Media Transformations not enabled"
Enable in CF dashboard: **Stream > Transformations**. Add source domains under "Sources".

### Cache not working (`cf-cache-status: DYNAMIC`)
Cache API requires a **custom domain route**, not `*.workers.dev`. Verify `routes` in `wrangler.jsonc` uses `custom_domain: true`.

### Container builds failing
- Ensure Docker Desktop is running
- Check Docker has enough disk space (container image is ~500MB)
- Try `docker system prune` if disk is full

### D1 "table not found" errors
Run the schema initialization:
```bash
npx wrangler d1 execute video-resizer-analytics --remote --file=src/analytics/schema.sql
```

### 401 on admin endpoints
```bash
npx wrangler secret put CONFIG_API_TOKEN
```

### Container jobs stuck / never complete
1. Check DLQ consumer is configured in `wrangler.jsonc` (both `video-transform-jobs` and `video-transform-dlq` consumers)
2. Check Docker Desktop is running (container image must exist)
3. Check the dashboard Jobs tab — stale jobs can be retried or deleted
4. Check queue backlog: `npx wrangler queues list`

### Dashboard shows login page but won't accept token
The `CONFIG_API_TOKEN` secret must be set. The dashboard login validates against this secret.

### Transform returns 502 "ALL_SOURCES_FAILED"
- Check your config has at least one working source for the matched origin
- For R2 sources: verify the file exists in the bucket (`npx wrangler r2 object head videos/path.mp4`)
- For remote sources: verify the URL is accessible and returns video content
- Check `?debug=view` output to see which origin matched and what sources were tried

### Container returns 500 / ffmpeg errors
Check the container logs in the dashboard Jobs tab (expand a failed job to see the error). Common causes:
- Input file is not a valid video
- Unsupported codec (the container supports H.264, H.265, VP9)
- Disk full (20GB limit per container instance)
