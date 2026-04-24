import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import { RefreshCw, ChevronRight, Loader2, Search, AlertTriangle, RotateCcw, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './ui/table';
import { SegmentedGroup } from './ui/segmented-group';
import { ErrorBanner } from './ui/error-banner';
import { T } from '@/lib/typography';
import { cn, BASE, HOURS_OPTIONS, statusColor, formatBytes, formatDuration, formatTime } from '@/lib/utils';

/** A single job row as returned by the admin API. */
interface JobRow {
	job_id: string;
	path: string;
	origin: string | null;
	status: string;
	params: Record<string, string | number | boolean> | null;
	source_type: string | null;
	created_at: number;
	started_at: number | null;
	completed_at: number | null;
	error: string | null;
	output_size: number | null;
	percent: number | null;
}

const ACTIVE_STATUSES = new Set(['pending', 'downloading', 'transcoding', 'uploading']);
const ALL_STATUSES = [
	{ value: 'all' as const, label: 'All' },
	{ value: 'active' as const, label: 'Active' },
	{ value: 'complete' as const, label: 'Complete' },
	{ value: 'failed' as const, label: 'Failed' },
];
type StatusFilter = 'all' | 'active' | 'complete' | 'failed';

const STALE_MS = 25 * 60_000;

/** Check whether an active job has gone stale (no progress for >25 min). */
function isStale(job: JobRow): boolean {
	if (!ACTIVE_STATUSES.has(job.status)) return false;
	const lastActivity = job.started_at ?? job.created_at;
	return Date.now() - lastActivity > STALE_MS;
}

const POLL_OPTIONS = [
	{ value: 5, label: '5s' },
	{ value: 10, label: '10s' },
	{ value: 30, label: '30s' },
	{ value: 60, label: '60s' },
] as const;

// ── Loading Skeleton ─────────────────────────────────────────────────

/** Placeholder skeleton for the jobs table during initial load. */
function JobsSkeleton() {
	return (
		<Card>
			<CardContent className="p-6 space-y-3" aria-busy="true" aria-label="Loading jobs">
				{Array.from({ length: 5 }).map((_, i) => (
					<Skeleton key={i} className="h-10 w-full" />
				))}
			</CardContent>
		</Card>
	);
}

// ── Status Badge ─────────────────────────────────────────────────────

/** Coloured badge showing a job's current status (or "stale" override). */
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

/** Small badge displaying a single key=value parameter. */
function ParamBadge({ k, v }: { k: string; v: string }) {
	return (
		<Badge className="bg-muted text-muted-foreground border-border">
			{k}={v}
		</Badge>
	);
}

// ── Job Card (active jobs) ───────────────────────────────────────────

/** Card for an active/in-progress job with progress bar and action buttons. */
function JobCard({ job, stale, onRetry, onDelete, actionLoading }: {
	job: JobRow;
	stale: boolean;
	onRetry: (id: string) => void;
	onDelete: (id: string) => void;
	actionLoading: string | null;
}) {
	const color = stale ? '#eab308' : statusColor(job.status);
	const percent = job.percent ?? 0;
	const elapsed = Math.max(0, job.started_at
		? ((job.completed_at ?? Date.now()) - job.started_at) / 1000
		: (Date.now() - job.created_at) / 1000);

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
					<div
						className="h-1.5 rounded-full overflow-hidden bg-muted mb-2"
						role="progressbar"
						aria-valuenow={percent}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-label={`Job progress: ${percent}%`}
					>
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

/** Jobs dashboard tab showing active and recent container transform jobs. */
export function JobsTab() {
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
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	const sseRefs = useRef<Map<string, EventSource>>(new Map());
	/** Incremented to trigger an immediate refetch (SSE terminal/error). */
	const [refetchTick, setRefetchTick] = useState(0);

	/** Retry or delete a job via the admin API. */
	const jobAction = useCallback(async (jobId: string, action: 'retry' | 'delete') => {
		setActionLoading(jobId);
		try {
			const body = action === 'delete'
				? { jobId, delete: true }
				: { jobId };
			const resp = await fetch(`${BASE}/admin/jobs/retry`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(body),
			});
			if (!resp.ok) {
				const data = await resp.json().catch(() => ({})) as { error?: { message?: string } };
				setError(data.error?.message ?? `HTTP ${resp.status}`);
				return;
			}
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
	}, []);

	/** Reset all stale jobs. */
	const clearStale = useCallback(async () => {
		setActionLoading('bulk-stale');
		try {
			const resp = await fetch(`${BASE}/admin/jobs/retry`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ staleMinutes: Math.round(STALE_MS / 60_000) }),
			});
			if (!resp.ok) {
				const data = await resp.json().catch(() => ({})) as { error?: { message?: string } };
				setError(data.error?.message ?? `HTTP ${resp.status}`);
				return;
			}
			// Consume response body (resetCount) but we only need the side-effect
			await resp.json();
			setJobs((prev) => prev.map((j) =>
				isStale(j) ? { ...j, status: 'pending', percent: 0, error: null } : j,
			));
			setError('');
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Action failed');
		} finally {
			setActionLoading(null);
		}
	}, []);

	// Debounce filter input (300ms)
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedFilter(filter), 300);
		return () => clearTimeout(timer);
	}, [filter]);

	const fetchJobs = useCallback(async () => {
		setLoading(true);
		setError('');
		try {
			const params = new URLSearchParams({ hours: String(hours), limit: '100' });
			if (debouncedFilter) params.set('filter', debouncedFilter);
			const resp = await fetch(`${BASE}/admin/jobs?${params}`, {
				credentials: 'same-origin',
			});
			if (resp.status === 401) {
				window.location.href = '/admin/dashboard'; // session expired — redirect to login
				return;
			}
			if (!resp.ok) { setError(`HTTP ${resp.status}`); return; }
			const data = await resp.json() as { jobs: JobRow[] };
			setJobs(data.jobs ?? []);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Fetch failed');
		} finally {
			setLoading(false);
			setInitialLoad(false);
		}
	}, [hours, debouncedFilter]);

	// Polling with visibility-aware pause
	useEffect(() => {
		fetchJobs();
		let interval = setInterval(fetchJobs, pollInterval * 1000);

		const onVisibilityChange = () => {
			clearInterval(interval);
			if (document.visibilityState === 'visible') {
				fetchJobs();
				interval = setInterval(fetchJobs, pollInterval * 1000);
			}
		};
		document.addEventListener('visibilitychange', onVisibilityChange);

		return () => {
			clearInterval(interval);
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	}, [fetchJobs, pollInterval]);

	// Refetch when SSE signals a terminal state or connection error
	useEffect(() => {
		if (refetchTick > 0) fetchJobs();
	}, [refetchTick, fetchJobs]);

	// SSE: connect for active jobs — use a stable dependency based on active job IDs + statuses
	const sseKey = useMemo(
		() => jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).map((j) => `${j.job_id}:${j.status}`).join(','),
		[jobs],
	);

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
						// Refetch to get full metadata (output_size, completed_at)
						setRefetchTick((t) => t + 1);
					}
				} catch { /* ignore parse errors */ }
			};
			es.onerror = () => {
				es.close();
				sseRefs.current.delete(job.job_id);
				// Connection lost — refetch to recover current state
				setRefetchTick((t) => t + 1);
			};
			sseRefs.current.set(job.job_id, es);
		}

		return () => {
			for (const es of sseRefs.current.values()) es.close();
			sseRefs.current.clear();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- sseKey is the stable serialization of active jobs
	}, [sseKey]);

	// Client-side filtering
	const displayed = jobs.filter((j) => {
		if (statusFilter === 'active') return ACTIVE_STATUSES.has(j.status);
		if (statusFilter === 'complete') return j.status === 'complete';
		if (statusFilter === 'failed') return j.status === 'failed';
		return true;
	});

	const activeJobs = displayed.filter((j) => ACTIVE_STATUSES.has(j.status));
	const recentJobs = displayed.filter((j) => !ACTIVE_STATUSES.has(j.status));

	const counts = useMemo(() => ({
		all: jobs.length,
		active: jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length,
		complete: jobs.filter((j) => j.status === 'complete').length,
		failed: jobs.filter((j) => j.status === 'failed').length,
	}), [jobs]);

	// Build status options with counts for display
	const statusOptions = useMemo(
		() => ALL_STATUSES.map((s) => ({ value: s.value, label: `${s.label} (${counts[s.value]})` })),
		[counts],
	);

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
				<SegmentedGroup
					label="Time range"
					options={HOURS_OPTIONS}
					value={hours}
					onChange={setHours}
				/>
				<SegmentedGroup
					label="Poll interval"
					options={POLL_OPTIONS}
					value={pollInterval}
					onChange={setPollInterval}
					activeClass="bg-lv-blue/20 text-lv-blue"
				/>
				<Button onClick={fetchJobs} disabled={loading} variant="outline" size="sm" className="gap-1.5">
					{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
					Refresh
				</Button>
			</div>

			{/* Status filter */}
			<SegmentedGroup
				label="Status filter"
				options={statusOptions}
				value={statusFilter}
				onChange={setStatusFilter}
			/>

			{/* Error */}
			{error && <ErrorBanner>{error}</ErrorBanner>}

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
								onDelete={(id) => { if (window.confirm(`Delete job ${id}?`)) jobAction(id, 'delete'); }}
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
												tabIndex={0}
												role="button"
												aria-expanded={expanded}
												aria-label={`${job.status} job: ${job.path}`}
												onClick={() => setExpandedId(expanded ? null : job.job_id)}
												onKeyDown={(e) => {
													if (e.key === 'Enter' || e.key === ' ') {
														e.preventDefault();
														setExpandedId(expanded ? null : job.job_id);
													}
												}}
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
																{confirmDeleteId === job.job_id ? (
																	<>
																		<Button
																			variant="outline"
																			size="xs"
																			className="gap-1 text-lv-red border-lv-red/30 hover:bg-lv-red/10"
																			onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); jobAction(job.job_id, 'delete'); }}
																		>
																			Confirm
																		</Button>
																		<Button
																			variant="outline"
																			size="xs"
																			className="gap-1"
																			onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
																		>
																			Cancel
																		</Button>
																	</>
																) : (
																	<Button
																		variant="outline"
																		size="xs"
																		className="gap-1 text-lv-red border-lv-red/30 hover:bg-lv-red/10"
																		disabled={actionLoading === job.job_id}
																		onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(job.job_id); }}
																	>
																		<Trash2 className="h-3 w-3" />
																		Delete
																	</Button>
																)}
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
