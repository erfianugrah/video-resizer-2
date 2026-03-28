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
import { execFile } from 'node:child_process';
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

	// Time offset — placed BEFORE -i for fast input seeking (avoids
	// decoding everything before the seek point).
	if (params.time) {
		args.push('-ss', params.time);
	}

	args.push('-i', inputPath);

	// Duration
	if (params.duration) {
		args.push('-t', params.duration);
	}

	// Video filters
	const vf = [];

	// Scale (width/height)
	// libx264 requires both dimensions to be divisible by 2.
	// -2 auto-calculates the other dimension as even, but user-specified
	// dimensions must also be forced even (round down).
	if (params.width || params.height) {
		const w = params.width ? (params.width % 2 === 0 ? params.width : params.width - 1) : -2;
		const h = params.height ? (params.height % 2 === 0 ? params.height : params.height - 1) : -2;
		vf.push(`scale=${w}:${h}`);
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

	if (vf.length > 0) {
		args.push('-vf', vf.join(','));
	}

	// Mode-specific
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
		args.push('-c:v', 'libvpx-vp9');
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

		processUrlTransform(id, sourceUrl, paramsJson, inputPath, outputPath, callbackUrl);
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
 * Background processing for URL-based async transforms.
 */
async function processUrlTransform(id, sourceUrl, paramsJson, inputPath, outputPath, callbackUrl) {
	try {
		const params = JSON.parse(paramsJson);

		console.log(`[${id}] Async: fetching source from ${sourceUrl}`);
		const resp = await fetch(sourceUrl);
		console.log(`[${id}] Async: source response: status=${resp.status} content-type=${resp.headers.get('content-type')} content-length=${resp.headers.get('content-length')}`);
		if (!resp.ok) throw new Error(`Source fetch failed: ${resp.status} ${resp.statusText} (url: ${resp.url})`);

		// Stream to disk instead of buffering entire file in memory (prevents OOM on 725MB+)
		await pipeline(Readable.fromWeb(resp.body), createWriteStream(inputPath));
		const inputStat = await stat(inputPath);
		console.log(`[${id}] Async: source streamed to disk: ${inputStat.size} bytes`);

		const args = buildFfmpegArgs(inputPath, outputPath, params);
		console.log(`[${id}] Async: ffmpeg ${args.join(' ')}`);
		await runFfmpeg(args);

		const actualOutput = findOutputFile(outputPath, params);
		const outputStat = await stat(actualOutput);
		const contentType = getContentType(params);

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

function getContentType(params) {
	if (params.mode === 'audio') return 'audio/mp4';
	if (params.mode === 'frame') return params.format === 'png' ? 'image/png' : 'image/jpeg';
	return 'video/mp4';
}

function findOutputFile(basePath, params) {
	if (params.mode === 'frame') {
		return params.format === 'png'
			? basePath.replace(/\.mp4$/, '.png')
			: basePath.replace(/\.mp4$/, '.jpg');
	}
	if (params.mode === 'audio') return basePath.replace(/\.mp4$/, '.m4a');
	if (params.format === 'vp9') return basePath.replace(/\.mp4$/, '.webm');
	return basePath;
}
