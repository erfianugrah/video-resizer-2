/**
 * Recursive JSON tree viewer.
 *
 * Renders nested objects/arrays as a collapsible tree with syntax
 * highlighting. No external dependencies — pure React.
 */
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Color a JSON value by its JS type. */
function valueColor(value: unknown): string {
	if (value === null || value === undefined) return 'text-muted-foreground';
	if (typeof value === 'boolean') return 'text-lv-peach';
	if (typeof value === 'number') return 'text-lv-blue';
	if (typeof value === 'string') return 'text-lv-green';
	return 'text-foreground';
}

/** Format a leaf value for display. */
function formatValue(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return `"${value}"`;
	return String(value);
}

/** Props for the JsonNode component. */
interface JsonNodeProps {
	label: string;
	value: unknown;
	depth: number;
	defaultOpen?: boolean;
}

/** Single node in the JSON tree. Collapsible for objects/arrays. */
function JsonNode({ label, value, depth, defaultOpen = false }: JsonNodeProps) {
	const isExpandable = value !== null && typeof value === 'object';
	const [open, setOpen] = useState(defaultOpen || depth < 1);

	if (!isExpandable) {
		return (
			<div className="flex gap-1.5" style={{ paddingLeft: depth * 16 }}>
				<span className="text-muted-foreground shrink-0">{label}:</span>
				<span className={cn('font-data', valueColor(value))}>{formatValue(value)}</span>
			</div>
		);
	}

	const entries = Array.isArray(value)
		? value.map((v, i) => [String(i), v] as [string, unknown])
		: Object.entries(value as Record<string, unknown>);

	const bracket = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
	const count = entries.length;

	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1 hover:bg-accent/30 rounded w-full text-left"
				style={{ paddingLeft: depth * 16 }}
			>
				<ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
				<span className="text-muted-foreground">{label}:</span>
				{!open && (
					<span className="text-muted-foreground/60 text-xs font-data">
						{bracket[0]} {count} {count === 1 ? 'item' : 'items'} {bracket[1]}
					</span>
				)}
			</button>
			{open && (
				<div>
					{entries.map(([k, v]) => (
						<JsonNode key={k} label={k} value={v} depth={depth + 1} />
					))}
				</div>
			)}
		</div>
	);
}

/** Top-level JSON tree viewer component. */
export function JsonTree({ data, className }: { data: unknown; className?: string }) {
	if (data === null || data === undefined) return null;

	return (
		<div className={cn('text-xs font-data space-y-0.5 overflow-x-auto', className)}>
			{typeof data === 'object' && !Array.isArray(data)
				? Object.entries(data as Record<string, unknown>).map(([k, v]) => (
					<JsonNode key={k} label={k} value={v} depth={0} defaultOpen />
				))
				: <JsonNode label="root" value={data} depth={0} defaultOpen />
			}
		</div>
	);
}
