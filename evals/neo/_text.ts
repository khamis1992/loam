/**
 * Helpers shared by the N20 fixtures.
 *
 * The `text(...)` helper is deliberately a plain pass-through: it exists so a
 * fixture reads as "a model said this" rather than a bare string, and so the
 * model-script parser has one obvious place to look for the assistant message.
 */
export function text(value: string): string {
  return value;
}
