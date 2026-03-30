# Transform Codec Audit

Date: 2026-03-30  
Target: `https://videos.erfi.io`  
Probed: 116 transforms, 52 anomalies

## Sources

| File | Size | Codec | Profile | Level | Res | Pix Fmt | Color | Route |
|------|------|-------|---------|-------|-----|---------|-------|-------|
| rocky.mp4 | 40 MB | H.264 | High | 4.1 | 1920x1080 | yuvj420p | bt709 | `/videos/` R2->binding, `/` remote->cdn-cgi |
| erfi-135kg.mp4 | 232 MB | HEVC | Main 10 | 5.1 | 1080x1920 | yuv420p10le | BT.2020/HLG | `/` remote->cdn-cgi |

## binding (43 transforms, 43 flagged)

| File | Params | Actual | Codec | Profile | Level | Res | Pix Fmt | Bits | Color | Flag |
|------|--------|--------|-------|---------|-------|-----|---------|------|-------|------|
| rocky.mp4 | w=128 | binding | h264 | High | 5.2 | 128x72 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.0 for 128x72@30fps |
| rocky.mp4 | w=160 | **cached** | h264 | High | 5.2 | 160x90 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.1 for 160x90@30fps |
| rocky.mp4 | w=176 | **cached** | h264 | High | 5.2 | 176x100 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.1 for 176x100@30fps |
| rocky.mp4 | w=192 | **cached** | h264 | High | 5.2 | 192x108 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.1 for 192x108@30fps |
| rocky.mp4 | w=240 | **cached** | h264 | High | 5.2 | 240x136 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.2 for 240x136@30fps |
| rocky.mp4 | w=320 | **cached** | h264 | High | 5.2 | 320x180 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.3 for 320x180@30fps |
| rocky.mp4 | w=480 | **cached** | h264 | High | 5.2 | 480x270 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.0 for 480x270@30fps |
| rocky.mp4 | w=640 | **cached** | h264 | High | 5.2 | 640x360 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | w=720 | **cached** | h264 | High | 5.2 | 720x406 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.2 for 720x406@30fps |
| rocky.mp4 | w=854 | **cached** | h264 | High | 5.2 | 854x480 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 854x480@30fps |
| rocky.mp4 | w=1080 | **cached** | h264 | High | 5.2 | 1080x608 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 1080x608@30fps |
| rocky.mp4 | w=1280 | **cached** | h264 | High | 5.2 | 1280x720 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | w=1440 | **cached** | h264 | High | 5.2 | 1440x810 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.1 for 1440x810@30fps |
| rocky.mp4 | w=1920 | **cached** | h264 | High | 5.2 | 1920x1080 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.2 for 1920x1080@30fps |
| rocky.mp4 | h=180 | **cached** | h264 | High | 5.2 | 320x180 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.3 for 320x180@30fps |
| rocky.mp4 | h=240 | **cached** | h264 | High | 5.2 | 426x240 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.0 for 426x240@30fps |
| rocky.mp4 | h=360 | **cached** | h264 | High | 5.2 | 640x360 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | h=480 | **cached** | h264 | High | 5.2 | 854x480 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 854x480@30fps |
| rocky.mp4 | h=720 | **cached** | h264 | High | 5.2 | 1280x720 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | h=1080 | **cached** | h264 | High | 5.2 | 1920x1080 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.2 for 1920x1080@30fps |
| rocky.mp4 | 320x240/contain | **cached** | h264 | High | 5.2 | 320x180 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.3 for 320x180@30fps |
| rocky.mp4 | 640x360/contain | **cached** | h264 | High | 5.2 | 640x360 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | 854x480/contain | **cached** | h264 | High | 5.2 | 854x480 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 854x480@30fps |
| rocky.mp4 | 1280x720/contain | **cached** | h264 | High | 5.2 | 1280x720 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | 1920x1080/contain | **cached** | h264 | High | 5.2 | 1920x1080 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.2 for 1920x1080@30fps |
| rocky.mp4 | 320x240/cover | **cached** | h264 | High | 5.2 | 320x240 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.3 for 320x240@30fps |
| rocky.mp4 | 640x360/cover | **cached** | h264 | High | 5.2 | 640x360 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | 854x480/cover | **cached** | h264 | High | 5.2 | 854x480 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 854x480@30fps |
| rocky.mp4 | 1280x720/cover | **cached** | h264 | High | 5.2 | 1280x720 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | 1920x1080/cover | **cached** | h264 | High | 5.2 | 1920x1080 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.2 for 1920x1080@30fps |
| rocky.mp4 | 320x240/scale-down | **cached** | h264 | High | 5.2 | 320x180 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.3 for 320x180@30fps |
| rocky.mp4 | 640x360/scale-down | **cached** | h264 | High | 5.2 | 640x360 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | 854x480/scale-down | **cached** | h264 | High | 5.2 | 854x480 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 854x480@30fps |
| rocky.mp4 | 1280x720/scale-down | **cached** | h264 | High | 5.2 | 1280x720 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | 1920x1080/scale-down | **cached** | h264 | High | 5.2 | 1920x1080 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.2 for 1920x1080@30fps |
| rocky.mp4 | 640x640 | **cached** | h264 | High | 5.2 | 640x360 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | 800x600 | **cached** | h264 | High | 5.2 | 800x450 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 800x450@30fps |
| rocky.mp4 | 400x720 | **cached** | h264 | High | 5.2 | 400x226 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.3 for 400x226@30fps |
| rocky.mp4 | 1280x1280 | **cached** | h264 | High | 5.2 | 1280x720 | yuv420p | 8 |  | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | 300x300 | **cached** | h264 | High | 5.2 | 300x168 | yuv420p | 8 |  | Level 5.2 vs expected ≤1.3 for 300x168@30fps |
| rocky.mp4 | w=640/d=5s | **cached** | h264 | High | 5.2 | 640x360 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | w=640/t=2s/d=5s | **cached** | h264 | High | 5.2 | 640x360 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | w=640/audio=false | **cached** | h264 | High | 5.2 | 640x360 | yuv420p | 8 |  | Level 5.2 vs expected ≤2.2 for 640x360@30fps |

