# Transform Codec Audit

Codec-level analysis of Cloudflare Media Transformations output across all
three transform paths: Media binding, cdn-cgi/media, and FFmpeg container.

Run: `npm run test:audit` (generates fresh data from live deployment)

## Test files

| File | Size | Codec | Profile | Level | Res | Pix Fmt | Color | FPS |
|------|------|-------|---------|-------|-----|---------|-------|-----|
| rocky.mp4 | 40 MB | H.264 | High | 4.1 | 1920x1080 | yuvj420p | bt709 | ~30 |
| erfi-135kg.mp4 | 232 MB | HEVC | Main 10 | 5.1 | 1080x1920 (portrait) | yuv420p10le | BT.2020/HLG | ~30 |
| big_buck_bunny_1080p.mov | 725 MB | H.264 | Main | 4.1 | 1920x1080 | yuv420p | bt709 | 24 |

## Routing

Based on live KV config (`standard` origin = remote priority 0, R2 priority 1):

| File | Path | Origin | Source | Transform |
|------|------|--------|--------|-----------|
| rocky.mp4 | `/videos/rocky.mp4` | videos | R2 (priority 0) | **binding** (40 MB ≤ 100 MB) |
| rocky.mp4 | `/rocky.mp4` | standard | remote (priority 0) | **cdn-cgi** |
| erfi-135kg.mp4 | `/erfi-135kg.mp4` | standard | remote (priority 0) | **cdn-cgi** (232 MB ≤ 256 MB cdnCgiSizeLimit) |
| erfi-135kg.mp4 | `/erfi-135kg.mp4` | standard | R2 fallback (priority 1) | **container** (232 MB > 100 MB bindingSizeLimit) |
| big_buck_bunny_1080p.mov | `/big_buck_bunny_1080p.mov` | standard | remote | **container** (725 MB > 256 MB cdnCgiSizeLimit) |

Note: erfi sometimes falls from cdn-cgi to R2→container when cdn-cgi returns the
raw source untransformed (passthrough detection at `src/handlers/transform.ts:662-670`).

## Binding output (rocky.mp4, H.264 High source)

Every binding transform outputs H.264 **High** profile, Level **5.2**, **yuv420p** 8-bit.
Level 5.2 is constant regardless of output resolution. No color space metadata emitted.

| Params | Res | Profile | Level | Pix Fmt | Expected Level |
|--------|-----|---------|-------|---------|----------------|
| w=128 | 128x72 | High | 5.2 | yuv420p | ≤1.0 |
| w=160 | 160x90 | High | 5.2 | yuv420p | ≤1.1 |
| w=176 | 176x100 | High | 5.2 | yuv420p | ≤1.1 |
| w=192 | 192x108 | High | 5.2 | yuv420p | ≤1.1 |
| w=240 | 240x136 | High | 5.2 | yuv420p | ≤1.2 |
| w=320 | 320x180 | High | 5.2 | yuv420p | ≤1.3 |
| w=480 | 480x270 | High | 5.2 | yuv420p | ≤2.0 |
| w=640 | 640x360 | High | 5.2 | yuv420p | ≤2.2 |
| w=720 | 720x406 | High | 5.2 | yuv420p | ≤2.2 |
| w=854 | 854x480 | High | 5.2 | yuv420p | ≤3.0 |
| w=1080 | 1080x608 | High | 5.2 | yuv420p | ≤3.0 |
| w=1280 | 1280x720 | High | 5.2 | yuv420p | ≤3.0 |
| w=1440 | 1440x810 | High | 5.2 | yuv420p | ≤3.1 |
| w=1920 | 1920x1080 | High | 5.2 | yuv420p | ≤3.2 |

Height, fit=contain/cover/scale-down, w+h combos, duration, audio=false — all
produce Level 5.2. No variation observed across any parameter combination.

## CDN-CGI output (rocky.mp4, H.264 High source)

Levels scale correctly with output resolution. Profile always High. Color
space correctly tagged bt709. 8-bit yuv420p throughout.

