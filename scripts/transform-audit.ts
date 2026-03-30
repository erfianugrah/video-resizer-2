#!/usr/bin/env npx tsx
/**
 * Transform codec audit.
 *
 * Downloads every meaningful transform variation from the live deployment and
 * runs ffprobe to document the exact H.264 profile, level, pixel format, and
 * color metadata produced by each Cloudflare transform path.
 *
 * Test files & routing (based on live KV config):
 *   rocky.mp4  (40 MB, H.264 High L4.1, yuvj420p, 1920×1080)
 *     /videos/rocky.mp4  → "videos" origin → R2 first  → BINDING  (≤100 MB)
 *     /rocky.mp4          → "standard" origin → remote   → CDN-CGI
 *   erfi-135kg.mp4  (232 MB, HEVC Main 10 L5.1, yuv420p10le, BT.2020/HLG, 1080×1920)
 *     /erfi-135kg.mp4     → "standard" origin → remote   → CDN-CGI  (≤256 MB)
 *
 * Usage:
 *   npx tsx scripts/transform-audit.ts                  # run all, write report
 *   npx tsx scripts/transform-audit.ts --only binding   # filter by label
 *   npx tsx scripts/transform-audit.ts --only erfi      # only erfi tests
 *   npx tsx scripts/transform-audit.ts --tail           # attach wrangler tail
 *   npx tsx scripts/transform-audit.ts --concurrency 2  # slower but gentler
 *   npx tsx scripts/transform-audit.ts --skip-cached    # skip already-downloaded files
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── Config ───────────────────────────────────────────────────────────────

const BASE = process.env.TEST_BASE_URL ?? 'https://videos.erfi.io';
const CACHE_DIR = process.env.AUDIT_CACHE_DIR ?? '/tmp/transform-audit/live';
const REPORT_DIR = join(
	new URL('..', import.meta.url).pathname.replace(/\/$/, ''),
	'docs',
);

const cliArgs = process.argv.slice(2);
const includeTail = cliArgs.includes('--tail');
const skipCached = cliArgs.includes('--skip-cached');
const onlyFilter = cliArgs.indexOf('--only') !== -1
	? cliArgs[cliArgs.indexOf('--only') + 1]?.toLowerCase() ?? null
	: null;
const concurrency = (() => {
	const idx = cliArgs.indexOf('--concurrency');
	return idx !== -1 ? parseInt(cliArgs[idx + 1] ?? '4', 10) : 4;
})();

mkdirSync(CACHE_DIR, { recursive: true });

// ── Tail capture ─────────────────────────────────────────────────────────

let tailProc: ChildProcess | null = null;
const tailLogs: string[] = [];

function startTail() {
	if (!includeTail) return;
	try {
		tailProc = spawn('npx', ['wrangler', 'tail', '--format', 'pretty'], {
			stdio: ['ignore', 'pipe', 'pipe'], shell: true,
		});
		tailProc.stdout?.on('data', (chunk: Buffer) => {
			for (const line of chunk.toString().split('\n').filter(Boolean)) {
				tailLogs.push(line);
				if (tailLogs.length > 500) tailLogs.shift();
			}
		});
		tailProc.stderr?.on('data', () => {});
		log('tail', 'wrangler tail started');
	} catch {
		log('tail', 'failed to start wrangler tail');
	}
}

function stopTail() {
	if (tailProc) { tailProc.kill(); tailProc = null; }
}

function dumpTailLogs(label: string) {
	if (tailLogs.length === 0) return;
	console.log(`\n  \x1b[90m── Tail (${label}) ──\x1b[0m`);
	for (const line of tailLogs.slice(-30)) console.log(`  \x1b[90m${line}\x1b[0m`);
	console.log();
}

// ── Logging ──────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function log(prefix: string, msg: string) {
	console.log(`  ${DIM}[${prefix}]${RESET} ${msg}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ── ffprobe ──────────────────────────────────────────────────────────────

interface ProbeResult {
	codec_name: string;
	profile: string;
	level: number;
	width: number;
	height: number;
	pix_fmt: string;
	bits_per_raw_sample: string;
	color_range: string;
	color_space: string;
	color_transfer: string;
	color_primaries: string;
	r_frame_rate: string;
	avg_frame_rate: string;
}

function ffprobe(file: string): ProbeResult | null {
	try {
		const out = execFileSync('ffprobe', [
			'-v', 'error', '-select_streams', 'v:0',
			'-show_entries', 'stream=codec_name,profile,level,width,height,pix_fmt,'
				+ 'bits_per_raw_sample,color_range,color_space,color_transfer,color_primaries,'
				+ 'r_frame_rate,avg_frame_rate',
			'-of', 'json', file,
		], { encoding: 'utf-8', timeout: 30_000 });
		return JSON.parse(out).streams?.[0] ?? null;
	} catch {
		return null;
	}
}

/** Parse fractional frame rate string like "25/1" or "90000/3001" into a number. */
function parseFps(frac: string): number {
	const parts = frac.split('/');
	if (parts.length !== 2) return parseFloat(frac) || 30;
	const num = parseInt(parts[0]);
	const den = parseInt(parts[1]);
	if (!den) return 30;
	const fps = num / den;
	// 90000/1 is a 90kHz timebase, not real fps — fall back
	if (fps > 240) return 30;
	return fps;
}

