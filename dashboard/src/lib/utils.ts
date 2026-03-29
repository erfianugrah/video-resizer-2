import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Safely copy text to the clipboard, logging on failure. */
export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch (e) {
		console.error('Clipboard write failed:', e);
		return false;
	}
}

/** Base URL for API calls (SSR-safe). */
export const BASE = typeof window !== 'undefined' ? window.location.origin : '';

// ── Status Colors ────────────────────────────────────────────────────
export const STATUS_COLORS: Record<string, string> = {
	pending: '#bdbdc1',
	downloading: '#8796f4',
	transcoding: '#c574dd',
	uploading: '#f1a171',
	complete: '#5adecd',
	failed: '#f37e96',
	stale: '#eab308',
};

export function statusColor(status: string): string {
	return STATUS_COLORS[status] ?? '#bdbdc1';
}

// ── Format Helpers ───────────────────────────────────────────────────

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
