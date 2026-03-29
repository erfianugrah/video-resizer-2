import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequestCoalescer } from '../../src/cache/coalesce';

describe('cache/coalesce', () => {
	let coalescer: RequestCoalescer;

	beforeEach(() => {
		coalescer = new RequestCoalescer({ maxSize: 100, ttlMs: 5000 });
	});

	it('returns null for first request with a key', () => {
		const result = coalescer.get('key1');
		expect(result).toBeNull();
	});

	it('returns a completion signal for duplicate concurrent requests', async () => {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});

		coalescer.set('key1', promise);
		const signal = coalescer.get('key1');

		expect(signal).not.toBeNull();
		// Signal should not resolve yet
		let resolved = false;
		signal!.then(() => { resolved = true; });
		await Promise.resolve(); // flush microtasks
		expect(resolved).toBe(false);

		resolve();
		await signal!;
		expect(resolved).toBe(true);
	});

	it('cleans up after promise resolves', async () => {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});

		coalescer.set('key1', promise);
		expect(coalescer.get('key1')).not.toBeNull();

		resolve();
		await promise;

		// After cleanup, key should be gone
		coalescer.delete('key1');
		expect(coalescer.get('key1')).toBeNull();
	});

	it('evicts oldest entries when maxSize exceeded', () => {
		const small = new RequestCoalescer({ maxSize: 2, ttlMs: 60000 });

		small.set('a', Promise.resolve());
		small.set('b', Promise.resolve());
		small.set('c', Promise.resolve()); // should evict 'a'

		expect(small.get('a')).toBeNull();
		expect(small.get('b')).not.toBeNull();
		expect(small.get('c')).not.toBeNull();
	});

	it('reports size correctly', () => {
		coalescer.set('a', Promise.resolve());
		coalescer.set('b', Promise.resolve());
		expect(coalescer.size).toBe(2);
	});

	it('expires entries after TTL', async () => {
		const fast = new RequestCoalescer({ maxSize: 100, ttlMs: 10 });
		fast.set('key1', Promise.resolve());
		expect(fast.get('key1')).not.toBeNull();

		// Wait for TTL to expire
		await new Promise((r) => setTimeout(r, 20));
		expect(fast.get('key1')).toBeNull();
	});
});
