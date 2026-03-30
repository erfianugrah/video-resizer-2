import { describe, it, expect } from 'vitest';
import { parseParams, translateAkamaiParams, needsContainer, parseImRef, type TransformParams, type ParamWarning } from '../../src/params/schema';

describe('params/schema', () => {
	describe('parseParams', () => {
		it('parses standard Cloudflare params', () => {
			const qs = new URLSearchParams('width=640&height=360&mode=video&fit=contain');
			const { params: result } = parseParams(qs);
			expect(result.width).toBe(640);
			expect(result.height).toBe(360);
			expect(result.mode).toBe('video');
			expect(result.fit).toBe('contain');
		});

		it('returns empty object for no params', () => {
			const { params: result } = parseParams(new URLSearchParams());
			expect(result.width).toBeUndefined();
			expect(result.height).toBeUndefined();
			expect(result.mode).toBeUndefined();
		});

		it('clamps width/height to 10-8192', () => {
			const qs = new URLSearchParams('width=5&height=9000');
			const { params: result, warnings } = parseParams(qs);
			expect(result.width).toBeUndefined();
			expect(result.height).toBeUndefined();
			expect(warnings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ param: 'width', value: '5' }),
					expect.objectContaining({ param: 'height', value: '9000' }),
				]),
			);
		});

		it('rejects invalid mode', () => {
			const qs = new URLSearchParams('mode=invalid');
			const { params: result, warnings } = parseParams(qs);
			expect(result.mode).toBeUndefined();
			expect(warnings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ param: 'mode', value: 'invalid' }),
				]),
			);
		});

		it('parses time and duration strings', () => {
			const qs = new URLSearchParams('time=5s&duration=30s');
			const { params: result } = parseParams(qs);
			expect(result.time).toBe('5s');
			expect(result.duration).toBe('30s');
		});

		it('parses audio boolean', () => {
			const qs = new URLSearchParams('audio=false');
			const { params: result } = parseParams(qs);
			expect(result.audio).toBe(false);
		});

		it('parses format', () => {
			const qs = new URLSearchParams('format=jpg');
			const { params: result } = parseParams(qs);
			expect(result.format).toBe('jpg');
		});

		it('parses filename', () => {
			const qs = new URLSearchParams('filename=my-clip');
			const { params: result } = parseParams(qs);
			expect(result.filename).toBe('my-clip');
		});

		it('parses derivative name', () => {
			const qs = new URLSearchParams('derivative=tablet');
			const { params: result } = parseParams(qs);
			expect(result.derivative).toBe('tablet');
		});

		it('ignores unknown params', () => {
			const qs = new URLSearchParams('width=640&bogus=xyz&debug=true');
			const { params: result } = parseParams(qs);
			expect(result.width).toBe(640);
			expect((result as Record<string, unknown>).bogus).toBeUndefined();
		});

		it('parses container-only params: fps, speed, rotate, crop, bitrate', () => {
			const qs = new URLSearchParams('fps=30&speed=1.5&rotate=90&crop=100:100:0:0&bitrate=2M');
			const { params: result } = parseParams(qs);
			expect(result.fps).toBe(30);
			expect(result.speed).toBe(1.5);
			expect(result.rotate).toBe(90);
			expect(result.crop).toBe('100:100:0:0');
			expect(result.bitrate).toBe('2M');
		});

		it('parses playback hint params', () => {
			const qs = new URLSearchParams('loop=true&autoplay=true&muted=true&preload=metadata');
			const { params: result } = parseParams(qs);
			expect(result.loop).toBe(true);
			expect(result.autoplay).toBe(true);
			expect(result.muted).toBe(true);
			expect(result.preload).toBe('metadata');
		});

		it('parses imageCount for spritesheets', () => {
			const qs = new URLSearchParams('imageCount=10');
			const { params: result } = parseParams(qs);
			expect(result.imageCount).toBe(10);
		});

		it('parses dpr', () => {
			const qs = new URLSearchParams('dpr=2.5');
			const { params: result } = parseParams(qs);
			expect(result.dpr).toBe(2.5);
		});

		it('returns warnings for invalid params', () => {
			const qs = new URLSearchParams('width=abc&fit=invalid&fps=-5');
			const { params, warnings } = parseParams(qs);
			// Invalid values are dropped
			expect(params.width).toBeUndefined();
			expect(params.fit).toBeUndefined();
			expect(params.fps).toBeUndefined();
			// Warnings produced for each
			expect(warnings.length).toBeGreaterThanOrEqual(3);
			expect(warnings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ param: 'width' }),
					expect.objectContaining({ param: 'fit' }),
					expect.objectContaining({ param: 'fps' }),
				]),
			);
		});

		it('returns no warnings for valid params', () => {
			const qs = new URLSearchParams('width=640&height=360&mode=video');
			const { warnings } = parseParams(qs);
			expect(warnings).toEqual([]);
		});
	});

	describe('translateAkamaiParams', () => {
		it('captures imwidth as rawImWidth (not forwarded as width)', () => {
			const qs = new URLSearchParams('imwidth=1080');
			const { params, rawImWidth } = translateAkamaiParams(qs);
			expect(rawImWidth).toBe(1080);
			expect(params.has('width')).toBe(false);
			expect(params.has('imwidth')).toBe(false);
		});

		it('captures imheight as rawImHeight (not forwarded as height)', () => {
			const qs = new URLSearchParams('imheight=720');
			const { params, rawImHeight } = translateAkamaiParams(qs);
			expect(rawImHeight).toBe(720);
			expect(params.has('height')).toBe(false);
			expect(params.has('imheight')).toBe(false);
		});

		it('translates impolicy to derivative', () => {
			const qs = new URLSearchParams('impolicy=tablet');
			const { params } = translateAkamaiParams(qs);
			expect(params.get('derivative')).toBe('tablet');
		});

		it('translates imdensity to dpr', () => {
			const qs = new URLSearchParams('imdensity=2.0');
			const { params } = translateAkamaiParams(qs);
			expect(params.get('dpr')).toBe('2.0');
		});

		it('translates shorthand params: w, h, q, f, start, dur', () => {
			const qs = new URLSearchParams('w=640&h=360&q=high&f=jpg&start=5s&dur=10s');
			const { params } = translateAkamaiParams(qs);
			expect(params.get('width')).toBe('640');
			expect(params.get('height')).toBe('360');
			expect(params.get('quality')).toBe('high');
			expect(params.get('format')).toBe('jpg');
			expect(params.get('time')).toBe('5s');
			expect(params.get('duration')).toBe('10s');
		});

		it('translates obj-fit with value mapping', () => {
			const qs1 = new URLSearchParams('obj-fit=crop');
			expect(translateAkamaiParams(qs1).params.get('fit')).toBe('cover');

			const qs2 = new URLSearchParams('obj-fit=fill');
			expect(translateAkamaiParams(qs2).params.get('fit')).toBe('contain');

			const qs3 = new URLSearchParams('obj-fit=contain');
			expect(translateAkamaiParams(qs3).params.get('fit')).toBe('contain');
		});

		it('translates imformat=h264 to mp4', () => {
			const qs = new URLSearchParams('imformat=h264');
			const { params } = translateAkamaiParams(qs);
			expect(params.get('format')).toBe('mp4');
		});

		it('passes through imformat=h265 for container routing', () => {
			const qs = new URLSearchParams('imformat=h265');
			const { params } = translateAkamaiParams(qs);
			expect(params.get('format')).toBe('h265');
		});

		it('preserves non-Akamai params', () => {
			const qs = new URLSearchParams('imwidth=1080&mode=video&derivative=tablet');
			const { params, rawImWidth } = translateAkamaiParams(qs);
			// imwidth is captured as rawImWidth, not forwarded as width
			expect(rawImWidth).toBe(1080);
			expect(params.has('width')).toBe(false);
			expect(params.get('mode')).toBe('video');
			expect(params.get('derivative')).toBe('tablet');
		});

		it('does not overwrite explicit params with translated ones', () => {
			const qs = new URLSearchParams('width=640&imwidth=1080');
			const { params } = translateAkamaiParams(qs);
			expect(params.get('width')).toBe('640');
		});

		it('translates mute to audio (inverted)', () => {
			const qs = new URLSearchParams('mute=true');
			const { params } = translateAkamaiParams(qs);
			expect(params.get('audio')).toBe('false');
		});

		it('consumes imref (not passed through)', () => {
			const qs = new URLSearchParams('imref=test&imwidth=800');
			const { params, rawImWidth } = translateAkamaiParams(qs);
			expect(params.has('imref')).toBe(false);
			expect(rawImWidth).toBe(800);
			expect(params.has('width')).toBe(false);
		});

		it('captures imwidth=2160 as rawImWidth=2160', () => {
			const qs = new URLSearchParams('imwidth=2160');
			const { rawImWidth, params } = translateAkamaiParams(qs);
			expect(rawImWidth).toBe(2160);
			expect(params.has('width')).toBe(false);
		});

		it('imwidth with impolicy — explicit derivative wins', () => {
			const qs = new URLSearchParams('imwidth=1080&impolicy=tablet');
			const { params, rawImWidth } = translateAkamaiParams(qs);
			// impolicy maps to derivative
			expect(params.get('derivative')).toBe('tablet');
			// imwidth captured as raw hint, not forwarded as width
			expect(rawImWidth).toBe(1080);
			expect(params.has('width')).toBe(false);
		});

		it('imwidth with explicit width — explicit width wins', () => {
			const qs = new URLSearchParams('imwidth=1080&width=640');
			const { params, rawImWidth } = translateAkamaiParams(qs);
			// Explicit width is passed through as-is
			expect(params.get('width')).toBe('640');
			// imwidth still captured as raw hint
			expect(rawImWidth).toBe(1080);
		});

		it('extracts im-viewwidth/im-viewheight/im-density as client hints', () => {
			const qs = new URLSearchParams('im-viewwidth=1024&im-viewheight=768&im-density=2');
			const { params, clientHints } = translateAkamaiParams(qs);
			expect(clientHints['Sec-CH-Viewport-Width']).toBe('1024');
			expect(clientHints['Viewport-Height']).toBe('768');
			expect(clientHints['Sec-CH-DPR']).toBe('2');
			// Not forwarded as params
			expect(params.has('im-viewwidth')).toBe(false);
		});

		it('translates dpr shorthand', () => {
			const qs = new URLSearchParams('dpr=3');
			const { params } = translateAkamaiParams(qs);
			expect(params.get('dpr')).toBe('3');
		});
	});

	describe('needsContainer', () => {
		it('returns false for binding-only params', () => {
			expect(needsContainer({ width: 640, height: 360 })).toBe(false);
			expect(needsContainer({ mode: 'frame', time: '2s', format: 'jpg' })).toBe(false);
			expect(needsContainer({ mode: 'audio', duration: '30s' })).toBe(false);
		});

		it('returns true for fps', () => {
			expect(needsContainer({ width: 640, fps: 30 })).toBe(true);
		});

		it('returns true for speed', () => {
			expect(needsContainer({ speed: 2.0 })).toBe(true);
		});

		it('returns true for rotate', () => {
			expect(needsContainer({ rotate: 90 })).toBe(true);
		});

		it('returns true for crop', () => {
			expect(needsContainer({ crop: '100:100:0:0' })).toBe(true);
		});

		it('returns true for bitrate', () => {
			expect(needsContainer({ bitrate: '2M' })).toBe(true);
		});

		it('returns true for h265/vp9 codec formats', () => {
			expect(needsContainer({ format: 'h265' })).toBe(true);
			expect(needsContainer({ format: 'vp9' })).toBe(true);
			expect(needsContainer({ format: 'av1' })).toBe(true);
		});

		it('returns false for binding-supported formats', () => {
			expect(needsContainer({ format: 'jpg' })).toBe(false);
			expect(needsContainer({ format: 'png' })).toBe(false);
			expect(needsContainer({ format: 'm4a' })).toBe(false);
			expect(needsContainer({ format: 'mp4' })).toBe(false);
		});

		it('returns true for duration > 60s', () => {
			expect(needsContainer({ duration: '90s' })).toBe(true);
			expect(needsContainer({ duration: '2m' })).toBe(true);
			expect(needsContainer({ duration: '1m30s' })).toBe(true);
		});

		it('returns false for duration <= 60s', () => {
			expect(needsContainer({ duration: '60s' })).toBe(false);
			expect(needsContainer({ duration: '30s' })).toBe(false);
			expect(needsContainer({ duration: '1m' })).toBe(false);
		});

		it('handles hour durations correctly', () => {
			expect(needsContainer({ duration: '1h' })).toBe(true);
			expect(needsContainer({ duration: '1h30m' })).toBe(true);
			expect(needsContainer({ duration: '1h30m15s' })).toBe(true);
		});

		it('does not match ms suffix as minutes', () => {
			// "10ms" should NOT be parsed as "10 minutes" (600s)
			expect(needsContainer({ duration: '10ms' })).toBe(false);
		});
	});

	describe('parseImRef', () => {
		it('parses key=value,key=value format', () => {
			const result = parseImRef('policy=mobile,width=1080,format=h264');
			expect(result).toEqual({ policy: 'mobile', width: '1080', format: 'h264' });
		});

		it('returns empty object for empty string', () => {
			expect(parseImRef('')).toEqual({});
		});

		it('handles single key=value pair', () => {
			expect(parseImRef('key=value')).toEqual({ key: 'value' });
		});

		it('skips malformed entries without =', () => {
			const result = parseImRef('good=val,bad,also=ok');
			expect(result).toEqual({ good: 'val', also: 'ok' });
		});
	});

	describe('translateAkamaiParams imref', () => {
		it('consumes imref and returns parsed record', () => {
			const qs = new URLSearchParams('imref=policy=tablet,width=1080&imwidth=1080');
			const result = translateAkamaiParams(qs);
			expect(result.imref).toEqual({ policy: 'tablet', width: '1080' });
			expect(result.params.has('imref')).toBe(false); // consumed, not forwarded
		});

		it('returns empty imref when not present', () => {
			const qs = new URLSearchParams('width=640');
			const result = translateAkamaiParams(qs);
			expect(result.imref).toEqual({});
		});
	});
});
