/**
 * Unified application error. Carries an HTTP status, machine-readable code,
 * human message, and optional structured details.
 *
 * Hono's `app.onError` handler catches these and returns the appropriate
 * JSON response — no per-handler try/catch needed.
 */
export class AppError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: Record<string, unknown>;

	constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = 'AppError';
		this.status = status;
		this.code = code;
		this.details = details;
	}

	/** Structured JSON payload for HTTP responses. */
	toJSON(): { error: { code: string; message: string; details?: Record<string, unknown> } } {
		const body: { code: string; message: string; details?: Record<string, unknown> } = {
			code: this.code,
			message: this.message,
		};
		if (this.details) body.details = this.details;
		return { error: body };
	}
}
