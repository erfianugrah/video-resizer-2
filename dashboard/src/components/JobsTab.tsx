import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { RefreshCw, ChevronRight, Loader2, Search, AlertTriangle, RotateCcw, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './ui/table';
import { T } from '@/lib/typography';
import { cn, BASE, statusColor, formatBytes, formatDuration, formatTime } from '@/lib/utils';

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

const STALE_MS = 25 * 60_000;

function isStale(job: JobRow): boolean {
	if (!ACTIVE_STATUSES.has(job.status)) return false;
	const lastActivity = job.started_at ?? job.created_at;
	return Date.now() - lastActivity > STALE_MS;
}

const HOURS_OPTIONS = [
	{ value: 1, label: '1h' },
	{ value: 6, label: '6h' },
	{ value: 12, label: '12h' },
	{ value: 24, label: '24h' },
	{ value: 48, label: '48h' },
	{ value: 168, label: '7d' },
];

const POLL_OPTIONS = [
	{ value: 5, label: '5s' },
	{ value: 10, label: '10s' },
	{ value: 30, label: '30s' },
	{ value: 60, label: '60s' },
];

// ── Loading Skeleton ─────────────────────────────────────────────────

function JobsSkeleton() {
	return (
		<Card>
			<CardContent className="p-6 space-y-3">
				{Array.from({ length: 5 }).map((_, i) => (
					<Skeleton key={i} className="h-10 w-full" />
				))}
			</CardContent>
		</Card>
	);
}

// ── Status Badge ─────────────────────────────────────────────────────

function StatusBadge({ status, stale }: { status: string; stale?: boolean }) {
	const display = stale ? 'stale' : status;
	const color = stale ? '#eab308' : statusColor(status);
	return (
		<Badge
			className="gap-1"
			style={{
				color,
				borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
				backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
			}}
		>
			{ACTIVE_STATUSES.has(status) && (
				<span className="inline-block h-1.5 w-1.5 rounded-full animate-pulse" style={{ backgroundColor: color }} />
			)}
			{display}
		</Badge>
	);
}

// ── Param Badge ──────────────────────────────────────────────────────

function ParamBadge({ k, v }: { k: string; v: string }) {
	return (
		<Badge className="bg-muted text-muted-foreground border-border">
			{k}={v}
		</Badge>
	);
}

// ── Job Card (active jobs) ───────────────────────────────────────────

function JobCard({ job, stale, onRetry, onDelete, actionLoading }: {
	job: JobRow;
	stale: boolean;
	onRetry: (id: string) => void;
	onDelete: (id: string) => void;
	actionLoading: string | null;
}) {
	const color = stale ? '#eab308' : statusColor(job.status);
	const percent = job.percent ?? 0;
	const elapsed = job.started_at
		? ((job.completed_at ?? Date.now()) - job.started_at) / 1000
		: (Date.now() - job.created_at) / 1000;

	return (
		<Card className="animate-fade-in-up opacity-0">
			<CardContent className="p-4">
				<div className="flex items-center justify-between mb-2">
					<div className="flex items-center gap-2">
						<StatusBadge status={job.status} stale={stale} />
						<span className="text-xs font-data tabular-nums text-muted-foreground">{formatDuration(elapsed)}</span>
						{stale && <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />}
					</div>
					<div className="flex items-center gap-1.5">
						<span className={T.muted}>{job.origin ?? ''}</span>
						{stale && (
							<>
								<Button
									variant="ghost"
									size="icon-sm"
									title="Retry job"
									disabled={actionLoading === job.job_id}
									onClick={() => onRetry(job.job_id)}
								>
									{actionLoading === job.job_id
										? <Loader2 className="h-3 w-3 animate-spin" />
										: <RotateCcw className="h-3 w-3" />}
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									title="Delete job"
									disabled={actionLoading === job.job_id}
									onClick={() => onDelete(job.job_id)}
									className="text-lv-red hover:text-lv-red"
								>
									<Trash2 className="h-3 w-3" />
								</Button>
							</>
						)}
					</div>
				</div>

				{/* Progress bar */}
				{percent > 0 && (
					<div className="h-1.5 rounded-full overflow-hidden bg-muted mb-2">
						<div
							className="h-full rounded-full transition-all duration-500"
							style={{ width: `${percent}%`, backgroundColor: color }}
						/>
					</div>
				)}

				<div className="text-xs font-data truncate mb-1.5 text-foreground/80">{job.path}</div>
				{job.params && Object.keys(job.params).length > 0 && (
					<div className="flex flex-wrap gap-1 mb-1.5">
						{Object.entries(job.params).filter(([, v]) => v != null).slice(0, 6).map(([k, v]) => (
							<ParamBadge key={k} k={k} v={String(v)} />
						))}
					</div>
				)}
				{job.error && (
					<div className="text-xs p-2 rounded-md mt-1.5 border border-lv-red/30 bg-lv-red/10 text-lv-red">
						{job.error}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

// ── Main Component ───────────────────────────────────────────────────

export default function JobsTab({ token }: { token: string }) {
	const [jobs, setJobs] = useState<JobRow[]>([]);
	const [filter, setFilter] = useState('');
	const [debouncedFilter, setDebouncedFilter] = useState('');
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
	const [hours, setHours] = useState(24);
	const [loading, setLoading] = useState(false);
	const [initialLoad, setInitialLoad] = useState(true);
	const [error, setError] = useState('');
	const [pollInterval, setPollInterval] = useState(10);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [actionLoading, setActionLoading] = useState<string | null>(null);

	const sseRefs = useRef<Map<string, EventSource>>(new Map());

	/** Retry or delete a job via the admin API. */
	const jobAction = useCallback(async (jobId: string, action: 'retry' | 'delete') => {
		if (!token) return;
		setActionLoading(jobId);
		try {
			const body = action === 'delete'
				? { jobId, delete: true }
				: { jobId };
			const resp = await fetch(`${BASE}/admin/jobs/retry`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!resp.ok) {
				const data = await resp.json().catch(() => ({})) as { error?: { message?: string } };
				setError(data.error?.message ?? `HTTP ${resp.status}`);
				return;
			}
			// Remove from local state if deleted, or update status if retried
			if (action === 'delete') {
				setJobs((prev) => prev.filter((j) => j.job_id !== jobId));
			} else {
				setJobs((prev) => prev.map((j) =>
					j.job_id === jobId ? { ...j, status: 'pending', percent: 0, error: null } : j,
				));
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Action failed');
		} finally {
			setActionLoading(null);
		}
	}, [token]);

	/** Reset all stale jobs. */
	const clearStale = useCallback(async () => {
		if (!token) return;
		setActionLoading('bulk-stale');
		try {
			const resp = await fetch(`${BASE}/admin/jobs/retry`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ staleMinutes: Math.round(STALE_MS / 60_000) }),
			});
			if (!resp.ok) {
				const data = await resp.json().catch(() => ({})) as { error?: { message?: string } };
				setError(data.error?.message ?? `HTTP ${resp.status}`);
				return;
			}
			const data = await resp.json() as { resetCount: number };
			// Refresh job list to reflect changes
			setJobs((prev) => prev.map((j) =>
				isStale(j) ? { ...j, status: 'pending', percent: 0, error: null } : j,
			));
			setError('');
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Action failed');
		} finally {
			setActionLoading(null);
		}
	}, [token]);

	// Debounce filter input (300ms)
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedFilter(filter), 300);
		return () => clearTimeout(timer);
	}, [filter]);

	const fetchJobs = useCallback(async () => {
		if (!token) { setError('Enter API token above'); setInitialLoad(false); return; }
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
			setInitialLoad(false);
		}
	}, [token, hours, debouncedFilter]);

	useEffect(() => {
		fetchJobs();
		const interval = setInterval(fetchJobs, pollInterval * 1000);
		return () => clearInterval(interval);
	}, [fetchJobs, pollInterval]);

	// SSE: connect for active jobs
	useEffect(() => {
		const active = jobs.filter((j) => ACTIVE_STATUSES.has(j.status));
		const activeIds = new Set(active.map((j) => j.job_id));

		for (const [id, es] of sseRefs.current) {
			if (!activeIds.has(id)) { es.close(); sseRefs.current.delete(id); }
		}

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

	const counts = {
		all: jobs.length,
		active: jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length,
		complete: jobs.filter((j) => j.status === 'complete').length,
		failed: jobs.filter((j) => j.status === 'failed').length,
	};

	return (
		<div className="space-y-4">
			{/* Controls */}
			<div className="flex items-center gap-2 flex-wrap">
				<div className="relative flex-1 max-w-xs">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
					<Input
						type="text"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter by path, status..."
						className="pl-8 font-data text-xs"
						aria-label="Filter jobs"
					/>
				</div>
				<div className="inline-flex rounded-lg border border-border overflow-hidden">
					{HOURS_OPTIONS.map((opt) => (
						<button
							key={opt.value}
							onClick={() => setHours(opt.value)}
							className={cn(
								'px-2.5 py-1.5 text-xs font-medium transition-colors border-r border-border last:border-r-0',
								hours === opt.value
									? 'bg-lv-purple/20 text-lv-purple'
									: 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
							)}
						>
							{opt.label}
						</button>
					))}
				</div>
				<div className="inline-flex rounded-lg border border-border overflow-hidden">
					{POLL_OPTIONS.map((opt) => (
						<button
							key={opt.value}
							onClick={() => setPollInterval(opt.value)}
							className={cn(
								'px-2.5 py-1.5 text-xs font-medium transition-colors border-r border-border last:border-r-0',
								pollInterval === opt.value
									? 'bg-lv-blue/20 text-lv-blue'
									: 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
							)}
						>
							{opt.label}
						</button>
					))}
				</div>
				<Button onClick={fetchJobs} disabled={loading} variant="outline" size="sm" className="gap-1.5">
					{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
					Refresh
				</Button>
			</div>

			{/* Status filter */}
			<div className="inline-flex rounded-lg border border-border overflow-hidden">
				{ALL_STATUSES.map((s) => (
					<button
						key={s}
						onClick={() => setStatusFilter(s)}
						className={cn(
							'px-3 py-1.5 text-xs font-medium transition-colors border-r border-border last:border-r-0 capitalize',
							statusFilter === s
								? 'bg-lv-purple/20 text-lv-purple'
								: 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
						)}
					>
						{s} ({counts[s]})
					</button>
				))}
			</div>

			{/* Error */}
			{error && (
				<div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">
					{error}
				</div>
			)}

			{/* Loading skeleton */}
			{initialLoad && !error && <JobsSkeleton />}

			{/* Active jobs */}
			{activeJobs.length > 0 && (
				<div>
					<div className="flex items-center justify-between mb-3">
						<h3 className={T.sectionHeading}>Active ({activeJobs.length})</h3>
						{activeJobs.some((j) => isStale(j)) && (
							<Button
								variant="outline"
								size="xs"
								className="gap-1.5 text-yellow-500 border-yellow-500/30 hover:bg-yellow-500/10"
								disabled={actionLoading === 'bulk-stale'}
								onClick={clearStale}
							>
								{actionLoading === 'bulk-stale'
									? <Loader2 className="h-3 w-3 animate-spin" />
									: <RotateCcw className="h-3 w-3" />}
								Clear stale
							</Button>
						)}
					</div>
					<div className="grid gap-3">
						{activeJobs.map((job) => (
							<JobCard
								key={job.job_id}
								job={job}
								stale={isStale(job)}
								onRetry={(id) => jobAction(id, 'retry')}
								onDelete={(id) => jobAction(id, 'delete')}
								actionLoading={actionLoading}
							/>
						))}
					</div>
				</div>
			)}

			{/* Recent jobs table */}
			{recentJobs.length > 0 && (
				<Card>
					<CardHeader className="pb-3">
						<CardTitle className={T.cardTitle}>Recent ({recentJobs.length})</CardTitle>
					</CardHeader>
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className={T.tableCell}>Status</TableHead>
									<TableHead className={T.tableCell}>Path</TableHead>
									<TableHead className={cn(T.tableCell, 'hidden sm:table-cell')}>Origin</TableHead>
									<TableHead className={cn(T.tableCell, 'hidden lg:table-cell')}>Params</TableHead>
									<TableHead className={cn(T.tableCell, 'text-right')}>Size</TableHead>
									<TableHead className={cn(T.tableCell, 'text-right hidden sm:table-cell')}>Duration</TableHead>
									<TableHead className={cn(T.tableCell, 'hidden md:table-cell')}>Created</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{recentJobs.map((job) => {
									const dur = job.started_at && job.completed_at
										? (job.completed_at - job.started_at) / 1000
										: null;
									const expanded = expandedId === job.job_id;
									return (
										<Fragment key={job.job_id}>
											<TableRow
												className="cursor-pointer"
												onClick={() => setExpandedId(expanded ? null : job.job_id)}
											>
												<TableCell>
													<div className="flex items-center gap-1.5">
														<ChevronRight
															className={cn(
																'h-3 w-3 text-muted-foreground transition-transform duration-150',
																expanded && 'rotate-90',
															)}
														/>
														<StatusBadge status={job.status} />
													</div>
												</TableCell>
												<TableCell className={cn(T.tableCellMono, 'truncate max-w-[200px]')} title={job.path}>
													{job.path}
												</TableCell>
												<TableCell className={cn(T.tableCell, 'text-muted-foreground hidden sm:table-cell')}>
													{job.origin ?? '\u2014'}
												</TableCell>
												<TableCell className={cn(T.tableCell, 'max-w-[250px] hidden lg:table-cell')}>
													<div className="flex flex-wrap gap-1">
														{job.params
															? Object.entries(job.params)
																.filter(([, v]) => v != null)
																.slice(0, 4)
																.map(([k, v]) => <ParamBadge key={k} k={k} v={String(v)} />)
															: <span className="text-muted-foreground">\u2014</span>}
													</div>
												</TableCell>
												<TableCell className={T.tableCellNumeric}>
													{job.output_size ? formatBytes(job.output_size) : '\u2014'}
												</TableCell>
												<TableCell className={cn(T.tableCellNumeric, 'hidden sm:table-cell')}>
													{dur != null ? formatDuration(dur) : '\u2014'}
												</TableCell>
												<TableCell className={cn(T.tableCellMono, 'text-muted-foreground hidden md:table-cell')}>
													{formatTime(job.created_at)}
												</TableCell>
											</TableRow>
											{expanded && (
												<TableRow className="bg-lovelace-950/50 hover:bg-lovelace-950/50">
													<TableCell colSpan={7} className="py-3 px-4">
														<div className="flex items-start justify-between gap-4">
													<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs">
														<dt className="text-muted-foreground">Job ID</dt>
														<dd className="font-data text-lv-cyan truncate" title={job.job_id}>{job.job_id}</dd>
														{job.source_type && <>
															<dt className="text-muted-foreground">Source</dt>
															<dd className="font-data">{job.source_type}</dd>
														</>}
														{job.error && <>
															<dt className="text-lv-red">Error</dt>
															<dd className="font-data text-lv-red">{job.error}</dd>
														</>}
														{job.params && Object.keys(job.params).length > 0 && <>
															<dt className="text-muted-foreground">All params</dt>
															<dd className="font-data">{Object.entries(job.params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(', ')}</dd>
														</>}
													</dl>
													<div className="flex gap-1.5 shrink-0">
														{job.status !== 'complete' && (
															<Button
																variant="outline"
																size="xs"
																className="gap-1"
																disabled={actionLoading === job.job_id}
																onClick={(e) => { e.stopPropagation(); jobAction(job.job_id, 'retry'); }}
															>
																{actionLoading === job.job_id
																	? <Loader2 className="h-3 w-3 animate-spin" />
																	: <RotateCcw className="h-3 w-3" />}
																Retry
															</Button>
														)}
														<Button
															variant="outline"
															size="xs"
															className="gap-1 text-lv-red border-lv-red/30 hover:bg-lv-red/10"
															disabled={actionLoading === job.job_id}
															onClick={(e) => { e.stopPropagation(); jobAction(job.job_id, 'delete'); }}
														>
															<Trash2 className="h-3 w-3" />
															Delete
														</Button>
													</div>
												</div>
													</TableCell>
												</TableRow>
											)}
										</Fragment>
									);
								})}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}

			{/* Empty state */}
			{displayed.length === 0 && !loading && !initialLoad && (
				<div className="flex flex-col items-center justify-center h-48">
					<p className={T.mutedSm}>
						{statusFilter !== 'all' ? `No ${statusFilter} jobs` : 'No container transform jobs found'}
					</p>
					<p className={cn(T.muted, 'mt-1')}>
						Jobs appear when a source exceeds the binding size limit ({'>'}100MB) or needs container-only params.
					</p>
				</div>
			)}
		</div>
	);
}
