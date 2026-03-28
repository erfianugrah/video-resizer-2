#!/usr/bin/env npx tsx
/**
 * Smoke test for videos.erfi.io after deploy.
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

const BASE = 'https://videos.erfi.io';
const SMALL = '/rocky.mp4';
const MEDIUM = '/erfi-135kg.mp4';
const HUGE = '/big_buck_bunny_1080p.mov';

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
	const timeout = opts?.timeout ?? 30_000;
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
	assertLt(sz(r), 40_000_000, 'size < raw');
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
	const r = await GET(`${SMALL}?width=320&loop=true&autoplay=true&muted=true&preload=auto&debug`);
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
	assertLt(sz(r), 40_000_000, 'size < raw');
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
	const r = await GET(`${SMALL}?imwidth=1280`);
	assertEq(r.status, 200, 'status');
	assertLt(sz(r), 40_000_000, 'size < raw');
	assertGt(sz(r), 0, 'size > 0');
});

test('imwidth=640: transformed', async () => {
	const r = await GET(`${SMALL}?imwidth=640`);
	assertEq(r.status, 200, 'status');
	assertLt(sz(r), 40_000_000, 'size < raw');
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

test('headers: X-Source-Type is r2 or remote', async () => {
	const r = await GET(`${SMALL}?width=320&debug`);
	assertOneOf(h(r, 'x-source-type'), ['r2', 'remote', 'fallback'], 'x-source-type');
});

test('headers: X-Transform-Source is binding or cdn-cgi', async () => {
	const r = await GET(`${SMALL}?width=320&debug`);
	assertOneOf(h(r, 'x-transform-source'), ['binding', 'cdn-cgi'], 'x-transform-source');
});

test('headers: X-Processing-Time-Ms > 0', async () => {
	const r = await GET(`${SMALL}?width=320&debug`);
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
	const r = await GET(`${MEDIUM}?imwidth=1280`, { timeout: 60_000 });
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'video/mp4', 'content-type');
	assertLt(sz(r), 232_000_000, 'size < raw');
	assertGt(sz(r), 0, 'size > 0');
});

test('large: thumbnail frame extraction', async () => {
	const r = await GET(`${MEDIUM}?derivative=thumbnail`, { timeout: 60_000 });
	assertEq(r.status, 200, 'status');
	assertEq(h(r, 'content-type'), 'image/png', 'content-type');
	assertLt(sz(r), 1_000_000, 'frame < 1MB');
});

// Container async (725MB) — only with --container flag
if (includeContainer) {
	test('container: first request returns passthrough or cached result', async () => {
		const r = await GET(`${HUGE}?imwidth=317`, { timeout: 60_000 });
		assertEq(r.status, 200, 'status');
		const pending = h(r, 'x-transform-pending');
		if (pending === 'true') {
			assertEq(h(r, 'content-type'), 'video/quicktime', 'raw .mov passthrough');
			assertGt(sz(r), 700_000_000, 'raw file size');
		} else {
			assertEq(h(r, 'content-type'), 'video/mp4', 'transformed mp4');
			assertLt(sz(r), 725_000_000, 'smaller than raw');
		}
	});

	test('container: poll for callback result (up to 6 min)', async () => {
		// Trigger with unique width
		const width = 313;
		const url = `${HUGE}?imwidth=${width}`;
		clearTailLogs();
		const r1 = await GET(url, { timeout: 60_000 });
		assertEq(r1.status, 200, 'status');

		if (h(r1, 'x-transform-pending') !== 'true') {
			// Already cached from a prior run
			assertEq(h(r1, 'content-type'), 'video/mp4', 'already cached');
			console.log(`    Already cached: ${sz(r1)} bytes`);
			return;
		}

		// Poll: download 725MB + ffmpeg transcode can take 3-6 min
		console.log('    Polling for container callback (up to 6 min)...');
		let cached = false;
		for (let i = 0; i < 36; i++) {
			await sleep(10_000);
			process.stdout.write(`    Poll ${i + 1}/36...`);
			const r = await GET(url, { timeout: 60_000 });
			const ct = h(r, 'content-type');
			const pending = h(r, 'x-transform-pending');
			console.log(` ct=${ct} pending=${pending} size=${sz(r)}`);
			if (pending !== 'true' && ct === 'video/mp4') {
				assertLt(sz(r), 725_000_000, 'transformed size');
				assertGt(sz(r), 0, 'size > 0');
				cached = true;
				break;
			}
		}
		if (!cached) {
			dumpTailLogs('container poll timeout');
		}
		assert(cached, 'Container callback never stored result in cache after 6 minutes');
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
