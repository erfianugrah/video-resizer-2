/**
 * Responsive video sizing.
 *
 * Detects the client's viewport/device and maps to a derivative. Applied only
 * when the request has no explicit width/height/derivative — it fills in the
 * gap, never overrides.
 *
 * Detection priority:
 * 1. Client Hints: Sec-CH-Viewport-Width (+ DPR scaling)
 * 2. Width header (legacy client hint)
 * 3. CF-Device-Type header (mobile/tablet/desktop)
 * 4. defaultDerivative from config
 */
import type { TransformParams } from './schema';
import type { AppConfig } from '../config/schema';

/** Device type string as sent by CF-Device-Type header. */
type DeviceType = 'mobile' | 'tablet' | 'desktop';

/** Map CF-Device-Type values to derivative names. Direct 1:1 when derivative exists. */
const DEVICE_TYPE_MAP: Record<DeviceType, string> = {
	mobile: 'mobile',
	tablet: 'tablet',
	desktop: 'desktop',
};

/**
 * Resolve responsive sizing into a derivative name.
 *
 * Returns a **new** params object — never mutates input.
 * Only sets `derivative` — the caller runs `resolveDerivative()` afterward
 * to expand it into width/height/quality/etc.
 */
export function resolveResponsive(
	params: TransformParams,
	headers: Headers,
	responsive: AppConfig['responsive'] | undefined,
	derivatives: AppConfig['derivatives'],
): TransformParams {
	// Already has explicit dimensions or derivative — nothing to do
	if (params.width || params.height || params.derivative) {
		return { ...params };
	}

	// No responsive config — can't auto-size
	if (!responsive) {
		return { ...params };
	}

	// Try Client Hints first
	const viewportWidth = parseFloat(headers.get('Sec-CH-Viewport-Width') ?? '') || parseFloat(headers.get('Width') ?? '') || null;

	if (viewportWidth && viewportWidth > 0) {
		// Apply DPR scaling
		const dpr = (params.dpr ?? parseFloat(headers.get('Sec-CH-DPR') ?? '')) || 1;
		const effectiveWidth = viewportWidth * dpr;

		// Match against breakpoints (sorted ascending by maxWidth)
		const sorted = [...responsive.breakpoints].sort((a, b) => a.maxWidth - b.maxWidth);
		for (const bp of sorted) {
			if (effectiveWidth <= bp.maxWidth && bp.derivative in derivatives) {
				return { ...params, derivative: bp.derivative };
			}
		}

		// No breakpoint matched — use default
		return { ...params, derivative: responsive.defaultDerivative };
	}

	// Try CF-Device-Type header
	const deviceType = headers.get('CF-Device-Type')?.toLowerCase() as DeviceType | undefined;
	if (deviceType && deviceType in DEVICE_TYPE_MAP) {
		const derivativeName = DEVICE_TYPE_MAP[deviceType];
		if (derivativeName in derivatives) {
			return { ...params, derivative: derivativeName };
		}
	}

	// Last resort: default derivative
	return { ...params, derivative: responsive.defaultDerivative };
}
