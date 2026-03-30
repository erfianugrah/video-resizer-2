# Debug Workbench (Future Work)

Spec for replacing the minimal DebugTab with a full interactive testing workbench.

## Current state

The DebugTab is a URL input + JSON diagnostics + response headers table. No media
preview, no param builder, no way to test variations without manually editing URLs.

## Goals

1. **Preview any video/image/audio** the worker has access to inline
2. **Form-driven param builder** — no manual URL construction
3. **Full debug headers** and worker-side logs
4. **Side-by-side comparison** of different params/derivatives
5. **One-click test** of all modes (video, frame, spritesheet, audio)

## Proposed layout

```
+------------------------------------------------------------------+
| Path: [/big_buck_bunny_1080p.mov        ] [Test] [Compare]       |
+------------------------------------------------------------------+
| Mode: [video] [frame] [spritesheet] [audio]                     |
|                                                                  |
| ┌─ Transform Params ──────────┐  ┌─ Preview ──────────────────┐ |
| │ Width:     [1280        ]   │  │                            │ |
| │ Height:    [720         ]   │  │   <video> / <img> / <audio>│ |
| │ Fit:       [contain ▼   ]   │  │                            │ |
| │ Quality:   [medium ▼    ]   │  │   (auto-detects content    │ |
| │ Compression:[auto ▼     ]   │  │    type from response)     │ |
| │ Time:      [           ]   │  │                            │ |
| │ Duration:  [           ]   │  │                            │ |
| │ FPS:       [           ]   │  └────────────────────────────┘ |
| │ Derivative:[        ▼  ]   │                                  |
| │ ☐ Skip cache (debug)       │                                  |
| └─────────────────────────────┘                                  |
|                                                                  |
| ┌─ Response ──────────────────────────────────────────────────┐ |
| │ Status: 200  Size: 1.2 MB  Time: 450ms  Source: cdn-cgi    │ |
| │ Cache: HIT   R2: HIT   Key: video:bbb:w=1280:h=720        │ |
| └─────────────────────────────────────────────────────────────┘ |
|                                                                  |
| ┌─ Debug Headers ─────────────┐  ┌─ Diagnostics JSON ────────┐ |
| │ x-request-id: abc-123       │  │ params: { width: 1280 }   │ |
| │ x-transform-source: cdn-cgi │  │ origin: { name: standard }│ |
| │ x-processing-time-ms: 450   │  │ needsContainer: false     │ |
| │ x-cache-key: video:bbb:...  │  │ resolvedWidth: 1280       │ |
| │ x-r2-cache: HIT             │  │ ...                       │ |
| │ cf-cache-status: HIT         │  │                           │ |
| │ (highlight x-* in cyan)     │  │                           │ |
| └─────────────────────────────┘  └───────────────────────────┘ |
+------------------------------------------------------------------+
```

## Features

### Media preview

- **Video mode**: `<video>` element with controls, autoplay muted. Blob URL from
  fetch response. Shows resolution, duration, codec info from response headers.
- **Frame mode**: `<img>` element. Shows dimensions.
- **Spritesheet mode**: `<img>` with scrollable overflow. Shows tile count.
- **Audio mode**: `<audio>` element with controls. Shows duration.
- Auto-detect content type from `Content-Type` response header.
- Show "202 Processing..." state with SSE progress bar for container jobs.

### Param form builder

- Dropdown for `mode` switches visible fields (video shows fps/speed/bitrate,
  frame shows time/format, spritesheet shows imageCount/duration, audio shows
  duration/format).
- Dropdown for `derivative` auto-fills width/height/quality from config.
  Fetches derivatives list from `/admin/config`.
- Dropdowns for `fit`, `quality`, `compression`, `format` with valid values.
- Numeric inputs for `width`, `height`, `fps`, `speed`, `rotate`, `imageCount`.
- Text inputs for `time`, `duration`, `crop`, `bitrate`.
- Checkbox for `audio` (enabled/disabled).
- Checkbox for "Skip cache" (adds `?debug`).
- Generated URL shown live as params change (readonly, copyable).

### Akamai compatibility tester

- Toggle between "Canonical" and "Akamai/IMQuery" param modes.
- In Akamai mode: shows `imwidth`, `impolicy`, `imformat`, `obj-fit`, etc.
- Side-by-side: canonical URL vs Akamai URL, verify they resolve to same params.

### Response inspector

- **Summary bar**: status, size, time, content-type, cache status (same as current).
- **Debug headers**: filtered to `x-*` headers, highlighted in cyan. Show
  `x-transform-source`, `x-processing-time-ms`, `x-cache-key`, `x-r2-cache`,
  `x-source-type`, `x-origin`, `cf-cache-status`, `cf-resized`.
- **All headers**: collapsible full header list.
- **Diagnostics JSON**: collapsible, syntax-highlighted (same as current but
  prettier — use a JSON tree viewer component).

### Comparison mode

- Click "Compare" to add a second column.
- Each column has its own param form + preview + headers.
- Visual diff: highlight differing headers in yellow.
- Use case: compare `derivative=tablet` vs `derivative=mobile`, or
  `quality=low` vs `quality=high`.

### Config-aware

- Fetch `/admin/config` on mount to populate:
  - Derivative dropdown with all configured names
  - Origin list for the diagnostics panel
  - Responsive breakpoints display
  - Container enabled/disabled badge
- Uses session cookie auth (same as other tabs).

### SSE integration for container jobs

- When response is 202 (container async), auto-connect to SSE endpoint.
- Show progress bar with phase + percent.
- On completion, auto-fetch the result and show preview.
- "Retry" button to re-request after completion.

## Implementation notes

- All fetches use `credentials: 'same-origin'` (session cookie auth).
- Preview uses `URL.createObjectURL(blob)` — revoke on unmount.
- Large video previews: limit preview to first 10MB via Range header
  (`Range: bytes=0-10485760`), or stream via `<video src="{url}">` directly.
- Form state persisted to URL hash for shareability:
  `#debug/big_buck_bunny.mp4?width=1280&mode=frame&time=5s`
- Lazy-load the workbench component (it's heavy with the form + preview).

## Estimated effort

- Phase 1: Param form builder + live URL generation (1-2 sessions)
- Phase 2: Media preview with auto-detection (1 session)
- Phase 3: Response inspector improvements (1 session)
- Phase 4: Comparison mode (1 session)
- Phase 5: SSE integration + container job tracking (1 session)
- Phase 6: Akamai compatibility tester (1 session)

## Dependencies

No new npm dependencies needed. Uses native `<video>`, `<audio>`, `<img>` elements.
JSON tree viewer can use a simple recursive React component (no library needed).
