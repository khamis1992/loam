/**
 * Neo N10 composer controls: the output-type selector and the effort selector.
 *
 * Kept free of React and of the i18n catalog so the option lists, the accepted
 * input spellings and the A/B arm choices can be unit tested directly. The
 * Composer renders these as plain selects; the values travel in `extData`.
 */
import { OUTPUT_TYPES } from '@shared/socket';

export type OutputType = (typeof OUTPUT_TYPES)[number];
export type EffortLevel = 'fast' | 'max';

/** Option value -> the catalog key used for its label. */
export const EFFORT_OPTIONS: ReadonlyArray<{ value: EffortLevel | ''; label: string }> = [
  { value: '', label: 'Effort' },
  { value: 'fast', label: 'Fast' },
  { value: 'max', label: 'Max' },
];

/** Catalog key per output type ("Auto (agent decides)" for the Auto entry). */
export const OUTPUT_TYPE_LABEL: Record<OutputType, string> = {
  auto: 'Auto (agent decides)',
  text: 'Text',
  image: 'Image',
  video: 'Video',
  slides: 'Slides',
  website: 'Website',
};

/**
 * Declared after `OUTPUT_TYPE_LABEL` on purpose: the option list reads the label
 * map during its own initializer, so the map must already be initialized. (A
 * `const` read before its declaration is a `ReferenceError`, not `undefined`.)
 */
export const OUTPUT_TYPE_OPTIONS: ReadonlyArray<{ value: OutputType; label: string }> = OUTPUT_TYPES.map(
  (value) => ({ value, label: OUTPUT_TYPE_LABEL[value] }),
);

/** Accept the backend's spellings (Auto/Text/Slides/"website") case-insensitively. */
export function normalizeOutputType(value: unknown): OutputType | undefined {
  if (typeof value !== 'string') return undefined;
  const needle = value.trim().toLowerCase();
  return OUTPUT_TYPES.find((option) => option === needle);
}

/** Accept "Fast"/"fast"/"quick" and "Max"/"max"/"maximum"; "" means unset. */
export function normalizeEffort(value: unknown): EffortLevel | '' {
  if (typeof value !== 'string') return '';
  const needle = value.trim().toLowerCase();
  if (needle === 'fast' || needle === 'quick' || needle === 'low' || needle === 'lite') return 'fast';
  if (needle === 'max' || needle === 'maximum' || needle === 'best') return 'max';
  return '';
}

/**
 * Build the `extData` fragment for a submit. Only changed values are included so
 * a plain run produces the same payload shape it did before N10.
 */
export function routingExtData(options: {
  outputType?: OutputType | '';
  effort?: EffortLevel | '';
  compareModels?: boolean;
  abModels?: readonly string[];
}): Record<string, unknown> {
  const ext: Record<string, unknown> = {};
  if (options.outputType && options.outputType !== 'auto') ext.outputType = options.outputType;
  if (options.effort) ext.effort = options.effort;
  if (options.compareModels && options.abModels && options.abModels.length > 0) ext.abModels = [...options.abModels];
  return ext;
}