| Params | Res | Profile | Level | Pix Fmt | Color |
|--------|-----|---------|-------|---------|-------|
| w=128 | 128x72 | High | 1.0 | yuv420p | bt709 |
| w=160 | 160x90 | High | 1.1 | yuv420p | bt709 |
| w=176 | 176x98 | High | 1.1 | yuv420p | bt709 |
| w=192 | 192x108 | High | 1.1 | yuv420p | bt709 |
| w=240 | 240x134 | High | 1.2 | yuv420p | bt709 |
| w=320 | 320x180 | High | 1.3 | yuv420p | bt709 |
| w=480 | 480x270 | High | 2.1 | yuv420p | bt709 |
| w=640 | 640x360 | High | 3.0 | yuv420p | bt709 |
| w=720 | 720x404 | High | 3.0 | yuv420p | bt709 |
| w=854 | 852x480 | High | 3.1 | yuv420p | bt709 |
| w=1080 | 1080x608 | High | 3.1 | yuv420p | bt709 |
| w=1280 | 1280x720 | High | 3.1 | yuv420p | bt709 |
| w=1440 | 1440x810 | High | 3.2 | yuv420p | bt709 |
| w=1920 | 1920x1080 | High | 4.0 | yuv420p | bt709 |

All fit/height/duration/audio variations produce correct levels for their resolution.

## CDN-CGI output (erfi-135kg.mp4, HEVC Main 10 source)

Transcodes HEVC to H.264. Mostly 8-bit High profile with correct levels.
BT.2020/HLG color metadata from source is preserved (arguably incorrect for
SDR H.264 but decoders handle it). Some transforms intermittently produce
10-bit High 10 profile — see Anomalies.

| Params | Res | Profile | Level | Pix Fmt | Bits | Color |
|--------|-----|---------|-------|---------|------|-------|
| w=128 | 128x228 | High | 1.2 | yuv420p | 8 | bt2020nc |
| w=160 | 160x284 | High | 1.2 | yuv420p | 8 | bt2020nc |
| w=176 | 176x312 | High | 1.3 | yuv420p | 8 | bt2020nc |
| w=192 | 192x340 | High | 1.3 | yuv420p | 8 | bt2020nc |
| w=240 | 240x426 | High | 2.1 | yuv420p | 8 | bt2020nc |
| w=320 | 320x568 | High | 3.0 | yuv420p | 8 | bt2020nc |
| w=480 | 480x852 | High | 3.1 | yuv420p | 8 | bt2020nc |
| w=640 | 640x1138 | High | 3.1 | yuv420p | 8 | bt2020nc |
| w=720 | 720x1280 | High | 3.1 | yuv420p | 8 | bt2020nc |
| w=854 | 854x1518 | **High 10** | 4.0 | **yuv420p10le** | 10 | bt2020nc |
| w=1080 | 1080x1920 | **High 10** | 4.0 | **yuv420p10le** | 10 | bt2020nc |
| w=1280 | 1080x1920 | High | 4.0 | yuv420p | 8 | bt2020nc |
| h=240 | 134x240 | High | 1.2 | yuv420p | 8 | bt2020nc |
| h=360 | 202x358 | High | 1.3 | yuv420p | 8 | bt2020nc |
| h=480 | 270x480 | **High 10** | 2.1 | **yuv420p10le** | 10 | bt2020nc |
| h=720 | 404x720 | High | 3.0 | yuv420p | 8 | bt2020nc |
| h=1080 | 608x1080 | **High 10** | 3.1 | **yuv420p10le** | 10 | bt2020nc |

The 10-bit outputs are non-deterministic — same params produce 8-bit on some
requests and 10-bit on others. This appears to be a Cloudflare cdn-cgi bug
with HEVC Main 10 source transcoding.

## Container fallback (erfi-135kg.mp4)

When cdn-cgi returns the raw source (passthrough), the request falls to R2
(priority 1 in standard origin) → 232 MB exceeds binding limit → container.

Before the `-pix_fmt yuv420p` fix (`container/server.mjs:378`), the container
always produced 10-bit High 10 from HEVC Main 10 input. After the fix, it
forces 8-bit yuv420p output.

