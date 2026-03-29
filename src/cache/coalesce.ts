/**
 * Request coalescing (single-flight dedup).
 *
 * When multiple concurrent requests arrive for the same transformation,
 * only the first one triggers the actual transform. Subsequent requests
 * wait for the transform to complete, then read from cache independently.
 *
 * Uses a bounded LRU map with TTL to prevent unbounded memory growth.
 *
 * Design: stores Promise<void> (completion signal), NOT Promise<Response>.
 * This avoids .clone() and .tee() entirely — each request gets its own
 * independent Response body from cache.match(). No shared streams.
 */

interface CoalescerOptions {
	maxSize: number;
	ttlMs: number;
}

interface Entry {
	promise: Promise<void>;
	createdAt: number;
}

/**
 * Bounded concurrent request deduplication map.
 *
 * - `get(key)` returns the in-flight signal or null
 * - `set(key, promise)` registers a new in-flight transform
 * - `delete(key)` removes a completed transform
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

	/** Get the in-flight completion signal for this key, or null if none exists. */
	get(key: string): Promise<void> | null {
		const entry = this.map.get(key);
		if (!entry) return null;

		// TTL check
		if (Date.now() - entry.createdAt > this.ttlMs) {
			this.map.delete(key);
			return null;
		}

		return entry.promise;
	}

	/** Register a new in-flight transform. */
	set(key: string, promise: Promise<void>): void {
		// Evict oldest if at capacity
		if (this.map.size >= this.maxSize) {
			const oldestKey = this.map.keys().next().value;
			if (oldestKey !== undefined) {
				this.map.delete(oldestKey);
			}
		}

		this.map.set(key, { promise, createdAt: Date.now() });
	}

	/** Remove a completed transform. */
	delete(key: string): void {
		this.map.delete(key);
	}

	/** Current number of in-flight transforms. */
	get size(): number {
		return this.map.size;
	}
}
