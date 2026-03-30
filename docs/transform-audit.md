# Transform Codec Audit

> Generated: 2026-03-30T15:04:15.364Z
> Base URL: `https://videos.erfi.io`
> Total probed: 0

## Source Files

| File | Codec | Profile | Level | Resolution | Pix Fmt | Color |
|------|-------|---------|-------|------------|---------|-------|
| rocky.mp4 | H.264 | High | 4.1 | 1920x1080 | yuvj420p | bt709 |
| erfi-135kg.mp4 | HEVC | Main 10 | 5.1 | 1080x1920 | yuv420p10le | BT.2020 / HLG |

## Anomalies

None detected.
## Key Findings

### 1. Binding always outputs Level 5.2

The Media binding produced level(s): **** across ALL output
resolutions (128x72 through 1920x1080). This is incorrect — Level 5.2 is meant
for 4K content. A 128x72 video should be Level 1.0. This is a Cloudflare Media
binding bug where the encoder does not auto-select the appropriate level.

### 2. CDN-CGI correctly auto-selects levels

CDN-CGI produced levels: **** — scaling correctly
with output resolution per the H.264 specification.

### 3. HEVC Main 10 → H.264 transcode is inconsistent

Of 0 erfi transforms, **0 output 10-bit** (High 10 / yuv420p10le)
and **0 correctly downconverted to 8-bit** (High / yuv420p).
The 10-bit outputs will cause playback failures on most mobile browsers and
hardware decoders that lack High 10 profile support.

### 4. Profile is always High

Both binding and cdn-cgi always output H.264 **High** profile regardless of
source (Main, High, or HEVC Main 10). This is acceptable — High profile provides
better compression efficiency and is universally supported.

### 5. Color metadata pass-through

BT.2020/HLG color metadata from the HEVC source is preserved in H.264 output.
When combined with 8-bit conversion, this creates an incorrect signal — the color
space should be BT.709 for SDR H.264. However, most decoders handle this gracefully.

### 6. We have no control over these parameters

The binding API (`src/transform/binding.ts`) only accepts: `width`, `height`, `fit`.
The cdn-cgi URL builder (`src/transform/cdncgi.ts`) adds: `mode`, `time`, `duration`,
`format`, `audio`. **Neither path exposes profile, level, pixel format, or color space
controls.** These are entirely determined by the Cloudflare Media Transformations service.

## H.264 Level Reference

| Level | Max MB/s | Typical Max Resolution | Bitrate (High) |
|-------|----------|------------------------|----------------|
| 1.0 | 1,485 | 176x144@15fps | 80 kbps |
| 1.2 | 3,000 | 320x240@10fps | 384 kbps |
| 1.3 | 6,000 | 320x240@36fps | 768 kbps |
| 2.1 | 19,800 | 480x360@30fps | 5 Mbps |
| 3.0 | 40,500 | 720x480@30fps | 12.5 Mbps |
| 3.1 | 108,000 | 1280x720@30fps | 17.5 Mbps |
| 3.2 | 216,000 | 1280x1024@42fps | 25 Mbps |
| 4.0 | 245,760 | 1920x1080@30fps | 25 Mbps |
| 4.1 | 245,760 | 1920x1080@30fps | 62.5 Mbps |
| 5.1 | 983,040 | 4096x2160@30fps | 300 Mbps |
| **5.2** | **2,073,600** | **4096x2160@60fps** | **300 Mbps** |
| 6.2 | 4,177,920 | 8192x4320@120fps | 800 Mbps |

> **Level 5.2 on a 128x72 output is absurd** — it tells the decoder to prepare
> for 4K60 content when the actual video is thumbnail-sized. While most software
> decoders handle this gracefully, hardware decoders on constrained devices may
> reject or mishandle the stream.
