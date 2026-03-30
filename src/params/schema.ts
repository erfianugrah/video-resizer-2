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
	// IMQuery params — imwidth/imheight are NOT mapped to width/height.
	// They're captured as rawImWidth/rawImHeight for breakpoint matching.
	// Only impolicy, imformat, imdensity get direct name mapping.
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
const AKAMAI_CONSUMED = new Set(['im-viewwidth', 'im-viewheight', 'im-density']);

/**
 * Parse `imref` value (`key=value,key=value` format) into a record.
 * Used for derivative matching context in Akamai IMQuery.
 * v1 parsed this but never used the result for derivative selection
 * (only imwidth/imheight affect matching). Kept for parity and logging.
 */
export function parseImRef(imref: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!imref) return result;
	for (const param of imref.split(',')) {
		const eq = param.indexOf('=');
		if (eq > 0) {
			result[param.slice(0, eq)] = param.slice(eq + 1);
		}
	}
	return result;
}

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
	width: intInRange(10, 8192),
	height: intInRange(10, 8192),
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
	imref: Record<string, string>;
	/** Raw imwidth value (before Zod validation) for breakpoint matching. */
	rawImWidth: number | null;
	/** Raw imheight value (before Zod validation) for breakpoint matching. */
	rawImHeight: number | null;
} {
	const out = new URLSearchParams();
	const translated = new Map<string, string>();
	const clientHints: Record<string, string> = {};
	let imref: Record<string, string> = {};
	let rawImWidth: number | null = null;
	let rawImHeight: number | null = null;

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
		if (key === 'imref') {
			imref = parseImRef(value);
			continue;
		}
		// IMQuery dimension params — captured for breakpoint matching,
		// NOT forwarded as width/height. imwidth is for derivative *selection*
		// (finding the closest breakpoint), not for raw transform dimensions.
		if (key === 'imwidth') {
			const n = parseFloat(value);
			if (Number.isFinite(n) && n > 0) rawImWidth = n;
			continue;
		}
		if (key === 'imheight') {
			const n = parseFloat(value);
			if (Number.isFinite(n) && n > 0) rawImHeight = n;
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

	return { params: out, clientHints, imref, rawImWidth, rawImHeight };
}

/** Validation warning for a param that was rejected by Zod. */
export interface ParamWarning {
	param: string;
	value: string;
	reason: string;
}

/**
 * Parse URLSearchParams into validated TransformParams.
 *
 * Returns both the parsed params and any validation warnings for params
 * that were provided but rejected (out-of-range, invalid enum, etc.).
 * Warnings are surfaced to the client via response headers / diagnostics.
 */
export function parseParams(qs: URLSearchParams): { params: TransformParams; warnings: ParamWarning[] } {
	const raw: Record<string, string> = {};
	for (const [key, value] of qs) {
		if (key in TransformParamsSchema.shape) {
			raw[key] = value;
		}
	}

	// Parse with catch(undefined) — Zod won't throw, but we need to detect
	// which fields were provided but got dropped by comparing input vs output.
	const params = TransformParamsSchema.parse(raw);
	const warnings: ParamWarning[] = [];

	// Detect silently dropped values by comparing raw input against parsed output
	for (const [key, value] of Object.entries(raw)) {
		if (!value) continue;
		const parsed = (params as Record<string, unknown>)[key];
		if (parsed === undefined && key !== 'debug') {
			// Value was provided but Zod dropped it — produce a warning
			const shape = TransformParamsSchema.shape[key as keyof typeof TransformParamsSchema.shape];
			let reason = 'invalid value';
			if (key === 'width' || key === 'height') reason = `must be integer between 10 and 8192, got ${value}`;
			else if (key === 'mode') reason = `must be video|frame|spritesheet|audio, got "${value}"`;
			else if (key === 'fit') reason = `must be contain|scale-down|cover, got "${value}"`;
			else if (key === 'fps' || key === 'speed' || key === 'dpr') reason = `must be a positive number, got "${value}"`;
			else if (key === 'rotate' || key === 'imageCount') reason = `must be a number, got "${value}"`;
			else if (key === 'preload') reason = `must be none|metadata|auto, got "${value}"`;
			else if (key === 'audio' || key === 'loop' || key === 'autoplay' || key === 'muted') reason = `must be true|false, got "${value}"`;
			else if (key === 'filename') reason = `must be alphanumeric (max 120 chars), got "${value}"`;
			warnings.push({ param: key, value, reason });
		}
	}

	// Auto-switch: format=m4a implies mode=audio (v1 compat)
	if (params.format === 'm4a' && !params.mode) {
		return { params: { ...params, mode: 'audio' as const }, warnings };
	}
	return { params, warnings };
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
	// Duration > 60s exceeds the Media binding cap
	if (params.duration && parseDurationSeconds(params.duration) > 60) return true;
	return false;
}

/** Parse a duration string like "5s", "2m", "1m30s", "1h30m" into total seconds. */
function parseDurationSeconds(duration: string): number {
	let total = 0;
	const hourMatch = duration.match(/(\d+(?:\.\d+)?)h/);
	const minMatch = duration.match(/(\d+(?:\.\d+)?)m(?!s)/); // negative lookahead: don't match 'ms'
	const secMatch = duration.match(/(\d+(?:\.\d+)?)s/);
	if (hourMatch) total += parseFloat(hourMatch[1]) * 3600;
	if (minMatch) total += parseFloat(minMatch[1]) * 60;
	if (secMatch) total += parseFloat(secMatch[1]);
	// If only a bare number (no unit suffixes at all), treat as seconds
	if (!hourMatch && !minMatch && !secMatch && /^\d+(\.\d+)?$/.test(duration)) {
		const n = parseFloat(duration);
		if (Number.isFinite(n)) total = n;
	}
	return total;
}
