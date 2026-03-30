/**
 * Debug Workbench — interactive testing workbench for video transforms.
 *
 * Replaces the minimal DebugTab with a full-featured form builder,
 * inline media preview, enhanced response inspector, comparison mode,
 * SSE container job tracking, and Akamai compatibility tester.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
	Play, Loader2, Globe, Clock, HardDrive, FileType, Shield,
	Copy, Check, Columns2, X, RefreshCw, ChevronDown,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ErrorBanner } from './ui/error-banner';
import { Badge } from './ui/badge';
import { SegmentedGroup } from './ui/segmented-group';
import { T } from '@/lib/typography';
import { cn, BASE, formatBytes } from '@/lib/utils';
import { ParamForm } from './debug/ParamForm';
import { MediaPreview } from './debug/MediaPreview';
import { JsonTree } from './debug/JsonTree';
import {
	type ParamValues,
	type DiagnosticsResult,
	type DiagnosticsData,
	type TestResult,
	type SseProgress,
	type WorkbenchConfig,
	EMPTY_PARAMS,
	EMPTY_RESULT,
	buildUrl,
	buildAkamaiUrl,
} from './debug/types';

// ── Response Summary ─────────────────────────────────────────────────

/** Compact summary of the HTTP response. */
function ResponseSummary({ status, size, time, type, cache }: {
	status: number; size: number; time: number; type: string; cache: string;
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
		<Card className="animate-fade-in-up opacity-0">
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

/** Definition list for key-value display. */
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

// ── Headers panel with debug highlight + collapsible ─────────────────

/** Response headers with x-* headers highlighted in cyan. */
function HeadersPanel({ headers, compareHeaders }: { headers: [string, string][]; compareHeaders?: [string, string][] }) {
	const [showAll, setShowAll] = useState(false);

	const debugHeaders = headers.filter(([k]) => k.startsWith('x-') || k.startsWith('cf-'));
	const otherHeaders = headers.filter(([k]) => !k.startsWith('x-') && !k.startsWith('cf-'));

	// Build comparison map for diffing
	const compareMap = useMemo(() => {
		if (!compareHeaders) return null;
		const map = new Map<string, string>();
		for (const [k, v] of compareHeaders) map.set(k, v);
		return map;
	}, [compareHeaders]);

	const isDifferent = (key: string, value: string) => {
		if (!compareMap) return false;
		const other = compareMap.get(key);
		return other !== undefined && other !== value;
	};

	return (
		<div className="space-y-2">
			<dl className="space-y-0.5 font-data text-xs">
				{debugHeaders.map(([k, v]) => (
					<div key={k} className={cn('flex gap-2', isDifferent(k, v) && 'bg-yellow-500/10 rounded px-1 -mx-1')}>
						<dt className="shrink-0 text-lv-cyan">{k}:</dt>
						<dd className="truncate text-foreground/80">{v}</dd>
					</div>
				))}
			</dl>
			{otherHeaders.length > 0 && (
				<>
					<button
						type="button"
						onClick={() => setShowAll(!showAll)}
						className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
					>
						<ChevronDown className={cn('h-3 w-3 transition-transform', showAll && 'rotate-180')} />
						{showAll ? 'Hide' : 'Show'} {otherHeaders.length} more headers
					</button>
					{showAll && (
						<dl className="space-y-0.5 font-data text-xs">
							{otherHeaders.map(([k, v]) => (
								<div key={k} className={cn('flex gap-2', isDifferent(k, v) && 'bg-yellow-500/10 rounded px-1 -mx-1')}>
									<dt className="shrink-0 text-muted-foreground">{k}:</dt>
									<dd className="truncate text-foreground/80">{v}</dd>
								</div>
							))}
						</dl>
					)}
				</>
			)}
		</div>
	);
}

// ── Akamai URL display ───────────────────────────────────────────────

/** Shows canonical vs Akamai URL side by side. */
function AkamaiTester({ path, params, skipCache }: { path: string; params: ParamValues; skipCache: boolean }) {
	const canonical = buildUrl(path, params, skipCache);
	const akamai = buildAkamaiUrl(path, params, skipCache);
	const [copied, setCopied] = useState<'canonical' | 'akamai' | null>(null);

	const copy = (text: string, which: 'canonical' | 'akamai') => {
		navigator.clipboard.writeText(text);
		setCopied(which);
		setTimeout(() => setCopied(null), 1500);
	};

	return (
		<Card className="animate-fade-in-up opacity-0">
			<CardHeader className="pb-3">
				<CardTitle className={T.cardTitle}>Akamai Compatibility</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="space-y-1">
					<div className="flex items-center justify-between">
						<span className={T.sectionLabel}>Canonical</span>
						<button type="button" onClick={() => copy(canonical, 'canonical')} className="text-muted-foreground hover:text-foreground">
							{copied === 'canonical' ? <Check className="h-3 w-3 text-lv-green" /> : <Copy className="h-3 w-3" />}
						</button>
					</div>
					<code className="block text-xs font-data bg-muted/50 rounded p-2 break-all">{canonical}</code>
				</div>
				<div className="space-y-1">
					<div className="flex items-center justify-between">
						<span className={T.sectionLabel}>Akamai / IMQuery</span>
						<button type="button" onClick={() => copy(akamai, 'akamai')} className="text-muted-foreground hover:text-foreground">
							{copied === 'akamai' ? <Check className="h-3 w-3 text-lv-green" /> : <Copy className="h-3 w-3" />}
						</button>
					</div>
					<code className="block text-xs font-data bg-muted/50 rounded p-2 break-all">{akamai}</code>
				</div>
			</CardContent>
		</Card>
	);
}

// ── Single test panel (used once or twice in comparison mode) ────────

/** Hook to run a test against a URL and manage SSE for container jobs. */
function useTestPanel() {
	const [result, setResult] = useState<TestResult>(EMPTY_RESULT);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [sseProgress, setSseProgress] = useState<SseProgress | null>(null);
	const sseRef = useRef<EventSource | null>(null);
	const prevBlobRef = useRef<string | null>(null);

	/** Clean up previous blob URL. */
	const revokePrevBlob = useCallback(() => {
		if (prevBlobRef.current) {
			URL.revokeObjectURL(prevBlobRef.current);
			prevBlobRef.current = null;
		}
	}, []);

	/** Close SSE connection. */
	const closeSse = useCallback(() => {
		if (sseRef.current) {
			sseRef.current.close();
			sseRef.current = null;
		}
	}, []);

	/** Clean up on unmount. */
	useEffect(() => {
		return () => {
			revokePrevBlob();
			closeSse();
		};
	}, [revokePrevBlob, closeSse]);

	/** Run the test against a URL. skipCache adds ?debug to skip edge/R2 cache. */
	const runTest = useCallback(async (url: string, skipCache = true) => {
		setLoading(true);
		setError('');
		setSseProgress(null);
		closeSse();
		revokePrevBlob();
		setResult(EMPTY_RESULT);

		try {
			const sep = url.includes('?') ? '&' : '?';

			// Fetch diagnostics (debug=view always — lightweight JSON, no transform)
			const diagUrl = `${BASE}${url}${sep}debug=view`;
			const diagRes = await fetch(diagUrl, { credentials: 'same-origin' });
			let diagnostics: DiagnosticsData | null = null;
			if (diagRes.ok) {
				const data = await diagRes.json() as DiagnosticsResult;
				diagnostics = data.diagnostics;
			}

			// Fetch the actual transform (debug skips cache; omit for cached response)
			const t0 = performance.now();
			const transformUrl = skipCache ? `${BASE}${url}${sep}debug` : `${BASE}${url}`;
			const res = await fetch(transformUrl, { credentials: 'same-origin' });
			const responseTime = Math.round(performance.now() - t0);
			const responseStatus = res.status;
			const contentType = res.headers.get('content-type') ?? '';
			const responseSize = parseInt(res.headers.get('content-length') ?? '0', 10);

			const hdrs: [string, string][] = [];
			res.headers.forEach((v, k) => hdrs.push([k, v]));
			hdrs.sort((a, b) => a[0].localeCompare(b[0]));

			// Create blob URL for preview if response has media content
			let previewUrl: string | null = null;
			if (responseStatus === 200 && (contentType.startsWith('video/') || contentType.startsWith('image/') || contentType.startsWith('audio/'))) {
				const blob = await res.blob();
				previewUrl = URL.createObjectURL(blob);
				prevBlobRef.current = previewUrl;
			}

			setResult({ diagnostics, headers: hdrs, responseTime, responseSize, responseStatus, contentType, previewUrl });

			// 202 means container job — connect SSE
			if (responseStatus === 202) {
				const jobId = res.headers.get('x-job-id');
				if (jobId) {
					setSseProgress({ status: 'pending', percent: 0, jobId });
					const es = new EventSource(`${BASE}/sse/job/${jobId}`);
					sseRef.current = es;
					es.onmessage = (event) => {
						try {
							const data = JSON.parse(event.data) as { status: string; percent?: number };
							setSseProgress({ status: data.status, percent: data.percent ?? 0, jobId });
							// Auto-close on terminal states
							if (data.status === 'complete' || data.status === 'failed' || data.status === 'not_found') {
								es.close();
								sseRef.current = null;
								// Auto-fetch result on completion
								if (data.status === 'complete') {
									fetch(`${BASE}${url}`, { credentials: 'same-origin' })
										.then(async (finalRes) => {
											const ct = finalRes.headers.get('content-type') ?? '';
											if (ct.startsWith('video/') || ct.startsWith('image/') || ct.startsWith('audio/')) {
												revokePrevBlob();
												const blob = await finalRes.blob();
												const blobUrl = URL.createObjectURL(blob);
												prevBlobRef.current = blobUrl;
												setResult((prev) => ({ ...prev, previewUrl: blobUrl, contentType: ct, responseStatus: finalRes.status }));
											}
										})
										.catch(() => { /* ignore auto-fetch failure */ });
								}
							}
						} catch { /* ignore parse errors */ }
					};
					es.onerror = () => {
						es.close();
						sseRef.current = null;
					};
				}
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Fetch failed');
		} finally {
			setLoading(false);
		}
	}, [closeSse, revokePrevBlob]);

	return { result, loading, error, sseProgress, runTest };
}

// ── Copyable URL display ─────────────────────────────────────────────

/** Read-only URL bar with copy button. */
function UrlBar({ url }: { url: string }) {
	const [copied, setCopied] = useState(false);

	const copy = () => {
		navigator.clipboard.writeText(url);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<div className="flex items-center gap-2 bg-muted/30 rounded-md px-3 py-1.5 border border-border">
			<Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
			<code className="text-xs font-data flex-1 truncate">{url}</code>
			<button type="button" onClick={copy} className="text-muted-foreground hover:text-foreground shrink-0">
				{copied ? <Check className="h-3.5 w-3.5 text-lv-green" /> : <Copy className="h-3.5 w-3.5" />}
			</button>
		</div>
	);
}

// ── Results panel (reusable for each comparison column) ──────────────

/** Render results for one test panel. */
function ResultsPanel({ result, loading, error, sseProgress, compareHeaders }: {
	result: TestResult;
	loading: boolean;
	error: string;
	sseProgress: SseProgress | null;
	compareHeaders?: [string, string][];
}) {
	const { diagnostics, headers, responseTime, responseSize, responseStatus, contentType, previewUrl } = result;
	const hasResults = diagnostics || headers.length > 0 || previewUrl || sseProgress;

	return (
		<div className="space-y-4">
			{error && <ErrorBanner>{error}</ErrorBanner>}

			{/* Media Preview */}
			<Card>
				<CardContent className="p-4">
					<MediaPreview
						previewUrl={previewUrl}
						contentType={contentType}
						loading={loading}
						sseProgress={sseProgress}
						status={responseStatus}
					/>
				</CardContent>
			</Card>

			{hasResults && (
				<>
					{/* Response Summary */}
					{responseStatus > 0 && (
						<ResponseSummary
							status={responseStatus}
							size={responseSize}
							time={responseTime}
							type={contentType || 'unknown'}
							cache={headers.find(([k]) => k === 'cf-cache-status')?.[1] ?? 'n/a'}
						/>
					)}

					{/* Debug Headers */}
					{headers.length > 0 && (
						<Card className="animate-fade-in-up opacity-0" style={{ animationDelay: '50ms' }}>
							<CardHeader className="pb-3">
								<CardTitle className={T.cardTitle}>Response Headers</CardTitle>
							</CardHeader>
							<CardContent>
								<HeadersPanel headers={headers} compareHeaders={compareHeaders} />
							</CardContent>
						</Card>
					)}

					{/* Diagnostics JSON Tree */}
					{diagnostics && (
						<Card className="animate-fade-in-up opacity-0" style={{ animationDelay: '100ms' }}>
							<CardHeader className="pb-3">
								<CardTitle className={T.cardTitle}>Diagnostics</CardTitle>
							</CardHeader>
							<CardContent>
								<JsonTree data={diagnostics} />
							</CardContent>
						</Card>
					)}
				</>
			)}
		</div>
	);
}

// ── Main Component ───────────────────────────────────────────────────

/** Debug Workbench — full interactive testing workbench. */
export function DebugTab() {
	// Path input (just the file path, no query params)
	const [path, setPath] = useState('/rocky.mp4');
	// Form params for the primary panel
	const [params, setParams] = useState<ParamValues>({ ...EMPTY_PARAMS, derivative: 'tablet' });
	// Skip cache checkbox
	const [skipCache, setSkipCache] = useState(true);
	// Comparison mode
	const [comparing, setComparing] = useState(false);
	// Comparison panel params
	const [compareParams, setCompareParams] = useState<ParamValues>({ ...EMPTY_PARAMS, derivative: 'mobile' });
	// Show Akamai tester
	const [showAkamai, setShowAkamai] = useState(false);
	// Config from /admin/config
	const [config, setConfig] = useState<WorkbenchConfig | null>(null);

	// Test panel hooks
	const primary = useTestPanel();
	const secondary = useTestPanel();

	// Fetch config on mount
	useEffect(() => {
		fetch(`${BASE}/admin/config`, { credentials: 'same-origin' })
			.then(async (res) => {
				if (res.status === 401) {
					window.location.href = '/admin/dashboard';
					return;
				}
				if (res.ok) {
					const data = await res.json();
					const derivatives = data?.config?.derivatives
						? Object.keys(data.config.derivatives)
						: [];
					const containerEnabled = data?.config?.container?.enabled ?? false;
					setConfig({ derivatives, containerEnabled });
				}
			})
			.catch(() => { /* config fetch is best-effort */ });
	}, []);

	// Build URLs
	const primaryUrl = useMemo(() => buildUrl(path, params, skipCache), [path, params, skipCache]);
	const compareUrl = useMemo(() => buildUrl(path, compareParams, skipCache), [path, compareParams, skipCache]);

	// Sync URL hash for shareability
	useEffect(() => {
		const hash = `debug${primaryUrl}`;
		if (window.location.hash !== `#${hash}`) {
			window.history.replaceState(null, '', `#${hash}`);
		}
	}, [primaryUrl]);

	// Parse URL hash on mount to restore state
	useEffect(() => {
		const hash = window.location.hash;
		if (hash.startsWith('#debug/')) {
			const urlPart = hash.slice(6); // remove '#debug'
			const qIdx = urlPart.indexOf('?');
			if (qIdx >= 0) {
				setPath(urlPart.slice(0, qIdx));
				const qs = new URLSearchParams(urlPart.slice(qIdx + 1));
				const restored = { ...EMPTY_PARAMS };
				for (const [k, v] of qs) {
					if (k in restored && k !== 'debug') {
						(restored as Record<string, string>)[k] = v;
					}
				}
				setParams(restored);
			} else {
				setPath(urlPart);
			}
		}
	}, []);

	const runPrimary = () => primary.runTest(primaryUrl, skipCache);
	const runSecondary = () => secondary.runTest(compareUrl, skipCache);
	const runBoth = () => { runPrimary(); if (comparing) runSecondary(); };

	return (
		<div className="space-y-4">
			{/* Path Input + Actions */}
			<div className="flex flex-wrap gap-2">
				<div className="relative flex-1 min-w-[200px]">
					<Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
					<Input
						type="text"
						value={path}
						onChange={(e) => setPath(e.target.value)}
						onKeyDown={(e) => e.key === 'Enter' && runBoth()}
						placeholder="/path/to/video.mp4"
						className="pl-8 font-data text-xs"
						aria-label="Video path"
					/>
				</div>
				<Button onClick={runBoth} disabled={primary.loading} className="gap-1.5">
					{primary.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
					Test
				</Button>
				<Button
					variant={comparing ? 'secondary' : 'outline'}
					onClick={() => setComparing(!comparing)}
					className="gap-1.5"
					size="sm"
				>
					{comparing ? <X className="h-3.5 w-3.5" /> : <Columns2 className="h-3.5 w-3.5" />}
					{comparing ? 'Close' : 'Compare'}
				</Button>
			</div>

			{/* Generated URL (read-only) */}
			<UrlBar url={primaryUrl} />

			{/* Options row */}
			<div className="flex flex-wrap items-center gap-3">
				<label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
					<input
						type="checkbox"
						checked={skipCache}
						onChange={(e) => setSkipCache(e.target.checked)}
						className="rounded border-border"
					/>
					Skip cache (debug)
				</label>
				<button
					type="button"
					onClick={() => setShowAkamai(!showAkamai)}
					className={cn('text-xs', showAkamai ? 'text-lv-purple' : 'text-muted-foreground hover:text-foreground')}
				>
					{showAkamai ? 'Hide' : 'Show'} Akamai URLs
				</button>
				{config && (
					<Badge variant="outline" className="text-xs">
						{config.containerEnabled ? 'Container enabled' : 'Container disabled'}
					</Badge>
				)}
			</div>

			{/* Akamai tester */}
			{showAkamai && <AkamaiTester path={path} params={params} skipCache={skipCache} />}

			{/* Main layout: form + results (+ optional comparison) */}
			<div className={cn('grid gap-4', comparing ? 'grid-cols-1 xl:grid-cols-[280px_1fr_1fr]' : 'grid-cols-1 md:grid-cols-[280px_1fr]')}>
				{/* Param Form(s) */}
				<div className="space-y-4">
					<Card>
						<CardHeader className="pb-3">
							<CardTitle className={T.cardTitle}>
								{comparing ? 'Panel A' : 'Transform Params'}
							</CardTitle>
						</CardHeader>
						<CardContent>
							<ParamForm params={params} onChange={setParams} config={config} />
						</CardContent>
					</Card>

					{comparing && (
						<Card>
							<CardHeader className="pb-3">
								<div className="flex items-center justify-between">
									<CardTitle className={T.cardTitle}>Panel B</CardTitle>
									<Button size="xs" variant="ghost" onClick={runSecondary} disabled={secondary.loading} className="gap-1">
										{secondary.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
										Test B
									</Button>
								</div>
							</CardHeader>
							<CardContent>
								<ParamForm params={compareParams} onChange={setCompareParams} config={config} />
							</CardContent>
						</Card>
					)}
				</div>

				{/* Primary Results */}
				<div className="space-y-4 min-w-0">
					{comparing && (
						<div className="flex items-center gap-2 mb-1">
							<Badge variant="outline">A</Badge>
							<UrlBar url={primaryUrl} />
						</div>
					)}
					<ResultsPanel
						result={primary.result}
						loading={primary.loading}
						error={primary.error}
						sseProgress={primary.sseProgress}
						compareHeaders={comparing ? secondary.result.headers : undefined}
					/>
				</div>

				{/* Comparison Results */}
				{comparing && (
					<div className="space-y-4 min-w-0">
						<div className="flex items-center gap-2 mb-1">
							<Badge variant="outline">B</Badge>
							<UrlBar url={compareUrl} />
						</div>
						<ResultsPanel
							result={secondary.result}
							loading={secondary.loading}
							error={secondary.error}
							sseProgress={secondary.sseProgress}
							compareHeaders={primary.result.headers}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
