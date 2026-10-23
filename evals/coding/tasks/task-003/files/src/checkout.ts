/** Checkout totals. Amounts are computed in integer cents to avoid float drift. */

export function lineTotal(qty: number, unitPrice: number): string {
  const cents = Math.round(qty * unitPrice * 100);
  return `$${(cents / 100).toFixed(2)}`;
}

export function grandTotal(rows: Array<[number, number]>): string {
  let cents = 0;
  for (const [qty, unitPrice] of rows) cents += Math.round(qty * unitPrice * 100);
  return `$${(cents / 100).toFixed(2)}`;
}
