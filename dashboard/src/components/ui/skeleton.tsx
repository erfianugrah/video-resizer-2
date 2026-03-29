import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Animated placeholder block used during loading states. */
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