## cdn-cgi (73 transforms, 9 flagged)

### rocky.mp4

| File | Params | Actual | Codec | Profile | Level | Res | Pix Fmt | Bits | Color | Flag |
|------|--------|--------|-------|---------|-------|-----|---------|------|-------|------|
| rocky.mp4 | w=128 | **cached** | h264 | High | 1.0 | 128x72 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=160 | **cached** | h264 | High | 1.1 | 160x90 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=176 | **cached** | h264 | High | 1.1 | 176x98 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=192 | **cached** | h264 | High | 1.1 | 192x108 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=240 | **cached** | h264 | High | 1.2 | 240x134 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=320 | **cached** | h264 | High | 1.3 | 320x180 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=480 | **cached** | h264 | High | 2.1 | 480x270 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=640 | **cached** | h264 | High | 3.0 | 640x360 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=720 | **cached** | h264 | High | 3.0 | 720x404 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=854 | **cached** | h264 | High | 3.1 | 852x480 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=1080 | **cached** | h264 | High | 3.1 | 1080x608 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=1280 | **cached** | h264 | High | 3.1 | 1280x720 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=1440 | **cached** | h264 | High | 3.2 | 1440x810 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=1920 | **cached** | h264 | High | 4.0 | 1920x1080 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | h=180 | **cached** | h264 | High | 1.3 | 320x180 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | h=240 | **cached** | h264 | High | 2.1 | 426x240 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | h=360 | **cached** | h264 | High | 3.0 | 640x360 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | h=480 | **cached** | h264 | High | 3.1 | 852x480 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | h=720 | **cached** | h264 | High | 3.1 | 1280x720 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | h=1080 | **cached** | h264 | High | 4.0 | 1920x1080 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 320x240/contain | **cached** | h264 | High | 1.3 | 320x180 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 640x360/contain | **cached** | h264 | High | 3.0 | 640x360 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 854x480/contain | **cached** | h264 | High | 3.1 | 852x480 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 1280x720/contain | **cached** | h264 | High | 3.1 | 1280x720 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 1920x1080/contain | **cached** | h264 | High | 4.0 | 1920x1080 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 320x240/cover | **cached** | h264 | High | 1.3 | 320x240 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 640x360/cover | **cached** | h264 | High | 3.0 | 640x360 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 854x480/cover | **cached** | h264 | High | 3.1 | 854x480 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 1280x720/cover | **cached** | h264 | High | 3.1 | 1280x720 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 1920x1080/cover | **cached** | h264 | High | 4.0 | 1920x1080 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 320x240/scale-down | **cached** | h264 | High | 1.3 | 320x180 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 640x360/scale-down | **cached** | h264 | High | 3.0 | 640x360 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 854x480/scale-down | **cached** | h264 | High | 3.1 | 852x480 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 1280x720/scale-down | **cached** | h264 | High | 3.1 | 1280x720 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 1920x1080/scale-down | **cached** | h264 | High | 4.0 | 1920x1080 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 640x640 | **cached** | h264 | High | 3.0 | 640x360 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 800x600 | **cached** | h264 | High | 3.1 | 800x450 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 400x720 | **cached** | h264 | High | 1.3 | 400x224 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | 300x300 | **cached** | h264 | High | 1.3 | 300x168 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=640/d=5s | **cached** | h264 | High | 3.0 | 640x360 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=640/t=2s/d=5s | **cached** | h264 | High | 3.0 | 640x360 | yuv420p | 8 | bt709 |  |
| rocky.mp4 | w=640/audio=false | **cached** | h264 | High | 3.0 | 640x360 | yuv420p | 8 | bt709 |  |

