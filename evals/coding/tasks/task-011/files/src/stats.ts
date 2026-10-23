/** Descriptive statistics for the metrics dashboard. */

export function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid]!;
}
