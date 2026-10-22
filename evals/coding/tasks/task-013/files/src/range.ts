/** Inclusive-exclusive numeric ranges. */

export function range(start: number, end: number, step = 1): number[] {
  if (step === 0) throw new Error("step must not be zero");
  const out: number[] = [];
  if (step > 0) {
    for (let value = start; value < end; value += step) out.push(value);
  } else {
    for (let value = start; value > end; value += step) out.push(value);
  }
  return out;
}
