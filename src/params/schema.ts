/**
 * Canonical transform parameters.
 *
 * Single source of truth for every parameter the system accepts.
 * Parse once from URLSearchParams, flow the validated object everywhere.
 * No mutation, no re-parsing.
 *
 * Akamai/IMQuery translation is a separate pure function that produces
 * a new URLSearchParams — never mutates the original.
 */
import { z } from 'zod';

// ── Akamai → Cloudflare param name mapping ───────────────────────────────

/** Direct name mapping: Akamai param name -> canonical param name. */
const AKAMAI_PARAM_MAP: Record<string, string> = {
	// IMQuery params
	imwidth: 'width',
	imheight: 'height',
	imformat: 'format',
	impolicy: 'derivative',
	imdensity: 'dpr',

	// Shorthand params (common Akamai abbreviations)
	w: 'width',
	h: 'height',
	q: 'quality',
	f: 'format',
	'obj-fit': 'fit',
	start: 'time',
	dur: 'duration',
	// Note: `dpr` is already the canonical name — no mapping needed.
	// It passes through as-is via the "not an Akamai param" branch.
};

/** Akamai params that need value translation (not just name mapping). */
const AKAMAI_VALUE_MAP: Record<string, Record<string, string>> = {
	'obj-fit': { crop: 'cover', fill: 'contain' },
	imformat: { h264: 'mp4' },
};

/** Akamai params that need value inversion. */
const AKAMAI_INVERTED: Record<string, { target: string; invert: boolean }> = {
	mute: { target: 'audio', invert: true },
};

/** Akamai params consumed during processing but not passed through. */
const AKAMAI_CONSUMED = new Set(['imref', 'im-viewwidth', 'im-viewheight', 'im-density']);

/**
 * Akamai imformat values that require container fallback (not native binding).
 * These are valid but can't be served by env.MEDIA — the transform router
 * checks for them and routes to the FFmpeg container.
 */
export const CONTAINER_CODEC_FORMATS = new Set(['h265', 'vp9', 'av1']);

// ── Transform params Zod schema ──────────────────────────────────────────

const intInRange = (min: number, max: number) => z.coerce.number().int().min(min).max(max).optional().catch(undefined);

const positiveFloat = z.coerce.number().positive().optional().catch(undefined);

export const TransformParamsSchema = z.object({
	// ── Binding-supported params ──────────────────────────────────────
	width: intInRange(10, 2000),
	height: intInRange(10, 2000),
	mode: z.enum(['video', 'frame', 'spritesheet', 'audio']).optional().catch(undefined),
	fit: z.enum(['contain', 'scale-down', 'cover']).optional().catch(undefined),
	audio: z
		.enum(['true', 'false'])
		.transform((v) => v === 'true')
		.optional()
		.catch(undefined),
	time: z.string().optional(),
	duration: z.string().optional(),
	format: z.string().optional(), // broader than binding — includes h265/vp9 for container routing
	imageCount: z.coerce.number().int().positive().optional().catch(undefined), // spritesheet: new in binding

	// ── Quality/compression (container-only, no-op for binding) ───────
	quality: z.string().optional(),
	compression: z.string().optional(),

	// ── Container-only params (trigger container routing) ─────────────
	fps: positiveFloat,
	speed: positiveFloat,
	rotate: z.coerce.number().optional().catch(undefined),
	crop: z.string().optional(),
	bitrate: z.string().optional(),

	// ── Response metadata (not transform params) ─────────────────────
	filename: z
		.string()
		.max(120)
		.regex(/^[a-zA-Z0-9\-_]+\.?[a-zA-Z0-9\-_]*$/)
		.optional()
		.catch(undefined),
	derivative: z.string().optional(),

	// ── Playback hints (response headers, not transform) ─────────────
	loop: z
		.enum(['true', 'false'])
		.transform((v) => v === 'true')
		.optional()
		.catch(undefined),
	autoplay: z
		.enum(['true', 'false'])
		.transform((v) => v === 'true')
		.optional()
		.catch(undefined),
	muted: z
		.enum(['true', 'false'])
		.transform((v) => v === 'true')
		.optional()
		.catch(undefined),
	preload: z.enum(['none', 'metadata', 'auto']).optional().catch(undefined),

	// ── Responsive sizing hint (not a transform param) ───────────────
	dpr: positiveFloat,
});

