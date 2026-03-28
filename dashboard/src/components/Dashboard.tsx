import { useState, useEffect, useCallback } from 'react';

type Tab = 'analytics' | 'debug';

interface AnalyticsSummary {
	total: number;
	success: number;
	errors: number;
	cacheHits: number;
	cacheMisses: number;
	hitRate: string;
	avgLatency: number;
	p50Latency: number;
	p95Latency: number;
	byStatus: { status: number; count: number }[];
	byOrigin: { origin: string; count: number }[];
	byDerivative: { derivative: string; count: number }[];
	bySource: { transform_source: string; count: number }[];
}

interface AnalyticsError {
	path: string;
	status: number;
	error_code: string;
	ts: number;
	duration_ms: number;
}

interface DiagnosticsResult {
	diagnostics: {
		requestId: string;
		path: string;
		params: Record<string, unknown>;
		origin: { name: string; sources: { type: string; priority: number }[]; ttl: Record<string, number> };
		captures: Record<string, string>;
		config: { derivatives: string[]; responsive: unknown; passthrough: unknown; containerEnabled: boolean };
		needsContainer: boolean;
		resolvedWidth: number | null;
		resolvedHeight: number | null;
	};
}

// Infer the base URL from window.location (works on any domain)
const BASE = typeof window !== 'undefined' ? window.location.origin : '';

export default function Dashboard() {
	const [tab, setTab] = useState<Tab>('analytics');
	const [token, setToken] = useState(() =>
		typeof window !== 'undefined' ? localStorage.getItem('vr2-token') ?? '' : '',
	);
	const [tokenSaved, setTokenSaved] = useState(!!token);

	const saveToken = () => {
		localStorage.setItem('vr2-token', token);
		setTokenSaved(true);
	};

	return (
		<div className="min-h-screen p-4 max-w-6xl mx-auto">
			<header className="flex items-center justify-between mb-6">
				<h1 className="text-xl font-semibold tracking-tight">video-resizer-2</h1>
				<div className="flex items-center gap-2">
					<input
						type="password"
						placeholder="API token"
						value={token}
						onChange={(e) => { setToken(e.target.value); setTokenSaved(false); }}
						onKeyDown={(e) => e.key === 'Enter' && saveToken()}
						className="px-3 py-1.5 text-sm rounded-md border"
						style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text)' }}
					/>
					{!tokenSaved && (
						<button onClick={saveToken} className="px-3 py-1.5 text-sm rounded-md" style={{ background: 'var(--accent)', color: 'white' }}>
							Save
						</button>
					)}
				</div>
			</header>

			<nav className="flex gap-1 mb-6 border-b" style={{ borderColor: 'var(--border)' }}>
				{(['analytics', 'debug'] as Tab[]).map((t) => (
					<button
						key={t}
						onClick={() => setTab(t)}
						className="px-4 py-2 text-sm font-medium capitalize transition-colors"
						style={{
							borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
							color: tab === t ? 'var(--text)' : 'var(--text-muted)',
						}}
					>
						{t}
					</button>
				))}
			</nav>

			{tab === 'analytics' && <AnalyticsTab token={token} />}
			{tab === 'debug' && <DebugTab />}
		</div>
	);
}

// ── Analytics Tab ────────────────────────────────────────────────────────

