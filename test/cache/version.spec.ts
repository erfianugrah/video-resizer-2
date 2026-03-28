import { describe, it, expect, beforeEach } from 'vitest';
import { getVersion, bumpVersion, setVersion, deleteVersion } from '../../src/cache/version';

/** Minimal in-memory KVNamespace mock. */
function createMockKV(): KVNamespace {
	const store = new Map<string, string>();
	return {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
		list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
		getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
	} as unknown as KVNamespace;
}

describe('cache/version', () => {
	let kv: KVNamespace;

	beforeEach(() => {
		kv = createMockKV();
	});

	it('returns 1 for unset paths', async () => {
		expect(await getVersion(kv, '/test.mp4')).toBe(1);
	});

	it('returns stored version', async () => {
		await kv.put('v:/test.mp4', '7');
		expect(await getVersion(kv, '/test.mp4')).toBe(7);
	});

	it('returns 1 for invalid stored values', async () => {
		await kv.put('v:/test.mp4', 'garbage');
		expect(await getVersion(kv, '/test.mp4')).toBe(1);
	});

	it('bumpVersion increments from 1', async () => {
		const v = await bumpVersion(kv, '/test.mp4');
		expect(v).toBe(2);
		expect(await getVersion(kv, '/test.mp4')).toBe(2);
	});

	it('bumpVersion increments from existing', async () => {
		await kv.put('v:/test.mp4', '5');
		const v = await bumpVersion(kv, '/test.mp4');
		expect(v).toBe(6);
	});

	it('setVersion sets an explicit value', async () => {
		await setVersion(kv, '/test.mp4', 42);
		expect(await getVersion(kv, '/test.mp4')).toBe(42);
	});

	it('deleteVersion resets to default', async () => {
		await setVersion(kv, '/test.mp4', 10);
		await deleteVersion(kv, '/test.mp4');
		expect(await getVersion(kv, '/test.mp4')).toBe(1);
	});

	it('different paths are independent', async () => {
		await bumpVersion(kv, '/a.mp4');
		await bumpVersion(kv, '/a.mp4');
		await bumpVersion(kv, '/b.mp4');
		expect(await getVersion(kv, '/a.mp4')).toBe(3);
		expect(await getVersion(kv, '/b.mp4')).toBe(2);
	});
});
