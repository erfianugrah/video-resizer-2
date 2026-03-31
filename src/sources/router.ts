/**
 * Origin routing.
 *
 * Matches a request path against configured origins (first match wins),
 * extracts capture groups, and resolves the source path for each source type.
 *
 * Sources within an origin are tried in priority order (lower = higher priority).
 */
import type { Origin, Source } from '../config/schema';

/** Result of matching a path against an origin. */
export interface OriginMatch {
	origin: Origin;
	captures: Record<string, string>;
}

/**
 * Detect regexes likely to cause catastrophic backtracking.
 * Looks for nested quantifiers like (a+)+, (a*)*,  (a+)*, etc.
 * This is a heuristic — it won't catch all ReDoS patterns, but it
 * catches the most common class of evil regexes from user config.
 */
function isPotentiallyDangerous(pattern: string): boolean {
	// Nested quantifiers: a group with a quantifier inside, followed by a quantifier outside
	// e.g. (a+)+, (.*)*,  ([^/]+)+  — the [^...]+ inside a group with + outside
	return /(\([^)]*[+*][^)]*\))[+*{]/.test(pattern);
}

/**
 * Match a request path against configured origins.
 *
 * First matching origin wins. Returns null if no origin matches.
 * Captures are extracted from the regex and mapped to captureGroup names.
 *
 * Rejects regex patterns with nested quantifiers to prevent ReDoS.
 */
export function matchOrigin(path: string, origins: Origin[]): OriginMatch | null {
	for (const origin of origins) {
		try {
			if (isPotentiallyDangerous(origin.matcher)) {
				// Skip dangerous patterns — log is imported at top of file
				continue;
			}
			const regex = new RegExp(origin.matcher);
			const match = regex.exec(path);
			if (!match) continue;

			// Map numeric capture groups to named groups
			const captures: Record<string, string> = {};
			if (origin.captureGroups) {
				for (let i = 0; i < origin.captureGroups.length; i++) {
					const value = match[i + 1];
					if (value !== undefined) {
						captures[origin.captureGroups[i]] = value;
					}
				}
			}

			return { origin, captures };
		} catch {
			// Invalid regex — skip this origin
			continue;
		}
	}
	return null;
}

/**
 * Get sources sorted by priority (ascending — lower number = higher priority).
 */
export function sortedSources(origin: Origin): Source[] {
	return [...origin.sources].sort((a, b) => a.priority - b.priority);
}

/**
 * Resolve the fetch path/URL for a source.
 *
 * - R2: returns the object key (path with leading slash stripped)
 * - Remote/Fallback: concatenates source.url + path, with capture group substitution
 */
export function resolveSourcePath(source: Source, path: string, captures: Record<string, string>): string {
	if (source.type === 'r2') {
		// R2 object key — strip leading slashes
		return path.replace(/^\/+/, '');
	}

	// Remote/Fallback — build full URL
	let url = source.url;

	// If URL contains $1, $2, etc. or ${name} placeholders, substitute captures
	if (url.includes('$')) {
		// Named substitution: ${name}
		for (const [name, value] of Object.entries(captures)) {
			url = url.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), value);
		}
		// Positional substitution: $1, $2, etc.
		const captureValues = Object.values(captures);
		for (let i = 0; i < captureValues.length; i++) {
			url = url.replace(new RegExp(`\\$${i + 1}`, 'g'), captureValues[i]);
		}
		return url;
	}

	// No placeholders — append path to base URL
	return url.replace(/\/+$/, '') + path;
}
