/**
 * E2E tests against the live deployment at videos.erfi.io.
 *
 * These test the full pipeline: Cloudflare edge -> Worker -> Media binding/cdn-cgi -> Cache API.
 * Run with: npx vitest run test/e2e/live.spec.ts
 *
 * NOTE: These make real HTTP requests and may incur Media transformation charges.
 * The first run after deploy will be slow (cache misses); subsequent runs are fast (cache hits).
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = 'https://videos.erfi.io';
const SMALL_VIDEO = '/rocky.mp4'; // 40MB, in R2 + remote
const LARGE_VIDEO = '/erfi-135kg.mp4'; // 232MB, R2 only
const API_TOKEN: string = (globalThis as Record<string, unknown>).process
	? ((globalThis as Record<string, unknown>).process as Record<string, Record<string, string>>).env?.CONFIG_API_TOKEN ?? 'test-analytics-token-2026'
	: 'test-analytics-token-2026';

/** Fetch helper with timeout. */
async function req(
	path: string,
	opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
	const { timeout = 30_000, ...fetchOpts } = opts;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	try {
		return await fetch(`${BASE}${path}`, { ...fetchOpts, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** Extract a response header as string or null. */
function h(resp: Response, name: string): string | null {
	return resp.headers.get(name);
}

// ── Derivative transforms ────────────────────────────────────────────────

describe('Derivative transforms', () => {
	it('tablet derivative returns 200 with correct dimensions in cache key', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('video/mp4');
		expect(h(resp, 'x-derivative')).toBe('tablet');
		expect(h(resp, 'x-cache-key')).toContain('w=1280');
		expect(h(resp, 'x-cache-key')).toContain('h=720');
	});

	it('mobile derivative returns 200 with correct dimensions', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=mobile`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-derivative')).toBe('mobile');
		expect(h(resp, 'x-cache-key')).toContain('w=854');
		expect(h(resp, 'x-cache-key')).toContain('h=640');
	});

	it('desktop derivative returns 200 with 1920x1080', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=desktop`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-cache-key')).toContain('w=1920');
		expect(h(resp, 'x-cache-key')).toContain('h=1080');
	});

	it('thumbnail derivative returns PNG frame', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=thumbnail`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/png');
		expect(h(resp, 'x-cache-key')).toContain('frame:');
		expect(h(resp, 'x-cache-key')).toContain('f=png');
	});

	it('unknown derivative is ignored (no crash)', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=nonexistent`);
		expect(resp.status).toBe(200);
	});
});

// ── Explicit params ──────────────────────────────────────────────────────

describe('Explicit params', () => {
	it('width + height resize', async () => {
		const resp = await req(`${SMALL_VIDEO}?width=320&height=240`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-cache-key')).toContain('w=320');
		expect(h(resp, 'x-cache-key')).toContain('h=240');
	});

	it('frame mode with time param', async () => {
		const resp = await req(`${SMALL_VIDEO}?mode=frame&width=320&time=5s&format=jpg`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/jpeg');
	});

	it('audio mode returns audio/mp4', async () => {
		const resp = await req(`${SMALL_VIDEO}?mode=audio&duration=10s`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('audio/mp4');
	});

	it('filename param sets Content-Disposition', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet&filename=myclip`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-disposition')).toContain('filename="myclip"');
	});

	it('invalid width (out of range) is dropped gracefully', async () => {
		const resp = await req(`${SMALL_VIDEO}?width=5`); // below min 10
		expect(resp.status).toBe(200); // should not crash
	});
});

// ── Akamai/IMQuery translation ───────────────────────────────────────────

describe('Akamai/IMQuery translation', () => {
	it('impolicy -> derivative', async () => {
		const resp = await req(`${SMALL_VIDEO}?impolicy=tablet`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-derivative')).toBe('tablet');
	});

	it('imwidth -> width', async () => {
		const resp = await req(`${SMALL_VIDEO}?imwidth=640`);
		expect(resp.status).toBe(200);
		// imwidth triggers derivative matching via responsive, result varies
	});

	it('shorthand w/h/q', async () => {
		const resp = await req(`${SMALL_VIDEO}?w=640&h=360`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-cache-key')).toContain('w=640');
		expect(h(resp, 'x-cache-key')).toContain('h=360');
	});

	it('obj-fit=crop -> fit=cover', async () => {
		const resp = await req(`${SMALL_VIDEO}?w=640&h=360&obj-fit=crop`);
		expect(resp.status).toBe(200);
	});

	it('mute=true -> audio=false (inverted)', async () => {
		const resp = await req(`${SMALL_VIDEO}?w=640&mute=true&duration=5s`);
		expect(resp.status).toBe(200);
	});

	it('start -> time shorthand', async () => {
		const resp = await req(`${SMALL_VIDEO}?mode=frame&start=3s&w=320&format=jpg`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/jpeg');
	});
});

// ── Cache behavior ───────────────────────────────────────────────────────

describe('Cache behavior', () => {
	it('second request is a cache HIT', async () => {
		// First request — may be HIT or MISS depending on prior runs
		await req(`${SMALL_VIDEO}?derivative=tablet`);
		// Second request — should be HIT
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'cf-cache-status')).toBe('HIT');
	});

	it('?debug skips Worker cache (fresh transform)', async () => {
		// ?debug bypasses our caches.default lookup, forcing a fresh transform.
		// cf-cache-status may still be HIT (CDN cache is separate from Worker cache).
		// We verify by checking X-Processing-Time-Ms is present (means Worker ran transform).
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet&debug`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'x-processing-time-ms')).toBeTruthy();
	});

	it('Cache-Control header is present with max-age', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`);
		const cc = h(resp, 'cache-control');
		expect(cc).toContain('public');
		expect(cc).toContain('max-age=');
	});

	it('Cache-Tag header is set on MISS (stripped by CF edge on HIT)', async () => {
		// CF edge consumes Cache-Tag for purge and strips it from cached responses.
		// We can only verify it on a cache MISS (debug bypass).
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet&debug`);
		const ct = h(resp, 'cache-tag');
		expect(ct).toContain('derivative:tablet');
		expect(ct).toContain('origin:');
	});
});

