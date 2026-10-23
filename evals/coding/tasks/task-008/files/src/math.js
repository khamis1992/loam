/** Tiny math helpers. */

export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}

export function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
