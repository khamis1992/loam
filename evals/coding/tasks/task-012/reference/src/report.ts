/** Sales report rendering. */

import { regions, totalAmount } from "./aggregate.ts";

export type Sale = { region: string; amount: number };

export function renderReport(sales: Sale[]): string {
  return `${regions(sales).length} regions, total ${totalAmount(sales)}`;
}
