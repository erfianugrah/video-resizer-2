/**
 * TransformJobDO — Durable Object for tracking container transform job state.
 *
 * Each unique transform (keyed by cache key / jobId) gets its own DO instance.
 * Manages the job lifecycle state machine and provides WebSocket connections
 * for real-time progress updates (using the Hibernation API for cost efficiency).
 *
 * State machine:
 *   (none) → PENDING → DOWNLOADING → TRANSCODING → UPLOADING → COMPLETE
 *                                                              → FAILED
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import * as log from '../log';

/** Job state machine phases. */
export type JobStatus = 'pending' | 'downloading' | 'transcoding' | 'uploading' | 'complete' | 'failed';

/** Message shape enqueued to TRANSFORM_QUEUE. */
export interface JobMessage {
	jobId: string;
	path: string;
	params: Record<string, unknown>;
	sourceUrl: string;
	callbackCacheKey: string;
	requestUrl: string;
	origin: string;
	sourceType: string;
	etag?: string;
	version?: number;
	createdAt: number;
}

/** Serializable job state returned via REST / WebSocket. */
export interface JobState {
	status: JobStatus | 'none';
	progress: number;
	error: string | null;
	createdAt: number | null;
	startedAt: number | null;
	completedAt: number | null;
	path: string | null;
	origin: string | null;
	params: Record<string, unknown> | null;
}

export type JobInitStatus = 'none'; // DO exists but no job was ever submitted

export class TransformJobDO extends DurableObject<Env> {
	private status: JobStatus | JobInitStatus = 'none';
	private progress = 0;
	private error: string | null = null;
	private createdAt: number | null = null;
	private startedAt: number | null = null;
	private completedAt: number | null = null;
	private path: string | null = null;
	private origin: string | null = null;
	private params: Record<string, unknown> | null = null;
	private initialized = false;

	/** Restore state from SQLite storage on first access. */
	private async ensureLoaded(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;

		const stored = await this.ctx.storage.get<Record<string, unknown>>('state');
		if (stored) {
			this.status = (stored.status as JobStatus) ?? 'none';
			this.progress = (stored.progress as number) ?? 0;
			this.error = (stored.error as string) ?? null;
			this.createdAt = (stored.createdAt as number) ?? null;
			this.startedAt = (stored.startedAt as number) ?? null;
			this.completedAt = (stored.completedAt as number) ?? null;
			this.path = (stored.path as string) ?? null;
			this.origin = (stored.origin as string) ?? null;
			this.params = (stored.params as Record<string, unknown>) ?? null;
		}
	}

	/** Persist current state to SQLite storage. */
	private async persist(): Promise<void> {
		await this.ctx.storage.put('state', {
			status: this.status,
			progress: this.progress,
			error: this.error,
			createdAt: this.createdAt,
			startedAt: this.startedAt,
			completedAt: this.completedAt,
			path: this.path,
			origin: this.origin,
			params: this.params,
		});
	}

	/** Get current job state snapshot. */
	private getState(): JobState {
		return {
			status: this.status,
			progress: this.progress,
			error: this.error,
			createdAt: this.createdAt,
			startedAt: this.startedAt,
			completedAt: this.completedAt,
			path: this.path,
			origin: this.origin,
			params: this.params,
		};
	}

	/** Broadcast state to all connected WebSocket clients. */
	private broadcast(data: object): void {
		const msg = JSON.stringify(data);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(msg);
			} catch {
				// Client disconnected — ignore
			}
		}
	}

	override async fetch(request: Request): Promise<Response> {
		await this.ensureLoaded();
		const url = new URL(request.url);

		// WebSocket upgrade for real-time progress
		if (request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			this.ctx.acceptWebSocket(server);
			// Send current status immediately
			server.send(JSON.stringify(this.getState()));
			return new Response(null, { status: 101, webSocket: client });
		}

		// REST: GET /status
		if (url.pathname.endsWith('/status') && request.method === 'GET') {
			return Response.json(this.getState());
		}

		// REST: POST /submit — called by producer when enqueuing
		if (url.pathname.endsWith('/submit') && request.method === 'POST') {
			const job: JobMessage = await request.json();
			await this.submit(job);
			return Response.json({ ok: true, status: this.status });
		}

		// REST: POST /start — called by queue consumer when starting
		if (url.pathname.endsWith('/start') && request.method === 'POST') {
			await this.start();
			return Response.json({ ok: true, status: this.status });
		}

		// REST: POST /progress — called by container outbound handler
		if (url.pathname.endsWith('/progress') && request.method === 'POST') {
			const body = await request.json() as { phase: string; percent: number };
			await this.updateProgress(body.phase, body.percent);
			return Response.json({ ok: true });
		}

		// REST: POST /complete — called when R2 put succeeds
		if (url.pathname.endsWith('/complete') && request.method === 'POST') {
			await this.complete();
			return Response.json({ ok: true, status: this.status });
		}

		// REST: POST /fail — called on failure
		if (url.pathname.endsWith('/fail') && request.method === 'POST') {
			const body = await request.json() as { error: string };
			await this.fail(body.error);
			return Response.json({ ok: true, status: this.status });
		}

		return new Response('Not found', { status: 404 });
	}

	/** Called by producer when enqueuing a new job. */
	async submit(job: JobMessage): Promise<void> {
		this.status = 'pending';
		this.progress = 0;
		this.error = null;
		this.createdAt = job.createdAt;
		this.startedAt = null;
		this.completedAt = null;
		this.path = job.path;
		this.origin = job.origin;
		this.params = job.params;
		await this.persist();
		this.broadcast({ status: 'pending', progress: 0, path: job.path });
		log.info('Job submitted', { jobId: job.jobId, path: job.path });
	}

	/** Called by queue consumer when processing begins. */
	async start(): Promise<void> {
		this.status = 'downloading';
		this.startedAt = Date.now();
		await this.persist();
		this.broadcast({ status: 'downloading', progress: 0 });
	}

	/** Called by container to report progress (via outbound handler). */
	async updateProgress(phase: string, percent: number): Promise<void> {
		this.status = phase as JobStatus;
		this.progress = Math.min(100, Math.max(0, percent));
		await this.persist();
		this.broadcast({ status: phase, progress: this.progress });
	}

	/** Called when R2 put completes successfully. */
	async complete(): Promise<void> {
		this.status = 'complete';
		this.progress = 100;
		this.completedAt = Date.now();
		await this.persist();
		this.broadcast({ status: 'complete', progress: 100 });
		// Close all WebSocket connections after sending completion
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1000, 'Job complete');
			} catch {
				// Already closed
			}
		}
	}

	/** Called on failure. */
	async fail(error: string): Promise<void> {
		this.status = 'failed';
		this.error = error;
		await this.persist();
		this.broadcast({ status: 'failed', error });
		log.error('Job failed', { path: this.path, error });
	}

	// ── Hibernation WebSocket handlers ───────────────────────────────────

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.ensureLoaded();
		if (message === 'status') {
			ws.send(JSON.stringify(this.getState()));
		}
	}

	async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
		// Code 1006 is reserved (abnormal closure) and cannot be sent explicitly.
		// Use 1000 (normal) as fallback for any reserved/invalid codes.
		const safeCode = (code >= 1000 && code <= 1003) || (code >= 3000 && code <= 4999) ? code : 1000;
		try { ws.close(safeCode); } catch { /* already closed */ }
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		ws.close(1011, 'WebSocket error');
	}
}
