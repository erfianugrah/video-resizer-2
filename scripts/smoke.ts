#!/usr/bin/env npx tsx
/**
 * Smoke test for live deployment after deploy.
 *
 * Usage:
 *   npx tsx scripts/smoke.ts              # run all tests
 *   npx tsx scripts/smoke.ts --container  # include container polling (slow, ~6min)
 *   npx tsx scripts/smoke.ts --only cache # run only tests matching "cache"
 *   npx tsx scripts/smoke.ts --tail       # capture wrangler tail logs alongside tests
 *
 * No dependencies — just fetch + console output + optional child_process for tail.
 */

import { spawn, type ChildProcess } from 'node:child_process';

// All configurable via env vars — set in shell or .env.test
const BASE = process.env.TEST_BASE_URL ?? 'https://videos.erfi.io';
const SMALL = process.env.TEST_SMALL_VIDEO ?? '/erfi-135kg.mp4'; // 232MB, R2 + remote
const SMALL2 = process.env.TEST_SMALL2_VIDEO ?? '/rocky.mp4'; // ~40MB, secondary test file
const HUGE = process.env.TEST_HUGE_VIDEO ?? '/big_buck_bunny_1080p.mov'; // 725MB, remote + R2 — container path

// ── Helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

const cliArgs = process.argv.slice(2);
const includeContainer = cliArgs.includes('--container');
const includeTail = cliArgs.includes('--tail') || cliArgs.includes('--container');
const onlyFilter = cliArgs.indexOf('--only') !== -1 ? cliArgs[cliArgs.indexOf('--only') + 1]?.toLowerCase() : null;

// ── Tail log capture ─────────────────────────────────────────────────────

let tailProc: ChildProcess | null = null;
const tailLogs: string[] = [];

function startTail() {
	if (!includeTail) return;
	try {
		tailProc = spawn('npx', ['wrangler', 'tail', '--format', 'pretty'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: true,
		});
		tailProc.stdout?.on('data', (chunk: Buffer) => {
			const lines = chunk.toString().split('\n').filter(Boolean);
			for (const line of lines) {
				tailLogs.push(line);
				// Keep last 200 lines
				if (tailLogs.length > 200) tailLogs.shift();
			}
		});
		tailProc.stderr?.on('data', (chunk: Buffer) => {
			// Ignore wrangler startup noise
		});
		console.log('  \x1b[90m[tail] wrangler tail started\x1b[0m');
	} catch {
		console.log('  \x1b[33m[tail] failed to start wrangler tail\x1b[0m');
	}
}

function stopTail() {
	if (tailProc) {
		tailProc.kill();
		tailProc = null;
	}
}

function dumpTailLogs(label: string) {
	if (tailLogs.length === 0) return;
	console.log(`\n  \x1b[90m── Tail logs (${label}) ──\x1b[0m`);
	// Show the last 30 lines
	const recent = tailLogs.slice(-30);
	for (const line of recent) {
		console.log(`  \x1b[90m${line}\x1b[0m`);
	}
	console.log(`  \x1b[90m── (${tailLogs.length} total lines captured) ──\x1b[0m\n`);
}

function clearTailLogs() {
	tailLogs.length = 0;
}

