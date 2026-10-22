/** Sales report rendering. */

export type Sale = { region: string; amount: number };

function totalAmount(sales: Sale[]): number {
  let total = 0;
  for (const sale of sales) total += sale.amount;
  return total;
}

function regions(sales: Sale[]): string[] {
  return [...new Set(sales.map((sale) => sale.region))].sort();
}

export function renderReport(sales: Sale[]): string {
  return `${regions(sales).length} regions, total ${totalAmount(sales)}`;
}
