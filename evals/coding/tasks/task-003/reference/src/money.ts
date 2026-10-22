/** Shared money formatting. Amounts are integer cents. */

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