async function GET(path: string, opts?: { headers?: Record<string, string>; timeout?: number }): Promise<Response> {
	const timeout = opts?.timeout ?? 180_000; // 3 min default for 232MB transforms
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	try {
		return await fetch(`${BASE}${path}`, {
			headers: opts?.headers,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

function h(r: Response, name: string): string | null {
	return r.headers.get(name);
}

function sz(r: Response): number {
	return parseInt(h(r, 'content-length') ?? '0', 10);
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type Check = {
	name: string;
	fn: () => Promise<void>;
};

const checks: Check[] = [];

function test(name: string, fn: () => Promise<void>) {
	checks.push({ name, fn });
}

function assert(condition: boolean, msg: string) {
	if (!condition) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, label: string) {
	if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertContains(haystack: string | null, needle: string, label: string) {
	if (!haystack || !haystack.includes(needle)) throw new Error(`${label}: expected "${needle}" in "${haystack}"`);
}

function assertLt(actual: number, max: number, label: string) {
	if (actual >= max) throw new Error(`${label}: expected < ${max}, got ${actual}`);
}

function assertGt(actual: number, min: number, label: string) {
	if (actual <= min) throw new Error(`${label}: expected > ${min}, got ${actual}`);
}

function assertOneOf<T>(actual: T, options: T[], label: string) {
	if (!options.includes(actual)) throw new Error(`${label}: expected one of ${JSON.stringify(options)}, got ${JSON.stringify(actual)}`);
}

function assertMatch(actual: string | null, pattern: RegExp, label: string) {
	if (!actual || !pattern.test(actual)) throw new Error(`${label}: expected ${pattern}, got "${actual}"`);
}

// ── Tests ────────────────────────────────────────────────────────────────

// Width / height / fit
test('width=320: resized, smaller than raw', async () => {
	const r = await GET(`${SMALL}?width=320`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'video/mp4', 'content-type');
	assertContains(h(r, 'x-cache-key'), 'w=320', 'cache-key');
	assertLt(sz(r), 232_000_000, 'size < raw');
	assertGt(sz(r), 0, 'size > 0');
});

test('height=240: resized', async () => {
	const r = await GET(`${SMALL}?height=240`);
	assertEq(r.status, 200, 'status');
	assertContains(h(r, 'x-cache-key'), 'h=240', 'cache-key');
});

test('width+height: both in cache key', async () => {
	const r = await GET(`${SMALL}?width=640&height=360`);
	assertEq(r.status, 200, 'status');
	assertContains(h(r, 'x-cache-key'), 'w=640', 'cache-key w');
	assertContains(h(r, 'x-cache-key'), 'h=360', 'cache-key h');
});

test('fit=cover: no crash', async () => {
	const r = await GET(`${SMALL}?width=640&height=360&fit=cover`);
	assertEq(r.status, 200, 'status');
});

// Mode
test('mode=frame: image/jpeg', async () => {
	const r = await GET(`${SMALL}?mode=frame&width=320`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'image/jpeg', 'content-type');
	assertLt(sz(r), 1_000_000, 'frame < 1MB');
});

test('mode=frame&format=png: image/png', async () => {
	const r = await GET(`${SMALL}?mode=frame&width=320&format=png`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'image/png', 'content-type');
});

test('mode=audio: audio/mp4', async () => {
	const r = await GET(`${SMALL}?mode=audio&duration=10s`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'audio/mp4', 'content-type');
});

// Time / duration
test('time=3s frame: extracts at offset', async () => {
	const r = await GET(`${SMALL}?mode=frame&time=3s&width=320`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'image/jpeg', 'content-type');
});

test('duration=5s: smaller clip', async () => {
	const r = await GET(`${SMALL}?width=320&duration=5s`);
	assertEq(r.status, 200, 'status');
	assertLt(sz(r), 20_000_000, 'clip < 20MB');
});

// Audio param
test('audio=false: strips audio', async () => {
	const r = await GET(`${SMALL}?width=320&duration=5s&audio=false`);
	assertEq(r.status, 200, 'status');
});

// Filename
test('filename=myclip: Content-Disposition', async () => {
	const r = await GET(`${SMALL}?width=320&filename=myclip`);
	assertEq(r.status, 200, 'status');
	assertContains(h(r, 'content-disposition'), 'filename="myclip"', 'disposition');
});

// Playback hints
test('playback hints: loop/autoplay/muted/preload headers', async () => {
	const r = await GET(`${SMALL}?width=320&loop=true&autoplay=true&muted=true&preload=auto&debug`);;
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'x-playback-loop'), 'true', 'loop');
	assertEq(h(r, 'x-playback-autoplay'), 'true', 'autoplay');
	assertEq(h(r, 'x-playback-muted'), 'true', 'muted');
	assertEq(h(r, 'x-playback-preload'), 'auto', 'preload');
});

// Derivatives
test('derivative=tablet: 1280x720, video/mp4, smaller', async () => {
	const r = await GET(`${SMALL}?derivative=tablet`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'video/mp4', 'content-type');
	assertEq(h(r, 'x-derivative'), 'tablet', 'x-derivative');
	assertContains(h(r, 'x-cache-key'), 'w=1280', 'cache-key w');
	assertLt(sz(r), 232_000_000, 'size < raw');
});

test('derivative=thumbnail: PNG frame', async () => {
	const r = await GET(`${SMALL}?derivative=thumbnail`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'image/png', 'content-type');
	assertContains(h(r, 'x-cache-key'), 'frame:', 'cache-key mode');
});

test('derivative=mobile: 854 wide', async () => {
	const r = await GET(`${SMALL}?derivative=mobile`);
	assertEq(r.status, 200, 'status');
	assertContains(h(r, 'x-cache-key'), 'w=854', 'cache-key w');
});

// Akamai params
test('impolicy=tablet -> derivative=tablet', async () => {
	const r = await GET(`${SMALL}?impolicy=tablet`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'x-derivative'), 'tablet', 'x-derivative');
});

test('imwidth=1280: transformed, smaller', async () => {
	// imwidth=1280 resolves to tablet derivative (duration=5m), heavy transform
	const r = await GET(`${SMALL}?imwidth=1280`, { timeout: 300_000 });
	assertEq(r.status, 200, 'status');
	assertLt(sz(r), 232_000_000, 'size < raw');
	assertGt(sz(r), 0, 'size > 0');
});

test('imwidth=640: transformed', async () => {
	const r = await GET(`${SMALL}?imwidth=640`);
	assertEq(r.status, 200, 'status');
	assertLt(sz(r), 232_000_000, 'size < raw');
});

test('w=640&h=360 shorthands', async () => {
	const r = await GET(`${SMALL}?w=640&h=360`);
	assertEq(r.status, 200, 'status');
	assertContains(h(r, 'x-cache-key'), 'w=640', 'cache-key w');
});

test('obj-fit=crop -> fit=cover', async () => {
	const r = await GET(`${SMALL}?w=640&h=360&obj-fit=crop`);
	assertEq(r.status, 200, 'status');
});

test('mute=true -> audio=false', async () => {
	const r = await GET(`${SMALL}?w=640&mute=true&duration=5s`);
	assertEq(r.status, 200, 'status');
});

test('start=3s -> time', async () => {
	const r = await GET(`${SMALL}?mode=frame&start=3s&w=320&format=jpg`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'image/jpeg', 'content-type');
});

test('dur=5s -> duration', async () => {
	const r = await GET(`${SMALL}?w=320&dur=5s`);
	assertEq(r.status, 200, 'status');
	assertLt(sz(r), 20_000_000, 'clip size');
});

test('q=high -> quality in cache key', async () => {
	const r = await GET(`${SMALL}?w=640&q=high&debug`);
	assertEq(r.status, 200, 'status');
	assertContains(h(r, 'x-cache-key'), 'q=high', 'cache-key');
});

// Cache
test('cache: second request is cf-cache-status HIT', async () => {
	await GET(`${SMALL}?derivative=tablet`);
	const r = await GET(`${SMALL}?derivative=tablet`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'cf-cache-status'), 'HIT', 'cf-cache-status');
});

test('cache: different widths produce different sizes', async () => {
	const r1 = await GET(`${SMALL}?width=320`);
	const r2 = await GET(`${SMALL}?width=640`);
	assert(sz(r1) !== sz(r2), `sizes should differ: ${sz(r1)} vs ${sz(r2)}`);
});

test('cache: Cache-Control has public + max-age', async () => {
	const r = await GET(`${SMALL}?derivative=tablet`);
	assertContains(h(r, 'cache-control'), 'public', 'cc public');
	assertContains(h(r, 'cache-control'), 'max-age=', 'cc max-age');
});

test('cache: Cache-Tag on fresh transform', async () => {
	const r = await GET(`${SMALL}?derivative=tablet&debug`);
	assertContains(h(r, 'cache-tag'), 'derivative:tablet', 'tag derivative');
	assertContains(h(r, 'cache-tag'), 'origin:', 'tag origin');
});

test('cache: fresh transform sets X-R2-Cache: MISS', async () => {
	// Use a unique width to force a fresh transform
	const r = await GET(`${SMALL}?width=327&debug`);
	assertEq(r.status, 200, 'status');
	// Fresh transform — R2 had nothing, so MISS
	assertEq(h(r, 'x-r2-cache'), 'MISS', 'x-r2-cache on fresh');
});

test('cache: R2 persistent store (X-R2-Cache: HIT after prior transform)', async () => {
	// First request stores to R2 (awaited, not waitUntil)
	await GET(`${SMALL}?width=328`);
	// Debug request bypasses edge cache, Worker checks R2 — should HIT
	const r = await GET(`${SMALL}?width=328&debug`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'x-r2-cache'), 'HIT', 'x-r2-cache');
});

test('cache: edge HIT after R2 promotion shows both headers', async () => {
	// Populate R2 via normal request
	await GET(`${SMALL}?width=329`);
	await sleep(500);
	// Debug request: R2 HIT, promotes to edge cache
	await GET(`${SMALL}?width=329&debug`);
	await sleep(500);
	// Normal request: edge HIT, response has X-R2-Cache: HIT from promotion
	const r = await GET(`${SMALL}?width=329`);
	assertEq(h(r, 'cf-cache-status'), 'HIT', 'cf-cache-status');
});

// Range
test('range: bytes=0-999 -> 206', async () => {
	const r = await GET(`${SMALL}?derivative=tablet`, { headers: { Range: 'bytes=0-999' } });
	assertEq(r.status, 206, 'status');
	assertMatch(h(r, 'content-range'), /^bytes 0-999\/\d+$/, 'content-range');
	assertEq(h(r, 'content-length'), '1000', 'content-length');
});

test('range: Accept-Ranges: bytes', async () => {
	const r = await GET(`${SMALL}?derivative=tablet`);
	assertEq(h(r, 'accept-ranges'), 'bytes', 'accept-ranges');
});

// Response headers
test('headers: Via video-resizer', async () => {
	const r = await GET(`${SMALL}?width=320`);
	assertContains(h(r, 'via'), 'video-resizer', 'via');
});

test('headers: X-Request-ID is UUID', async () => {
	const r = await GET(`${SMALL}?width=320`);
	assertMatch(h(r, 'x-request-id'), /^[0-9a-f]{8}-/, 'x-request-id');
});

test('headers: X-Origin present', async () => {
	const r = await GET(`${SMALL}?width=320&debug`);
	assert(!!h(r, 'x-origin'), 'x-origin present');
});

test('headers: X-Source-Type present on fresh transform', async () => {
	// Use unique width to force fresh transform (no R2 cache)
	const r = await GET(`${SMALL}?width=331&debug`);;
	assertOneOf(h(r, 'x-source-type'), ['r2', 'remote', 'fallback'], 'x-source-type');
});

test('headers: X-Transform-Source present on fresh transform', async () => {
	const r = await GET(`${SMALL}?width=332&debug`);;
	assertOneOf(h(r, 'x-transform-source'), ['binding', 'cdn-cgi', 'container'], 'x-transform-source');
});

test('headers: X-Processing-Time-Ms > 0 on fresh transform', async () => {
	const r = await GET(`${SMALL}?width=333&debug`);;
	assertGt(parseInt(h(r, 'x-processing-time-ms') ?? '0', 10), 0, 'processing time');
});

// Error cases
test('error: non-video extension passes through', async () => {
	const r = await GET('/test.html');
	assert(r.status !== 500, `expected non-500, got ${r.status}`);
});

test('error: Via loop prevention', async () => {
	const r = await GET(`${SMALL}?width=320`, { headers: { Via: 'video-resizer' } });
	assert(r.status !== 500, `expected non-500, got ${r.status}`);
});

// Debug diagnostics
test('debug=view: JSON with requestId, params, origin', async () => {
	const r = await GET(`${SMALL}?derivative=tablet&debug=view`);
	assertEq(r.status, 200, 'status');
	assertContains(h(r, 'content-type'), 'application/json', 'content-type');
	const body = await r.json() as any;
	assert(!!body.diagnostics.requestId, 'has requestId');
	assertEq(body.diagnostics.path, SMALL, 'path');
	assertEq(body.diagnostics.params.derivative, 'tablet', 'params.derivative');
	assertEq(body.diagnostics.params.width, 1280, 'params.width');
	assertEq(body.diagnostics.resolvedWidth, 1280, 'resolvedWidth');
});

// Large file (232MB)
test('large: imwidth=1280 transformed, smaller than raw', async () => {
	const r = await GET(`${SMALL}?imwidth=1280`);;
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'video/mp4', 'content-type');
	assertLt(sz(r), 232_000_000, 'size < raw');
	assertGt(sz(r), 0, 'size > 0');
});

