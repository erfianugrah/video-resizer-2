/**
 * Transform parameter form builder.
 *
 * Renders contextual form fields based on the selected mode.
 * Dropdowns for enums, numeric inputs for dimensions, text for durations.
 * Derivative dropdown populated from config.
 */
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';
import { Input } from '../ui/input';
import type { ParamValues, WorkbenchConfig } from './types';
import {
	MODE_OPTIONS,
	FIT_OPTIONS,
	QUALITY_OPTIONS,
	COMPRESSION_OPTIONS,
	FORMAT_OPTIONS,
	AUDIO_OPTIONS,
	MODE_FIELDS,
} from './types';

/** Props for the ParamForm component. */
interface ParamFormProps {
	params: ParamValues;
	onChange: (params: ParamValues) => void;
	config: WorkbenchConfig | null;
}

/** Styled select matching the Input component look. */
function Select({
	value,
	onChange,
	options,
	label,
}: {
	value: string;
	onChange: (v: string) => void;
	options: readonly string[];
	label: string;
}) {
	return (
		<select
			value={value}
			onChange={(e) => onChange(e.target.value)}
			aria-label={label}
			className={cn(
				'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1',
				'text-xs font-data ring-offset-background focus-visible:outline-none',
				'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
			)}
		>
			{options.map((opt) => (
				<option key={opt} value={opt}>
					{opt || '(none)'}
				</option>
			))}
		</select>
	);
}

/** A single labelled form field. */
function Field({ label, children, visible = true }: { label: string; children: React.ReactNode; visible?: boolean }) {
	if (!visible) return null;
	return (
		<div className="space-y-1">
			<label className={T.formLabel}>{label}</label>
			{children}
		</div>
	);
}

/** Form-driven transform parameter builder. */
export function ParamForm({ params, onChange, config }: ParamFormProps) {
	const set = <K extends keyof ParamValues>(key: K, value: ParamValues[K]) => {
		onChange({ ...params, [key]: value });
	};

	const visibleFields = MODE_FIELDS[params.mode] ?? MODE_FIELDS[''];
	const isVisible = (field: keyof ParamValues) => visibleFields.includes(field);

	const derivativeOptions = ['', ...(config?.derivatives ?? [])];

	return (
		<div className="space-y-3">
			{/* Mode selector */}
			<Field label="Mode">
				<Select value={params.mode} onChange={(v) => set('mode', v)} options={MODE_OPTIONS} label="Mode" />
			</Field>

			{/* Derivative */}
			<Field label="Derivative">
				<Select value={params.derivative} onChange={(v) => set('derivative', v)} options={derivativeOptions} label="Derivative" />
			</Field>

			{/* Dimensions */}
			<div className="grid grid-cols-2 gap-2">
				<Field label="Width" visible={isVisible('width')}>
					<Input
						type="number"
						min={10}
						max={8192}
						value={params.width}
						onChange={(e) => set('width', e.target.value)}
						placeholder="10-8192"
						className="font-data text-xs"
						aria-label="Width"
					/>
				</Field>
				<Field label="Height" visible={isVisible('height')}>
					<Input
						type="number"
						min={10}
						max={8192}
						value={params.height}
						onChange={(e) => set('height', e.target.value)}
						placeholder="10-8192"
						className="font-data text-xs"
						aria-label="Height"
					/>
				</Field>
			</div>

			{/* DPR */}
			<Field label="DPR" visible={isVisible('dpr')}>
				<Input
					type="number"
					min={0.1}
					step={0.5}
					value={params.dpr}
					onChange={(e) => set('dpr', e.target.value)}
					placeholder="e.g. 2"
					className="font-data text-xs"
					aria-label="Device pixel ratio"
				/>
			</Field>

			{/* Fit */}
			<Field label="Fit" visible={isVisible('fit')}>
				<Select value={params.fit} onChange={(v) => set('fit', v)} options={FIT_OPTIONS} label="Fit" />
			</Field>

			{/* Quality & Compression */}
			<div className="grid grid-cols-2 gap-2">
				<Field label="Quality" visible={isVisible('quality')}>
					<Select value={params.quality} onChange={(v) => set('quality', v)} options={QUALITY_OPTIONS} label="Quality" />
				</Field>
				<Field label="Compression" visible={isVisible('compression')}>
					<Select value={params.compression} onChange={(v) => set('compression', v)} options={COMPRESSION_OPTIONS} label="Compression" />
				</Field>
			</div>

			{/* Time & Duration */}
			<div className="grid grid-cols-2 gap-2">
				<Field label="Time" visible={isVisible('time')}>
					<Input
						value={params.time}
						onChange={(e) => set('time', e.target.value)}
						placeholder="e.g. 5s, 1m30s"
						className="font-data text-xs"
						aria-label="Time offset"
					/>
				</Field>
				<Field label="Duration" visible={isVisible('duration')}>
					<Input
						value={params.duration}
						onChange={(e) => set('duration', e.target.value)}
						placeholder="e.g. 10s, 2m"
						className="font-data text-xs"
						aria-label="Duration"
					/>
				</Field>
			</div>

			{/* FPS & Speed */}
			<div className="grid grid-cols-2 gap-2">
				<Field label="FPS" visible={isVisible('fps')}>
					<Input
						type="number"
						min={1}
						value={params.fps}
						onChange={(e) => set('fps', e.target.value)}
						placeholder="e.g. 30"
						className="font-data text-xs"
						aria-label="Frames per second"
					/>
				</Field>
				<Field label="Speed" visible={isVisible('speed')}>
					<Input
						type="number"
						min={0.1}
						step={0.1}
						value={params.speed}
						onChange={(e) => set('speed', e.target.value)}
						placeholder="e.g. 1.5"
						className="font-data text-xs"
						aria-label="Playback speed"
					/>
				</Field>
			</div>

			{/* Rotate & Crop */}
			<div className="grid grid-cols-2 gap-2">
				<Field label="Rotate" visible={isVisible('rotate')}>
					<Input
						type="number"
						value={params.rotate}
						onChange={(e) => set('rotate', e.target.value)}
						placeholder="degrees"
						className="font-data text-xs"
						aria-label="Rotation degrees"
					/>
				</Field>
				<Field label="Crop" visible={isVisible('crop')}>
					<Input
						value={params.crop}
						onChange={(e) => set('crop', e.target.value)}
						placeholder="geometry"
						className="font-data text-xs"
						aria-label="Crop geometry"
					/>
				</Field>
			</div>

			{/* Bitrate */}
			<Field label="Bitrate" visible={isVisible('bitrate')}>
				<Input
					value={params.bitrate}
					onChange={(e) => set('bitrate', e.target.value)}
					placeholder="e.g. 2M"
					className="font-data text-xs"
					aria-label="Bitrate"
				/>
			</Field>

			{/* Format */}
			<Field label="Format" visible={isVisible('format')}>
				<Select value={params.format} onChange={(v) => set('format', v)} options={FORMAT_OPTIONS} label="Format" />
			</Field>

			{/* Audio toggle */}
			<Field label="Audio" visible={isVisible('audio')}>
				<Select value={params.audio} onChange={(v) => set('audio', v)} options={AUDIO_OPTIONS} label="Audio" />
			</Field>

			{/* Image count (spritesheet) */}
			<Field label="Image Count" visible={isVisible('imageCount')}>
				<Input
					type="number"
					min={1}
					value={params.imageCount}
					onChange={(e) => set('imageCount', e.target.value)}
					placeholder="tile count"
					className="font-data text-xs"
					aria-label="Image count"
				/>
			</Field>
		</div>
	);
}
