# Parameters

## Canonical transform params

All params are parsed once via Zod into a `TransformParams` object. Derivatives overlay onto this object. The result is immutable.

| Param | Type | Range/Values | Binding | Container | Notes |
|-------|------|-------------|---------|-----------|-------|
| `width` | int | 10-2000 | `.transform({width})` | ffmpeg `-vf scale=W:-2` | |
| `height` | int | 10-2000 | `.transform({height})` | ffmpeg `-vf scale=-2:H` | |
| `fit` | enum | contain, scale-down, cover | `.transform({fit})` | ffmpeg pad/crop | |
| `mode` | enum | video, frame, spritesheet, audio | `.output({mode})` | ffmpeg output flags | |
| `time` | string | 0s-10m | `.output({time})` | ffmpeg `-ss` | Seek offset |
| `duration` | string | 1s-60s (binding), unlimited (container) | `.output({duration})` | ffmpeg `-t` | |
| `audio` | bool | true/false | `.output({audio})` | ffmpeg `-an`/copy | |
| `format` | enum | jpg, png (frame); m4a (audio) | `.output({format})` | ffmpeg format | |
| `filename` | string | alphanumeric, max 120 | N/A (response header) | same | Content-Disposition |
| `derivative` | string | config key | N/A (resolved before transform) | same | Named preset |
| `quality` | enum | low, medium, high, auto | **Not in binding** | ffmpeg `-crf` | Container only |
| `compression` | enum | low, medium, high, auto | **Not in binding** | ffmpeg `-preset` (encode speed vs file size) | Container only |
| `fps` | float | >0 | **Not in binding** | ffmpeg `-r` | Container only |
| `speed` | float | >0 | **Not in binding** | ffmpeg setpts | Container only |
| `rotate` | float | any | **Not in binding** | ffmpeg rotate | Container only |
| `crop` | string | geometry spec | **Not in binding** | ffmpeg crop | Container only |
| `bitrate` | string | e.g. 2M | **Not in binding** | ffmpeg `-b:v` | Container only |
| `dpr` | float | >0 | Multiplies width/height | same | Pixel density multiplier |
| `imageCount` | int | >0 | `.output({imageCount})` | ffmpeg fps+tile | Spritesheet only |
| `loop` | bool | true/false | N/A | N/A | Playback hint header only |
| `autoplay` | bool | true/false | N/A | N/A | Playback hint header only |
| `muted` | bool | true/false | N/A | N/A | Playback hint header only |
| `preload` | enum | none, metadata, auto | N/A | N/A | Playback hint header only |
| `debug` | any | `view` for JSON diagnostics | N/A | N/A | Skips cache |

## Akamai/IMQuery translation

Single translation function in `params/schema.ts`. Produces a new URLSearchParams. Explicit canonical params always win over translated Akamai equivalents.

| Akamai Param | Canonical | Value Translation | Notes |
|-------------|-----------|-------------------|-------|
| `imwidth` | `width` | direct | Primary IMQuery param; used for derivative matching |
| `imheight` | `height` | direct | Used with imwidth for derivative matching |
| `imref` | consumed | parsed as `key=value,key=value` | Derivative matching context, not forwarded |
| `impolicy` | `derivative` | direct | Akamai "policy" = our "derivative" |
| `imformat` | `format` | `h264`->`mp4`; `h265`/`vp9`/`av1`->container | Codec selection |
| `imdensity` | `dpr` | direct | Pixel density multiplier |
| `im-viewwidth` | responsive | sets `Sec-CH-Viewport-Width` hint | Not a transform param |
| `im-viewheight` | responsive | sets `Viewport-Height` hint | Not a transform param |
| `im-density` | responsive | sets `Sec-CH-DPR` hint | Not a transform param |
| `w` | `width` | direct | Shorthand |
| `h` | `height` | direct | Shorthand |
| `q` | `quality` | direct | Shorthand |
| `f` | `format` | direct | Shorthand |
| `obj-fit` | `fit` | `crop`->`cover`, `fill`->`contain` | Value mapping |
| `start` | `time` | direct | |
| `dur` | `duration` | direct | |
| `mute` | `audio` | **inverted**: `mute=true` -> `audio=false` | |
| `fps`, `speed`, `crop`, `rotate`, `bitrate`, `dpr` | same | direct | Passthrough |

## Derivatives (named presets)

`?derivative=mobile` (or `?impolicy=mobile`) bundles width/height/quality/etc into a single name. Core caching strategy -- maps infinite possible dimensions to a finite preset set.

**Critical invariant**: derivative dimensions are always canonical. When a derivative is specified, its width/height/quality/etc. _replace_ any explicit params. Raw `imwidth` values are used only for derivative _selection_ (finding the closest match), never for the actual transform or cache key. This prevents cache key mismatch bugs.

### IMQuery derivative matching

`?imwidth=1080` -> find closest derivative via breakpoint mapping -> `tablet` (1280x720).

- Width-only: uses breakpoint ranges from responsive config
- Width+height: Euclidean distance with aspect ratio weighting
- Matching happens in `params/schema.ts`, result is a derivative name that feeds into standard resolution

## Auto mode switching

`format=m4a` without explicit `mode=audio` automatically switches to audio mode, clearing irrelevant params (width, height, fit). This maintains compatibility with clients that relied on format-based mode inference.

## Responsive sizing

When no explicit dimensions are provided, auto-sizing fills them from client signals. Applied after derivative resolution -- only fills in missing dimensions, never overrides derivative values.

Detection priority:
1. Client Hints headers (`Sec-CH-Viewport-Width`, `Sec-CH-DPR`, `Width`)
2. `CF-Device-Type` header (mobile/tablet/desktop)
3. User-Agent parsing (fallback)

Network-aware: `ECT`, `Downlink`, `Sec-CH-Save-Data` headers can downgrade quality.

## Codec output (not configurable)

H.264 profile, level, pixel format, and color space are determined by the
transform path encoder — not by request parameters. No API exists to control these.

| Property | Binding | CDN-CGI | Container |
|----------|---------|---------|-----------|
| Profile | High (always) | High (always) | High (libx264 default) |
| Level | 5.2 (always, CF bug) | Auto-scales with resolution | Auto (ffmpeg) |
| Pixel format | yuv420p | yuv420p (usually; intermittent 10-bit from HEVC sources) | yuv420p (forced via `-pix_fmt`) |
| Color space | Not emitted | Preserved from source | ffmpeg default (bt709) |

See `docs/transform-audit.md` for full ffprobe data.