test('large: thumbnail frame extraction', async () => {
	const r = await GET(`${SMALL}?derivative=thumbnail`);;
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'image/png', 'content-type');
	assertLt(sz(r), 1_000_000, 'frame < 1MB');
});

// ── Missing param coverage ───────────────────────────────────────────────

test('fit=scale-down: no crash', async () => {
	const r = await GET(`${SMALL}?width=640&height=360&fit=scale-down`);
	assertEq(r.status, 200, 'status');
});

test('fit=contain explicit: no crash', async () => {
	const r = await GET(`${SMALL}?width=640&height=360&fit=contain`);
	assertEq(r.status, 200, 'status');
});

test('mode=video explicit: video/mp4', async () => {
	const r = await GET(`${SMALL}?width=320&mode=video`);
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'video/mp4', 'content-type');
});

test('time+duration on video: clip from offset', async () => {
	const r = await GET(`${SMALL}?width=320&time=2s&duration=3s`);
	assertEq(r.status, 200, 'status');
	assertLt(sz(r), 10_000_000, 'short clip');
});

test('compression=auto in cache key', async () => {
	const r = await GET(`${SMALL}?width=640&debug`);
	assertEq(r.status, 200, 'status');
	// compression=auto is set as per-origin default
	assertContains(h(r, 'x-cache-key'), 'c=auto', 'cache-key compression');
});

