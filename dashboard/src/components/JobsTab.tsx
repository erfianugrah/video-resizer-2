import { useState, useEffect, useCallback, useRef } from 'react';
import { BASE, ErrorBanner, Badge, statusColor, formatBytes, formatDuration, formatTime } from './shared';

interface JobRow {
	job_id: string;
	path: string;
	origin: string | null;
	status: string;
	params: Record<string, unknown> | null;
	source_type: string | null;
	created_at: number;
	started_at: number | null;
	completed_at: number | null;
	error: string | null;
	output_size: number | null;
	percent: number | null;
}

const ACTIVE_STATUSES = new Set(['pending', 'downloading', 'transcoding', 'uploading']);
const ALL_STATUSES = ['all', 'active', 'complete', 'failed'] as const;
type StatusFilter = (typeof ALL_STATUSES)[number];

// Client-side staleness: job active for >25 min without update is likely stuck
const STALE_MS = 25 * 60_000;

function isStale(job: JobRow): boolean {
	if (!ACTIVE_STATUSES.has(job.status)) return false;
	const lastActivity = job.started_at ?? job.created_at;
	return Date.now() - lastActivity > STALE_MS;
}

export default function JobsTab({ token }: { token: string }) {
	const [jobs, setJobs] = useState<JobRow[]>([]);
	const [filter, setFilter] = useState('');
	const [debouncedFilter, setDebouncedFilter] = useState('');
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
	const [hours, setHours] = useState(24);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [pollInterval, setPollInterval] = useState(10);
	const [expandedId, setExpandedId] = useState<string | null>(null);

	// SSE connections for active jobs (ref to avoid re-render storms)
	const sseRefs = useRef<Map<string, EventSource>>(new Map());

	// Debounce filter input (300ms)
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedFilter(filter), 300);
		return () => clearTimeout(timer);
	}, [filter]);

	const fetchJobs = useCallback(async () => {
		if (!token) { setError('Enter API token above'); return; }
		setLoading(true);
		setError('');
		try {
			const params = new URLSearchParams({ hours: String(hours), limit: '100' });
			if (debouncedFilter) params.set('filter', debouncedFilter);
			const resp = await fetch(`${BASE}/admin/jobs?${params}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (resp.status === 401) { setError('Invalid token'); return; }
			if (!resp.ok) { setError(`HTTP ${resp.status}`); return; }
			const data = await resp.json() as { jobs: JobRow[] };
			setJobs(data.jobs ?? []);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Fetch failed');
		} finally {
			setLoading(false);
		}
	}, [token, hours, debouncedFilter]);

	useEffect(() => {
		fetchJobs();
		const interval = setInterval(fetchJobs, pollInterval * 1000);
		return () => clearInterval(interval);
	}, [fetchJobs, pollInterval]);

	// SSE: connect for active jobs, close on complete/unmount
	useEffect(() => {
		const active = jobs.filter((j) => ACTIVE_STATUSES.has(j.status));
		const activeIds = new Set(active.map((j) => j.job_id));

		// Close connections for jobs no longer active
		for (const [id, es] of sseRefs.current) {
			if (!activeIds.has(id)) { es.close(); sseRefs.current.delete(id); }
		}

		// Open connections for new active jobs
		for (const job of active) {
			if (sseRefs.current.has(job.job_id)) continue;
			const es = new EventSource(`${BASE}/sse/job/${encodeURIComponent(job.job_id)}`);
			es.onmessage = (ev) => {
				try {
					const data = JSON.parse(ev.data) as { status: string; percent?: number };
					setJobs((prev) => prev.map((j) =>
						j.job_id === job.job_id
							? { ...j, status: data.status, percent: data.percent ?? j.percent }
							: j,
					));
					if (data.status === 'complete' || data.status === 'failed' || data.status === 'not_found') {
						es.close();
						sseRefs.current.delete(job.job_id);
					}
				} catch { /* ignore parse errors */ }
			};
			es.onerror = () => { es.close(); sseRefs.current.delete(job.job_id); };
			sseRefs.current.set(job.job_id, es);
		}

		return () => {
			for (const es of sseRefs.current.values()) es.close();
			sseRefs.current.clear();
		};
	}, [jobs.map((j) => `${j.job_id}:${j.status}`).join(',')]);

	// Client-side filtering
	const displayed = jobs.filter((j) => {
		if (statusFilter === 'active') return ACTIVE_STATUSES.has(j.status);
		if (statusFilter === 'complete') return j.status === 'complete';
		if (statusFilter === 'failed') return j.status === 'failed';
		return true;
	});

	const activeJobs = displayed.filter((j) => ACTIVE_STATUSES.has(j.status));
	const recentJobs = displayed.filter((j) => !ACTIVE_STATUSES.has(j.status));

	// Status counts for filter buttons
	const counts = {
		all: jobs.length,
		active: jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length,
		complete: jobs.filter((j) => j.status === 'complete').length,
		failed: jobs.filter((j) => j.status === 'failed').length,
	};

	return (
		<div>
			{/* Controls */}
			<div className="flex items-center gap-3 mb-4 flex-wrap">
				<input
					type="text"
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="Filter by path, status..."
					className="flex-1 min-w-[200px] px-3 py-1.5 text-sm rounded-md border font-mono"
					style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text)' }}
				/>
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
				<select
					value={pollInterval}
					onChange={(e) => setPollInterval(Number(e.target.value))}
					className="px-3 py-1.5 text-sm rounded-md border"
					style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text)' }}
					title="Poll interval"
				>
					{[5, 10, 30, 60].map((s) => (
						<option key={s} value={s}>{s}s</option>
					))}
				</select>
				<button
					onClick={fetchJobs}
					disabled={loading}
					className="px-3 py-1.5 text-sm rounded-md"
					style={{ background: 'var(--accent)', color: 'white', opacity: loading ? 0.5 : 1 }}
				>
					{loading ? 'Loading...' : 'Refresh'}
				</button>
			</div>

			{/* Status filter buttons (gatekeeper tab-button pattern) */}
			<div className="flex rounded-md border mb-4 w-fit" style={{ borderColor: 'var(--border)' }}>
				{ALL_STATUSES.map((s, i) => (
					<button
						key={s}
						onClick={() => setStatusFilter(s)}
						className="px-3 py-1 text-xs font-mono transition-colors capitalize"
						style={{
							background: statusFilter === s ? 'color-mix(in srgb, var(--accent) 20%, transparent)' : 'transparent',
							color: statusFilter === s ? 'var(--accent)' : 'var(--text-muted)',
							borderLeft: i > 0 ? '1px solid var(--border)' : 'none',
						}}
					>
						{s} ({counts[s]})
					</button>
				))}
			</div>

			{error && <ErrorBanner message={error} />}

			{/* Active jobs with progress */}
			{activeJobs.length > 0 && (
				<div className="mb-6">
					<h3 className="text-sm font-medium mb-3">Active ({activeJobs.length})</h3>
					<div className="space-y-2">
						{activeJobs.map((job) => (
							<JobCard key={job.job_id} job={job} stale={isStale(job)} />
						))}
					</div>
				</div>
			)}

			{/* Recent jobs table */}
			{recentJobs.length > 0 && (
				<div>
					<h3 className="text-sm font-medium mb-3">Recent ({recentJobs.length})</h3>
					<div className="overflow-x-auto">
						<table className="w-full text-xs">
							<thead>
								<tr style={{ color: 'var(--text-muted)' }}>
									<th className="text-left py-1 pr-3">Status</th>
									<th className="text-left py-1 pr-3">Path</th>
									<th className="text-left py-1 pr-3">Origin</th>
									<th className="text-left py-1 pr-3">Params</th>
									<th className="text-right py-1 pr-3">Size</th>
									<th className="text-right py-1 pr-3">Duration</th>
									<th className="text-left py-1">Created</th>
								</tr>
							</thead>
							<tbody>
								{recentJobs.map((job) => {
									const dur = job.started_at && job.completed_at
										? (job.completed_at - job.started_at) / 1000
										: null;
									const expanded = expandedId === job.job_id;
									return (
										<>
											<tr
												key={job.job_id}
												className="border-t cursor-pointer transition-colors"
												style={{ borderColor: 'var(--border)' }}
												onClick={() => setExpandedId(expanded ? null : job.job_id)}
											>
												<td className="py-1.5 pr-3">
													<Badge color={statusColor(job.status)}>{job.status}</Badge>
												</td>
												<td className="py-1.5 pr-3 font-mono truncate max-w-[200px]">{job.path}</td>
												<td className="py-1.5 pr-3" style={{ color: 'var(--text-muted)' }}>{job.origin ?? '—'}</td>
												<td className="py-1.5 pr-3 max-w-[250px]">
													<div className="flex flex-wrap gap-1">
														{job.params
															? Object.entries(job.params)
																.filter(([, v]) => v != null)
																.slice(0, 4)
																.map(([k, v]) => <Badge key={k} color="var(--text-muted)">{k}={String(v)}</Badge>)
															: <span style={{ color: 'var(--text-muted)' }}>—</span>}
													</div>
												</td>
												<td className="py-1.5 pr-3 text-right font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
													{job.output_size ? formatBytes(job.output_size) : '—'}
												</td>
												<td className="py-1.5 pr-3 text-right font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
													{dur != null ? formatDuration(dur) : '—'}
												</td>
												<td className="py-1.5 font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
													{formatTime(job.created_at)}
												</td>
											</tr>
											{expanded && (
												<tr key={`${job.job_id}-detail`} className="border-t" style={{ borderColor: 'var(--border)' }}>
													<td colSpan={7} className="py-3 px-4" style={{ background: 'var(--bg)' }}>
														<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
															<dt style={{ color: 'var(--text-muted)' }}>Job ID</dt>
															<dd className="font-mono truncate" style={{ color: '#79e6f3' }}>{job.job_id}</dd>
															{job.source_type && <>
																<dt style={{ color: 'var(--text-muted)' }}>Source</dt>
																<dd className="font-mono">{job.source_type}</dd>
															</>}
															{job.error && <>
																<dt style={{ color: 'var(--error)' }}>Error</dt>
																<dd className="font-mono" style={{ color: 'var(--error)' }}>{job.error}</dd>
															</>}
															{job.params && Object.keys(job.params).length > 0 && <>
																<dt style={{ color: 'var(--text-muted)' }}>All params</dt>
																<dd className="font-mono">{Object.entries(job.params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(', ')}</dd>
															</>}
														</dl>
													</td>
												</tr>
											)}
										</>
									);
								})}
							</tbody>
						</table>
					</div>
				</div>
			)}

			{/* Empty state */}
			{displayed.length === 0 && !loading && (
				<div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
					<p className="text-sm mb-2">
						{statusFilter !== 'all' ? `No ${statusFilter} jobs` : 'No container transform jobs found'}
					</p>
					<p className="text-xs">Jobs appear when a source exceeds the binding size limit ({'>'}100MB) or needs container-only params.</p>
				</div>
			)}
		</div>
	);
}

function JobCard({ job, stale }: { job: JobRow; stale: boolean }) {
	const color = stale ? 'var(--warning)' : statusColor(job.status);
	const percent = job.percent ?? 0;

	const elapsed = job.started_at
		? ((job.completed_at ?? Date.now()) - job.started_at) / 1000
		: (Date.now() - job.created_at) / 1000;

	return (
		<div className="rounded-lg border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
			<div className="flex items-center justify-between mb-2">
				<div className="flex items-center gap-2">
					<span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: color }} />
					<Badge color={color}>{stale ? 'stale' : job.status}</Badge>
					<span className="text-xs font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
						{formatDuration(elapsed)}
					</span>
				</div>
				<span className="text-xs" style={{ color: 'var(--text-muted)' }}>{job.origin ?? ''}</span>
			</div>

			{/* Progress bar */}
			{percent > 0 && (
				<div className="h-1.5 rounded-full overflow-hidden mb-2" style={{ background: 'var(--bg)' }}>
					<div
						className="h-full rounded-full transition-all duration-500"
						style={{ width: `${percent}%`, background: color }}
					/>
				</div>
			)}

			<div className="text-xs font-mono truncate mb-1">{job.path}</div>
			{job.params && Object.keys(job.params).length > 0 && (
				<div className="flex flex-wrap gap-1 mb-1">
					{Object.entries(job.params).filter(([, v]) => v != null).slice(0, 6).map(([k, v]) => (
						<Badge key={k} color="var(--text-muted)">{k}={String(v)}</Badge>
					))}
				</div>
			)}
			{job.error && (
				<div className="text-xs p-2 rounded mt-1" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--error)' }}>
					{job.error}
				</div>
			)}
		</div>
	);
}
