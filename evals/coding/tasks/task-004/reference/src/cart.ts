/** Cart pricing. Rates are fractions (0.2 means 20%). */

export function applyTax(subtotal: number, taxRate: number): number {
  const total = subtotal * (1 + taxRate);
  return Math.round(total * 100) / 100;
}
