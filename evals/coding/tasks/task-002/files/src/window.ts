/** Window helpers for paginated lists. */

export function lastN<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  return items.slice(-n - 1);
}
