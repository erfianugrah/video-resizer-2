import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Activity, CheckCircle2, XCircle, Zap, Clock, TrendingUp, Loader2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Skeleton } from './ui/skeleton';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './ui/table';
import { T } from '@/lib/typography';
import { cn, BASE, formatTime } from '@/lib/utils';

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

const HOURS_OPTIONS = [
	{ value: 1, label: '1h' },
	{ value: 6, label: '6h' },
	{ value: 12, label: '12h' },
	{ value: 24, label: '24h' },
	{ value: 48, label: '48h' },
	{ value: 168, label: '7d' },
];

// ── Stat Card ────────────────────────────────────────────────────────

function StatCard({
	label,
	value,
	icon: Icon,
	color,
	delay = 0,
}: {
	label: string;
	value: string | number;
	icon: React.ElementType;
	color: string;
	delay?: number;
}) {
	return (
		<Card className="animate-fade-in-up opacity-0" style={{ animationDelay: `${delay}ms` }}>
			<CardContent className="p-5">
				<div className="flex items-center justify-between mb-3">
					<span className={T.statLabelUpper}>{label}</span>
					<div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', color)}>
						<Icon className="h-4 w-4" />
					</div>
				</div>
				<div className={T.statValue}>{value}</div>
			</CardContent>
		</Card>
	);
}

// ── Breakdown Card ───────────────────────────────────────────────────

