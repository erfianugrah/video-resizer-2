/**
 * Derivative resolution.
 *
 * When a request specifies `?derivative=tablet`, the derivative's canonical
 * properties (width, height, quality, etc.) REPLACE any explicit params.
 * This is intentional — derivatives are named presets that define the exact
 * transformation. Raw imwidth/imheight values are used only for derivative
 * *selection* (finding the closest match), never for the actual transform.
 *
 * This design prevents the v1 bug where raw imwidth leaked into cache keys
 * while derivative height came from the preset, creating mismatched keys.
 */
import type { TransformParams } from './schema';
import type { AppConfig, Derivative } from '../config/schema';

/**
 * Resolve a derivative into final transform params.
 *
 * - If `params.derivative` names a known derivative, its defined properties
 *   override the corresponding fields in params. Undefined derivative
 *   properties are left as-is from params.
 * - If `params.derivative` is not set or not found, params pass through unchanged.
 *
 * Returns a **new** object — never mutates the input.
 */
export function resolveDerivative(params: TransformParams, derivatives: AppConfig['derivatives']): TransformParams {
	const { derivative: name, ...rest } = params;

	if (!name) return { ...params };

	const preset = derivatives[name];
	if (!preset) {
		// Unknown derivative — clear it so downstream doesn't try to use it
		return { ...rest };
	}

	// Start with the caller's params, then overlay every defined derivative property.
	// Derivative values always win — this is the key correctness invariant.
	const resolved: TransformParams = { ...rest, derivative: name };

	const OVERLAY_KEYS = ['width', 'height', 'mode', 'fit', 'quality', 'compression', 'time', 'duration', 'format', 'audio'] as const;

	for (const key of OVERLAY_KEYS) {
		const value = preset[key as keyof Derivative];
		if (value !== undefined) {
			(resolved as Record<string, unknown>)[key] = value;
		}
	}

	return resolved;
}