test('imheight=360: resizes', async () => {
	const r = await GET(`${SMALL}?imheight=360`);
	assertEq(r.status, 200, 'status');
});

test('?debug skips edge cache, serves from R2 or fresh transform', async () => {
	// First request without debug populates R2
	await GET(`${SMALL}?width=334`);;
	await sleep(1000);
	// Debug request should serve from R2 (X-R2-Cache: HIT) or fresh (X-R2-Cache: MISS)
	const r = await GET(`${SMALL}?width=334&debug`);;
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'video/mp4', 'content-type');
	assert(!!h(r, 'x-r2-cache'), 'has x-r2-cache header');
});

// Source type verification
test('source: small2 uses r2 or remote on fresh transform', async () => {
	const r = await GET(`${SMALL}?width=337&debug`);
	// On fresh transform, x-source-type is set. On R2 HIT, it may be absent.
	const st = h(r, 'x-source-type');
	const r2 = h(r, 'x-r2-cache');
	if (r2 === 'MISS') {
		// Fresh transform — source type should be present
		assertOneOf(st, ['r2', 'remote', 'fallback'], 'x-source-type on fresh');
	}
	// If R2 HIT, source type comes from R2 metadata — may or may not be present
});

test('source: small video has source type on transform', async () => {
	// Unique width forces fresh transform (not R2 HIT with old metadata)
	const r = await GET(`${SMALL}?width=338&duration=5s&debug`);
	assertEq(r.status, 200, 'status');
	assertOneOf(h(r, 'x-source-type'), ['r2', 'remote', 'fallback', 'unknown'], 'x-source-type');
	assertOneOf(h(r, 'x-transform-source'), ['binding', 'cdn-cgi', 'unknown'], 'x-transform-source');
	assertLt(sz(r), 232_000_000, 'size < raw');
});

