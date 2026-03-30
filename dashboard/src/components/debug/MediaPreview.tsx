/**
 * Inline media preview component.
 *
 * Auto-detects content type and renders the appropriate HTML element:
 * `<video>` for video, `<img>` for images/spritesheets, `<audio>` for audio.
 * Shows SSE progress bar when a container job is in flight (202 response).
 */
import { Loader2, Film, Image, Music, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';
import type { SseProgress } from './types';

/** Props for the MediaPreview component. */
interface MediaPreviewProps {
	/** Blob URL or direct URL for the media element. */
	previewUrl: string | null;
	/** Content-Type header from the transform response. */
	contentType: string;
	/** True while the initial fetch is in progress. */
	loading: boolean;
	/** SSE progress when response was 202 (container job). */
	sseProgress: SseProgress | null;
	/** HTTP status of the last response (0 if none). */
	status: number;
}

/** Determine preview kind from Content-Type. */
function detectKind(contentType: string): 'video' | 'image' | 'audio' | 'unknown' {
	if (!contentType) return 'unknown';
	if (contentType.startsWith('video/')) return 'video';
	if (contentType.startsWith('image/')) return 'image';
	if (contentType.startsWith('audio/')) return 'audio';
	return 'unknown';
}

/** Inline media preview with SSE progress support. */
export function MediaPreview({ previewUrl, contentType, loading, sseProgress, status }: MediaPreviewProps) {
	// SSE progress state (202 container job)
	if (sseProgress) {
		const isTerminal = sseProgress.status === 'complete' || sseProgress.status === 'failed';
		return (
			<div className="flex flex-col items-center justify-center h-48 gap-3">
				{!isTerminal && <Loader2 className="h-5 w-5 animate-spin text-lv-purple" />}
				{sseProgress.status === 'failed' && <AlertCircle className="h-5 w-5 text-lv-red" />}
				<div className="w-full max-w-xs space-y-1.5">
					<div className="flex justify-between">
						<span className={cn(T.muted, 'capitalize')}>{sseProgress.status}</span>
						<span className={cn(T.muted, 'font-data')}>{sseProgress.percent}%</span>
					</div>
					<div className="h-1.5 rounded-full bg-muted overflow-hidden">
						<div
							className={cn(
								'h-full rounded-full transition-all duration-300',
								sseProgress.status === 'failed' ? 'bg-lv-red' : 'bg-lv-purple',
							)}
							style={{ width: `${Math.min(sseProgress.percent, 100)}%` }}
						/>
					</div>
				</div>
			</div>
		);
	}

	// Loading state
	if (loading) {
		return (
			<div className="flex items-center justify-center h-48">
				<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	// No result yet
	if (!previewUrl || status === 0) {
		return (
			<div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground">
				<Film className="h-8 w-8 opacity-30" />
				<span className={T.muted}>Run a test to see preview</span>
			</div>
		);
	}

	// Error status (4xx/5xx) — no preview
	if (status >= 400) {
		return (
			<div className="flex flex-col items-center justify-center h-48 gap-2">
				<AlertCircle className="h-5 w-5 text-lv-red" />
				<span className={cn(T.muted, 'text-lv-red')}>HTTP {status} — no preview available</span>
			</div>
		);
	}

	const kind = detectKind(contentType);

	if (kind === 'video') {
		return (
			<video
				src={previewUrl}
				controls
				autoPlay
				muted
				className="w-full max-h-72 rounded-md bg-black"
			>
				<track kind="captions" />
			</video>
		);
	}

	if (kind === 'image') {
		return (
			<div className="overflow-auto max-h-72 rounded-md bg-black/20">
				<img src={previewUrl} alt="Transform preview" className="max-w-full" />
			</div>
		);
	}

	if (kind === 'audio') {
		return (
			<div className="flex flex-col items-center justify-center h-32 gap-3">
				<Music className="h-6 w-6 text-muted-foreground" />
				<audio src={previewUrl} controls className="w-full max-w-sm">
					<track kind="captions" />
				</audio>
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center justify-center h-48 gap-2">
			<Image className="h-6 w-6 text-muted-foreground opacity-50" />
			<span className={T.muted}>Unknown content type: {contentType}</span>
		</div>
	);
}
