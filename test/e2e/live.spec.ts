/**
 * E2E tests against the live deployment at videos.erfi.io.
 *
 * Tests the full pipeline: CF edge -> Worker -> Media binding/cdn-cgi/container -> Cache API.
 * Run with: npm run test:e2e
 *
 * NOTE: These make real HTTP requests and may incur Media transformation charges.
 *
 * Test strategy:
 *   - Every canonical transform param is tested at least once
 *   - Every Akamai/IMQuery param is tested
 *   - Cache behavior: MISS -> HIT cycle verified
 *   - Response headers: all debug/standard headers checked
 *   - Size verification: transformed output must be smaller than source
 *   - Content-Type verification: correct MIME for each mode
 *   - Container async path: 725MB file -> passthrough -> callback -> cached
 *   - Error recovery: via loop, non-video, cdn-cgi passthrough
 */
import { describe, it, expect } from 'vitest';

const BASE = 'https://videos.erfi.io';
const SMALL = '/rocky.mp4'; // ~40MB, remote + R2
const MEDIUM = '/erfi-135kg.mp4'; // ~232MB, R2 only
const HUGE = '/big_buck_bunny_1080p.mov'; // ~725MB, remote + R2
const SMALL_RAW_SIZE = 40_000_000; // approximate raw size of rocky.mp4
const MEDIUM_RAW_SIZE = 232_000_000;
const HUGE_RAW_SIZE = 725_000_000;
const API_TOKEN: string = (globalThis as Record<string, unknown>).process
	? ((globalThis as Record<string, unknown>).process as Record<string, Record<string, string>>).env?.CONFIG_API_TOKEN ?? 'test-analytics-token-2026'
	: 'test-analytics-token-2026';

// ── Helpers ──────────────────────────────────────────────────────────────