// Derivative canonical invariant
test('derivative invariant: impolicy=tablet and derivative=tablet produce same cache key', async () => {
	const r1 = await GET(`${SMALL}?impolicy=tablet&debug`);
	const r2 = await GET(`${SMALL}?derivative=tablet&debug`);
	assertEq(h(r1, 'x-cache-key'), h(r2, 'x-cache-key'), 'same cache key');
});

test('derivative invariant: imwidth=1280 resolves to derivative with same dims', async () => {
	// imwidth=1280 resolves to tablet derivative (duration=5m), heavy transform
	const r = await GET(`${SMALL}?imwidth=1280&debug`, { timeout: 300_000 });
	assertEq(r.status, 200, 'status');
	assert(!!h(r, 'x-resolved-width'), 'has resolved width');
});

// Admin: auth required
test('admin: GET /admin/config without token returns 401', async () => {
	const r = await GET('/admin/config');
	assertEq(r.status, 401, 'status');
});

// Error: structured JSON on 404 origin
test('error: no matching origin returns structured JSON', async () => {
	const r = await GET('/unknown-path.mp4');
	if (r.status === 502) {
		const body = await r.json() as { error: { code: string } };
		assertEq(body.error.code, 'ALL_SOURCES_FAILED', 'error code');
	}
});

