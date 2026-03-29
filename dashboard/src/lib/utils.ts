import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes with clsx support. */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Base URL for API calls (SSR-safe). */
export const BASE = typeof window !== 'undefined' ? window.location.origin : '';

// ── Shared Constants ─────────────────────────────────────────────────

/** Time range options shared across Analytics and Jobs tabs. */
export const HOURS_OPTIONS = [
	{ value: 1, label: '1h' },
	{ value: 6, label: '6h' },
	{ value: 12, label: '12h' },
	{ value: 24, label: '24h' },
	{ value: 48, label: '48h' },
	{ value: 168, label: '7d' },
] as const;

// ── Status Colors ────────────────────────────────────────────────────

/** Mapping of job status strings to their hex color values. */
export const STATUS_COLORS: Record<string, string> = {
	pending: '#bdbdc1',
	downloading: '#8796f4',
	transcoding: '#c574dd',
	uploading: '#f1a171',
	complete: '#5adecd',
	failed: '#f37e96',
	stale: '#eab308',
};

/** Return the hex color for a given job status, defaulting to grey. */
export function statusColor(status: string): string {
	return STATUS_COLORS[status] ?? '#bdbdc1';
}

// ── Format Helpers ───────────────────────────────────────────────────

/** Format a byte count as a human-readable string (e.g. "1.5 MB"). Guards against negative/NaN/overflow. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '\u2014';
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Format a duration in seconds as a short string (e.g. "42s", "1.5m"). Guards against negative/NaN. */
export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '\u2014';
	if (seconds < 60) return `${seconds.toFixed(0)}s`;
	if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
	return `${(seconds / 3600).toFixed(1)}h`;
}

/** Format a timestamp as HH:MM:SS in 24-hour format (locale-independent). */
export function formatTime(ts: number): string {
	if (!Number.isFinite(ts)) return '\u2014';
	return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
