/** True when a user-facing string was decoded with a lossy charset upstream:
 *  every glyph became a literal question mark. It is not recoverable, so the
 *  UI must show a neutral placeholder instead of mojibake ("?????"). */
export function isCorruptedPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && /^[?؟\s]+$/.test(trimmed);
}
