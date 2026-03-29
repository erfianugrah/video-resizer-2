import { useState, useEffect, useCallback } from 'react';
import { BASE, StatCard, BreakdownTable, ErrorBanner, formatTime } from './shared';

interface AnalyticsSummary {
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

interface AnalyticsError {
	path: string;
	status: number;
	errorCode: string | null;
	ts: number;
	durationMs: number | null;
}

const ADMIN_PATH_RE = /^\/(admin|internal|ws|sse)\//;

export default function AnalyticsTab({ token }: { token: string }) {
	const [hours, setHours] = useState(24);
	const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
	const [errors, setErrors] = useState<AnalyticsError[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [showAdminErrors, setShowAdminErrors] = useState(false);

	const fetchData = useCallback(async () => {
		if (!token) { setError('Enter API token above'); return; }
		setLoading(true);
		setError('');
		try {
			const [summaryRes, errorsRes] = await Promise.all([
				fetch(`${BASE}/admin/analytics?hours=${hours}`, { headers: { Authorization: `Bearer ${token}` } }),
				fetch(`${BASE}/admin/analytics/errors?hours=${hours}&limit=50`, { headers: { Authorization: `Bearer ${token}` } }),
			]);
			if (summaryRes.status === 401) { setError('Invalid token'); return; }
			const summaryData = await summaryRes.json() as { summary: AnalyticsSummary };
			const errorsData = await errorsRes.json() as { errors: AnalyticsError[] };
			setSummary(summaryData.summary);
			setErrors(errorsData.errors ?? []);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Fetch failed');
		} finally {
			setLoading(false);
		}
	}, [token, hours]);

	useEffect(() => { fetchData(); }, [fetchData]);

	const filteredErrors = showAdminErrors ? errors : errors.filter((e) => !ADMIN_PATH_RE.test(e.path));

	return (
		<div>
			<div className="flex items-center gap-3 mb-4">
				<select
					value={hours}
					onChange={(e) => setHours(Number(e.target.value))}
					className="px-3 py-1.5 text-sm rounded-md border"
					style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text)' }}
				>
					{[1, 6, 12, 24, 48, 168].map((h) => (
						<option key={h} value={h}>{h}h</option>
					))}
				</select>
				<button
					onClick={fetchData}
					disabled={loading}
					className="px-3 py-1.5 text-sm rounded-md"
					style={{ background: 'var(--accent)', color: 'white', opacity: loading ? 0.5 : 1 }}
				>
					{loading ? 'Loading...' : 'Refresh'}
				</button>
				{error && <span className="text-sm" style={{ color: 'var(--error)' }}>{error}</span>}
			</div>

			{summary && (
				<>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
						<StatCard label="Total Requests" value={summary.total} />
						<StatCard label="Success" value={summary.success} color="var(--success)" />
						<StatCard label="Errors" value={summary.errors} color="var(--error)" />
						<StatCard label="Cache Hit Rate" value={`${(summary.cacheHitRate * 100).toFixed(1)}%`} color="var(--accent)" />
					</div>
					<div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
						<StatCard label="Avg Latency" value={`${summary.avgLatencyMs ?? 0}ms`} />
						<StatCard label="p50 Latency" value={`${summary.p50LatencyMs ?? 0}ms`} />
						<StatCard label="p95 Latency" value={`${summary.p95LatencyMs ?? 0}ms`} />
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
						<BreakdownTable title="By Status" rows={summary.byStatus?.map((r) => [String(r.status), r.count]) ?? []} />
						<BreakdownTable title="By Origin" rows={summary.byOrigin?.map((r) => [r.origin ?? 'unknown', r.count]) ?? []} />
						<BreakdownTable title="By Derivative" rows={summary.byDerivative?.map((r) => [r.derivative ?? 'none', r.count]) ?? []} />
						<BreakdownTable title="By Transform Source" rows={summary.byTransformSource?.map((r) => [r.source ?? 'unknown', r.count]) ?? []} />
					</div>

					{errors.length > 0 && (
						<div className="rounded-lg border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
							<div className="flex items-center justify-between mb-3">
								<h3 className="text-sm font-medium">Recent Errors</h3>
								<label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>
									<input type="checkbox" checked={showAdminErrors} onChange={(e) => setShowAdminErrors(e.target.checked)} />
									Show admin/internal
								</label>
							</div>
							{filteredErrors.length === 0 ? (
								<p className="text-xs" style={{ color: 'var(--text-muted)' }}>No transform errors (only admin/internal errors hidden)</p>
							) : (
								<div className="overflow-x-auto">
									<table className="w-full text-xs">
										<thead>
											<tr style={{ color: 'var(--text-muted)' }}>
												<th className="text-left py-1 pr-3">Time</th>
												<th className="text-left py-1 pr-3">Path</th>
												<th className="text-left py-1 pr-3">Status</th>
												<th className="text-left py-1 pr-3">Code</th>
												<th className="text-right py-1">Latency</th>
											</tr>
										</thead>
										<tbody>
											{filteredErrors.map((e, i) => (
												<tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
													<td className="py-1.5 pr-3" style={{ color: 'var(--text-muted)' }}>{formatTime(e.ts)}</td>
													<td className="py-1.5 pr-3 font-mono truncate max-w-[200px]">{e.path}</td>
													<td className="py-1.5 pr-3" style={{ color: 'var(--error)' }}>{e.status}</td>
													<td className="py-1.5 pr-3 font-mono">{e.errorCode ?? '—'}</td>
													<td className="py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{e.durationMs ?? '—'}ms</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}
