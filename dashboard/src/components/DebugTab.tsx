import { useState } from 'react';
import { Play, Loader2, Globe, Clock, HardDrive, FileType, Shield } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ErrorBanner } from './ui/error-banner';
import { T } from '@/lib/typography';
import { cn, BASE, formatBytes } from '@/lib/utils';

/** Shape of the diagnostics response from the debug endpoint. */
interface DiagnosticsResult {
	diagnostics: {
		requestId: string;
		path: string;
		params: Record<string, string | number | boolean>;
		origin: { name: string; sources: { type: string; priority: number }[]; ttl: Record<string, number> };
		captures: Record<string, string>;
		config: { derivatives: string[]; responsive: unknown; passthrough: unknown; containerEnabled: boolean };
		needsContainer: boolean;
		resolvedWidth: number | null;
		resolvedHeight: number | null;
	};
}

// ── Response Summary Card ────────────────────────────────────────────

/** Compact summary of the HTTP response from a debug test. */
function ResponseSummary({
	status,
	size,
	time,
	type,
	cache,
}: {
	status: number;
	size: number;
	time: number;
	type: string;
	cache: string;
}) {
	const statusOk = status < 400;
	const items = [
		{ icon: Globe, label: 'Status', value: String(status), color: statusOk ? 'text-lv-green' : 'text-lv-red' },
		{ icon: HardDrive, label: 'Size', value: formatBytes(size), color: 'text-foreground' },
		{ icon: Clock, label: 'Time', value: `${time}ms`, color: 'text-foreground' },
		{ icon: FileType, label: 'Type', value: type, color: 'text-foreground' },
		{ icon: Shield, label: 'Cache', value: cache, color: cache === 'HIT' ? 'text-lv-green' : 'text-muted-foreground' },
	];

	return (
		<Card className="animate-fade-in-up opacity-0 md:col-span-2">
			<CardContent className="p-4">
				<div className="grid grid-cols-2 sm:grid-cols-3 md:flex md:flex-wrap gap-4 md:gap-6">
					{items.map(({ icon: Icon, label, value, color }) => (
						<div key={label} className="flex items-center gap-2">
							<Icon className="h-3.5 w-3.5 text-muted-foreground" />
							<span className={T.muted}>{label}</span>
							<span className={cn('text-sm font-semibold font-data', color)}>{value}</span>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

// ── Key-Value List ───────────────────────────────────────────────────

/** Definition list for key-value display (params, origin info, etc). */
function KVList({ items }: { items: { key: string; value: React.ReactNode; color?: string }[] }) {
	return (
		<dl className="space-y-1.5">
			{items.map(({ key, value, color }) => (
				<div key={key} className="flex justify-between gap-4">
					<dt className={T.muted}>{key}</dt>
					<dd className={cn('text-xs font-data text-right truncate max-w-[250px]', color)}>{value}</dd>
				</div>
			))}
		</dl>
	);
}

/** Normalize a URL path, ensuring it starts with '/'. */
function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return '/';
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

// ── Main Component ───────────────────────────────────────────────────

/** Debug tab for testing transform URLs and inspecting diagnostics. */
export function DebugTab() {
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
			const normalizedUrl = normalizePath(url);
			const sep = normalizedUrl.includes('?') ? '&' : '?';
			const diagUrl = `${BASE}${normalizedUrl}${sep}debug=view`;
			const diagRes = await fetch(diagUrl);
			if (diagRes.ok) {
				const data = await diagRes.json() as DiagnosticsResult;
				setDiagnostics(data.diagnostics);
			}

			const t0 = performance.now();
			const transformUrl = `${BASE}${normalizedUrl}${sep}debug`;
			const res = await fetch(transformUrl);
			setResponseTime(Math.round(performance.now() - t0));
			setResponseStatus(res.status);
			setResponseSize(parseInt(res.headers.get('content-length') ?? '0', 10));

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
		<div className="space-y-4">
			{/* URL Input */}
			<div className="flex gap-2">
				<div className="relative flex-1">
					<Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
					<Input
						type="text"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						onKeyDown={(e) => e.key === 'Enter' && testUrl()}
						placeholder="/path.mp4?params"
						className="pl-8 font-data text-xs"
						aria-label="URL to debug"
					/>
				</div>
				<Button onClick={testUrl} disabled={loading} className="gap-1.5">
					{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
					Test
				</Button>
			</div>

			{/* Error */}
			{error && <ErrorBanner>{error}</ErrorBanner>}

			{/* Results */}
			{(diagnostics || headers.length > 0) && (
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					{responseStatus > 0 && (
						<ResponseSummary
							status={responseStatus}
							size={responseSize}
							time={responseTime}
							type={headers.find(([k]) => k === 'content-type')?.[1] ?? 'unknown'}
							cache={headers.find(([k]) => k === 'cf-cache-status')?.[1] ?? 'n/a'}
						/>
					)}

					{diagnostics && (
						<Card className="animate-fade-in-up opacity-0" style={{ animationDelay: '50ms' }}>
							<CardHeader className="pb-3">
								<CardTitle className={T.cardTitle}>Param Resolution</CardTitle>
							</CardHeader>
							<CardContent className="space-y-5">
								<KVList
									items={Object.entries(diagnostics.params)
										.filter(([, v]) => v !== undefined && v !== null)
										.map(([k, v]) => ({ key: k, value: String(v) }))}
								/>

								<div>
									<h4 className={cn(T.sectionLabel, 'mb-2')}>Origin</h4>
									<KVList items={[
										{ key: 'name', value: diagnostics.origin.name },
										{ key: 'sources', value: diagnostics.origin.sources.map((s) => `${s.type}(p${s.priority})`).join(', ') },
										{
											key: 'needsContainer',
											value: String(diagnostics.needsContainer),
											color: diagnostics.needsContainer ? 'text-lv-peach' : 'text-lv-green',
										},
									]} />
								</div>

								{diagnostics.captures && Object.keys(diagnostics.captures).length > 0 && (
									<div>
										<h4 className={cn(T.sectionLabel, 'mb-2')}>Captures</h4>
										<KVList
											items={Object.entries(diagnostics.captures).map(([k, v]) => ({ key: k, value: v }))}
										/>
									</div>
								)}

								<div>
									<h4 className={cn(T.sectionLabel, 'mb-2')}>Config</h4>
									<KVList items={[
										{ key: 'derivatives', value: diagnostics.config.derivatives.join(', ') },
										{
											key: 'container',
											value: String(diagnostics.config.containerEnabled),
											color: diagnostics.config.containerEnabled ? 'text-lv-green' : 'text-muted-foreground',
										},
									]} />
								</div>
							</CardContent>
						</Card>
					)}

					{headers.length > 0 && (
						<Card className="animate-fade-in-up opacity-0" style={{ animationDelay: '100ms' }}>
							<CardHeader className="pb-3">
								<CardTitle className={T.cardTitle}>Response Headers</CardTitle>
							</CardHeader>
							<CardContent>
								<dl className="space-y-0.5 font-data text-xs">
									{headers.map(([k, v]) => (
										<div key={k} className="flex gap-2">
											<dt className={cn('shrink-0', k.startsWith('x-') ? 'text-lv-cyan' : 'text-muted-foreground')}>
												{k}:
											</dt>
											<dd className="truncate text-foreground/80">{v}</dd>
										</div>
									))}
								</dl>
							</CardContent>
						</Card>
					)}
				</div>
			)}
		</div>
	);
}
