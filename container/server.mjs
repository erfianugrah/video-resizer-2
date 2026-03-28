/**
 * FFmpeg transform server.
 *
 * Runs inside a Cloudflare Container alongside the Worker. Accepts video
 * source data + transform params via POST, runs ffmpeg, returns the
 * transformed output.
 *
 * Endpoints:
 *   POST /transform         — synchronous: upload source, receive output
 *   POST /transform-async   — async: upload source + callbackUrl, respond 202,
 *                              POST result to callbackUrl when done
 *   GET  /health            — health check
 */
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { writeFile, readFile, unlink, mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { availableParallelism, cpus } from 'node:os';

const PORT = 8080;
const WORK_DIR = '/tmp/ffmpeg-work';

// Quality presets: CRF + preset
const QUALITY_PRESETS = {
	low: { crf: '28', preset: 'fast' },
	medium: { crf: '23', preset: 'medium' },
	high: { crf: '18', preset: 'medium' },
};

await mkdir(WORK_DIR, { recursive: true });

const server = createServer(async (req, res) => {
	try {
		if (req.method === 'GET' && req.url === '/health') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
			return;
		}

		if (req.method === 'POST' && req.url === '/transform') {
			await handleTransform(req, res);
			return;
		}

		if (req.method === 'POST' && req.url === '/transform-async') {
			await handleTransformAsync(req, res);
			return;
		}

		// URL-based transform: container fetches source directly (no streaming through DO)
		if (req.method === 'POST' && req.url === '/transform-url') {
			await handleTransformUrl(req, res);
			return;
		}

		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not found' }));
	} catch (err) {
		console.error('Request error:', err);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: err.message }));
	}
});

server.listen(PORT, () => {
	console.log(`FFmpeg server listening on port ${PORT}`);
});

/**
 * Synchronous transform: receive source video, return transformed output.
 *
 * Body: multipart or raw video bytes
 * Headers:
 *   X-Transform-Params: JSON-encoded transform params
 */
async function handleTransform(req, res) {
	const id = randomUUID();
	const inputPath = join(WORK_DIR, `${id}-input`);
	const outputPath = join(WORK_DIR, `${id}-output.mp4`);

	try {
		// Read params from header
		const paramsJson = req.headers['x-transform-params'];
		if (!paramsJson) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing X-Transform-Params header' }));
			return;
		}
		const params = JSON.parse(paramsJson);

		// Buffer input body to file
		const chunks = [];
		for await (const chunk of req) {
			chunks.push(chunk);
		}
		await writeFile(inputPath, Buffer.concat(chunks));

		// Build ffmpeg args
		const args = buildFfmpegArgs(inputPath, outputPath, params);
		console.log(`[${id}] ffmpeg ${args.join(' ')}`);

		// Run ffmpeg
		await runFfmpeg(args);

		// Read output from correct path (may differ by mode/format)
		const actualOutput = findOutputFile(outputPath, params);
		const output = await readFile(actualOutput);
		const contentType = getContentType(params);

		res.writeHead(200, {
			'Content-Type': contentType,
			'Content-Length': output.length.toString(),
		});
		res.end(output);
	} finally {
		// Cleanup temp files (including alternative extensions)
		await unlink(inputPath).catch(() => {});
		await unlink(outputPath).catch(() => {});
		const altExts = ['.png', '.jpg', '.m4a', '.webm'];
		for (const ext of altExts) {
			await unlink(outputPath.replace(/\.mp4$/, ext)).catch(() => {});
		}
	}
}

/**
 * Async transform: receive source + callbackUrl, return 202 immediately,
 * POST result to callbackUrl when done.
 */