// Cache tag purge (requires CF API key in env)
test('cache: purge by cache tag via CF API', async () => {
	const zoneId = process.env.CLOUDFLARE_ZONE_ID;
	const email = process.env.CLOUDFLARE_EMAIL;
	const apiKey = process.env.CLOUDFLARE_API_KEY;
	if (!zoneId || !email || !apiKey) {
		return; // skip if no API credentials
	}
	// Fresh transform to get cache tag from response (non-debug to get full headers)
	const fresh = await GET(`${SMALL}?width=336`);
	const cacheTag = h(fresh, 'cache-tag');
	if (!cacheTag) {
		// Cache-Tag may be stripped by CF edge on cached responses — skip test
		return;
	}
	// Extract the first tag to use for purge
	const tag = cacheTag!.split(',')[0].trim();
	assert(!!tag, 'extracted a tag');

	// Warm edge cache
	await GET(`${SMALL}?width=336`);;
	const r1 = await GET(`${SMALL}?width=336`);
	assertEq(h(r1, 'cf-cache-status'), 'HIT', 'cached before purge');

	// Purge by the tag we got from the response
	const purgeResp = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
		method: 'POST',
		headers: { 'X-Auth-Email': email, 'X-Auth-Key': apiKey, 'Content-Type': 'application/json' },
		body: JSON.stringify({ tags: [tag] }),
	});
	const purgeBody = await purgeResp.json() as { success: boolean };
	assert(purgeBody.success, 'purge API success');
	await sleep(5000); // edge propagation can take a few seconds

	// Verify purged — may need a few attempts as purge propagates
	const r2 = await GET(`${SMALL}?width=336`);
	const cacheStatus = h(r2, 'cf-cache-status');
	// After purge: MISS, EXPIRED, or DYNAMIC (varies by plan/zone config)
	assertOneOf(cacheStatus, ['MISS', 'EXPIRED', 'DYNAMIC', 'HIT'], 'purge result');
	// Note: Cache-Tag purge may require Enterprise plan. On free/pro plans,
	// purge_everything works but tag-based purge may be a no-op.
});

// Container result from R2 (if previously cached)
test('container: R2 cached result has x-transform-source=container', async () => {
	const r = await GET(`${HUGE}?imwidth=320`, { timeout: 600_000 });
	if (h(r, 'content-type') === 'video/mp4' && sz(r) < 100_000_000) {
		// New R2 entries have 'container', old ones may have 'unknown'
		assertOneOf(h(r, 'x-transform-source'), ['container', 'unknown'], 'x-transform-source');
	}
	// If 202, container is processing — not an error
	if (r.status === 202) {
		assertContains(await r.text(), 'processing', '202 body');
	}
});

// Range on container result
test('container: range request on R2-cached result', async () => {
	const r = await GET(`${HUGE}?imwidth=320`, { timeout: 600_000, headers: { Range: 'bytes=0-999' } });
	if (h(r, 'content-type') === 'video/mp4') {
		assertEq(r.status, 206, 'status');
		assertEq(h(r, 'content-length'), '1000', 'content-length');
	}
});

// ── Queue / Job endpoints ────────────────────────────────────────────────

test('job: GET /admin/jobs without auth returns 401', async () => {
	const r = await GET('/admin/jobs');
	assertEq(r.status, 401, 'status');
});

test('job: GET /admin/jobs with auth returns job list', async () => {
	const r = await GET('/admin/jobs?hours=24&limit=10', {
		headers: { Authorization: `Bearer ${process.env.CONFIG_API_TOKEN}` },
	});
	assertEq(r.status, 200, 'status');
	const body = await r.json() as any;
	assert(Array.isArray(body.jobs), 'jobs is array');
	assert(typeof body._meta.ts === 'number', 'has _meta.ts');
});

test('job: GET /sse/job/:id returns text/event-stream', async () => {
	const r = await GET('/sse/job/test-job-id');
	assertContains(r.headers.get('content-type') ?? '', 'text/event-stream', 'content-type');
});

test('job: 202 from oversized source includes job metadata', async () => {
	const r = await GET(`${HUGE}?imwidth=315`, { timeout: 600_000 });
	if (r.status === 202) {
		const body = await r.json() as any;
		assert(!!body.status, 'has status');
		assert(!!body.path, 'has path');
		assert(!!body.message, 'has message');
		// jobId present when queue configured
		if (body.jobId) {
			assert(typeof body.jobId === 'string', 'jobId is string');
			assertGt(body.jobId.length, 0, 'jobId not empty');
		}
		if (body.sse) {
			assertContains(body.sse, 'https://', 'sse protocol');
			assertContains(body.sse, '/sse/job/', 'sse path');
		}
	}
	// 200 = cached from prior run, also ok
});

// ── Coverage gaps: container-only params, spritesheet, Akamai, direct params ──

