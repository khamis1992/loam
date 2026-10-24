/** Cartesian expansion of vars lists into per-case bindings, capped to keep suites bounded. */
export const MAX_VAR_COMBINATIONS = 200;

export function expandVars(vars: Record<string, readonly string[]>): Record<string, string>[] {
  const keys = Object.keys(vars);
  if (keys.length === 0) return [{}];
  let combos: Record<string, string>[] = [{}];
  for (const k of keys) {
    const values = vars[k]!.length ? vars[k]! : [""];
    const next: Record<string, string>[] = [];
    for (const base of combos) {
      for (const v of values) {
        if (next.length >= MAX_VAR_COMBINATIONS) break;
        next.push({ ...base, [k]: v });
      }
      if (next.length >= MAX_VAR_COMBINATIONS) break;
    }
    combos = next;
  }
  return combos;
}