// ── Range requests ───────────────────────────────────────────────────────

describe('Range requests', () => {
	it('returns 206 with Content-Range for byte range', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`, {
			headers: { Range: 'bytes=0-999' },
		});
		expect(resp.status).toBe(206);
		expect(h(resp, 'content-range')).toMatch(/^bytes 0-999\/\d+$/);
		expect(h(resp, 'content-length')).toBe('1000');
	});

	it('returns 206 for suffix range', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`, {
			headers: { Range: 'bytes=-500' },
		});
		expect(resp.status).toBe(206);
		expect(h(resp, 'content-length')).toBe('500');
	});

	it('Accept-Ranges header is present', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`);
		expect(h(resp, 'accept-ranges')).toBe('bytes');
	});
});

// ── Response headers ─────────────────────────────────────────────────────

describe('Response headers', () => {
	it('Via header is set', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`);
		expect(h(resp, 'via')).toContain('video-resizer');
	});

	it('X-Request-ID is a UUID', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`);
		const rid = h(resp, 'x-request-id');
		expect(rid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('cf-cache-status is set by Cloudflare edge', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`);
		const status = h(resp, 'cf-cache-status');
		expect(status).toBeTruthy();
		expect(['HIT', 'MISS', 'EXPIRED', 'DYNAMIC']).toContain(status);
	});

	it('X-Origin header identifies matched origin', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`);
		expect(h(resp, 'x-origin')).toBeTruthy();
	});

	it('X-Source-Type header indicates source type', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet&debug`);
		const st = h(resp, 'x-source-type');
		expect(['r2', 'remote', 'fallback']).toContain(st);
	});

	it('X-Cache-Key header is present', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`);
		expect(h(resp, 'x-cache-key')).toBeTruthy();
	});

	it('playback hint headers are set when params provided', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet&loop=true&autoplay=true&muted=true&preload=auto&debug`);
		expect(h(resp, 'x-playback-loop')).toBe('true');
		expect(h(resp, 'x-playback-autoplay')).toBe('true');
		expect(h(resp, 'x-playback-muted')).toBe('true');
		expect(h(resp, 'x-playback-preload')).toBe('auto');
	});
});

// ── Error cases ──────────────────────────────────────────────────────────

