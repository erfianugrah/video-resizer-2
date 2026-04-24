import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Option shape for SegmentedGroup. */
interface SegmentedOption<V extends string | number> {
	value: V;
	label: ReactNode;
}

/** Props for the SegmentedGroup component. */
interface SegmentedGroupProps<V extends string | number> {
	/** Accessible label describing this group of options. */
	label: string;
	options: readonly SegmentedOption<V>[];
	value: V;
	onChange: (value: V) => void;
	/** Optional color class pair for the active state (defaults to purple). */
	activeClass?: string;
}

/**
 * Accessible segmented button group rendered as a radiogroup.
 * Each option is a button with `role="radio"` and `aria-checked`.
 */
function SegmentedGroup<V extends string | number>({
	label,
	options,
	value,
	onChange,
	activeClass = 'bg-lv-purple/20 text-lv-purple',
}: SegmentedGroupProps<V>) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="inline-flex rounded-lg border border-border overflow-hidden"
		>
			{options.map((opt) => (
				<button
					type="button"
					key={opt.value}
					role="radio"
					aria-checked={value === opt.value}
					onClick={() => onChange(opt.value)}
					className={cn(
						'px-2.5 py-1.5 text-xs font-medium transition-colors border-r border-border last:border-r-0',
						value === opt.value
							? activeClass
							: 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
					)}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}

export { SegmentedGroup };
export type { SegmentedGroupProps, SegmentedOption };