function AnalyticsTab({ token }: { token: string }) {
	const [hours, setHours] = useState(24);
	const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
	const [errors, setErrors] = useState<AnalyticsError[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');

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
					{/* Stat cards */}
					<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
						<StatCard label="Total Requests" value={summary.total} />
						<StatCard label="Success" value={summary.success} color="var(--success)" />
						<StatCard label="Errors" value={summary.errors} color="var(--error)" />
						<StatCard label="Cache Hit Rate" value={summary.hitRate} color="var(--accent)" />
					</div>
					<div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
						<StatCard label="Avg Latency" value={`${summary.avgLatency}ms`} />
						<StatCard label="p50 Latency" value={`${summary.p50Latency}ms`} />
						<StatCard label="p95 Latency" value={`${summary.p95Latency}ms`} />
					</div>

					{/* Breakdowns */}
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
						<BreakdownTable title="By Status" rows={summary.byStatus?.map((r) => [String(r.status), r.count]) ?? []} />
						<BreakdownTable title="By Origin" rows={summary.byOrigin?.map((r) => [r.origin ?? 'unknown', r.count]) ?? []} />
						<BreakdownTable title="By Derivative" rows={summary.byDerivative?.map((r) => [r.derivative ?? 'none', r.count]) ?? []} />
						<BreakdownTable title="By Transform Source" rows={summary.bySource?.map((r) => [r.transform_source ?? 'unknown', r.count]) ?? []} />
					</div>

					{/* Errors table */}
					{errors.length > 0 && (
						<div className="rounded-lg border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
							<h3 className="text-sm font-medium mb-3">Recent Errors</h3>
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
										{errors.map((e, i) => (
											<tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
												<td className="py-1.5 pr-3" style={{ color: 'var(--text-muted)' }}>
													{new Date(e.ts).toLocaleTimeString()}
												</td>
												<td className="py-1.5 pr-3 font-mono truncate max-w-[200px]">{e.path}</td>
												<td className="py-1.5 pr-3" style={{ color: 'var(--error)' }}>{e.status}</td>
												<td className="py-1.5 pr-3 font-mono">{e.error_code}</td>
												<td className="py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{e.duration_ms}ms</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}

// ── Debug Tab ────────────────────────────────────────────────────────────

function DebugTab() {
	const [url, setUrl] = useState('/rocky.mp4?derivative=tablet');
	const [diagnostics, setDiagnostics] = useState<DiagnosticsResult['diagnostics'] | null>(null);
	const [headers, setHeaders] = useState<[string, string][]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [responseTime, setResponseTime] = useState(0);
	const [responseSize, setResponseSize] = useState(0);
	const [responseStatus, setResponseStatus] = useState(0);

	const testUrl = async () => {
		setLoading(true);
		setError('');
		setDiagnostics(null);
		setHeaders([]);
		try {
			// First: fetch diagnostics via debug=view
			const sep = url.includes('?') ? '&' : '?';
			const diagUrl = `${BASE}${url}${sep}debug=view`;
			const diagRes = await fetch(diagUrl);
			if (diagRes.ok) {
				const data = await diagRes.json() as DiagnosticsResult;
				setDiagnostics(data.diagnostics);
			}

			// Second: fetch the actual transform (with debug flag for headers)
			const t0 = performance.now();
			const transformUrl = `${BASE}${url}${sep}debug`;
			const res = await fetch(transformUrl);
			setResponseTime(Math.round(performance.now() - t0));
			setResponseStatus(res.status);
			setResponseSize(parseInt(res.headers.get('content-length') ?? '0', 10));

			// Collect response headers
			const hdrs: [string, string][] = [];
			res.headers.forEach((v, k) => hdrs.push([k, v]));
			setHeaders(hdrs.sort((a, b) => a[0].localeCompare(b[0])));
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Fetch failed');
		} finally {
			setLoading(false);
		}
	};

	return (
		<div>
			<div className="flex gap-2 mb-4">
				<input
					type="text"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && testUrl()}
					placeholder="/path.mp4?params"
					className="flex-1 px-3 py-2 text-sm rounded-md border font-mono"
					style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text)' }}
				/>
				<button
					onClick={testUrl}
					disabled={loading}
					className="px-4 py-2 text-sm rounded-md font-medium"
					style={{ background: 'var(--accent)', color: 'white', opacity: loading ? 0.5 : 1 }}
				>
					{loading ? 'Testing...' : 'Test'}
				</button>
			</div>

			{error && <div className="text-sm mb-4 p-3 rounded-md border" style={{ color: 'var(--error)', borderColor: 'var(--error)', background: 'rgba(239,68,68,0.1)' }}>{error}</div>}

			{(diagnostics || headers.length > 0) && (
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					{/* Response summary */}
					{responseStatus > 0 && (
						<div className="rounded-lg border p-4 md:col-span-2" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
							<h3 className="text-sm font-medium mb-2">Response</h3>
							<div className="flex gap-6 text-sm">
								<span>Status: <b style={{ color: responseStatus < 400 ? 'var(--success)' : 'var(--error)' }}>{responseStatus}</b></span>
								<span>Size: <b>{formatBytes(responseSize)}</b></span>
								<span>Time: <b>{responseTime}ms</b></span>
								<span>Type: <b>{headers.find(([k]) => k === 'content-type')?.[1] ?? 'unknown'}</b></span>
								<span>Cache: <b>{headers.find(([k]) => k === 'cf-cache-status')?.[1] ?? 'n/a'}</b></span>
							</div>
						</div>
					)}

					{/* Diagnostics */}
					{diagnostics && (
						<div className="rounded-lg border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
							<h3 className="text-sm font-medium mb-3">Param Resolution</h3>
							<dl className="text-xs space-y-1">
								{Object.entries(diagnostics.params).map(([k, v]) => (
									v !== undefined && v !== null && (
										<div key={k} className="flex justify-between">
											<dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
											<dd className="font-mono">{String(v)}</dd>
										</div>
									)
								))}
							</dl>

							<h3 className="text-sm font-medium mt-4 mb-2">Origin</h3>
							<dl className="text-xs space-y-1">
								<div className="flex justify-between">
									<dt style={{ color: 'var(--text-muted)' }}>name</dt>
									<dd className="font-mono">{diagnostics.origin.name}</dd>
								</div>
								<div className="flex justify-between">
									<dt style={{ color: 'var(--text-muted)' }}>sources</dt>
									<dd className="font-mono">{diagnostics.origin.sources.map((s) => `${s.type}(p${s.priority})`).join(', ')}</dd>
								</div>
								<div className="flex justify-between">
									<dt style={{ color: 'var(--text-muted)' }}>needsContainer</dt>
									<dd className="font-mono" style={{ color: diagnostics.needsContainer ? 'var(--warning)' : 'var(--success)' }}>
										{String(diagnostics.needsContainer)}
									</dd>
								</div>
							</dl>

							{diagnostics.captures && Object.keys(diagnostics.captures).length > 0 && (
								<>
									<h3 className="text-sm font-medium mt-4 mb-2">Captures</h3>
									<dl className="text-xs space-y-1">
										{Object.entries(diagnostics.captures).map(([k, v]) => (
											<div key={k} className="flex justify-between">
												<dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
												<dd className="font-mono">{v}</dd>
											</div>
										))}
									</dl>
								</>
							)}

							<h3 className="text-sm font-medium mt-4 mb-2">Config</h3>
							<dl className="text-xs space-y-1">
								<div className="flex justify-between">
									<dt style={{ color: 'var(--text-muted)' }}>derivatives</dt>
									<dd className="font-mono">{diagnostics.config.derivatives.join(', ')}</dd>
								</div>
								<div className="flex justify-between">
									<dt style={{ color: 'var(--text-muted)' }}>container</dt>
									<dd className="font-mono">{String(diagnostics.config.containerEnabled)}</dd>
								</div>
							</dl>
						</div>
					)}

					{/* Response headers */}
					{headers.length > 0 && (
						<div className="rounded-lg border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
							<h3 className="text-sm font-medium mb-3">Response Headers</h3>
							<dl className="text-xs space-y-0.5 font-mono">
								{headers.map(([k, v]) => (
									<div key={k} className="flex gap-2">
										<dt className="shrink-0" style={{ color: k.startsWith('x-') ? 'var(--accent)' : 'var(--text-muted)' }}>{k}:</dt>
										<dd className="truncate">{v}</dd>
									</div>
								))}
							</dl>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ── Shared Components ────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
	return (
		<div className="rounded-lg border p-3" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
			<div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
			<div className="text-lg font-semibold" style={{ color: color ?? 'var(--text)' }}>{value}</div>
		</div>
	);
}

function BreakdownTable({ title, rows }: { title: string; rows: [string, number][] }) {
	if (!rows.length) return null;
	const max = Math.max(...rows.map(([, v]) => v));
	return (
		<div className="rounded-lg border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
			<h3 className="text-sm font-medium mb-2">{title}</h3>
			<div className="space-y-1.5">
				{rows.map(([label, count]) => (
					<div key={label} className="flex items-center gap-2 text-xs">
						<span className="w-24 shrink-0 font-mono truncate">{label}</span>
						<div className="flex-1 h-3 rounded-sm overflow-hidden" style={{ background: 'var(--bg)' }}>
							<div
								className="h-full rounded-sm"
								style={{ width: `${(count / max) * 100}%`, background: 'var(--accent)', opacity: 0.7 }}
							/>
						</div>
						<span className="w-12 text-right" style={{ color: 'var(--text-muted)' }}>{count}</span>
					</div>
				))}
			</div>
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
