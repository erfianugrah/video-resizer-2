import { useState } from 'react';
import { BASE, ErrorBanner, formatBytes } from './shared';

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

export default function DebugTab() {
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
			const sep = url.includes('?') ? '&' : '?';
			const diagUrl = `${BASE}${url}${sep}debug=view`;
			const diagRes = await fetch(diagUrl);
			if (diagRes.ok) {
				const data = await diagRes.json() as DiagnosticsResult;
				setDiagnostics(data.diagnostics);
			}

			const t0 = performance.now();
			const transformUrl = `${BASE}${url}${sep}debug`;
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

			{error && <ErrorBanner message={error} />}

			{(diagnostics || headers.length > 0) && (
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
