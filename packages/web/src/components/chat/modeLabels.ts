import { PRODUCT } from '../../i18n/t';

export interface ModeChipResolved {
  mode: string;
  label: string;
  labelAr: string;
}

export const LOAM_MODES = [
  { value: 'build', label: 'Build' },
  { value: 'write', label: 'Write' },
  { value: 'data', label: 'Data' },
  { value: 'media', label: 'Media' },
  { value: 'research', label: 'Research' },
  { value: 'security', label: 'Security' },
  { value: 'automate', label: 'Automate' },
] as const;

/** Collapse repeated leading brand tokens so the chip renders the brand
 *  exactly once: "Loam" -> "Loam", "Loam Loam Build" -> "Loam Build". */
export function dedupeBrandLabel(label: string): string {
  const trimmed = label.trim();
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  let index = 0;
  let hasBrand = false;
  while (index < tokens.length && tokens[index] === PRODUCT) {
    hasBrand = true;
    index += 1;
  }
  const rest = tokens.slice(index).join(' ');
  if (!rest) return hasBrand ? PRODUCT : '';
  return hasBrand ? `${PRODUCT} ${rest}` : rest;
}