function BreakdownCard({ title, rows }: { title: string; rows: [string, number][] }) {
	if (!rows.length) return null;
	const max = Math.max(...rows.map(([, v]) => v));
	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className={T.cardTitle}>{title}</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="space-y-2">
					{rows.map(([label, count]) => (
						<div key={label} className="flex items-center gap-3">
							<span className="w-24 shrink-0 truncate font-data text-xs text-muted-foreground">{label}</span>
							<div className="flex-1 h-2 rounded-full overflow-hidden bg-muted">
								<div
									className="h-full rounded-full bg-lv-purple/70 transition-all duration-500"
									style={{ width: `${(count / max) * 100}%` }}
								/>
							</div>
							<span className="w-12 text-right font-data text-xs tabular-nums text-muted-foreground">{count}</span>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

// ── Loading Skeleton ─────────────────────────────────────────────────

function AnalyticsSkeleton() {
	return (
		<div className="space-y-6">
			<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
				{Array.from({ length: 4 }).map((_, i) => (
					<Card key={i}>
						<CardContent className="p-5 space-y-3">
							<div className="flex items-center justify-between">
								<Skeleton className="h-3 w-20" />
								<Skeleton className="h-8 w-8 rounded-lg" />
							</div>
							<Skeleton className="h-8 w-24" />
						</CardContent>
					</Card>
				))}
			</div>
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				{Array.from({ length: 4 }).map((_, i) => (
					<Card key={i}>
						<CardContent className="p-6 space-y-3">
							<Skeleton className="h-4 w-32" />
							<Skeleton className="h-2 w-full" />
							<Skeleton className="h-2 w-3/4" />
							<Skeleton className="h-2 w-1/2" />
						</CardContent>
					</Card>
				))}
			</div>
		</div>
	);
}

// ── Main Component ───────────────────────────────────────────────────

export default function AnalyticsTab({ token }: { token: string }) {
	const [hours, setHours] = useState(24);
	const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
	const [errors, setErrors] = useState<AnalyticsError[]>([]);
	const [loading, setLoading] = useState(false);
	const [initialLoad, setInitialLoad] = useState(true);
	const [error, setError] = useState('');
	const [showAdminErrors, setShowAdminErrors] = useState(false);

	const fetchData = useCallback(async () => {
		if (!token) { setError('Enter API token above'); setInitialLoad(false); return; }
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
			setInitialLoad(false);
		}
	}, [token, hours]);

	useEffect(() => { fetchData(); }, [fetchData]);

	const filteredErrors = showAdminErrors ? errors : errors.filter((e) => !ADMIN_PATH_RE.test(e.path));

	return (
		<div className="space-y-6">
			{/* Controls */}
			<div className="flex items-center gap-2 flex-wrap">
				<div className="inline-flex rounded-lg border border-border overflow-hidden">
					{HOURS_OPTIONS.map((opt) => (
						<button
							key={opt.value}
							onClick={() => setHours(opt.value)}
							className={cn(
								'px-3 py-1.5 text-xs font-medium transition-colors border-r border-border last:border-r-0',
								hours === opt.value
									? 'bg-lv-purple/20 text-lv-purple'
									: 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
							)}
						>
							{opt.label}
						</button>
					))}
				</div>
				<Button onClick={fetchData} disabled={loading} variant="outline" size="sm" className="gap-1.5">
					{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
					Refresh
				</Button>
				{error && (
					<div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-3 py-1.5 text-xs text-lv-red">
						{error}
					</div>
				)}
			</div>

			{/* Loading skeleton */}
			{initialLoad && !error && <AnalyticsSkeleton />}

			{/* Content */}
			{summary && (
				<>
					{/* Stat cards */}
					<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
						<StatCard label="Total Requests" value={summary.total.toLocaleString()} icon={Activity} color="bg-lv-blue/10 text-lv-blue" delay={0} />
						<StatCard label="Success" value={summary.success.toLocaleString()} icon={CheckCircle2} color="bg-lv-green/10 text-lv-green" delay={50} />
						<StatCard label="Errors" value={summary.errors.toLocaleString()} icon={XCircle} color="bg-lv-red/10 text-lv-red" delay={100} />
						<StatCard label="Cache Hit Rate" value={`${(summary.cacheHitRate * 100).toFixed(1)}%`} icon={Zap} color="bg-lv-purple/10 text-lv-purple" delay={150} />
					</div>

					{/* Latency cards */}
					<div className="grid grid-cols-3 gap-3">
						<StatCard label="Avg Latency" value={`${summary.avgLatencyMs ?? 0}ms`} icon={Clock} color="bg-lv-peach/10 text-lv-peach" delay={200} />
						<StatCard label="p50 Latency" value={`${summary.p50LatencyMs ?? 0}ms`} icon={TrendingUp} color="bg-lv-cyan/10 text-lv-cyan" delay={250} />
						<StatCard label="p95 Latency" value={`${summary.p95LatencyMs ?? 0}ms`} icon={TrendingUp} color="bg-lv-red/10 text-lv-red" delay={300} />
					</div>

					{/* Breakdown charts */}
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<BreakdownCard title="By Status" rows={summary.byStatus?.map((r) => [String(r.status), r.count]) ?? []} />
						<BreakdownCard title="By Origin" rows={summary.byOrigin?.map((r) => [r.origin ?? 'unknown', r.count]) ?? []} />
						<BreakdownCard title="By Derivative" rows={summary.byDerivative?.map((r) => [r.derivative ?? 'none', r.count]) ?? []} />
						<BreakdownCard title="By Transform Source" rows={summary.byTransformSource?.map((r) => [r.source ?? 'unknown', r.count]) ?? []} />
					</div>

					{/* Error table */}
					{errors.length > 0 && (
						<Card>
							<CardHeader className="pb-3">
								<div className="flex items-center justify-between">
									<CardTitle className={T.cardTitle}>Recent Errors</CardTitle>
									<label className="flex items-center gap-1.5 cursor-pointer">
										<input
											type="checkbox"
											checked={showAdminErrors}
											onChange={(e) => setShowAdminErrors(e.target.checked)}
											className="rounded border-border"
										/>
										<span className={T.muted}>Show admin/internal</span>
									</label>
								</div>
							</CardHeader>
							<CardContent>
								{filteredErrors.length === 0 ? (
									<p className={T.muted}>No transform errors (only admin/internal errors hidden)</p>
								) : (
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead className={T.tableCell}>Time</TableHead>
												<TableHead className={T.tableCell}>Path</TableHead>
												<TableHead className={T.tableCell}>Status</TableHead>
												<TableHead className={T.tableCell}>Code</TableHead>
												<TableHead className={cn(T.tableCell, 'text-right')}>Latency</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{filteredErrors.map((e, i) => (
												<TableRow key={i}>
													<TableCell className={T.tableCellMono}>{formatTime(e.ts)}</TableCell>
													<TableCell className={cn(T.tableCellMono, 'truncate max-w-[200px]')}>{e.path}</TableCell>
													<TableCell>
														<Badge className="bg-lv-red/20 text-lv-red border-lv-red/30">{e.status}</Badge>
													</TableCell>
													<TableCell className={T.tableCellMono}>{e.errorCode ?? '\u2014'}</TableCell>
													<TableCell className={T.tableCellNumeric}>{e.durationMs ?? '\u2014'}ms</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								)}
							</CardContent>
						</Card>
					)}
				</>
			)}
		</div>
	);
}