async function handleTransformAsync(req, res) {
	const paramsJson = req.headers['x-transform-params'];
	const callbackUrl = req.headers['x-callback-url'];
	if (!paramsJson || !callbackUrl) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Missing X-Transform-Params or X-Callback-Url header' }));
		return;
	}

	const id = randomUUID();
	const inputPath = join(WORK_DIR, `${id}-input`);
	const outputPath = join(WORK_DIR, `${id}-output.mp4`);

	// Buffer input
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(chunk);
	}
	await writeFile(inputPath, Buffer.concat(chunks));

	// Respond 202 immediately
	res.writeHead(202, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ id, status: 'processing' }));

	// Process in background
	try {
		const params = JSON.parse(paramsJson);
		const args = buildFfmpegArgs(inputPath, outputPath, params);
		console.log(`[${id}] async ffmpeg ${args.join(' ')}`);
		await runFfmpeg(args);

		const actualOutput = findOutputFile(outputPath, params);
		const output = await readFile(actualOutput);
		const contentType = getContentType(params);

		// POST result to callback
		await fetch(callbackUrl, {
			method: 'POST',
			headers: {
				'Content-Type': contentType,
				'X-Transform-ID': id,
			},
			body: output,
		});
		console.log(`[${id}] Callback sent to ${callbackUrl}`);
	} catch (err) {
		console.error(`[${id}] Async transform failed:`, err);
		// Try to notify callback of failure
		await fetch(callbackUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Transform-ID': id,
				'X-Transform-Error': 'true',
			},
			body: JSON.stringify({ error: err.message }),
		}).catch(() => {});
	} finally {
		await unlink(inputPath).catch(() => {});
		await unlink(outputPath).catch(() => {});
		const altExts = ['.png', '.jpg', '.m4a', '.webm'];
		for (const ext of altExts) {
			await unlink(outputPath.replace(/\.mp4$/, ext)).catch(() => {});
		}
	}
}

/**
 * Build ffmpeg command-line arguments from transform params.
 */