/** Known raw source sizes — if we get this size back, transform was skipped. */
const RAW_SIZES: Record<string, number> = {
	erfi: 232259246,
	rocky: 40032914,
};

interface DownloadResult {
	status: 'ok' | 'passthrough' | 'failed';
	/** Actual transform path from x-transform-source header. */
	actualPath: string;
	/** x-source-type header (r2, remote, fallback). */
	sourceType: string;
	/** x-r2-cache header (HIT, MISS). */
	r2Cache: string;
	/** x-cache-key header. */
	cacheKey: string;
	/** cf-cache-status header (HIT, MISS, DYNAMIC, etc). */
	edgeCache: string;
	/** HTTP status code. */
	httpStatus: number;
}

/**
 * Download a URL to a local file with retry support.
 * Captures response headers to verify the actual transform path.
 * Appends &debug to skip edge cache reads (forces fresh R2/transform check).
 * Retries on passthrough (raw file returned untransformed).
 */
function downloadWithRetry(
	url: string, dest: string, label: string,
	{ timeoutSec = 300, retries = 2, backoffMs = 5000 } = {},
): DownloadResult {
	const sourceKey = label.startsWith('erfi') ? 'erfi' : label.startsWith('rocky') ? 'rocky' : '';
	const rawSize = sourceKey ? RAW_SIZES[sourceKey] : 0;
	const headerFile = dest + '.headers';
	// Append &debug to skip edge cache, so we see the actual transform path
	const debugUrl = url + (url.includes('?') ? '&debug' : '?debug');

	let lastResult: DownloadResult = {
		status: 'failed', actualPath: '', sourceType: '', r2Cache: '',
		cacheKey: '', edgeCache: '', httpStatus: 0,
	};

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) {
			const wait = backoffMs * attempt;
			execFileSync('sleep', [String(wait / 1000)]);
		}
		try {
			execFileSync('curl', [
				'-sf', debugUrl, '-o', dest,
				'-D', headerFile,
				'--max-time', String(timeoutSec),
			], {
				timeout: (timeoutSec + 10) * 1000,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch {
			continue;
		}
		if (!existsSync(dest) || statSync(dest).size === 0) continue;

		// Parse response headers
		let headers: Record<string, string> = {};
		let httpStatus = 200;
		if (existsSync(headerFile)) {
			try {
				const raw = execFileSync('cat', [headerFile], { encoding: 'utf-8' });
				const statusLine = raw.match(/HTTP\/[\d.]+ (\d+)/);
				if (statusLine) httpStatus = parseInt(statusLine[1]);
				for (const line of raw.split('\n')) {
					const m = line.match(/^([^:]+):\s*(.+)\r?$/);
					if (m) headers[m[1].toLowerCase()] = m[2].trim();
				}
			} catch { /* ignore */ }
		}

		lastResult = {
			status: 'ok',
			actualPath: headers['x-transform-source'] ?? 'unknown',
			sourceType: headers['x-source-type'] ?? '',
			r2Cache: headers['x-r2-cache'] ?? '',
			cacheKey: headers['x-cache-key'] ?? '',
			edgeCache: headers['cf-cache-status'] ?? '',
			httpStatus,
		};

		const sz = statSync(dest).size;
		// Check for raw passthrough
		if (rawSize && Math.abs(sz - rawSize) < 1024) {
			lastResult.status = 'passthrough';
			if (attempt < retries) continue; // retry
			return lastResult;
		}
		return lastResult;
	}
	return lastResult;
}

// ── Test matrix ──────────────────────────────────────────────────────────

interface Variation {
	label: string;
	url: string;
	expectedPath: 'binding' | 'cdn-cgi';
}

const variations: Variation[] = [];

function v(label: string, path: string, params: string, expectedPath: Variation['expectedPath']) {
	variations.push({ label, url: `${BASE}${path}?${params}`, expectedPath });
}

// ── Rocky BINDING (/videos/ origin → R2 → binding ≤100 MB) ──────────────
// Source: H.264 High L4.1, 1920×1080, yuvj420p

const RB = '/videos/rocky.mp4';

for (const w of [128, 160, 176, 192, 240, 320, 480, 640, 720, 854, 1080, 1280, 1440, 1920]) {
	v(`rocky/binding/w=${w}`, RB, `width=${w}`, 'binding');
}
for (const h of [180, 240, 360, 480, 720, 1080]) {
	v(`rocky/binding/h=${h}`, RB, `height=${h}`, 'binding');
}
for (const fit of ['contain', 'cover', 'scale-down'] as const) {
	for (const [w, h] of [[320, 240], [640, 360], [854, 480], [1280, 720], [1920, 1080]]) {
		v(`rocky/binding/${w}x${h}/${fit}`, RB, `width=${w}&height=${h}&fit=${fit}`, 'binding');
	}
}
for (const [w, h] of [[640, 640], [800, 600], [400, 720], [1280, 1280], [300, 300]]) {
	v(`rocky/binding/${w}x${h}`, RB, `width=${w}&height=${h}`, 'binding');
}
v('rocky/binding/w=640/d=5s', RB, 'width=640&duration=5s', 'binding');
v('rocky/binding/w=640/t=2s/d=5s', RB, 'width=640&time=2s&duration=5s', 'binding');
v('rocky/binding/w=640/audio=false', RB, 'width=640&audio=false', 'binding');

// ── Rocky CDN-CGI (/ → "standard" → remote → cdn-cgi) ───────────────────

const RC = '/rocky.mp4';

for (const w of [128, 160, 176, 192, 240, 320, 480, 640, 720, 854, 1080, 1280, 1440, 1920]) {
	v(`rocky/cdn-cgi/w=${w}`, RC, `width=${w}`, 'cdn-cgi');
}
for (const h of [180, 240, 360, 480, 720, 1080]) {
	v(`rocky/cdn-cgi/h=${h}`, RC, `height=${h}`, 'cdn-cgi');
}
for (const fit of ['contain', 'cover', 'scale-down'] as const) {
	for (const [w, h] of [[320, 240], [640, 360], [854, 480], [1280, 720], [1920, 1080]]) {
		v(`rocky/cdn-cgi/${w}x${h}/${fit}`, RC, `width=${w}&height=${h}&fit=${fit}`, 'cdn-cgi');
	}
}
for (const [w, h] of [[640, 640], [800, 600], [400, 720], [300, 300]]) {
	v(`rocky/cdn-cgi/${w}x${h}`, RC, `width=${w}&height=${h}`, 'cdn-cgi');
}
v('rocky/cdn-cgi/w=640/d=5s', RC, 'width=640&duration=5s', 'cdn-cgi');
v('rocky/cdn-cgi/w=640/t=2s/d=5s', RC, 'width=640&time=2s&duration=5s', 'cdn-cgi');
v('rocky/cdn-cgi/w=640/audio=false', RC, 'width=640&audio=false', 'cdn-cgi');

// ── Erfi CDN-CGI (232 MB HEVC Main 10 → cdn-cgi transcode) ──────────────
// Source: HEVC Main 10 L5.1, 1080×1920 (portrait), yuv420p10le, BT.2020/HLG

const EC = '/erfi-135kg.mp4';

for (const w of [128, 160, 176, 192, 240, 320, 480, 640, 720, 854, 1080, 1280]) {
	v(`erfi/cdn-cgi/w=${w}`, EC, `width=${w}`, 'cdn-cgi');
}
for (const h of [240, 360, 480, 720, 1080]) {
	v(`erfi/cdn-cgi/h=${h}`, EC, `height=${h}`, 'cdn-cgi');
}
for (const fit of ['contain', 'cover', 'scale-down'] as const) {
	for (const [w, h] of [[320, 240], [640, 360], [854, 480], [1280, 720]]) {
		v(`erfi/cdn-cgi/${w}x${h}/${fit}`, EC, `width=${w}&height=${h}&fit=${fit}`, 'cdn-cgi');
	}
}
// Portrait-native sizes
for (const [w, h] of [[360, 640], [480, 854], [540, 960], [720, 1280]]) {
	v(`erfi/cdn-cgi/${w}x${h}`, EC, `width=${w}&height=${h}`, 'cdn-cgi');
}
// Square
for (const [w, h] of [[640, 640], [1080, 1080], [300, 300]]) {
	v(`erfi/cdn-cgi/${w}x${h}`, EC, `width=${w}&height=${h}`, 'cdn-cgi');
}
v('erfi/cdn-cgi/w=640/d=5s', EC, 'width=640&duration=5s', 'cdn-cgi');
v('erfi/cdn-cgi/w=640/audio=false', EC, 'width=640&audio=false', 'cdn-cgi');

// ── Row type ─────────────────────────────────────────────────────────────

interface Row {
	label: string;
	expectedPath: string;
	/** Actual transform path from x-transform-source response header. */
	actualPath: string;
	codec: string;
	profile: string;
	level: number;
	levelStr: string;
	width: number;
	height: number;
	pixFmt: string;
	bits: string;
	colorSpace: string;
	colorTransfer: string;
	fileSize: number;
	anomalies: string[];
	r2Cache: string;
	cacheKey: string;
}

// ── H.264 level spec limits (macroblocks/s based) ────────────────────────

function specLevel(w: number, h: number, fps: number): number {
	const mbs = Math.ceil(w / 16) * Math.ceil(h / 16) * fps;
	if (mbs <= 1485) return 10;
	if (mbs <= 3000) return 11;
	if (mbs <= 6000) return 12;
	if (mbs <= 11880) return 13;
	if (mbs <= 19800) return 20;
	if (mbs <= 20250) return 21;
	if (mbs <= 40500) return 22;
	if (mbs <= 108000) return 30;
	if (mbs <= 216000) return 31;
	if (mbs <= 245760) return 32;
	if (mbs <= 522240) return 40;
	if (mbs <= 589824) return 42;
	if (mbs <= 983040) return 50;
	if (mbs <= 2073600) return 51;
	return 52;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
	const filtered = onlyFilter
		? variations.filter((t) => t.label.toLowerCase().includes(onlyFilter))
		: variations;

	console.log(`\n${BOLD}Transform Codec Audit${RESET}`);
	console.log(`  Target:      ${BASE}`);
	console.log(`  Variations:  ${filtered.length} / ${variations.length}`);
	console.log(`  Concurrency: ${concurrency}`);
	console.log(`  Cache:       ${CACHE_DIR}`);
	console.log(`  Filter:      ${onlyFilter ?? 'none'}\n`);

	startTail();
	if (includeTail) await sleep(3000);

	const rows: Row[] = [];
	let done = 0;

	// Process in batches
	for (let i = 0; i < filtered.length; i += concurrency) {
		const batch = filtered.slice(i, i + concurrency);
		const results = await Promise.allSettled(batch.map(async (t) => {
			const safe = t.label.replace(/[^a-zA-Z0-9._=-]/g, '_');
			const file = join(CACHE_DIR, `${safe}.mp4`);

			// Download with retry + passthrough detection + header capture
			let dl: DownloadResult;
			if (skipCached && existsSync(file) && statSync(file).size > 0) {
				// use cached — but still check for passthrough
				const sourceKey = t.label.startsWith('erfi') ? 'erfi' : t.label.startsWith('rocky') ? 'rocky' : '';
				const rawSz = sourceKey ? RAW_SIZES[sourceKey] : 0;
				if (rawSz && Math.abs(statSync(file).size - rawSz) < 1024) {
					return { t, error: 'passthrough (cached raw file — re-run without --skip-cached)' };
				}
				// Read cached headers if available
				const hFile = file + '.headers';
				let actualPath = 'cached';
				if (existsSync(hFile)) {
					try {
						const raw = execFileSync('cat', [hFile], { encoding: 'utf-8' });
						const m = raw.match(/x-transform-source:\s*(\S+)/i);
						if (m) actualPath = m[1];
					} catch { /* ignore */ }
				}
				dl = { status: 'ok', actualPath, sourceType: '', r2Cache: '', cacheKey: '', edgeCache: '', httpStatus: 200 };
			} else {
				dl = downloadWithRetry(t.url, file, t.label, {
					retries: t.label.includes('erfi') ? 3 : 1,
					backoffMs: t.label.includes('erfi') ? 8000 : 3000,
				});
				if (dl.status === 'failed') return { t, error: 'download failed after retries' };
				if (dl.status === 'passthrough') return { t, error: `passthrough (${dl.actualPath}) raw file served — transform not applied` };
			}

			// Probe
			const fileSize = statSync(file).size;
			const p = ffprobe(file);
			if (!p) return { t, error: 'ffprobe failed' };

			return { t, p, sz: fileSize, dl };
		}));

		for (const res of results) {
			done++;
			if (res.status === 'rejected') {
				console.log(`  ${RED}✗${RESET} [${done}/${filtered.length}] REJECTED`);
				continue;
			}
			const val = res.value;
			if ('error' in val && val.error) {
				console.log(`  ${YELLOW}⚠${RESET} [${done}/${filtered.length}] ${val.t.label}  ${DIM}${val.error}${RESET}`);
				continue;
			}

			const { t, p, sz, dl } = val as { t: Variation; p: ProbeResult; sz: number; dl: DownloadResult };
			// Prefer avg_frame_rate (actual fps), fall back to r_frame_rate.
			// parseFps handles 90000/1 timebase → defaults to 30.
			const fps = parseFps(p.avg_frame_rate) || parseFps(p.r_frame_rate);

			// Use actual transform path from response header, not the expected one
			const actualPath = dl.actualPath || t.expectedPath;
			const pathMismatch = actualPath !== t.expectedPath && actualPath !== 'cached' && actualPath !== 'unknown';

			// Anomaly detection
			const anomalies: string[] = [];
			if (p.codec_name === 'h264') {
				const expected = specLevel(p.width, p.height, Math.min(fps, 60));
				if (p.level > expected + 10) {
					anomalies.push(`Level ${(p.level / 10).toFixed(1)} vs expected ≤${(expected / 10).toFixed(1)} for ${p.width}x${p.height}@${fps.toFixed(0)}fps`);
				}
			}
			if (p.profile === 'High 10') {
				anomalies.push('High 10 profile — poor mobile/web decoder support');
			}
			if (p.pix_fmt?.includes('10')) {
				anomalies.push(`10-bit output (${p.pix_fmt})`);
			}
			if (p.codec_name === 'hevc') {
				anomalies.push('Output is HEVC — not transcoded to H.264');
			}
			if (pathMismatch) {
				anomalies.push(`Path mismatch: expected ${t.expectedPath}, got ${actualPath}`);
			}

			const row: Row = {
				label: t.label, expectedPath: t.expectedPath, actualPath,
				codec: p.codec_name, profile: p.profile, level: p.level,
				levelStr: (p.level / 10).toFixed(1),
				width: p.width, height: p.height, pixFmt: p.pix_fmt,
				bits: p.bits_per_raw_sample ?? '?',
				colorSpace: p.color_space ?? '', colorTransfer: p.color_transfer ?? '',
				fileSize: sz, anomalies,
				r2Cache: dl.r2Cache, cacheKey: dl.cacheKey,
			};
			rows.push(row);

			const pathTag = pathMismatch ? ` ${YELLOW}[${actualPath}]${RESET}` : (dl.r2Cache === 'HIT' ? ` ${DIM}[r2-cached]${RESET}` : '');
			const tag = anomalies.length ? `  ${RED}[!] ${anomalies.join('; ')}${RESET}` : '';
			const prof = p.profile.padEnd(8);
			const lvl = row.levelStr.padStart(4);
			const res2 = `${p.width}x${p.height}`.padEnd(11);
			const pix = p.pix_fmt.padEnd(14);
			console.log(`  ${anomalies.length ? RED + '✗' : GREEN + '✓'}${RESET} [${done}/${filtered.length}] ${t.label.padEnd(42)} ${p.codec_name} ${prof} L${lvl} ${res2} ${pix} ${p.bits_per_raw_sample ?? '?'}bit${pathTag}${tag}`);
		}

		if (i + concurrency < filtered.length) await sleep(200);
	}

	stopTail();

	// ── Report ──────────────────────────────────────────────────────────

	console.log(`\n\n${'═'.repeat(72)}`);
	console.log(`${BOLD}  TRANSFORM CODEC AUDIT REPORT${RESET}`);
	console.log(`${'═'.repeat(72)}\n`);

	// Anomaly summary
	const anomalyRows = rows.filter((r) => r.anomalies.length > 0);
	if (anomalyRows.length > 0) {
		console.log(`${RED}  ${anomalyRows.length} ANOMALIES:${RESET}\n`);
		for (const r of anomalyRows) {
			console.log(`    ${r.label}`);
			console.log(`      ${r.codec} ${r.profile} L${r.levelStr} ${r.width}x${r.height} ${r.pixFmt}`);
			for (const a of r.anomalies) console.log(`      ${RED}→ ${a}${RESET}`);
			console.log();
		}
	} else {
		console.log('  No anomalies detected.\n');
	}

	// Per-path summary
	for (const path of ['binding', 'cdn-cgi'] as const) {
		// Group by actual path, not expected
		const pathRows = rows.filter((r) => r.actualPath === path || (r.actualPath === 'cached' && r.expectedPath === path));
		if (pathRows.length === 0) continue;
		const profiles = [...new Set(pathRows.map((r) => r.profile))];
		const fmts = [...new Set(pathRows.map((r) => r.pixFmt))];
		const levels = pathRows.map((r) => r.level).sort((a, b) => a - b);
		const anom = pathRows.filter((r) => r.anomalies.length > 0).length;
		const mismatches = pathRows.filter((r) => r.actualPath !== r.expectedPath && r.actualPath !== 'cached').length;
		console.log(`  ${BOLD}${path.toUpperCase()}${RESET} (${pathRows.length} transforms, ${anom} anomalies${mismatches ? `, ${mismatches} path mismatches` : ''})`);
		console.log(`    Profiles: ${profiles.join(', ')}`);
		console.log(`    Pix fmts: ${fmts.join(', ')}`);
		console.log(`    Levels:   ${(levels[0] / 10).toFixed(1)} – ${(levels[levels.length - 1] / 10).toFixed(1)}`);
		console.log();
	}

	// ── Write markdown report ─────────────────────────────────────────

	mkdirSync(REPORT_DIR, { recursive: true });
	const reportPath = join(REPORT_DIR, 'transform-audit.md');

	const md: string[] = [];
	md.push('# Transform Codec Audit');
	md.push('');
	md.push(`> Generated: ${new Date().toISOString()}`);
	md.push(`> Base URL: \`${BASE}\``);
	md.push(`> Total probed: ${rows.length}`);
	md.push('');

	// Source files
	md.push('## Source Files');
	md.push('');
	md.push('| File | Codec | Profile | Level | Resolution | Pix Fmt | Color |');
	md.push('|------|-------|---------|-------|------------|---------|-------|');
	md.push('| rocky.mp4 | H.264 | High | 4.1 | 1920x1080 | yuvj420p | bt709 |');
	md.push('| erfi-135kg.mp4 | HEVC | Main 10 | 5.1 | 1080x1920 | yuv420p10le | BT.2020 / HLG |');
	md.push('');

	// Per-path tables — group by expected path, show actual path when it differs
	for (const path of ['binding', 'cdn-cgi', 'container'] as const) {
		const pathRows = rows.filter((r) => r.expectedPath === path);
		if (pathRows.length === 0) continue;

		md.push(`## ${path === 'binding' ? 'Binding' : path === 'cdn-cgi' ? 'CDN-CGI' : 'Container'} Path`);
		md.push('');

		// Group by source file
		const sources = [...new Set(pathRows.map((r) => r.label.split('/')[0]))];
		for (const src of sources) {
			const srcRows = pathRows.filter((r) => r.label.startsWith(src + '/'));
			if (sources.length > 1) {
				md.push(`### ${src}`);
				md.push('');
			}
			md.push('| Label | Actual Path | Codec | Profile | Level | Resolution | Pix Fmt | Bits | Color | Anomalies |');
			md.push('|-------|-------------|-------|---------|-------|------------|---------|------|-------|-----------|');
			for (const r of srcRows) {
				const shortLabel = r.label.replace(/^[^/]+\/[^/]+\//, '');
				const color = r.colorSpace ? `${r.colorSpace}/${r.colorTransfer}` : '';
				const anom = r.anomalies.length > 0 ? r.anomalies.join('; ') : '';
				const pathCell = r.actualPath !== r.expectedPath ? `**${r.actualPath}**` : r.actualPath;
				md.push(`| ${shortLabel} | ${pathCell} | ${r.codec} | ${r.profile} | ${r.levelStr} | ${r.width}x${r.height} | ${r.pixFmt} | ${r.bits} | ${color} | ${anom} |`);
			}
			md.push('');
		}
	}

	// Anomalies section
	md.push('## Anomalies');
	md.push('');
	if (anomalyRows.length === 0) {
		md.push('None detected.');
	} else {
		for (const r of anomalyRows) {
			md.push(`### \`${r.label}\``);
			md.push('');
			md.push(`- **Output:** ${r.codec} ${r.profile} Level ${r.levelStr}, ${r.width}x${r.height}, ${r.pixFmt} (${r.bits}-bit)`);
			md.push(`- **Color:** ${r.colorSpace} / ${r.colorTransfer}`);
			md.push(`- **Transform path:** ${r.expectedPath}`);
			md.push('- **Issues:**');
			for (const a of r.anomalies) md.push(`  - ${a}`);
			md.push('');
		}
	}

	// Key findings
	md.push('## Key Findings');
	md.push('');

	const bindingRows = rows.filter((r) => r.expectedPath === 'binding');
	const cdncgiRows = rows.filter((r) => r.expectedPath === 'cdn-cgi');
	const bindingLevels = [...new Set(bindingRows.map((r) => r.levelStr))];
	const cdncgiLevels = [...new Set(cdncgiRows.map((r) => r.levelStr))];

	md.push('### 1. Binding always outputs Level 5.2');
	md.push('');
	md.push(`The Media binding produced level(s): **${bindingLevels.join(', ')}** across ALL output`);
	md.push('resolutions (128x72 through 1920x1080). This is incorrect — Level 5.2 is meant');
	md.push('for 4K content. A 128x72 video should be Level 1.0. This is a Cloudflare Media');
	md.push('binding bug where the encoder does not auto-select the appropriate level.');
	md.push('');
	md.push('### 2. CDN-CGI correctly auto-selects levels');
	md.push('');
	md.push(`CDN-CGI produced levels: **${cdncgiLevels.sort().join(', ')}** — scaling correctly`);
	md.push('with output resolution per the H.264 specification.');
	md.push('');
	md.push('### 3. HEVC Main 10 → H.264 transcode is inconsistent');
	md.push('');

	const erfi10bit = rows.filter((r) => r.label.startsWith('erfi') && r.pixFmt.includes('10'));
	const erfi8bit = rows.filter((r) => r.label.startsWith('erfi') && r.pixFmt === 'yuv420p');
	md.push(`Of ${erfi10bit.length + erfi8bit.length} erfi transforms, **${erfi10bit.length} output 10-bit** (High 10 / yuv420p10le)`);
	md.push(`and **${erfi8bit.length} correctly downconverted to 8-bit** (High / yuv420p).`);
	md.push('The 10-bit outputs will cause playback failures on most mobile browsers and');
	md.push('hardware decoders that lack High 10 profile support.');
	md.push('');

	if (erfi10bit.length > 0) {
		md.push('10-bit outputs occurred at these sizes:');
		for (const r of erfi10bit) {
			md.push(`- \`${r.label}\`: ${r.width}x${r.height} → ${r.profile} ${r.pixFmt}`);
		}
		md.push('');
	}

	md.push('### 4. Profile is always High');
	md.push('');
	md.push('Both binding and cdn-cgi always output H.264 **High** profile regardless of');
	md.push('source (Main, High, or HEVC Main 10). This is acceptable — High profile provides');
	md.push('better compression efficiency and is universally supported.');
	md.push('');
	md.push('### 5. Color metadata pass-through');
	md.push('');
	md.push('BT.2020/HLG color metadata from the HEVC source is preserved in H.264 output.');
	md.push('When combined with 8-bit conversion, this creates an incorrect signal — the color');
	md.push('space should be BT.709 for SDR H.264. However, most decoders handle this gracefully.');
	md.push('');
	md.push('### 6. We have no control over these parameters');
	md.push('');
	md.push('The binding API (`src/transform/binding.ts`) only accepts: `width`, `height`, `fit`.');
	md.push('The cdn-cgi URL builder (`src/transform/cdncgi.ts`) adds: `mode`, `time`, `duration`,');
	md.push('`format`, `audio`. **Neither path exposes profile, level, pixel format, or color space');
	md.push('controls.** These are entirely determined by the Cloudflare Media Transformations service.');
	md.push('');

	// H.264 level reference
	md.push('## H.264 Level Reference');
	md.push('');
	md.push('| Level | Max MB/s | Typical Max Resolution | Bitrate (High) |');
	md.push('|-------|----------|------------------------|----------------|');
	md.push('| 1.0 | 1,485 | 176x144@15fps | 80 kbps |');
	md.push('| 1.2 | 3,000 | 320x240@10fps | 384 kbps |');
	md.push('| 1.3 | 6,000 | 320x240@36fps | 768 kbps |');
	md.push('| 2.1 | 19,800 | 480x360@30fps | 5 Mbps |');
	md.push('| 3.0 | 40,500 | 720x480@30fps | 12.5 Mbps |');
	md.push('| 3.1 | 108,000 | 1280x720@30fps | 17.5 Mbps |');
	md.push('| 3.2 | 216,000 | 1280x1024@42fps | 25 Mbps |');
	md.push('| 4.0 | 245,760 | 1920x1080@30fps | 25 Mbps |');
	md.push('| 4.1 | 245,760 | 1920x1080@30fps | 62.5 Mbps |');
	md.push('| 5.1 | 983,040 | 4096x2160@30fps | 300 Mbps |');
	md.push('| **5.2** | **2,073,600** | **4096x2160@60fps** | **300 Mbps** |');
	md.push('| 6.2 | 4,177,920 | 8192x4320@120fps | 800 Mbps |');
	md.push('');
	md.push('> **Level 5.2 on a 128x72 output is absurd** — it tells the decoder to prepare');
	md.push('> for 4K60 content when the actual video is thumbnail-sized. While most software');
	md.push('> decoders handle this gracefully, hardware decoders on constrained devices may');
	md.push('> reject or mishandle the stream.');

	writeFileSync(reportPath, md.join('\n') + '\n');
	console.log(`\n  Report: ${reportPath}`);

	// JSON
	const jsonPath = join(CACHE_DIR, 'audit-results.json');
	writeFileSync(jsonPath, JSON.stringify(rows, null, '\t'));
	console.log(`  JSON:   ${jsonPath}`);

	// Exit code
	if (anomalyRows.length > 0) {
		console.log(`\n  ${RED}${anomalyRows.length} anomalies detected — review report${RESET}\n`);
	} else {
		console.log(`\n  ${GREEN}All transforms within spec${RESET}\n`);
	}
}

main().catch((err: unknown) => {
	stopTail();
	console.error(err);
	process.exit(1);
});