/** Validated transform parameters. Immutable after parse. */
export type TransformParams = z.infer<typeof TransformParamsSchema>;

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Translate Akamai/IMQuery params to canonical Cloudflare param names.
 *
 * Returns a **new** URLSearchParams — never mutates the input.
 * Explicit canonical params take precedence over translated Akamai ones.
 *
 * Also extracts IMQuery client hint params (`im-viewwidth`, `im-viewheight`,
 * `im-density`) into a separate map for responsive sizing injection.
 */
export function translateAkamaiParams(qs: URLSearchParams): {
	params: URLSearchParams;
	clientHints: Record<string, string>;
} {
	const out = new URLSearchParams();
	const translated = new Map<string, string>();
	const clientHints: Record<string, string> = {};

	for (const [key, value] of qs) {
		// Client hint injection params — consumed, not forwarded
		if (key === 'im-viewwidth') {
			clientHints['Sec-CH-Viewport-Width'] = value;
			continue;
		}
		if (key === 'im-viewheight') {
			clientHints['Viewport-Height'] = value;
			continue;
		}
		if (key === 'im-density') {
			clientHints['Sec-CH-DPR'] = value;
			continue;
		}
		if (AKAMAI_CONSUMED.has(key)) {
			continue;
		}

		// Name mapping
		const canonicalName = AKAMAI_PARAM_MAP[key];
		if (canonicalName) {
			if (!qs.has(canonicalName)) {
				// Apply value mapping if defined
				const valueMap = AKAMAI_VALUE_MAP[key];
				const mappedValue = valueMap?.[value] ?? value;
				translated.set(canonicalName, mappedValue);
			}
			continue;
		}

		// Value inversion (e.g. mute -> audio)
		const inverted = AKAMAI_INVERTED[key];
		if (inverted) {
			if (!qs.has(inverted.target)) {
				const invertedValue = inverted.invert ? (value === 'true' ? 'false' : 'true') : value;
				translated.set(inverted.target, invertedValue);
			}
			continue;
		}

		// Not an Akamai param — pass through
		out.set(key, value);
	}

	// Translated params fill gaps (canonical params already in `out` win)
	for (const [key, value] of translated) {
		if (!out.has(key)) {
			out.set(key, value);
		}
	}

	return { params: out, clientHints };
}

/**
 * Parse URLSearchParams into validated TransformParams.
 *
 * Invalid values are silently dropped (not errors) — out-of-range width
 * becomes undefined, invalid mode becomes undefined, etc. The caller
 * fills in defaults from derivatives or responsive sizing later.
 */
export function parseParams(qs: URLSearchParams): TransformParams {
	const raw: Record<string, string> = {};
	for (const [key, value] of qs) {
		if (key in TransformParamsSchema.shape) {
			raw[key] = value;
		}
	}
	return TransformParamsSchema.parse(raw);
}

/**
 * Check if resolved params require the FFmpeg container instead of
 * the Media binding. Pure function — no side effects.
 */
export function needsContainer(params: TransformParams): boolean {
	if (params.fps != null) return true;
	if (params.speed != null) return true;
	if (params.rotate != null) return true;
	if (params.crop != null) return true;
	if (params.bitrate != null) return true;
	if (params.format && CONTAINER_CODEC_FORMATS.has(params.format)) return true;
	// Duration > 60s check would need parsing the duration string
	// That's done in the transform router where we have the parsed value
	return false;
}
