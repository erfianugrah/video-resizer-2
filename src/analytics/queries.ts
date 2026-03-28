/**
 * Analytics aggregation queries for the admin API.
 *
 * All queries operate on the transform_log D1 table.
 * Results are JSON-serializable for the REST API.
 */

/** Summary stats for a time window. */
export interface AnalyticsSummary {
	total: number;
	success: number;
	errors: number;
	cacheHits: number;
	cacheHitRate: number;
	avgLatencyMs: number;
	p50LatencyMs: number | null;
	p95LatencyMs: number | null;
	byStatus: { status: number; count: number }[];
	byOrigin: { origin: string; count: number }[];
	byDerivative: { derivative: string; count: number }[];
	byTransformSource: { source: string; count: number }[];
}

/** A recent error entry. */
export interface AnalyticsError {
	ts: number;
	path: string;
	status: number;
	errorCode: string | null;
	origin: string | null;
	durationMs: number | null;
}

/**
 * Get summary analytics for a time window.
 * @param db D1 database
 * @param sinceMs Timestamp in ms — only rows with ts > sinceMs are included
 */
export async function getSummary(db: D1Database, sinceMs: number): Promise<AnalyticsSummary> {
	// Main aggregates
	const agg = await db
		.prepare(
			`SELECT
				COUNT(*) as total,
				SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) as success,
				SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors,
				SUM(cache_hit) as cache_hits,
				AVG(duration_ms) as avg_latency_ms
			FROM transform_log WHERE ts > ?`,
		)
		.bind(sinceMs)
		.first<{ total: number; success: number; errors: number; cache_hits: number; avg_latency_ms: number }>();

	const total = agg?.total ?? 0;

	// Percentiles (manual: fetch sorted durations)
	let p50: number | null = null;
	let p95: number | null = null;
	if (total > 0) {
		const durations = await db
			.prepare(`SELECT duration_ms FROM transform_log WHERE ts > ? AND duration_ms IS NOT NULL ORDER BY duration_ms`)
			.bind(sinceMs)
			.all<{ duration_ms: number }>();
		const vals = durations.results.map((r) => r.duration_ms);
		if (vals.length > 0) {
			p50 = vals[Math.floor(vals.length * 0.5)];
			p95 = vals[Math.floor(vals.length * 0.95)];
		}
	}

	// By status
	const byStatus = await db
		.prepare(`SELECT status, COUNT(*) as count FROM transform_log WHERE ts > ? GROUP BY status ORDER BY count DESC LIMIT 20`)
		.bind(sinceMs)
		.all<{ status: number; count: number }>();

	// By origin
	const byOrigin = await db
		.prepare(
			`SELECT origin, COUNT(*) as count FROM transform_log WHERE ts > ? AND origin IS NOT NULL GROUP BY origin ORDER BY count DESC LIMIT 20`,
		)
		.bind(sinceMs)
		.all<{ origin: string; count: number }>();

	// By derivative
	const byDerivative = await db
		.prepare(
			`SELECT derivative, COUNT(*) as count FROM transform_log WHERE ts > ? AND derivative IS NOT NULL GROUP BY derivative ORDER BY count DESC LIMIT 20`,
		)
		.bind(sinceMs)
		.all<{ derivative: string; count: number }>();

	// By transform source
	const byTransformSource = await db
		.prepare(
			`SELECT transform_source as source, COUNT(*) as count FROM transform_log WHERE ts > ? AND transform_source IS NOT NULL GROUP BY transform_source ORDER BY count DESC`,
		)
		.bind(sinceMs)
		.all<{ source: string; count: number }>();

	return {
		total,
		success: agg?.success ?? 0,
		errors: agg?.errors ?? 0,
		cacheHits: agg?.cache_hits ?? 0,
		cacheHitRate: total > 0 ? (agg?.cache_hits ?? 0) / total : 0,
		avgLatencyMs: Math.round(agg?.avg_latency_ms ?? 0),
		p50LatencyMs: p50,
		p95LatencyMs: p95,
		byStatus: byStatus.results,
		byOrigin: byOrigin.results,
		byDerivative: byDerivative.results,
		byTransformSource: byTransformSource.results,
	};
}

/**
 * Get recent errors.
 * @param db D1 database
 * @param sinceMs Timestamp in ms
 * @param limit Max number of errors to return
 */
export async function getRecentErrors(db: D1Database, sinceMs: number, limit: number = 50): Promise<AnalyticsError[]> {
	const result = await db
		.prepare(
			`SELECT ts, path, status, error_code, origin, duration_ms
			FROM transform_log
			WHERE ts > ? AND status >= 400
			ORDER BY ts DESC
			LIMIT ?`,
		)
		.bind(sinceMs, limit)
		.all<{ ts: number; path: string; status: number; error_code: string | null; origin: string | null; duration_ms: number | null }>();

	return result.results.map((r) => ({
		ts: r.ts,
		path: r.path,
		status: r.status,
		errorCode: r.error_code,
		origin: r.origin,
		durationMs: r.duration_ms,
	}));
}
