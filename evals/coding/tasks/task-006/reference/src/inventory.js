/** Inventory helpers. */

export function totalUnits(items) {
  let total = 0;
  for (const item of items) {
    total += item.qty;
  }
  return total;
}

export function inStock(items) {
  return items.filter((item) => item.qty > 0);
}