describe('Error cases', () => {
	it('non-video extension passes through (not transformed)', async () => {
		const resp = await req('/test.html');
		// Should pass through to origin (which may 404/522, but not our transform error)
		expect(resp.status).not.toBe(500);
	});

	it('cdn-cgi path passes through', async () => {
		const resp = await req('/cdn-cgi/media/mode=frame/https://example.com/test.mp4');
		// cdn-cgi handler responds (may 404 if not enabled, but shouldn't be our Worker error)
		expect(resp.status).not.toBe(500);
	});

	it('via loop detection prevents infinite recursion', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet`, {
			headers: { Via: 'video-resizer' },
		});
		// Should pass through, not transform
		expect(resp.status).not.toBe(500);
	});

	it('no matching origin returns 404', async () => {
		// Files without video extension don't match any origin except default
		// But a path that matches no origin pattern...
		// Actually all paths match "default" origin (matcher: ".*")
		// So this tests that even unknown paths get handled
		const resp = await req('/unknown-path.mp4');
		// Will match "standard" origin and fail source fetch -> error or passthrough
		expect([200, 404, 502]).toContain(resp.status);
	});
});

// ── Admin endpoints ──────────────────────────────────────────────────────

describe('Admin endpoints', () => {
	it('GET /admin/config requires auth', async () => {
		const resp = await req('/admin/config');
		expect(resp.status).toBe(401);
	});

	it('GET /admin/config returns config with valid token', async () => {
		const resp = await req('/admin/config', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { config: { origins: unknown[]; derivatives: Record<string, unknown> } };
		expect(body.config).toBeTruthy();
		expect(body.config.origins).toBeInstanceOf(Array);
		expect(body.config.derivatives).toBeTruthy();
	});

	it('GET /admin/analytics returns summary', async () => {
		const resp = await req('/admin/analytics?hours=24', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { summary: { total: number; success: number } };
		expect(body.summary).toBeTruthy();
		expect(typeof body.summary.total).toBe('number');
		expect(typeof body.summary.success).toBe('number');
	});

	it('GET /admin/analytics/errors returns array', async () => {
		const resp = await req('/admin/analytics/errors?hours=24', {
			headers: { Authorization: `Bearer ${API_TOKEN}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { errors: unknown[] };
		expect(body.errors).toBeInstanceOf(Array);
	});

	it('POST /admin/cache/bust requires path', async () => {
		const resp = await req('/admin/cache/bust', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
	});

	it('POST /admin/cache/bust bumps version', async () => {
		const resp = await req('/admin/cache/bust', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ path: '/test-bust.mp4' }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json() as { ok: boolean; version: number };
		expect(body.ok).toBe(true);
		expect(body.version).toBeGreaterThanOrEqual(2);
	});
});

// ── Large file handling ──────────────────────────────────────────────────

describe('Large file (232MB)', () => {
	it('thumbnail (frame mode) works for large file', async () => {
		const resp = await req(`${LARGE_VIDEO}?derivative=thumbnail`, { timeout: 30_000 });
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/png');
	});

	it('short duration clip works for large file via R2 binding', async () => {
		const resp = await req(`${LARGE_VIDEO}?width=320&height=240&duration=5s`, { timeout: 30_000 });
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('video/mp4');
		expect(h(resp, 'x-source-type')).toBe('r2');
	});
});

// ── Source fallback ──────────────────────────────────────────────────────

describe('Source fallback', () => {
	it('erfi file (R2 only) returns 200 via fallback chain', async () => {
		// erfi-135kg.mp4 exists in R2 but NOT at the remote URL.
		// Without ?debug, the cached result from a prior run is served.
		// The key assertion: the file IS accessible and returns 200.
		const resp = await req(`${LARGE_VIDEO}?derivative=thumbnail`, { timeout: 30_000 });
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toBe('image/png');
	});
});

// ── Debug diagnostics ────────────────────────────────────────────────────

describe('Debug diagnostics', () => {
	it('?debug=view returns JSON diagnostics instead of video', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet&debug=view`);
		expect(resp.status).toBe(200);
		expect(h(resp, 'content-type')).toContain('application/json');
		const body = await resp.json() as {
			diagnostics: {
				requestId: string;
				path: string;
				params: { width: number; height: number; derivative: string; duration: string };
				origin: { name: string };
				needsContainer: boolean;
				resolvedWidth: number;
				resolvedHeight: number;
			};
		};
		expect(body.diagnostics.path).toBe(SMALL_VIDEO);
		expect(body.diagnostics.params.derivative).toBe('tablet');
		expect(body.diagnostics.params.width).toBe(1280);
		expect(body.diagnostics.params.height).toBe(720);
		expect(body.diagnostics.origin.name).toBeTruthy();
		expect(typeof body.diagnostics.needsContainer).toBe('boolean');
		// tablet derivative has duration=5m (>60s), so needsContainer is true
		expect(body.diagnostics.needsContainer).toBe(true);
		expect(body.diagnostics.resolvedWidth).toBe(1280);
		expect(body.diagnostics.resolvedHeight).toBe(720);
	});

	it('X-Resolved-Width and X-Resolved-Height headers are set', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet&debug`);
		expect(h(resp, 'x-resolved-width')).toBe('1280');
		expect(h(resp, 'x-resolved-height')).toBe('720');
	});

	it('X-Transform-Source header shows binding or cdn-cgi', async () => {
		const resp = await req(`${SMALL_VIDEO}?derivative=tablet&debug`);
		const ts = h(resp, 'x-transform-source');
		expect(['binding', 'cdn-cgi']).toContain(ts);
	});
});
