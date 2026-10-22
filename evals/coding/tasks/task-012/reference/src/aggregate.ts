/** Aggregation helpers used by the report renderer. */

import type { Sale } from "./report.ts";

export function totalAmount(sales: Sale[]): number {
  let total = 0;
  for (const sale of sales) total += sale.amount;
  return total;
}

export function regions(sales: Sale[]): string[] {
  return [...new Set(sales.map((sale) => sale.region))].sort();
}
