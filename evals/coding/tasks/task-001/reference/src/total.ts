/** Running-total helpers used by the checkout screen. */

export function calculateTotal(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