async function req(path: string, opts: RequestInit & { timeout?: number } = {}): Promise<Response> {
	const { timeout = 30_000, ...fetchOpts } = opts;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	try {
		return await fetch(`${BASE}${path}`, { ...fetchOpts, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function h(resp: Response, name: string): string | null {
	return resp.headers.get(name);
}

function size(resp: Response): number {
	return parseInt(h(resp, 'content-length') ?? '0', 10);
}

/** Sleep helper for container callback wait. */
function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Transform params: width/height/fit ───────────────────────────────────

describe('Width + height + fit', () => {
	it('width only: resizes, output smaller than source', async () => {
		const resp = await req(`${SMALL}?width=320`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('video/mp4');
		expect(h(resp, 'x-cache-key')).toContain('w=320');
		expect(size(resp)).toBeLessThan(SMALL_RAW_SIZE);
		expect(size(resp)).toBeGreaterThan(0);
	});

	it('height only: resizes', async () => {
		const resp = await req(`${SMALL}?height=240`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-cache-key')).toContain('h=240');
		expect(size(resp)).toBeLessThan(SMALL_RAW_SIZE);
	});

	it('width + height together', async () => {
		const resp = await req(`${SMALL}?width=640&height=360`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-cache-key')).toContain('w=640');
		expect(h(resp, 'x-cache-key')).toContain('h=360');
	});

	it('fit=cover does not crash', async () => {
		const resp = await req(`${SMALL}?width=640&height=360&fit=cover`);
		expect(resp.status).toBe(200);
	});

	it('fit=scale-down does not crash', async () => {
		const resp = await req(`${SMALL}?width=640&height=360&fit=scale-down`);
		expect(resp.status).toBe(200);
	});
});

// ── Transform params: mode ───────────────────────────────────────────────

describe('Mode param', () => {
	it('mode=video (default): returns video/mp4', async () => {
		const resp = await req(`${SMALL}?width=320&mode=video`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('video/mp4');
	});

	it('mode=frame: returns image/jpeg by default', async () => {
		const resp = await req(`${SMALL}?mode=frame&width=320`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/jpeg');
		expect(size(resp)).toBeLessThan(1_000_000); // frame should be <1MB
	});

	it('mode=frame&format=png: returns image/png', async () => {
		const resp = await req(`${SMALL}?mode=frame&width=320&format=png`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/png');
	});

	it('mode=frame&format=jpg: returns image/jpeg', async () => {
		const resp = await req(`${SMALL}?mode=frame&width=320&format=jpg`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/jpeg');
	});

	it('mode=audio: returns audio/mp4', async () => {
		const resp = await req(`${SMALL}?mode=audio&duration=10s`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('audio/mp4');
		expect(size(resp)).toBeLessThan(SMALL_RAW_SIZE);
	});
});

// ── Transform params: time/duration ──────────────────────────────────────

describe('Time + duration', () => {
	it('time=3s on frame mode: extracts frame at offset', async () => {
		const resp = await req(`${SMALL}?mode=frame&time=3s&width=320`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/jpeg');
	});

	it('duration=5s: returns shorter clip, smaller size', async () => {
		const resp = await req(`${SMALL}?width=320&duration=5s`);
		expect(resp.status).toBe(200);
		expect(size(resp)).toBeLessThan(SMALL_RAW_SIZE / 2);
	});

	it('time + duration together: clip from offset', async () => {
		const resp = await req(`${SMALL}?width=320&time=2s&duration=3s`);
		expect(resp.status).toBe(200);
		expect(size(resp)).toBeLessThan(SMALL_RAW_SIZE / 2);
	});
});

// ── Transform params: audio boolean ──────────────────────────────────────

describe('Audio param', () => {
	it('audio=false strips audio track', async () => {
		const resp = await req(`${SMALL}?width=320&duration=5s&audio=false`);
		expect(resp.status).toBe(200);
		// Output without audio should be smaller than with audio
		const withAudio = await req(`${SMALL}?width=320&duration=5s&audio=true`);
		expect(size(resp)).toBeLessThanOrEqual(size(withAudio));
	});
});

// ── Transform params: filename ───────────────────────────────────────────

describe('Filename param', () => {
	it('filename sets Content-Disposition header', async () => {
		const resp = await req(`${SMALL}?width=320&filename=myclip`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-disposition')).toContain('filename="myclip"');
	});
});

// ── Transform params: playback hints ─────────────────────────────────────

describe('Playback hint params', () => {
	it('loop/autoplay/muted/preload set X-Playback-* headers', async () => {
		const resp = await req(`${SMALL}?width=320&loop=true&autoplay=true&muted=true&preload=auto&debug`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-playback-loop')).toBe('true');
		expect(h(resp, 'x-playback-autoplay')).toBe('true');
		expect(h(resp, 'x-playback-muted')).toBe('true');
		expect(h(resp, 'x-playback-preload')).toBe('auto');
	});
});

// ── Derivatives ──────────────────────────────────────────────────────────

describe('Derivatives', () => {
	it('tablet: 1280x720 video', async () => {
		const resp = await req(`${SMALL}?derivative=tablet`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('video/mp4');
		expect(h(resp, 'x-derivative')).toBe('tablet');
		expect(h(resp, 'x-cache-key')).toContain('w=1280');
		expect(h(resp, 'x-cache-key')).toContain('h=720');
		expect(size(resp)).toBeLessThan(SMALL_RAW_SIZE);
		expect(size(resp)).toBeGreaterThan(0);
	});

	it('mobile: 854x640 video', async () => {
		const resp = await req(`${SMALL}?derivative=mobile`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-derivative')).toBe('mobile');
		expect(h(resp, 'x-cache-key')).toContain('w=854');
	});

	it('desktop: 1920x1080 video', async () => {
		const resp = await req(`${SMALL}?derivative=desktop`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-cache-key')).toContain('w=1920');
		expect(h(resp, 'x-cache-key')).toContain('h=1080');
	});

	it('thumbnail: frame mode, PNG', async () => {
		const resp = await req(`${SMALL}?derivative=thumbnail`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/png');
		expect(h(resp, 'x-cache-key')).toContain('frame:');
	});

	it('unknown derivative: does not crash', async () => {
		const resp = await req(`${SMALL}?derivative=nonexistent`);
		expect(resp.status).toBe(200);
	});
});

// ── Akamai/IMQuery params ────────────────────────────────────────────────

describe('Akamai/IMQuery translation', () => {
	it('impolicy=tablet -> derivative=tablet', async () => {
		const resp = await req(`${SMALL}?impolicy=tablet`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-derivative')).toBe('tablet');
	});

	it('imwidth=640 -> width', async () => {
		const resp = await req(`${SMALL}?imwidth=640`);
		expect(resp.status).toBe(200);
		// imwidth triggers derivative matching; verify response is transformed
		expect(size(resp)).toBeLessThan(SMALL_RAW_SIZE);
	});

	it('imwidth=1280 -> transforms with width', async () => {
		const resp = await req(`${SMALL}?imwidth=1280`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-resolved-width')).toBeTruthy();
		expect(size(resp)).toBeLessThan(SMALL_RAW_SIZE);
	});

	it('w=640&h=360 shorthands', async () => {
		const resp = await req(`${SMALL}?w=640&h=360`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-cache-key')).toContain('w=640');
		expect(h(resp, 'x-cache-key')).toContain('h=360');
	});

	it('obj-fit=crop -> fit=cover', async () => {
		const resp = await req(`${SMALL}?w=640&h=360&obj-fit=crop`);
		expect(resp.status).toBe(200);
	});

	it('mute=true -> audio=false (inverted)', async () => {
		const resp = await req(`${SMALL}?w=640&mute=true&duration=5s`);
		expect(resp.status).toBe(200);
	});

	it('start=3s -> time=3s', async () => {
		const resp = await req(`${SMALL}?mode=frame&start=3s&w=320&format=jpg`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/jpeg');
	});

	it('dur=5s -> duration=5s', async () => {
		const resp = await req(`${SMALL}?w=320&dur=5s`);
		expect(resp.status).toBe(200);
		expect(size(resp)).toBeLessThan(SMALL_RAW_SIZE / 2);
	});

	it('q=high -> quality=high (in cache key)', async () => {
		const resp = await req(`${SMALL}?w=640&q=high&debug`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-cache-key')).toContain('q=high');
	});
});

// ── Cache behavior ───────────────────────────────────────────────────────

describe('Cache behavior', () => {
	it('first request transforms, second request is cf-cache-status HIT', async () => {
		// Warm the cache
		const r1 = await req(`${SMALL}?derivative=tablet`);
		expect(r1.status).toBe(200);
		// Second request
		const r2 = await req(`${SMALL}?derivative=tablet`);
		expect(r2.status).toBe(200);
		expect(h(r2, 'cf-cache-status')).toBe('HIT');
	});

	it('transformed output is cached (content-length identical on HIT)', async () => {
		const r1 = await req(`${SMALL}?width=320&duration=5s`);
		const r2 = await req(`${SMALL}?width=320&duration=5s`);
		expect(size(r1)).toBe(size(r2));
	});

	it('different params produce different cached responses', async () => {
		const r320 = await req(`${SMALL}?width=320`);
		const r640 = await req(`${SMALL}?width=640`);
		expect(size(r320)).not.toBe(size(r640));
	});

	it('?debug bypasses Worker cache (forces fresh transform)', async () => {
		const resp = await req(`${SMALL}?width=320&debug`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-processing-time-ms')).toBeTruthy();
	});

	it('Cache-Control header has public + max-age', async () => {
		const resp = await req(`${SMALL}?derivative=tablet`);
		const cc = h(resp, 'cache-control');
		expect(cc).toContain('public');
		expect(cc).toContain('max-age=');
	});

	it('Cache-Tag present on fresh transform', async () => {
		const resp = await req(`${SMALL}?derivative=tablet&debug`);
		const ct = h(resp, 'cache-tag');
		expect(ct).toContain('derivative:tablet');
		expect(ct).toContain('origin:');
	});
});

// ── Range requests ───────────────────────────────────────────────────────

describe('Range requests', () => {
	it('byte range returns 206 with Content-Range', async () => {
		const resp = await req(`${SMALL}?derivative=tablet`, {
			headers: { Range: 'bytes=0-999' },
		});
		expect(resp.status).toBe(206);
		expect(h(resp, 'content-range')).toMatch(/^bytes 0-999\/\d+$/);
		expect(h(resp, 'content-length')).toBe('1000');
	});

	it('suffix range returns 206', async () => {
		const resp = await req(`${SMALL}?derivative=tablet`, {
			headers: { Range: 'bytes=-500' },
		});
		expect(resp.status).toBe(206);
		expect(h(resp, 'content-length')).toBe('500');
	});

	it('Accept-Ranges: bytes header present', async () => {
		const resp = await req(`${SMALL}?derivative=tablet`);
		expect(h(resp, 'accept-ranges')).toBe('bytes');
	});
});

// ── Response headers ─────────────────────────────────────────────────────

describe('Response headers', () => {
	it('Via: video-resizer', async () => {
		const resp = await req(`${SMALL}?width=320`);
		expect(h(resp, 'via')).toContain('video-resizer');
	});

	it('X-Request-ID is a UUID', async () => {
		const resp = await req(`${SMALL}?width=320`);
		expect(h(resp, 'x-request-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('X-Origin identifies matched origin', async () => {
		const resp = await req(`${SMALL}?width=320&debug`);
		expect(h(resp, 'x-origin')).toBeTruthy();
	});

	it('X-Source-Type is r2 or remote', async () => {
		const resp = await req(`${SMALL}?width=320&debug`);
		expect(['r2', 'remote', 'fallback']).toContain(h(resp, 'x-source-type'));
	});

	it('X-Transform-Source is binding or cdn-cgi', async () => {
		const resp = await req(`${SMALL}?width=320&debug`);
		expect(['binding', 'cdn-cgi']).toContain(h(resp, 'x-transform-source'));
	});

	it('X-Processing-Time-Ms is a number', async () => {
		const resp = await req(`${SMALL}?width=320&debug`);
		const ms = parseInt(h(resp, 'x-processing-time-ms') ?? '', 10);
		expect(ms).toBeGreaterThan(0);
	});

	it('X-Cache-Key is present and structured', async () => {
		const resp = await req(`${SMALL}?width=320`);
		const key = h(resp, 'x-cache-key');
		expect(key).toBeTruthy();
		expect(key).toContain('video:');
		expect(key).toContain('rocky.mp4');
	});

	it('cf-cache-status is set by CF edge', async () => {
		const resp = await req(`${SMALL}?derivative=tablet`);
		expect(['HIT', 'MISS', 'EXPIRED', 'DYNAMIC', 'REVALIDATED']).toContain(h(resp, 'cf-cache-status'));
	});
});

// ── Error cases ──────────────────────────────────────────────────────────

describe('Error cases', () => {
	it('non-video extension passes through', async () => {
		const resp = await req('/test.html');
		expect(resp.status).not.toBe(500);
	});

	it('cdn-cgi path passes through', async () => {
		const resp = await req('/cdn-cgi/media/mode=frame/https://example.com/test.mp4');
		expect(resp.status).not.toBe(500);
	});

	it('Via loop detection prevents recursion', async () => {
		const resp = await req(`${SMALL}?width=320`, {
			headers: { Via: 'video-resizer' },
		});
		expect(resp.status).not.toBe(500);
	});

	it('unknown path returns error or passthrough', async () => {
		const resp = await req('/unknown-path.mp4');
		expect([200, 404, 502]).toContain(resp.status);
	});

	it('invalid width below minimum is dropped gracefully', async () => {
		const resp = await req(`${SMALL}?width=5`);
		expect(resp.status).toBe(200);
	});
});

// ── Admin endpoints ──────────────────────────────────────────────────────

describe('Admin endpoints', () => {
	it('GET /admin/config requires auth (401 without token)', async () => {
		const resp = await req('/admin/config');
		expect(resp.status).toBe(401);
	});

	it('GET /admin/config returns config with valid token', async () => {
		const resp = await req('/admin/config', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { config: { origins: unknown[]; derivatives: Record<string, unknown> } };
		expect(body.config.origins).toBeInstanceOf(Array);
		expect(Object.keys(body.config.derivatives).length).toBeGreaterThan(0);
	});

	it('GET /admin/analytics returns summary', async () => {
		const resp = await req('/admin/analytics?hours=24', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { summary: { total: number; success: number } };
		expect(typeof body.summary.total).toBe('number');
	});

	it('GET /admin/analytics/errors returns array', async () => {
		const resp = await req('/admin/analytics/errors?hours=24', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { errors: unknown[] };
		expect(body.errors).toBeInstanceOf(Array);
	});

	it('POST /admin/cache/bust without path returns 400', async () => {
		const resp = await req('/admin/cache/bust', {
			method: 'POST',
			headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
	});

	it('POST /admin/cache/bust with path bumps version', async () => {
		const resp = await req('/admin/cache/bust', {
			method: 'POST',
			headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/test-bust.mp4' }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { ok: boolean; version: number };
		expect(body.ok).toBe(true);
		expect(body.version).toBeGreaterThanOrEqual(2);
	});
});

// ── Large file: 232MB (binding edge case) ────────────────────────────────

describe('Large file via binding (232MB)', () => {
	it('imwidth=1280: transformed, smaller than raw', async () => {
		const resp = await req(`${MEDIUM}?imwidth=1280`, { timeout: 60_000 });
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('video/mp4');
		expect(size(resp)).toBeLessThan(MEDIUM_RAW_SIZE);
		expect(size(resp)).toBeGreaterThan(0);
	});

	it('thumbnail: frame extraction from 232MB source', async () => {
		const resp = await req(`${MEDIUM}?derivative=thumbnail`, { timeout: 60_000 });
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/png');
		expect(size(resp)).toBeLessThan(1_000_000);
	});

	it('width=320&duration=5s: short clip from large file', async () => {
		const resp = await req(`${MEDIUM}?width=320&height=240&duration=5s`, { timeout: 60_000 });
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('video/mp4');
		expect(h(resp, 'x-source-type')).toBe('r2');
	});
});

// ── Very large file: 725MB (container async path) ────────────────────────

describe('Very large file via container (725MB)', () => {
	it('first request returns passthrough with X-Transform-Pending', async () => {
		// Use a unique width to avoid cached results from prior runs
		const testWidth = 317; // unlikely to be cached
		const resp = await req(`${HUGE}?imwidth=${testWidth}`, { timeout: 60_000 });
		expect(resp.status).toBe(200);
		// Should be either a passthrough (pending) or a cached container result
		const pending = h(resp, 'x-transform-pending');
		const ct = h(resp, 'content-type');
		if (pending === 'true') {
			// Passthrough: raw .mov file, not yet transformed
			expect(ct).toBe('video/quicktime');
			expect(size(resp)).toBeGreaterThan(700_000_000); // raw file
		} else {
			// Container result was already cached from a prior run
			expect(ct).toBe('video/mp4');
			expect(size(resp)).toBeLessThan(HUGE_RAW_SIZE);
		}
	});

	it('debug=view shows correct diagnostics for oversized file', async () => {
		const resp = await req(`${HUGE}?imwidth=640&debug=view`);
		expect(resp.status).toBe(200);
		const body = await resp.json() as {
			diagnostics: {
				path: string;
				params: { width: number };
				origin: { name: string };
				resolvedWidth: number;
			};
		};
		expect(body.diagnostics.path).toBe(HUGE);
		expect(body.diagnostics.resolvedWidth).toBeTruthy();
		expect(body.diagnostics.origin.name).toBeTruthy();
	});

	it('container callback stores result in cache (poll for up to 3 minutes)', async () => {
		// Trigger a transform with a unique width
		const testWidth = 319; // unlikely to be cached
		const url = `${HUGE}?imwidth=${testWidth}`;

		// First request: triggers async container
		const r1 = await req(url, { timeout: 60_000 });
		expect(r1.status).toBe(200);

		const pending = h(r1, 'x-transform-pending');
		if (pending !== 'true') {
			// Already cached from a prior run — skip polling
			expect(h(r1, 'content-type')).toBe('video/mp4');
			expect(size(r1)).toBeLessThan(HUGE_RAW_SIZE);
			return;
		}

		// Poll: wait for the container to finish and cache the result
		// Container needs to: download 725MB + ffmpeg transcode + POST callback
		// This can take 1-3 minutes on standard-1 instance
		let cached = false;
		for (let attempt = 0; attempt < 18; attempt++) {
			await sleep(10_000); // wait 10s between polls
			const r = await req(url, { timeout: 60_000 });
			const stillPending = h(r, 'x-transform-pending');
			if (stillPending !== 'true' && h(r, 'content-type') === 'video/mp4') {
				// Container result is now cached
				expect(size(r)).toBeLessThan(HUGE_RAW_SIZE);
				expect(size(r)).toBeGreaterThan(0);
				cached = true;
				break;
			}
		}

		// If we get here without caching, the container callback didn't land
		// This is the test that catches the outbound handler bug
		expect(cached).toBe(true);
	}, 240_000); // 4 minute timeout for this test
});

// ── Debug diagnostics ────────────────────────────────────────────────────

describe('Debug diagnostics', () => {
	it('?debug=view returns JSON with full diagnostics', async () => {
		const resp = await req(`${SMALL}?derivative=tablet&debug=view`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toContain('application/json');
		const body = await resp.json() as {
			diagnostics: {
				requestId: string;
				path: string;
				params: Record<string, unknown>;
				origin: { name: string; sources: { type: string; priority: number }[] };
				captures: Record<string, string>;
				config: { derivatives: string[]; responsive: unknown; containerEnabled: boolean };
				needsContainer: boolean;
				resolvedWidth: number | null;
				resolvedHeight: number | null;
			};
		};
		const d = body.diagnostics;
		expect(d.requestId).toMatch(/^[0-9a-f-]+$/);
		expect(d.path).toBe(SMALL);
		expect(d.params.derivative).toBe('tablet');
		expect(d.params.width).toBe(1280);
		expect(d.params.height).toBe(720);
		expect(d.origin.name).toBeTruthy();
		expect(d.origin.sources.length).toBeGreaterThan(0);
		expect(d.captures).toBeTruthy();
		expect(d.config.derivatives.length).toBeGreaterThan(0);
		expect(typeof d.needsContainer).toBe('boolean');
		expect(d.resolvedWidth).toBe(1280);
		expect(d.resolvedHeight).toBe(720);
	});

	it('X-Resolved-Width/Height headers on normal requests', async () => {
		const resp = await req(`${SMALL}?derivative=tablet&debug`);
		expect(h(resp, 'x-resolved-width')).toBe('1280');
		expect(h(resp, 'x-resolved-height')).toBe('720');
	});
});

// ── Source types ──────────────────────────────────────────────────────────

describe('Source types', () => {
	it('small video: remote or r2 source', async () => {
		const resp = await req(`${SMALL}?width=320&debug`);
		expect(['r2', 'remote']).toContain(h(resp, 'x-source-type'));
	});

	it('medium video (R2 only): r2 source', async () => {
		const resp = await req(`${MEDIUM}?width=320&duration=5s&debug`, { timeout: 60_000 });
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-source-type')).toBe('r2');
	});
});
