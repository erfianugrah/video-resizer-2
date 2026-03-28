/**
 * Media binding transform pipeline.
 *
 * Takes a source ReadableStream + resolved TransformParams and runs
 * it through env.MEDIA.input() -> .transform() -> .output() -> .response().
 *
 * This is the core of v2 — replaces the entire cdn-cgi URL construction
 * and HTTP-fetch dance from v1.
 */
import type { TransformParams } from '../params/schema';
import { AppError } from '../errors';

/** Minimal interface for the Media binding (avoids depending on generated types). */
export interface MediaBinding {
	input(stream: ReadableStream<Uint8Array>): MediaInput;
}

interface MediaInput {
	transform(opts: Record<string, unknown>): MediaTransformed;
	output(opts: Record<string, unknown>): MediaOutput;
}

interface MediaTransformed {
	output(opts: Record<string, unknown>): MediaOutput;
}

interface MediaOutput {
	response(): Promise<Response>;
	media(): Promise<ReadableStream<Uint8Array>>;
	contentType(): Promise<string>;
}

/**
 * Transform a video stream using the Media binding.
 *
 * @param media The env.MEDIA binding
 * @param stream Source video ReadableStream
 * @param params Resolved transform params (derivative already applied)
 * @returns Response ready to serve to client or store in cache
 */
export async function transformViaBinding(
	media: MediaBinding,
	stream: ReadableStream<Uint8Array>,
	params: TransformParams,
): Promise<Response> {
	try {
		const input = media.input(stream);

		// Build transform options (resize/crop) — skip if audio-only
		const needsTransform = params.mode !== 'audio' && (params.width || params.height || params.fit);

		// Build output options
		const outputOpts: Record<string, unknown> = {};
		if (params.mode) outputOpts.mode = params.mode;
		if (params.time) outputOpts.time = params.time;
		if (params.duration) outputOpts.duration = params.duration;
		if (params.format) outputOpts.format = params.format;
		if (params.audio !== undefined) outputOpts.audio = params.audio;
		if (params.imageCount) outputOpts.imageCount = params.imageCount;

		let result: MediaOutput;

		if (needsTransform) {
			const transformOpts: Record<string, unknown> = {};
			if (params.width) transformOpts.width = params.width;
			if (params.height) transformOpts.height = params.height;
			if (params.fit) transformOpts.fit = params.fit;

			result = input.transform(transformOpts).output(outputOpts);
		} else {
			result = input.output(outputOpts);
		}

		return await result.response();
	} catch (err: unknown) {
		if (err instanceof Error) {
			// MediaError has a numeric `code` property
			if ('code' in err) {
				const code = (err as Error & { code: number }).code;
				throw new AppError(502, `MEDIA_ERROR_${code}`, err.message, {
					mediaErrorCode: code,
					params: sanitizeParams(params),
				});
			}
			// MEDIA_TRANSFORMATION_ERROR pattern: "MEDIA_TRANSFORMATION_ERROR {code}: {message}"
			const mtMatch = err.message.match(/MEDIA_TRANSFORMATION_ERROR\s+(\d+)/);
			if (mtMatch) {
				const code = parseInt(mtMatch[1], 10);
				throw new AppError(502, `MEDIA_ERROR_${code}`, err.message, {
					mediaErrorCode: code,
					params: sanitizeParams(params),
				});
			}
		}
		throw err;
	}
}

/** Strip non-serializable fields for error details. */
function sanitizeParams(params: TransformParams): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}