function buildFfmpegArgs(inputPath, outputPath, params) {
	// Use all available CPU cores for encoding. With custom instance types
	// (up to 4 vCPU), this can cut transcode time by 3-4x.
	const cpuCount = availableParallelism?.() ?? cpus().length;
	const args = ['-y', '-threads', String(cpuCount)];

	// Time offset — placed BEFORE -i for fast input seeking.
	// Convert human-readable (5m, 30s, 1m30s) to seconds — ffmpeg
	// doesn't understand "5m" or "30s" format.
	if (params.time) {
		args.push('-ss', String(parseDuration(params.time)));
	}

	args.push('-i', inputPath);

	// Duration — same conversion needed
	if (params.duration) {
		args.push('-t', String(parseDuration(params.duration)));
	}

	// Video filters
	const vf = [];

	// Scale (width/height) with fit mode support
	// libx264 requires both dimensions to be divisible by 2.
	// -2 auto-calculates the other dimension as even, but user-specified
	// dimensions must also be forced even (round down).
	if (params.width || params.height) {
		const w = params.width ? (params.width % 2 === 0 ? params.width : params.width - 1) : -2;
		const h = params.height ? (params.height % 2 === 0 ? params.height : params.height - 1) : -2;
		const fit = params.fit || 'contain';

		if (fit === 'cover' && params.width && params.height) {
			// Cover: scale UP to fill both dimensions, then center-crop to exact size
			vf.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`);
			vf.push(`crop=${w}:${h}`);
		} else if (fit === 'scale-down') {
			// Scale-down: only shrink, never enlarge. Maintain aspect ratio.
			vf.push(`scale='min(${w},iw)':'min(${h},ih)':force_original_aspect_ratio=decrease`);
			// Ensure even dimensions after clamping
			vf.push(`pad=ceil(iw/2)*2:ceil(ih/2)*2`);
		} else {
			// Contain (default): scale to fit within dimensions, maintain aspect ratio
			if (params.width && params.height) {
				vf.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
				// Ensure even dimensions
				vf.push(`pad=ceil(iw/2)*2:ceil(ih/2)*2`);
			} else {
				vf.push(`scale=${w}:${h}`);
			}
		}
	}

	// FPS
	if (params.fps) {
		vf.push(`fps=${params.fps}`);
	}

	// Speed
	if (params.speed) {
		vf.push(`setpts=${(1 / params.speed).toFixed(4)}*PTS`);
	}

	// Rotation
	if (params.rotate) {
		vf.push(`rotate=${params.rotate}*PI/180`);
	}

	// Crop
	if (params.crop) {
		vf.push(`crop=${params.crop}`);
	}

	// Mode-specific (checked before generic -vf push to build combined filter chains)
	if (params.mode === 'spritesheet') {
		// Extract N frames and tile them into a single image.
		// imageCount defaults to 20 if not specified. Layout: ceil(sqrt(N)) columns.
		const count = params.imageCount || 20;
		const cols = Math.ceil(Math.sqrt(count));
		const rows = Math.ceil(count / cols);

		// Calculate fps to evenly sample `count` frames across the video duration.
		// If duration is specified, use it. Otherwise use select filter with scene detection
		// fallback to fps=1 (1 frame/sec) and let -frames:v limit the output.
		const dur = params.duration ? parseDuration(String(params.duration)) : null;
		if (dur && dur > 0) {
			// Evenly distributed: e.g., 20 frames over 60s = fps=0.333
			const spriteFps = (count / dur).toFixed(4);
			vf.push(`fps=${spriteFps}`, `tile=${cols}x${rows}`);
		} else {
			// No duration known — use select filter to pick N evenly spaced frames.
			// fps=1 samples 1/sec; tile fills the grid; -frames:v limits output.
			vf.push('fps=1', `tile=${cols}x${rows}`);
		}
		args.push('-vf', vf.join(','));
		args.push('-frames:v', '1');
		args.push('-f', 'image2', '-c:v', 'mjpeg', '-q:v', '3');
		const jpgOutput = outputPath.replace(/\.mp4$/, '.jpg');
		args.push(jpgOutput);
		return args;
	}

	if (vf.length > 0) {
		args.push('-vf', vf.join(','));
	}

	if (params.mode === 'frame') {
		args.push('-frames:v', '1');
		if (params.format === 'png') {
			args.push('-f', 'image2', '-c:v', 'png');
			// Change output extension
			const pngOutput = outputPath.replace(/\.mp4$/, '.png');
			args.push(pngOutput);
			return args;
		} else {
			args.push('-f', 'image2', '-c:v', 'mjpeg');
			const jpgOutput = outputPath.replace(/\.mp4$/, '.jpg');
			args.push(jpgOutput);
			return args;
		}
	}

	if (params.mode === 'audio') {
		args.push('-vn', '-c:a', 'aac');
		const m4aOutput = outputPath.replace(/\.mp4$/, '.m4a');
		args.push(m4aOutput);
		return args;
	}

	// Video mode
	if (params.audio === false) {
		args.push('-an');
	} else {
		args.push('-c:a', 'aac');
		// Audio speed compensation — when video speed changes via setpts,
		// audio must be adjusted with atempo to stay in sync.
		// atempo range is 0.5-2.0; chain multiple for larger ranges.
		if (params.speed && params.speed !== 1) {
			const af = [];
			let remaining = params.speed;
			while (remaining > 2.0) { af.push('atempo=2.0'); remaining /= 2.0; }
			while (remaining < 0.5) { af.push('atempo=0.5'); remaining /= 0.5; }
			af.push(`atempo=${remaining.toFixed(4)}`);
			args.push('-af', af.join(','));
		}
	}

	// Quality preset
	const quality = params.quality || 'medium';
	const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium;
	args.push('-crf', preset.crf, '-preset', preset.preset);

	// Bitrate override
	if (params.bitrate) {
		args.push('-b:v', params.bitrate);
	}

	// Codec
	if (params.format === 'h265') {
		args.push('-c:v', 'libx265');
	} else if (params.format === 'vp9') {
		args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-row-mt', '1');
		const webmOutput = outputPath.replace(/\.mp4$/, '.webm');
		args.push(webmOutput);
		return args;
	} else {
		args.push('-c:v', 'libx264');
	}

	// Movflags for streaming
	args.push('-movflags', '+faststart');
	args.push(outputPath);
	return args;
}

/**
 * Run ffmpeg as a child process, return a promise.
 */
function runFfmpeg(args) {
	return new Promise((resolve, reject) => {
		execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				console.error('ffmpeg stderr:', stderr);
				// Include the last 2000 chars of stderr — that's where the actual error is
				const stderrTail = stderr ? stderr.slice(-2000) : '';
				reject(new Error(`ffmpeg failed (exit ${err.code}): ${stderrTail}`));
			} else {
				resolve({ stdout, stderr });
			}
		});
	});
}

/**
 * URL-based transform: container fetches source directly from a URL.
 * No body streaming through DO — container downloads source independently.
 *
 * Headers:
 *   X-Transform-Params: JSON transform params
 *   X-Source-Url: URL to fetch the source from
 *   X-Callback-Url: (optional) URL to POST the result to when done
 *
 * If callbackUrl is present, responds 202 and processes async.
 * Otherwise, responds synchronously with the transform result.
 */
async function handleTransformUrl(req, res) {
	// Consume request body (empty for URL-based)
	for await (const _ of req) { /* drain */ }

	const paramsJson = req.headers['x-transform-params'];
	const sourceUrl = req.headers['x-source-url'];
	const callbackUrl = req.headers['x-callback-url'];
	const jobId = req.headers['x-job-id'] || null;

	if (!paramsJson || !sourceUrl) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Missing X-Transform-Params or X-Source-Url header' }));
		return;
	}

	const id = randomUUID();
	const inputPath = join(WORK_DIR, `${id}-input`);
	const outputPath = join(WORK_DIR, `${id}-output.mp4`);

	// If callback provided, respond immediately and process async
	if (callbackUrl) {
		res.writeHead(202, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ id, status: 'processing' }));

		processUrlTransform(id, sourceUrl, paramsJson, inputPath, outputPath, callbackUrl, jobId);
		return;
	}

	// Synchronous: download, transform, respond
	try {
		const params = JSON.parse(paramsJson);

		console.log(`[${id}] Fetching source from ${sourceUrl}`);
		const resp = await fetch(sourceUrl);
		if (!resp.ok) throw new Error(`Source fetch failed: ${resp.status}`);

		// Stream to disk to avoid OOM on large files
		await pipeline(Readable.fromWeb(resp.body), createWriteStream(inputPath));
		const inputStat = await stat(inputPath);
		console.log(`[${id}] Source streamed to disk: ${inputStat.size} bytes`);

		const args = buildFfmpegArgs(inputPath, outputPath, params);
		console.log(`[${id}] ffmpeg ${args.join(' ')}`);
		await runFfmpeg(args);

		// Determine actual output path (may have different extension)
		const actualOutput = findOutputFile(outputPath, params);
		const output = await readFile(actualOutput);
		const contentType = getContentType(params);

		res.writeHead(200, {
			'Content-Type': contentType,
			'Content-Length': output.length.toString(),
		});
		res.end(output);
	} catch (err) {
		console.error(`[${id}] URL transform failed:`, err);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: err.message }));
	} finally {
		await unlink(inputPath).catch(() => {});
		await unlink(outputPath).catch(() => {});
	}
}

/**
 * Report progress to the Worker's outbound handler, which forwards to TransformJobDO.
 * Fire-and-forget — errors are silently ignored.
 */
function reportProgress(callbackUrl, jobId, phase, percent) {
	if (!jobId) return;
	// Extract the host from callback URL to build progress URL
	const url = new URL(callbackUrl);
	const progressUrl = `${url.protocol}//${url.host}/internal/job-progress?jobId=${encodeURIComponent(jobId)}&phase=${encodeURIComponent(phase)}&percent=${percent}`;
	fetch(progressUrl).catch(() => {});
}

/**
 * Background processing for URL-based async transforms.
 */
async function processUrlTransform(id, sourceUrl, paramsJson, inputPath, outputPath, callbackUrl, jobId) {
	try {
		const params = JSON.parse(paramsJson);

		reportProgress(callbackUrl, jobId, 'downloading', 0);
		console.log(`[${id}] Async: fetching source from ${sourceUrl}`);
		const resp = await fetch(sourceUrl);
		console.log(`[${id}] Async: source response: status=${resp.status} content-type=${resp.headers.get('content-type')} content-length=${resp.headers.get('content-length')}`);
		if (!resp.ok) throw new Error(`Source fetch failed: ${resp.status} ${resp.statusText} (url: ${resp.url})`);

		// Stream to disk instead of buffering entire file in memory (prevents OOM on 725MB+)
		await pipeline(Readable.fromWeb(resp.body), createWriteStream(inputPath));
		const inputStat = await stat(inputPath);
		console.log(`[${id}] Async: source streamed to disk: ${inputStat.size} bytes`);

		reportProgress(callbackUrl, jobId, 'transcoding', 10);
		const args = buildFfmpegArgs(inputPath, outputPath, params);
		console.log(`[${id}] Async: ffmpeg ${args.join(' ')}`);
		await runFfmpegWithProgress(args, callbackUrl, jobId, params);

		const actualOutput = findOutputFile(outputPath, params);
		const outputStat = await stat(actualOutput);
		const contentType = getContentType(params);

		reportProgress(callbackUrl, jobId, 'uploading', 90);
		console.log(`[${id}] Async: transform complete, ${outputStat.size} bytes, posting to callback`);
		const { createReadStream } = await import('node:fs');
		const outputStream = Readable.toWeb(createReadStream(actualOutput));
		await fetch(callbackUrl, {
			method: 'POST',
			headers: {
				'Content-Type': contentType,
				'Content-Length': String(outputStat.size),
				'X-Transform-ID': id,
			},
			body: outputStream,
			duplex: 'half',
		});
		console.log(`[${id}] Async: callback sent`);
	} catch (err) {
		console.error(`[${id}] Async URL transform failed:`, err);
		await fetch(callbackUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Transform-ID': id,
				'X-Transform-Error': 'true',
			},
			body: JSON.stringify({ error: err.message }),
		}).catch(() => {});
	} finally {
		await unlink(inputPath).catch(() => {});
		await unlink(outputPath).catch(() => {});
		// Clean up any alternative output extensions
		const altExts = ['.png', '.jpg', '.m4a', '.webm'];
		for (const ext of altExts) {
			await unlink(outputPath.replace(/\.mp4$/, ext)).catch(() => {});
		}
	}
}

