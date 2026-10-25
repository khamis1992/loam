/** Mitigations are TEMPORARY measures, never fixes — the type system enforces it
 *  (REMEDIATE_INTO_LOAM §5.1: `isFix` is the literal false). */
export interface Mitigation {
  id: string;
  summary: string;
  isFix: false;
}

/** Build a Mitigation; impossible to construct one marked as a fix. */
export function mitigation(id: string, summary: string): Mitigation {
  return { id, summary, isFix: false };
}
