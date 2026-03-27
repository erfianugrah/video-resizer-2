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

	it('returns the same promise for duplicate concurrent requests', async () => {
		const response = new Response('hello');
		const promise = Promise.resolve(response);

		coalescer.set('key1', promise);
		const joined = coalescer.get('key1');

		expect(joined).not.toBeNull();
		const result = await joined!;
		expect(await result.text()).toBe('hello');
	});

	it('cleans up after promise resolves', async () => {
		let resolve!: (r: Response) => void;
		const promise = new Promise<Response>((r) => {
			resolve = r;
		});

		coalescer.set('key1', promise);
		expect(coalescer.get('key1')).not.toBeNull();

		resolve(new Response('done'));
		await promise;

		// After cleanup, key should be gone
		coalescer.delete('key1');
		expect(coalescer.get('key1')).toBeNull();
	});

	it('evicts oldest entries when maxSize exceeded', () => {
		const small = new RequestCoalescer({ maxSize: 2, ttlMs: 60000 });

		small.set('a', Promise.resolve(new Response()));
		small.set('b', Promise.resolve(new Response()));
		small.set('c', Promise.resolve(new Response())); // should evict 'a'

		expect(small.get('a')).toBeNull();
		expect(small.get('b')).not.toBeNull();
		expect(small.get('c')).not.toBeNull();
	});

	it('reports size correctly', () => {
		coalescer.set('a', Promise.resolve(new Response()));
		coalescer.set('b', Promise.resolve(new Response()));
		expect(coalescer.size).toBe(2);
	});
});
