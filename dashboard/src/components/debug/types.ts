/**
 * Shared types and constants for the Debug Workbench.
 *
 * Centralises param definitions, Akamai mapping, and config shape
 * so form builder, URL generator, and Akamai tester stay in sync.
 */

// ── Transform param form state ───────────────────────────────────────

/** All transform params that the form can set. */
export interface ParamValues {
	mode: string;
	width: string;
	height: string;
	fit: string;
	quality: string;
	compression: string;
	time: string;
	duration: string;
	fps: string;
	speed: string;
	rotate: string;
	crop: string;
	bitrate: string;
	format: string;
	audio: string;
	imageCount: string;
	derivative: string;
	dpr: string;
}

/** Default (empty) param values. */
export const EMPTY_PARAMS: ParamValues = {
	mode: '',
	width: '',
	height: '',
	fit: '',
	quality: '',
	compression: '',
	time: '',
	duration: '',
	fps: '',
	speed: '',
	rotate: '',
	crop: '',
	bitrate: '',
	format: '',
	audio: '',
	imageCount: '',
	derivative: '',
	dpr: '',
};

// ── Enum options for dropdowns ───────────────────────────────────────

export const MODE_OPTIONS = ['', 'video', 'frame', 'spritesheet', 'audio'] as const;
export const FIT_OPTIONS = ['', 'contain', 'scale-down', 'cover'] as const;
export const QUALITY_OPTIONS = ['', 'low', 'medium', 'high', 'auto'] as const;
export const COMPRESSION_OPTIONS = ['', 'low', 'medium', 'high', 'auto'] as const;
export const FORMAT_OPTIONS = ['', 'mp4', 'jpg', 'png', 'm4a', 'h265', 'vp9', 'av1'] as const;
export const AUDIO_OPTIONS = ['', 'true', 'false'] as const;

/** Fields visible per mode. Empty string = all fields. */
export const MODE_FIELDS: Record<string, (keyof ParamValues)[]> = {
	'': ['width', 'height', 'fit', 'quality', 'compression', 'time', 'duration', 'fps', 'speed', 'rotate', 'crop', 'bitrate', 'format', 'audio', 'dpr', 'imageCount'],
	video: ['width', 'height', 'fit', 'quality', 'compression', 'duration', 'fps', 'speed', 'rotate', 'crop', 'bitrate', 'format', 'audio', 'dpr'],
	frame: ['width', 'height', 'fit', 'time', 'format', 'dpr'],
	spritesheet: ['width', 'height', 'fit', 'time', 'duration', 'imageCount', 'dpr'],
	audio: ['duration', 'format', 'quality', 'compression', 'bitrate'],
};

// ── Akamai param mapping (mirrors src/params/schema.ts) ──────────────

export const AKAMAI_PARAM_MAP: Record<string, string> = {
	width: 'imwidth',
	height: 'imheight',
	format: 'imformat',
	derivative: 'impolicy',
	dpr: 'imdensity',
	fit: 'obj-fit',
	time: 'start',
	duration: 'dur',
};

export const AKAMAI_FIT_VALUES: Record<string, string> = {
	cover: 'crop',
	contain: 'fill',
};

export const AKAMAI_FORMAT_VALUES: Record<string, string> = {
	mp4: 'h264',
};

// ── Diagnostics response shape ───────────────────────────────────────

export interface DiagnosticsData {
	requestId: string;
	path: string;
	params: Record<string, string | number | boolean>;
	origin: { name: string; sources: { type: string; priority: number }[]; ttl: Record<string, number> };
	captures: Record<string, string>;
	config: { derivatives: string[]; responsive: unknown; passthrough: unknown; containerEnabled: boolean };
	needsContainer: boolean;
	resolvedWidth: number | null;
	resolvedHeight: number | null;
}

/** Full diagnostics API response. */
export interface DiagnosticsResult {
	diagnostics: DiagnosticsData;
}