/**
 * Run ffmpeg with progress reporting via stderr parsing.
 * Falls back to regular runFfmpeg if progress parsing fails.
 */
function runFfmpegWithProgress(args, callbackUrl, jobId, params) {
	if (!jobId) return runFfmpeg(args);

	return new Promise((resolve, reject) => {
		const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
		let stderr = '';
		let lastReportedPercent = 10;

		// Try to extract total duration from input (probe first few seconds of stderr)
		let totalDuration = null;
		if (params.duration) {
			totalDuration = parseDuration(String(params.duration));
		}

		proc.stderr.on('data', (chunk) => {
			const line = chunk.toString();
			stderr += line;

			// Parse total duration from "Duration: HH:MM:SS.mm" line
			if (!totalDuration) {
				const durMatch = line.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
				if (durMatch) {
					totalDuration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
				}
			}

			// Parse progress from "time=HH:MM:SS.mm" output
			const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
			if (timeMatch && totalDuration && totalDuration > 0) {
				const currentSec = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
				// Scale progress to 10-85 range (10=start, 85=done, 90=uploading)
				const percent = Math.min(85, Math.round(10 + (currentSec / totalDuration) * 75));
				if (percent > lastReportedPercent + 4) {
					lastReportedPercent = percent;
					reportProgress(callbackUrl, jobId, 'transcoding', percent);
				}
			}
		});

		proc.on('close', (code) => {
			if (code !== 0) {
				const stderrTail = stderr.slice(-2000);
				reject(new Error(`ffmpeg failed (exit ${code}): ${stderrTail}`));
			} else {
				resolve({ stdout: '', stderr });
			}
		});

		proc.on('error', reject);
	});
}