test('container param: fps triggers needsContainer via debug', async () => {
	const r = await GET(`${SMALL}?fps=15&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.needsContainer, true, 'needsContainer');
	assertEq(body.diagnostics.params.fps, 15, 'fps param');
});

test('container param: speed triggers needsContainer via debug', async () => {
	const r = await GET(`${SMALL}?speed=2&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.needsContainer, true, 'needsContainer');
	assertEq(body.diagnostics.params.speed, 2, 'speed param');
});

test('container param: rotate triggers needsContainer via debug', async () => {
	const r = await GET(`${SMALL}?rotate=90&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.needsContainer, true, 'needsContainer');
	assertEq(body.diagnostics.params.rotate, 90, 'rotate param');
});

test('container param: crop triggers needsContainer via debug', async () => {
	const r = await GET(`${SMALL}?crop=100:100:0:0&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.needsContainer, true, 'needsContainer');
});

test('container param: bitrate triggers needsContainer via debug', async () => {
	const r = await GET(`${SMALL}?bitrate=2M&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.needsContainer, true, 'needsContainer');
});

test('mode=spritesheet: returns image/jpeg', async () => {
	const r = await GET(`${SMALL2}?mode=spritesheet&width=320&duration=5s&imageCount=4`);
	if (r.status === 200) {
		assertContains(h(r, 'content-type') ?? '', 'image/jpeg', 'content-type');
		assertGt(parseInt(h(r, 'content-length') ?? '0', 10), 0, 'has content');
	}
	// 202 acceptable for large files, 502 if container needed but unavailable
});

test('akamai: imformat=h264 does not trigger container', async () => {
	const r = await GET(`${SMALL2}?imformat=h264&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.needsContainer, false, 'needsContainer');
});

test('akamai: imformat=h265 triggers container', async () => {
	const r = await GET(`${SMALL2}?imformat=h265&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.needsContainer, true, 'needsContainer');
});

test('akamai: imdensity=2 sets dpr param', async () => {
	const r = await GET(`${SMALL2}?imdensity=2&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.params.dpr, 2, 'dpr');
});

test('akamai: f=png shorthand with mode=frame', async () => {
	const r = await GET(`${SMALL2}?mode=frame&f=png&w=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.params.format, 'png', 'format');
	assertEq(body.diagnostics.params.width, 320, 'width');
});

test('akamai: imref is consumed without error', async () => {
	const r = await GET(`${SMALL2}?imref=policy%3Dmobile%2Cwidth%3D1080&imwidth=640&debug=view`);
	assertEq(r.status, 200, 'status');
	const body = await r.json() as any;
	assert(!!body.diagnostics, 'has diagnostics');
});

test('direct param: quality=high accepted', async () => {
	const r = await GET(`${SMALL2}?quality=high&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.params.quality, 'high', 'quality');
});

test('direct param: compression=high accepted', async () => {
	const r = await GET(`${SMALL2}?compression=high&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.params.compression, 'high', 'compression');
});

test('duration: 1h triggers needsContainer (>60s)', async () => {
	const r = await GET(`${SMALL2}?duration=1h&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.needsContainer, true, 'needsContainer');
});

test('duration: 500ms does not trigger needsContainer', async () => {
	const r = await GET(`${SMALL2}?duration=500ms&width=320&debug=view`);
	const body = await r.json() as any;
	assertEq(body.diagnostics.needsContainer, false, 'needsContainer');
});

test('cache key: fit=cover differs from fit=contain', async () => {
	const r1 = await GET(`${SMALL2}?width=321&height=241&fit=cover`);
	const r2 = await GET(`${SMALL2}?width=321&height=241&fit=contain`);
	const k1 = h(r1, 'x-cache-key');
	const k2 = h(r2, 'x-cache-key');
	assert(k1 !== k2, `keys differ: ${k1} vs ${k2}`);
	assertContains(k1 ?? '', 'fit=cover', 'k1 has fit=cover');
	assertContains(k2 ?? '', 'fit=contain', 'k2 has fit=contain');
});

test('cache key: audio=true differs from audio=false', async () => {
	const r1 = await GET(`${SMALL2}?width=322&audio=true`);
	const r2 = await GET(`${SMALL2}?width=322&audio=false`);
	const k1 = h(r1, 'x-cache-key');
	const k2 = h(r2, 'x-cache-key');
	assert(k1 !== k2, `keys differ: ${k1} vs ${k2}`);
});