// ── Test result state ────────────────────────────────────────────────

export interface TestResult {
	diagnostics: DiagnosticsData | null;
	headers: [string, string][];
	responseTime: number;
	responseSize: number;
	responseStatus: number;
	contentType: string;
	/** Blob URL for the media preview (revoke on cleanup). */
	previewUrl: string | null;
}

export const EMPTY_RESULT: TestResult = {
	diagnostics: null,
	headers: [],
	responseTime: 0,
	responseSize: 0,
	responseStatus: 0,
	contentType: '',
	previewUrl: null,
};

// ── SSE progress ─────────────────────────────────────────────────────

export interface SseProgress {
	status: string;
	percent: number;
	jobId: string;
}

// ── Config fetched from /admin/config ────────────────────────────────

export interface WorkbenchConfig {
	derivatives: string[];
	containerEnabled: boolean;
}

// ── URL builder ──────────────────────────────────────────────────────

/**
 * Build a canonical URL from path + params.
 *
 * Does NOT append `debug` — that's handled by the test execution logic
 * which needs to add `debug=view` (diagnostics) and `debug` (skip cache)
 * as separate requests. Adding it here would create duplicate params.
 */
export function buildUrl(path: string, params: ParamValues, _skipCache: boolean): string {
	const normalized = path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`;
	const qs = new URLSearchParams();

	if (params.mode) qs.set('mode', params.mode);
	if (params.derivative) qs.set('derivative', params.derivative);
	if (params.width) qs.set('width', params.width);
	if (params.height) qs.set('height', params.height);
	if (params.fit) qs.set('fit', params.fit);
	if (params.quality) qs.set('quality', params.quality);
	if (params.compression) qs.set('compression', params.compression);
	if (params.time) qs.set('time', params.time);
	if (params.duration) qs.set('duration', params.duration);
	if (params.fps) qs.set('fps', params.fps);
	if (params.speed) qs.set('speed', params.speed);
	if (params.rotate) qs.set('rotate', params.rotate);
	if (params.crop) qs.set('crop', params.crop);
	if (params.bitrate) qs.set('bitrate', params.bitrate);
	if (params.format) qs.set('format', params.format);
	if (params.audio) qs.set('audio', params.audio);
	if (params.imageCount) qs.set('imageCount', params.imageCount);
	if (params.dpr) qs.set('dpr', params.dpr);

	const query = qs.toString();
	return query ? `${normalized}?${query}` : normalized;
}

/** Build an Akamai-style URL from the same path + params. */
export function buildAkamaiUrl(path: string, params: ParamValues, _skipCache: boolean): string {
	const normalized = path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`;
	const qs = new URLSearchParams();

	for (const [key, value] of Object.entries(params)) {
		if (!value) continue;
		if (key === 'derivative') {
			qs.set('impolicy', value);
		} else if (key === 'fit') {
			qs.set('obj-fit', AKAMAI_FIT_VALUES[value] ?? value);
		} else if (key === 'format') {
			qs.set('imformat', AKAMAI_FORMAT_VALUES[value] ?? value);
		} else if (key === 'width') {
			qs.set('imwidth', value);
		} else if (key === 'height') {
			qs.set('imheight', value);
		} else if (key === 'dpr') {
			qs.set('imdensity', value);
		} else if (key === 'time') {
			qs.set('start', value);
		} else if (key === 'duration') {
			qs.set('dur', value);
		} else if (key === 'audio') {
			// audio=false -> mute=true (inverted)
			qs.set('mute', value === 'false' ? 'true' : 'false');
		} else if (key === 'mode') {
			// mode has no Akamai equivalent — pass through
			qs.set(key, value);
		} else {
			// fps, speed, crop, rotate, bitrate — passthrough
			qs.set(key, value);
		}
	}

	const query = qs.toString();
	return query ? `${normalized}?${query}` : normalized;
}