function getContentType(params) {
	if (params.mode === 'audio') return 'audio/mp4';
	if (params.mode === 'frame') return params.format === 'png' ? 'image/png' : 'image/jpeg';
	if (params.mode === 'spritesheet') return 'image/jpeg';
	if (params.format === 'vp9') return 'video/webm';
	return 'video/mp4';
}

/**
 * Parse a human-readable duration string to seconds.
 * Supports: "5s", "2m", "1m30s", "5m", "300", "1h", "1h30m15s"
 * ffmpeg doesn't understand "5m" — it needs seconds or HH:MM:SS.
 */
function parseDuration(str) {
	if (!str) return 0;
	str = String(str).trim();
	// Already numeric (seconds)
	if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
	let total = 0;
	const h = str.match(/(\d+(?:\.\d+)?)h/);
	const m = str.match(/(\d+(?:\.\d+)?)m(?!s)/); // m but not ms
	const s = str.match(/(\d+(?:\.\d+)?)s/);
	if (h) total += parseFloat(h[1]) * 3600;
	if (m) total += parseFloat(m[1]) * 60;
	if (s) total += parseFloat(s[1]);
	// If nothing matched, try parsing as plain number
	if (total === 0 && !h && !m && !s) {
		const n = parseFloat(str);
		if (!isNaN(n)) return n;
	}
	return total;
}

function findOutputFile(basePath, params) {
	if (params.mode === 'frame') {
		return params.format === 'png'
			? basePath.replace(/\.mp4$/, '.png')
			: basePath.replace(/\.mp4$/, '.jpg');
	}
	if (params.mode === 'spritesheet') return basePath.replace(/\.mp4$/, '.jpg');
	if (params.mode === 'audio') return basePath.replace(/\.mp4$/, '.m4a');
	if (params.format === 'vp9') return basePath.replace(/\.mp4$/, '.webm');
	return basePath;
}
