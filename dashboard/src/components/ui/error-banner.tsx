import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Props for the ErrorBanner component. */
interface ErrorBannerProps {
	children: ReactNode;
	/** Optional extra class names. */
	className?: string;
}

/** Accessible error banner with `role="alert"` for screen reader announcements. */
function ErrorBanner({ children, className }: ErrorBannerProps) {
	return (
		<div
			role="alert"
			className={cn(
				'rounded-lg border border-lv-red/30 bg-lv-red/10 px-3 py-1.5 text-xs text-lv-red',
				className,
			)}
		>
			{children}
		</div>
	);
}

export { ErrorBanner };
export type { ErrorBannerProps };