| Scenario | Profile | Pix Fmt | Cause |
|----------|---------|---------|-------|
| Before fix | High 10 | yuv420p10le | libx264 preserves 10-bit from source |
| After fix | High | yuv420p | `-pix_fmt yuv420p` forces 8-bit downconversion |

## Passthrough behavior

When cdn-cgi fails to transform erfi (returns raw 232 MB source), the
passthrough detection at `src/handlers/transform.ts:662-670` catches it:

```
contentLength > 0 && response.Content-Length === contentLength → passthrough
```

The `standard` origin then tries R2 (priority 1) → binding limit exceeded
→ container. Previously `x-transform-source` was set to `unknown` for the
raw passthrough fallback path. Now set to `passthrough`.

Passthrough was observed at these erfi dimension combos:

- `854x480/fit=contain` — cdn-cgi returned raw source
- `854x480/fit=cover` — cdn-cgi returned raw source
- `854x480/fit=scale-down` — cdn-cgi returned raw source

Not all large erfi transforms trigger passthrough — `w=640`, `w=720`, `w=1280`
all worked via cdn-cgi. The failure pattern correlates with specific w+h+fit
combinations on the 232 MB HEVC source.

## Anomalies

### 1. Binding: Level 5.2 on all resolutions

43/43 binding transforms output Level 5.2 (4K60 spec). The binding encoder
does not auto-select level based on output resolution. cdn-cgi does this
correctly. Cloudflare Media binding bug — no API parameter to control this.

Impact: hardware decoders on constrained devices (set-top boxes, older phones)
may reject streams or over-allocate resources. Software decoders handle it.

### 2. CDN-CGI: intermittent 10-bit from HEVC Main 10 source

9/38 erfi cdn-cgi transforms produced H.264 High 10 / yuv420p10le. The
same params produce 8-bit on retry. Non-deterministic.

10-bit outputs observed at: `w=128`, `w=854`, `w=1080`, `h=480`, `h=1080`,
`320x240/scale-down`, `720x1280`, `1080x1080`, `w=640/audio=false`.

H.264 High 10 is not supported by most mobile hardware decoders or Safari.

### 3. CDN-CGI: passthrough on large HEVC with w+h+fit

cdn-cgi sometimes returns the raw 232 MB source untransformed for specific
dimension combos on erfi. Our passthrough detection catches this and falls
through to container. Fixed: container now forces 8-bit via `-pix_fmt yuv420p`.

## What we send

| Path | Parameters sent |
|------|----------------|
| binding (`src/transform/binding.ts`) | `width`, `height`, `fit` |
| cdn-cgi (`src/transform/cdncgi.ts`) | `width`, `height`, `fit`, `mode`, `time`, `duration`, `format`, `audio` |
| container (`container/server.mjs`) | all params + `-c:v libx264 -pix_fmt yuv420p` |

No profile, level, or color space controls exist in the binding or cdn-cgi APIs.

## H.264 level reference

| Level | Max MB/s | Typical Res |
|-------|----------|-------------|
| 1.0 | 1,485 | 176x144@15 |
| 1.3 | 6,000 | 320x240@36 |
| 2.1 | 19,800 | 480x360@30 |
| 3.0 | 40,500 | 720x480@30 |
| 3.1 | 108,000 | 1280x720@30 |
| 4.0 | 245,760 | 1920x1080@30 |
| 5.1 | 983,040 | 4096x2160@30 |
| 5.2 | 2,073,600 | 4096x2160@60 |
| 6.2 | 4,177,920 | 8192x4320@120 |

## Audit tool

```sh
npm run test:audit                    # full run: download + ffprobe + report
npm run test:audit -- --only binding  # filter by label
npm run test:audit -- --skip-cached   # reuse downloaded files
npm run test:audit -- --tail          # attach wrangler tail
npm run test:audit -- --concurrency 2 # fewer parallel requests
```

Requires: `ffprobe` (ffmpeg), `curl`. Downloads each transform variant,
saves to `/tmp/transform-audit/live/`, runs ffprobe, captures response
headers (`x-transform-source`, `x-r2-cache`, etc.) to verify actual
transform path. Retries on passthrough detection. Outputs report to
`docs/transform-audit.md` and JSON to `/tmp/transform-audit/live/audit-results.json`.
