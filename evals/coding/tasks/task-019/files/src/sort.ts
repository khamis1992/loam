/** Sorting utilities for the table view. */

export function insertionSort(values: number[]): number[] {
  const out = [...values];
  for (let i = 1; i < out.length; i++) {
    const current = out[i]!;
    let j = i - 1;
    while (j >= 0 && out[j]! > current) {
      out[j + 1] = out[j]!;
      j -= 1;
    }
    out[j + 1] = current;
  }
  return out;
}