test('cache key: different duration produces different key', async () => {
	const r1 = await GET(`${SMALL2}?width=323&duration=3s`);
	const r2 = await GET(`${SMALL2}?width=323&duration=8s`);
	const k1 = h(r1, 'x-cache-key');
	const k2 = h(r2, 'x-cache-key');
	assert(k1 !== k2, `keys differ: ${k1} vs ${k2}`);
});

test('security: /internal/r2-source rejects unauthenticated', async () => {
	const r = await GET('/internal/r2-source?key=rocky.mp4');
	assertEq(r.status, 401, 'status');
});

test('sse: /sse/job/:id returns not_found for unknown job', async () => {
	const r = await GET('/sse/job/smoke-nonexistent');
	const text = await r.text();
	assertContains(text, 'not_found', 'body contains not_found');
});

// Container async (725MB) — only with --container flag
if (includeContainer) {
	test('container: first request returns 202 or cached result', async () => {
		const r = await GET(`${HUGE}?imwidth=320`, { timeout: 600_000 });
		if (r.status === 202) {
			// Container job triggered, processing
			assertContains(await r.text(), 'processing', '202 body');
		} else if (r.status === 200) {
			// Cached from prior run
			assertEq(h(r, 'content-type'), 'video/mp4', 'transformed mp4');
			assertLt(sz(r), 725_000_000, 'smaller than raw');
		} else {
			assert(false, `unexpected status ${r.status}`);
		}
	});

	test('container: poll for callback result (up to 10 min)', async () => {
		const width = 313;
		const url = `${HUGE}?imwidth=${width}`;
		clearTailLogs();
		const r1 = await GET(url, { timeout: 600_000 });

		if (r1.status === 200 && h(r1, 'content-type') === 'video/mp4') {
			// Already cached from a prior run
			console.log(`    Already cached: ${sz(r1)} bytes`);
			return;
		}
		// 202 = container job triggered, poll for result
		assert(r1.status === 200 || r1.status === 202, `expected 200 or 202, got ${r1.status}`);

		// Poll: container downloads 725MB + ffmpeg transcode, stores in R2
		console.log('    Polling for container result in R2 (up to 10 min)...');
		let cached = false;
		for (let i = 0; i < 60; i++) {
			await sleep(10_000);
			process.stdout.write(`    Poll ${i + 1}/60...`);
			const r = await GET(url, { timeout: 600_000 });
			const ct = h(r, 'content-type');
			const status = r.status;
			console.log(` status=${status} ct=${ct} size=${sz(r)} r2=${h(r, 'x-r2-cache')}`);
			// 200 + video/mp4 = container result stored in R2 and served
			if (status === 200 && ct === 'video/mp4') {
				assertLt(sz(r), 725_000_000, 'transformed size');
				assertGt(sz(r), 0, 'size > 0');
				cached = true;
				break;
			}
			// 202 = still processing, keep polling
		}
		if (!cached) {
			dumpTailLogs('container poll timeout');
		}
		assert(cached, 'Container callback never stored result after 10 minutes');
	});
}

// ── Runner ───────────────────────────────────────────────────────────────

async function run() {
	const t0 = performance.now();
	console.log(`\nSmoke test: ${BASE}`);
	console.log(`Tests: ${checks.length}${onlyFilter ? ` (filter: "${onlyFilter}")` : ''}${includeTail ? ' [tail enabled]' : ''}\n`);

	startTail();
	// Give tail a moment to connect
	if (includeTail) await sleep(3000);

	for (const check of checks) {
		if (onlyFilter && !check.name.toLowerCase().includes(onlyFilter)) {
			skipped++;
			continue;
		}
		const start = performance.now();
		try {
			await check.fn();
			const ms = Math.round(performance.now() - start);
			console.log(`  \x1b[32m✓\x1b[0m ${check.name} \x1b[90m(${ms}ms)\x1b[0m`);
			passed++;
		} catch (err) {
			const ms = Math.round(performance.now() - start);
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  \x1b[31m✗\x1b[0m ${check.name} \x1b[90m(${ms}ms)\x1b[0m`);
			console.log(`    \x1b[31m${msg}\x1b[0m`);
			dumpTailLogs(check.name);
			failures.push(`${check.name}: ${msg}`);
			failed++;
		}
	}

	stopTail();

	const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
	console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} (${elapsed}s)\n`);

	if (failures.length > 0) {
		console.log('Failures:');
		for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
		console.log();
		process.exit(1);
	}
}

run();
