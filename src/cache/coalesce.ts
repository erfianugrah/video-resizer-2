/**
 * Request coalescing (single-flight dedup).
 *
 * When multiple concurrent requests arrive for the same transformation,
 * only the first one triggers the actual transform. Subsequent requests
 * join the in-flight promise and receive a cloned response.
 *
 * Uses a bounded LRU map with TTL to prevent unbounded memory growth.
 */

interface CoalescerOptions {
	maxSize: number;
	ttlMs: number;
}

interface Entry {
	promise: Promise<Response>;
	createdAt: number;
}

/**
 * Bounded concurrent request deduplication map.
 *
 * - `get(key)` returns the in-flight promise (cloned) or null
 * - `set(key, promise)` registers a new in-flight request
 * - `delete(key)` removes a completed request
 * - Entries auto-evict when maxSize is exceeded (LRU) or TTL expires
 */
export class RequestCoalescer {
	private map = new Map<string, Entry>();
	private readonly maxSize: number;
	private readonly ttlMs: number;

	constructor(options: CoalescerOptions) {
		this.maxSize = options.maxSize;
		this.ttlMs = options.ttlMs;
	}

	/** Get an in-flight promise for this key, or null if none exists. */
	get(key: string): Promise<Response> | null {
		const entry = this.map.get(key);
		if (!entry) return null;

		// TTL check
		if (Date.now() - entry.createdAt > this.ttlMs) {
			this.map.delete(key);
			return null;
		}

		// Clone the response so each consumer gets their own stream
		return entry.promise.then((r) => r.clone());
	}

	/** Register a new in-flight request. */
	set(key: string, promise: Promise<Response>): void {
		// Evict oldest if at capacity
		if (this.map.size >= this.maxSize) {
			const oldestKey = this.map.keys().next().value;
			if (oldestKey !== undefined) {
				this.map.delete(oldestKey);
			}
		}

		this.map.set(key, { promise, createdAt: Date.now() });
	}

	/** Remove a completed request. */
	delete(key: string): void {
		this.map.delete(key);
	}

	/** Current number of in-flight requests. */
	get size(): number {
		return this.map.size;
	}
}