### erfi-135kg.mp4

| File | Params | Actual | Codec | Profile | Level | Res | Pix Fmt | Bits | Color | Flag |
|------|--------|--------|-------|---------|-------|-----|---------|------|-------|------|
| erfi-135kg.mp4 | w=128 | **cached** | h264 | High 10 | 1.2 | 128x228 | yuv420p10le | 10 | bt2020nc | High 10 profile, 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | w=160 | **cached** | h264 | High | 1.2 | 160x284 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | w=176 | **cached** | h264 | High | 1.3 | 176x312 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | w=192 | **cached** | h264 | High | 1.3 | 192x340 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | w=240 | **cached** | h264 | High | 2.1 | 240x426 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | w=320 | **cached** | h264 | High | 3.0 | 320x568 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | w=480 | **cached** | h264 | High | 3.1 | 480x852 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | w=640 | **cached** | h264 | High | 3.1 | 640x1138 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | w=720 | **cached** | h264 | High | 3.1 | 720x1280 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | w=854 | **cached** | h264 | High 10 | 4.0 | 854x1518 | yuv420p10le | 10 | bt2020nc | High 10 profile, 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | w=1080 | **cached** | h264 | High 10 | 4.0 | 1080x1920 | yuv420p10le | 10 | bt2020nc | High 10 profile, 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | w=1280 | **cached** | h264 | High | 4.0 | 1080x1920 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | h=240 | **cached** | h264 | High | 1.2 | 134x240 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | h=360 | **cached** | h264 | High | 1.3 | 202x358 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | h=480 | **cached** | h264 | High 10 | 2.1 | 270x480 | yuv420p10le | 10 | bt2020nc | High 10 profile, 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | h=720 | **cached** | h264 | High | 3.0 | 404x720 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | h=1080 | **cached** | h264 | High 10 | 3.1 | 608x1080 | yuv420p10le | 10 | bt2020nc | High 10 profile, 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | 640x360/contain | **cached** | h264 | High | 1.3 | 202x360 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | 640x360/cover | **cached** | h264 | High | 3.0 | 640x360 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | 320x240/scale-down | **cached** | h264 | High 10 | 1.2 | 136x240 | yuv420p10le | 10 | bt2020nc | High 10 profile, 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | 640x360/scale-down | **cached** | h264 | High | 1.3 | 202x360 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | 1280x720/scale-down | **cached** | h264 | High | 3.0 | 404x720 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | 360x640 | **cached** | h264 | High | 3.0 | 360x640 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | 480x854 | **cached** | h264 | High | 3.1 | 480x852 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | 540x960 | **cached** | h264 | High | 3.1 | 540x960 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | 720x1280 | **cached** | h264 | High 10 | 3.1 | 720x1280 | yuv420p10le | 10 | bt2020nc | High 10 profile, 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | 640x640 | **cached** | h264 | High | 3.0 | 360x640 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | 1080x1080 | **cached** | h264 | High 10 | 3.1 | 608x1080 | yuv420p10le | 10 | bt2020nc | High 10 profile, 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | 300x300 | **cached** | h264 | High | 1.3 | 168x300 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | w=640/d=5s | **cached** | h264 | High | 3.1 | 640x1138 | yuv420p | 8 | bt2020nc |  |
| erfi-135kg.mp4 | w=640/audio=false | **cached** | h264 | High 10 | 3.1 | 640x1138 | yuv420p10le | 10 | bt2020nc | High 10 profile, 10-bit output (yuv420p10le) |

## Flagged

