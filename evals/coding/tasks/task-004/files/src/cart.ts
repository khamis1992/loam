/** Cart pricing. Rates are fractions (0.2 means 20%). */

export function applyTax(a: number, b: number): number {
  const x = a * (1 + b);
  return Math.round(x * 100) / 100;
}
