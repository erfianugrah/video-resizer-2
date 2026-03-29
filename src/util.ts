/**
 * Shared utility functions.
 */

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Compares all bytes even when lengths differ (pads shorter to match).
 */
export function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const bufA = encoder.encode(a);
	const bufB = encoder.encode(b);
	const len = Math.max(bufA.length, bufB.length);
	let result = bufA.length ^ bufB.length; // length mismatch contributes to result
	for (let i = 0; i < len; i++) {
		result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
	}
	return result === 0;
}
