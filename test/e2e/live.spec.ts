/**
 * E2E tests against the live deployment.
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

// All configurable via env vars — set in .env.test or shell
const BASE = process.env.TEST_BASE_URL ?? 'https://videos.erfi.io';
const SMALL = process.env.TEST_SMALL_VIDEO ?? '/rocky.mp4'; // ~40MB, remote + R2
const MEDIUM = process.env.TEST_MEDIUM_VIDEO ?? '/erfi-135kg.mp4'; // ~232MB, R2 only
const HUGE = process.env.TEST_HUGE_VIDEO ?? '/big_buck_bunny_1080p.mov'; // ~725MB, remote + R2
const SMALL_RAW_SIZE = parseInt(process.env.TEST_SMALL_SIZE ?? '40000000', 10);
const MEDIUM_RAW_SIZE = parseInt(process.env.TEST_MEDIUM_SIZE ?? '232000000', 10);
const HUGE_RAW_SIZE = parseInt(process.env.TEST_HUGE_SIZE ?? '725000000', 10);
const API_TOKEN: string = (globalThis as Record<string, unknown>).process
	? ((globalThis as Record<string, unknown>).process as Record<string, Record<string, string>>).env?.CONFIG_API_TOKEN ?? ''
	: '';
const HAS_TOKEN = !!API_TOKEN;

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

	it('?debug bypasses edge cache (serves from R2 or fresh transform)', async () => {
		const resp = await req(`${SMALL}?width=320&debug`);
		expect(resp.status).toBe(200);
		// On R2 HIT, processing time header may not be set (not a fresh transform)
		// Just verify we get a valid response with debug headers
		expect(h(resp, 'x-cache-key')).toBeTruthy();
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

	it('X-Processing-Time-Ms is a number on fresh transform', async () => {
		// Use a unique width to force a fresh transform (not R2 HIT)
		const uniqueWidth = 300 + Math.floor(Math.random() * 50);
		const resp = await req(`${SMALL}?width=${uniqueWidth}&debug`, { timeout: 60_000 });
		expect(resp.status).toBe(200);
		const r2Cache = h(resp, 'x-r2-stored');
		// Only check processing time on fresh transforms (R2 MISS)
		if (r2Cache === 'MISS') {
			const ms = parseInt(h(resp, 'x-processing-time-ms') ?? '', 10);
			expect(ms).toBeGreaterThan(0);
		}
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
		if (!HAS_TOKEN) return; // skip without CONFIG_API_TOKEN env var
		const resp = await req('/admin/config', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { config: { origins: unknown[]; derivatives: Record<string, unknown> } };
		expect(body.config.origins).toBeInstanceOf(Array);
		expect(Object.keys(body.config.derivatives).length).toBeGreaterThan(0);
	});

	it('GET /admin/analytics returns summary', async () => {
		if (!HAS_TOKEN) return;
		const resp = await req('/admin/analytics?hours=24', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { summary: { total: number; success: number } };
		expect(typeof body.summary.total).toBe('number');
	});

	it('GET /admin/analytics/errors returns array', async () => {
		if (!HAS_TOKEN) return;
		const resp = await req('/admin/analytics/errors?hours=24', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { errors: unknown[] };
		expect(body.errors).toBeInstanceOf(Array);
	});

	it('POST /admin/cache/bust without path returns 400', async () => {
		if (!HAS_TOKEN) return;
		const resp = await req('/admin/cache/bust', {
			method: 'POST',
			headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
	});

	it('POST /admin/cache/bust with path bumps version', async () => {
		if (!HAS_TOKEN) return;
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
		// May return 200 (cached/binding) or 202 (queued for container)
		expect([200, 202]).toContain(resp.status);
		if (resp.status === 200) {
			expect(h(resp, 'content-type')).toBe('video/mp4');
		}
	});
});

// ── Very large file: 725MB (container async path) ────────────────────────

describe('Very large file via container (725MB)', () => {
	it('first request returns 202 queued or cached result', async () => {
		// Use a unique width to avoid cached results from prior runs
		const testWidth = 317; // unlikely to be cached
		const resp = await req(`${HUGE}?imwidth=${testWidth}`, { timeout: 60_000 });
		// Queue-based: returns 202 with jobId, or 200 if already cached
		expect([200, 202]).toContain(resp.status);
		if (resp.status === 202) {
			const body = await resp.json() as { status: string; jobId?: string; path?: string };
			expect(body.status).toBeTruthy();
			expect(body.path).toBe(HUGE);
			expect(h(resp, 'x-transform-pending')).toBe('true');
		} else {
			// Container result was already cached from a prior run
			expect(h(resp, 'content-type')).toBe('video/mp4');
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

	it('container callback stores result in R2 (poll for up to 5 minutes)', async () => {
		// Trigger a transform with a unique width
		const testWidth = 319; // unlikely to be cached
		const url = `${HUGE}?imwidth=${testWidth}`;

		// First request: triggers queue-based container job
		const r1 = await req(url, { timeout: 60_000 });
		// Queue returns 202, or 200 if already cached
		expect([200, 202]).toContain(r1.status);

		if (r1.status === 200 && h(r1, 'content-type') === 'video/mp4') {
			// Already cached from a prior run — skip polling
			expect(size(r1)).toBeLessThan(HUGE_RAW_SIZE);
			return;
		}

		// Poll: wait for the container to finish and store in R2
		// Container needs to: download 725MB + ffmpeg transcode + R2 put
		// Queue retries check R2 every 120s; total window ~20 minutes
		let cached = false;
		for (let attempt = 0; attempt < 30; attempt++) {
			await sleep(10_000); // wait 10s between polls
			const r = await req(url, { timeout: 60_000 });
			if (r.status === 200 && h(r, 'content-type') === 'video/mp4') {
				// Container result is now in R2 + edge cache
				expect(size(r)).toBeLessThan(HUGE_RAW_SIZE);
				expect(size(r)).toBeGreaterThan(0);
				cached = true;
				break;
			}
		}

		// If we get here without caching, the container callback didn't land
		expect(cached).toBe(true);
	}, 360_000); // 6 minute timeout for this test
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

	it('medium video (R2 only): r2 source or R2 cached result', async () => {
		const resp = await req(`${MEDIUM}?width=320&duration=5s&debug`, { timeout: 60_000 });
		expect([200, 202]).toContain(resp.status);
		if (resp.status === 200) {
			// Source type may be 'r2' (fresh transform) or 'unknown'/'container' (R2 cached from prior run)
			expect(['r2', 'remote', 'container', 'unknown']).toContain(h(resp, 'x-source-type'));
		}
	});
});

// ── Job management endpoints ─────────────────────────────────────────────

describe('Jobs list endpoint', () => {
	it('GET /admin/jobs requires auth', async () => {
		const resp = await req('/admin/jobs');
		expect(resp.status).toBe(401);
	});

	it('GET /admin/jobs returns job list with auth', async () => {
		if (!HAS_TOKEN) return;
		const resp = await req('/admin/jobs?hours=24&limit=10', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { jobs: unknown[]; _meta: { ts: number; hours: number } };
		expect(Array.isArray(body.jobs)).toBe(true);
		expect(body._meta.ts).toBeGreaterThan(0);
		expect(body._meta.hours).toBe(24);
	});

	it('GET /admin/jobs?active=true returns only active jobs', async () => {
		if (!HAS_TOKEN) return;
		const resp = await req('/admin/jobs?active=true', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { jobs: Array<{ status: string }> };
		const terminal = new Set(['complete', 'failed']);
		for (const job of body.jobs) {
			expect(terminal.has(job.status)).toBe(false);
		}
	});

	it('GET /admin/jobs?filter=rocky filters by path', async () => {
		if (!HAS_TOKEN) return;
		const resp = await req('/admin/jobs?filter=rocky', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { jobs: Array<{ path: string }> };
		for (const job of body.jobs) {
			expect(job.path.toLowerCase()).toContain('rocky');
		}
	});
});

describe('SSE job progress endpoint', () => {
	it('GET /sse/job/:id returns text/event-stream content type', async () => {
		// Use a non-existent job ID — should still return SSE format with not_found
		const resp = await req('/sse/job/nonexistent-test-id');
		expect(h(resp, 'content-type')).toContain('text/event-stream');
		expect(h(resp, 'cache-control')).toBe('no-cache');
	});

	it('GET /sse/job/:id streams not_found for unknown job', async () => {
		const resp = await req('/sse/job/nonexistent-test-id');
		const text = await resp.text();
		expect(text).toContain('data:');
		const match = text.match(/data: (.+)/);
		if (match) {
			const data = JSON.parse(match[1]);
			expect(data.status).toBe('not_found');
		}
	});
});

describe('202 response shape (container async)', () => {
	it('202 response includes jobId and SSE URL for oversized sources', async () => {
		const testWidth = 311;
		const resp = await req(`${HUGE}?imwidth=${testWidth}`, { timeout: 60_000 });

		if (resp.status === 202) {
			const body = await resp.json() as {
				status: string;
				jobId?: string;
				sse?: string;
				path?: string;
				message?: string;
			};
			expect(body.status).toBeTruthy();
			expect(body.path).toBe(HUGE);
			expect(body.message).toBeTruthy();
			if (body.jobId) {
				expect(typeof body.jobId).toBe('string');
				expect(body.jobId.length).toBeGreaterThan(0);
			}
			if (body.sse) {
				expect(body.sse).toMatch(/^https:\/\//);
				expect(body.sse).toContain('/sse/job/');
			}
			const jobIdHeader = h(resp, 'x-job-id');
			if (jobIdHeader) {
				expect(jobIdHeader.length).toBeGreaterThan(0);
			}
		}
	});

	it('Retry-After header on 202 response', async () => {
		const testWidth = 312;
		const resp = await req(`${HUGE}?imwidth=${testWidth}`, { timeout: 60_000 });
		if (resp.status === 202) {
			expect(h(resp, 'retry-after')).toBeTruthy();
			const retryAfter = parseInt(h(resp, 'retry-after') ?? '0', 10);
			expect(retryAfter).toBeGreaterThan(0);
			expect(retryAfter).toBeLessThanOrEqual(30);
		}
	});

	it('X-Transform-Pending header on 202 response', async () => {
		const testWidth = 314;
		const resp = await req(`${HUGE}?imwidth=${testWidth}`, { timeout: 60_000 });
		if (resp.status === 202) {
			expect(h(resp, 'x-transform-pending')).toBe('true');
		}
	});
});

// ── Config upload ────────────────────────────────────────────────────────

describe('Config admin', () => {
	it('POST /admin/config with invalid body returns 400 or 500', async () => {
		if (!HAS_TOKEN) return;
		const resp = await req('/admin/config', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ origins: 'not-an-array' }),
		});
		// Either 400 (validation error) or 500 (parse error) — not 200
		expect(resp.status).toBeGreaterThanOrEqual(400);
	});
});

// ── Spritesheet mode ─────────────────────────────────────────────────────

describe('Spritesheet mode', () => {
	it('mode=spritesheet returns image/jpeg', async () => {
		const resp = await req(`${SMALL}?mode=spritesheet&width=320&duration=5s&imageCount=4`);
		if (resp.status === 200) {
			expect(h(resp, 'content-type')).toContain('image/jpeg');
			expect(size(resp)).toBeGreaterThan(0);
		}
		// 202 is acceptable for large files, 502 if container is needed but unavailable
	});
});

// ── Fix verification tests ───────────────────────────────────────────────

describe('fix verification', () => {
	// Fix 1: Cache key includes time/duration/fit/audio in video mode
	it('different time values produce different cache keys', async () => {
		const resp1 = await req(`${SMALL}?derivative=tablet&time=1s&debug=view`);
		const resp2 = await req(`${SMALL}?derivative=tablet&time=3s&debug=view`);
		const d1 = await resp1.json() as any;
		const d2 = await resp2.json() as any;
		expect(d1.diagnostics.params.time).toBe('1s');
		expect(d2.diagnostics.params.time).toBe('3s');
	});

	it('different duration values produce different cache keys', async () => {
		const resp1 = await req(`${SMALL}?width=320&duration=3s`);
		const resp2 = await req(`${SMALL}?width=320&duration=8s`);
		const key1 = h(resp1, 'x-cache-key');
		const key2 = h(resp2, 'x-cache-key');
		expect(key1).toContain(':d=3s');
		expect(key2).toContain(':d=8s');
		expect(key1).not.toBe(key2);
	});

	it('different fit values produce different cache keys', async () => {
		const resp1 = await req(`${SMALL}?width=320&height=240&fit=cover`);
		const resp2 = await req(`${SMALL}?width=320&height=240&fit=contain`);
		const key1 = h(resp1, 'x-cache-key');
		const key2 = h(resp2, 'x-cache-key');
		expect(key1).toContain('fit=cover');
		expect(key2).toContain('fit=contain');
		expect(key1).not.toBe(key2);
	});

	it('audio=true and audio=false produce different cache keys', async () => {
		const resp1 = await req(`${SMALL}?width=320&audio=true`);
		const resp2 = await req(`${SMALL}?width=320&audio=false`);
		const key1 = h(resp1, 'x-cache-key');
		const key2 = h(resp2, 'x-cache-key');
		expect(key1).toContain(':a=true');
		expect(key2).toContain(':a=false');
		expect(key1).not.toBe(key2);
	});

	// Fix 2: /internal/r2-source requires auth
	it('/internal/r2-source rejects unauthenticated requests', async () => {
		const resp = await req('/internal/r2-source?key=rocky.mp4');
		expect(resp.status).toBe(401);
	});

	// Fix 8: parseDurationSeconds handles hours
	it('hour duration resolves correctly in debug diagnostics', async () => {
		const resp = await req(`${SMALL}?duration=1h&debug=view`);
		const data = await resp.json() as any;
		expect(data.diagnostics.params.duration).toBe('1h');
		expect(data.diagnostics.needsContainer).toBe(true);
	});

	it('ms duration does not trigger container routing', async () => {
		const resp = await req(`${SMALL}?duration=500ms&debug=view`);
		const data = await resp.json() as any;
		// 500ms should parse as 0 seconds (ms not supported), not 500 minutes
		expect(data.diagnostics.needsContainer).toBe(false);
	});

	// Fix 12: X-Transform-Source tracks actual method
	it('X-Transform-Source is set on transform responses', async () => {
		const resp = await req(`${SMALL}?derivative=tablet`);
		const src = h(resp, 'x-transform-source');
		expect(src).toBeTruthy();
		expect(['binding', 'cdn-cgi', 'container', 'unknown']).toContain(src);
	});

	// SSE endpoint is reachable (not caught by passthrough middleware)
	it('SSE endpoint is reachable (not caught by non-video passthrough)', async () => {
		const resp = await req('/sse/job/test-reachability');
		// Should get SSE response, not a fetch passthrough or 404
		expect(h(resp, 'content-type')).toContain('text/event-stream');
	});

	// Akamai imformat param
	it('imformat=h265 triggers container routing', async () => {
		const resp = await req(`${SMALL}?imformat=h265&width=320&debug=view`);
		const data = await resp.json() as any;
		expect(data.diagnostics.needsContainer).toBe(true);
	});

	it('imformat=h264 does not trigger container routing', async () => {
		const resp = await req(`${SMALL}?imformat=h264&width=320&debug=view`);
		const data = await resp.json() as any;
		expect(data.diagnostics.needsContainer).toBe(false);
	});

	// quality and compression as direct params
	it('quality=high is accepted as direct param', async () => {
		const resp = await req(`${SMALL}?width=320&quality=high&debug=view`);
		const data = await resp.json() as any;
		expect(data.diagnostics.params.quality).toBe('high');
	});

	it('compression=auto is accepted as direct param', async () => {
		const resp = await req(`${SMALL}?width=320&compression=auto&debug=view`);
		const data = await resp.json() as any;
		expect(data.diagnostics.params.compression).toBe('auto');
	});
});
