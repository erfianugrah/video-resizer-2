/**
 * Structured logging via console.log for Workers Logs.
 *
 * Every log is a JSON object with: level, msg, ts, and arbitrary data fields.
 * Workers Logs auto-indexes these for search/filter.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
	console.log(JSON.stringify({ ...data, level, msg, ts: Date.now() }));
}

export const debug = (msg: string, data?: Record<string, unknown>) => log('debug', msg, data);
export const info = (msg: string, data?: Record<string, unknown>) => log('info', msg, data);
export const warn = (msg: string, data?: Record<string, unknown>) => log('warn', msg, data);
export const error = (msg: string, data?: Record<string, unknown>) => log('error', msg, data);
