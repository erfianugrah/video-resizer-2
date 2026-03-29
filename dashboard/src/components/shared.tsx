/** Shared UI components and utilities for the dashboard. */

// ── Status colors (gatekeeper pattern: semantic color map) ───────────────

export const STATUS_COLORS: Record<string, string> = {
	pending: 'var(--text-muted)',
	downloading: '#8796f4', // blue
	transcoding: '#c574dd', // purple
	uploading: '#f1a171', // peach
	complete: 'var(--success)',
	failed: 'var(--error)',
	stale: 'var(--warning)',
};

export function statusColor(status: string): string {
	return STATUS_COLORS[status] ?? 'var(--text-muted)';
}

// ── Format helpers ───────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds.toFixed(0)}s`;
	if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
	return `${(seconds / 3600).toFixed(1)}h`;
}

export function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString();
}

// ── Base URL ─────────────────────────────────────────────────────────────

export const BASE = typeof window !== 'undefined' ? window.location.origin : '';

// ── Reusable components ──────────────────────────────────────────────────

export function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
	return (
		<div className="rounded-lg border p-3" style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}>
			<div className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
			<div className="text-xl font-semibold tabular-nums" style={{ color: color ?? 'var(--text)' }}>{value}</div>
		</div>
	);
}

export function BreakdownTable({ title, rows }: { title: string; rows: [string, number][] }) {
	if (!rows.length) return null;
	const max = Math.max(...rows.map(([, v]) => v));
	const total = rows.reduce((s, [, v]) => s + v, 0);
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
						<span className="w-16 text-right tabular-nums" style={{ color: 'var(--text-muted)' }}>
							{count}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

export function ErrorBanner({ message }: { message: string }) {
	return (
		<div className="text-sm mb-4 p-3 rounded-md border" style={{ color: 'var(--error)', borderColor: 'var(--error)', background: 'rgba(239,68,68,0.1)' }}>
			{message}
		</div>
	);
}

export function Badge({ children, color }: { children: React.ReactNode; color: string }) {
	return (
		<span
			className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium font-mono border"
			style={{ color, borderColor: `color-mix(in srgb, ${color} 30%, transparent)`, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
		>
			{children}
		</span>
	);
}