| File | Params | Path | Profile | Level | Res | Pix Fmt | Issue |
|------|--------|------|---------|-------|-----|---------|-------|
| rocky.mp4 | w=128 | binding | High | 5.2 | 128x72 | yuv420p | Level 5.2 vs expected ≤1.0 for 128x72@30fps |
| rocky.mp4 | w=160 | cached | High | 5.2 | 160x90 | yuv420p | Level 5.2 vs expected ≤1.1 for 160x90@30fps |
| rocky.mp4 | w=176 | cached | High | 5.2 | 176x100 | yuv420p | Level 5.2 vs expected ≤1.1 for 176x100@30fps |
| rocky.mp4 | w=192 | cached | High | 5.2 | 192x108 | yuv420p | Level 5.2 vs expected ≤1.1 for 192x108@30fps |
| rocky.mp4 | w=240 | cached | High | 5.2 | 240x136 | yuv420p | Level 5.2 vs expected ≤1.2 for 240x136@30fps |
| rocky.mp4 | w=320 | cached | High | 5.2 | 320x180 | yuv420p | Level 5.2 vs expected ≤1.3 for 320x180@30fps |
| rocky.mp4 | w=480 | cached | High | 5.2 | 480x270 | yuv420p | Level 5.2 vs expected ≤2.0 for 480x270@30fps |
| rocky.mp4 | w=640 | cached | High | 5.2 | 640x360 | yuv420p | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | w=720 | cached | High | 5.2 | 720x406 | yuv420p | Level 5.2 vs expected ≤2.2 for 720x406@30fps |
| rocky.mp4 | w=854 | cached | High | 5.2 | 854x480 | yuv420p | Level 5.2 vs expected ≤3.0 for 854x480@30fps |
| rocky.mp4 | w=1080 | cached | High | 5.2 | 1080x608 | yuv420p | Level 5.2 vs expected ≤3.0 for 1080x608@30fps |
| rocky.mp4 | w=1280 | cached | High | 5.2 | 1280x720 | yuv420p | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | w=1440 | cached | High | 5.2 | 1440x810 | yuv420p | Level 5.2 vs expected ≤3.1 for 1440x810@30fps |
| rocky.mp4 | w=1920 | cached | High | 5.2 | 1920x1080 | yuv420p | Level 5.2 vs expected ≤3.2 for 1920x1080@30fps |
| rocky.mp4 | h=180 | cached | High | 5.2 | 320x180 | yuv420p | Level 5.2 vs expected ≤1.3 for 320x180@30fps |
| rocky.mp4 | h=240 | cached | High | 5.2 | 426x240 | yuv420p | Level 5.2 vs expected ≤2.0 for 426x240@30fps |
| rocky.mp4 | h=360 | cached | High | 5.2 | 640x360 | yuv420p | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | h=480 | cached | High | 5.2 | 854x480 | yuv420p | Level 5.2 vs expected ≤3.0 for 854x480@30fps |
| rocky.mp4 | h=720 | cached | High | 5.2 | 1280x720 | yuv420p | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | h=1080 | cached | High | 5.2 | 1920x1080 | yuv420p | Level 5.2 vs expected ≤3.2 for 1920x1080@30fps |
| rocky.mp4 | 320x240/contain | cached | High | 5.2 | 320x180 | yuv420p | Level 5.2 vs expected ≤1.3 for 320x180@30fps |
| rocky.mp4 | 640x360/contain | cached | High | 5.2 | 640x360 | yuv420p | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | 854x480/contain | cached | High | 5.2 | 854x480 | yuv420p | Level 5.2 vs expected ≤3.0 for 854x480@30fps |
| rocky.mp4 | 1280x720/contain | cached | High | 5.2 | 1280x720 | yuv420p | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | 1920x1080/contain | cached | High | 5.2 | 1920x1080 | yuv420p | Level 5.2 vs expected ≤3.2 for 1920x1080@30fps |
| rocky.mp4 | 320x240/cover | cached | High | 5.2 | 320x240 | yuv420p | Level 5.2 vs expected ≤1.3 for 320x240@30fps |
| rocky.mp4 | 640x360/cover | cached | High | 5.2 | 640x360 | yuv420p | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | 854x480/cover | cached | High | 5.2 | 854x480 | yuv420p | Level 5.2 vs expected ≤3.0 for 854x480@30fps |
| rocky.mp4 | 1280x720/cover | cached | High | 5.2 | 1280x720 | yuv420p | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | 1920x1080/cover | cached | High | 5.2 | 1920x1080 | yuv420p | Level 5.2 vs expected ≤3.2 for 1920x1080@30fps |
| rocky.mp4 | 320x240/scale-down | cached | High | 5.2 | 320x180 | yuv420p | Level 5.2 vs expected ≤1.3 for 320x180@30fps |
| rocky.mp4 | 640x360/scale-down | cached | High | 5.2 | 640x360 | yuv420p | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | 854x480/scale-down | cached | High | 5.2 | 854x480 | yuv420p | Level 5.2 vs expected ≤3.0 for 854x480@30fps |
| rocky.mp4 | 1280x720/scale-down | cached | High | 5.2 | 1280x720 | yuv420p | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | 1920x1080/scale-down | cached | High | 5.2 | 1920x1080 | yuv420p | Level 5.2 vs expected ≤3.2 for 1920x1080@30fps |
| rocky.mp4 | 640x640 | cached | High | 5.2 | 640x360 | yuv420p | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | 800x600 | cached | High | 5.2 | 800x450 | yuv420p | Level 5.2 vs expected ≤3.0 for 800x450@30fps |
| rocky.mp4 | 400x720 | cached | High | 5.2 | 400x226 | yuv420p | Level 5.2 vs expected ≤1.3 for 400x226@30fps |
| rocky.mp4 | 1280x1280 | cached | High | 5.2 | 1280x720 | yuv420p | Level 5.2 vs expected ≤3.0 for 1280x720@30fps |
| rocky.mp4 | 300x300 | cached | High | 5.2 | 300x168 | yuv420p | Level 5.2 vs expected ≤1.3 for 300x168@30fps |
| rocky.mp4 | w=640/d=5s | cached | High | 5.2 | 640x360 | yuv420p | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | w=640/t=2s/d=5s | cached | High | 5.2 | 640x360 | yuv420p | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| rocky.mp4 | w=640/audio=false | cached | High | 5.2 | 640x360 | yuv420p | Level 5.2 vs expected ≤2.2 for 640x360@30fps |
| erfi-135kg.mp4 | w=128 | cached | High 10 | 1.2 | 128x228 | yuv420p10le | High 10 profile — poor mobile/web decoder support |
| erfi-135kg.mp4 | w=128 | cached | High 10 | 1.2 | 128x228 | yuv420p10le | 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | w=854 | cached | High 10 | 4.0 | 854x1518 | yuv420p10le | High 10 profile — poor mobile/web decoder support |
| erfi-135kg.mp4 | w=854 | cached | High 10 | 4.0 | 854x1518 | yuv420p10le | 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | w=1080 | cached | High 10 | 4.0 | 1080x1920 | yuv420p10le | High 10 profile — poor mobile/web decoder support |
| erfi-135kg.mp4 | w=1080 | cached | High 10 | 4.0 | 1080x1920 | yuv420p10le | 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | h=480 | cached | High 10 | 2.1 | 270x480 | yuv420p10le | High 10 profile — poor mobile/web decoder support |
| erfi-135kg.mp4 | h=480 | cached | High 10 | 2.1 | 270x480 | yuv420p10le | 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | h=1080 | cached | High 10 | 3.1 | 608x1080 | yuv420p10le | High 10 profile — poor mobile/web decoder support |
| erfi-135kg.mp4 | h=1080 | cached | High 10 | 3.1 | 608x1080 | yuv420p10le | 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | 320x240/scale-down | cached | High 10 | 1.2 | 136x240 | yuv420p10le | High 10 profile — poor mobile/web decoder support |
| erfi-135kg.mp4 | 320x240/scale-down | cached | High 10 | 1.2 | 136x240 | yuv420p10le | 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | 720x1280 | cached | High 10 | 3.1 | 720x1280 | yuv420p10le | High 10 profile — poor mobile/web decoder support |
| erfi-135kg.mp4 | 720x1280 | cached | High 10 | 3.1 | 720x1280 | yuv420p10le | 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | 1080x1080 | cached | High 10 | 3.1 | 608x1080 | yuv420p10le | High 10 profile — poor mobile/web decoder support |
| erfi-135kg.mp4 | 1080x1080 | cached | High 10 | 3.1 | 608x1080 | yuv420p10le | 10-bit output (yuv420p10le) |
| erfi-135kg.mp4 | w=640/audio=false | cached | High 10 | 3.1 | 640x1138 | yuv420p10le | High 10 profile — poor mobile/web decoder support |
| erfi-135kg.mp4 | w=640/audio=false | cached | High 10 | 3.1 | 640x1138 | yuv420p10le | 10-bit output (yuv420p10le) |

## Summary

**binding** (43): levels=5.2, profiles=High, pix_fmt=yuv420p
**cdn-cgi** (73): levels=1.0,1.1,1.2,1.3,2.1,3.0,3.1,3.2,4.0, profiles=High,High 10, pix_fmt=yuv420p,yuv420p10le
**erfi HEVC->H.264** (31): 9 output 10-bit, 22 output 8-bit

## Parameters we send

binding: `width`, `height`, `fit`  
cdn-cgi: `width`, `height`, `fit`, `mode`, `time`, `duration`, `format`, `audio`  
No profile, level, bit depth, or color space controls exist in either API.

## H.264 Levels

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
