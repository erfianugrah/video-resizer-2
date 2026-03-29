# Setup Guide

Step-by-step setup for video-resizer-2 from scratch.

## Prerequisites

- Node.js >= 22
- npm
- Cloudflare account with Workers Paid plan
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler`)
- Docker Desktop (for container builds)
- A custom domain on Cloudflare (required for Cache API)

## 1. Clone and install

```bash
git clone <repo-url>
cd video-resizer-2
npm install
```

## 2. Cloudflare resources

Create the required resources via the Cloudflare dashboard or CLI:

### R2 Bucket

```bash
npx wrangler r2 bucket create videos
```

### KV Namespaces

```bash
npx wrangler kv namespace create CONFIG
npx wrangler kv namespace create CACHE_VERSIONS
```

Note the IDs printed — you'll need them for `wrangler.jsonc`.

### D1 Database

```bash
npx wrangler d1 create video-resizer-analytics
```

Note the database ID.

### Queues

```bash
npx wrangler queues create video-transform-jobs
npx wrangler queues create video-transform-dlq
```

## 3. Configure wrangler.jsonc

Update `wrangler.jsonc` with your resource IDs:

```jsonc
{
  "name": "video-resizer-2",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-10",
  "compatibility_flags": ["nodejs_compat"],
  "account_id": "<your-account-id>",
  // ...
  "kv_namespaces": [
    { "binding": "CONFIG", "id": "<your-config-kv-id>" },
    { "binding": "CACHE_VERSIONS", "id": "<your-cache-versions-kv-id>" }
  ],
  "d1_databases": [
    { "binding": "ANALYTICS", "database_name": "video-resizer-analytics", "database_id": "<your-d1-id>" }
  ],
  "routes": [
    { "pattern": "your-domain.com", "custom_domain": true }
  ]
}
```

## 4. Initialize D1 schema

The schema is defined in `src/analytics/schema.sql` (single source of truth):

```bash
npx wrangler d1 execute video-resizer-analytics --remote --file=src/analytics/schema.sql
```

This creates two tables: `transform_log` (analytics) and `transform_jobs` (container job registry).

## 5. Set secrets

```bash
# Admin API token (used for /admin/* endpoints and dashboard login)
npx wrangler secret put CONFIG_API_TOKEN
# Enter a strong random token when prompted
```

## 6. Upload initial config

Create a JSON config and upload via the admin API (after first deploy), or seed KV directly:

```bash
npx wrangler kv key put --namespace-id=<config-kv-id> "worker-config" '{
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
    "desktop": { "width": 1920, "height": 1080 },
    "tablet": { "width": 1280, "height": 720 },
    "mobile": { "width": 854, "height": 640 },
    "thumbnail": { "width": 640, "height": 360, "mode": "frame", "format": "png", "time": "2s" }
  },
  "responsive": {
    "breakpoints": [
      { "maxWidth": 854, "derivative": "mobile" },
      { "maxWidth": 1280, "derivative": "tablet" },
      { "maxWidth": 99999, "derivative": "desktop" }
    ],
    "defaultDerivative": "desktop"
  }
}'
```

## 7. Enable Media Transformations

In the Cloudflare dashboard:

1. Go to **Stream** > **Transformations**
2. Enable **Media Transformations** on your zone
3. Under **Sources**, add any remote origin domains your config references (or select "Any origin")

Without this, `cdn-cgi/media` requests will return errors for remote sources.

## 8. Build dashboard

```bash
npm run dashboard:build
```

This builds the Astro+React dashboard to `dashboard/dist/` which is served via the `ASSETS` binding.

## 9. Deploy

```bash
# Ensure Docker Desktop is running (needed for container image build)
npx wrangler deploy
```

First deploy will:
- Upload the Worker code
- Build and push the FFmpeg container image
- Set up queue consumers (including DLQ)
- Configure the cron trigger (weekly D1 cleanup)

## 10. Verify

```bash
# Basic transform
curl -s "https://your-domain.com/video.mp4?width=640" -o /dev/null -w "%{http_code}\n"

# Debug diagnostics
curl -s "https://your-domain.com/video.mp4?debug=view" | jq .diagnostics.params

# Admin API
curl -s -H "Authorization: Bearer YOUR_TOKEN" "https://your-domain.com/admin/analytics?hours=1" | jq .

# Dashboard
open https://your-domain.com/admin/dashboard
```

## 11. Run tests

```bash
# Unit tests (runs in Workers pool, no deploy needed)
npm run test:run

# E2E tests (requires live deployment + CONFIG_API_TOKEN env var)
CONFIG_API_TOKEN=your-token npm run test:e2e

# Smoke tests (post-deploy verification, 84 checks)
CONFIG_API_TOKEN=your-token npx tsx scripts/smoke.ts

# Playwright browser tests (requires live deployment)
CONFIG_API_TOKEN=your-token npx playwright test

# All with container tests (slow, ~6min, tests 725MB+ async path)
CONFIG_API_TOKEN=your-token npx tsx scripts/smoke.ts --container
```

## Upload videos to R2

```bash
# Via wrangler
npx wrangler r2 object put videos/my-video.mp4 --file=./my-video.mp4

# Or via rclone (for bulk uploads)
rclone copy ./videos/ r2:videos/
```

## Troubleshooting

### "Media Transformations not enabled"
Enable in CF dashboard: Stream > Transformations. Add source domains.

### Cache not working (cf-cache-status: DYNAMIC)
Cache API requires a custom domain route, not `*.workers.dev`. Check your `routes` in `wrangler.jsonc`.

### Container builds failing
Ensure Docker Desktop is running. Wrangler uses Docker to build the FFmpeg container image.

### D1 "table not found" errors
Run the schema initialization: `npx wrangler d1 execute video-resizer-analytics --remote --file=src/analytics/schema.sql`

### 401 on admin endpoints
Set the `CONFIG_API_TOKEN` secret: `npx wrangler secret put CONFIG_API_TOKEN`

### Container jobs stuck / never complete
Check the DLQ consumer is configured in `wrangler.jsonc`. Jobs that exhaust 10 retries go to `video-transform-dlq` and are marked failed by the DLQ consumer.
