/** Checkout totals. Amounts are computed in integer cents to avoid float drift. */

import { formatCents } from "./money.ts";

export function lineTotal(qty: number, unitPrice: number): string {
  return formatCents(Math.round(qty * unitPrice * 100));
}

export function grandTotal(rows: Array<[number, number]>): string {
  let cents = 0;
  for (const [qty, unitPrice] of rows) cents += Math.round(qty * unitPrice * 100);
  return formatCents(cents);
}
