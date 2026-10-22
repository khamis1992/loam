/**
 * invoice.mjs — invoice total calculation (no dependencies).
 */

/**
 * Compute the invoice total for a list of items.
 *
 * @param {Array<{quantity: number, price: number}>} items
 * @returns {number} Sum of (quantity * price) rounded to 2 decimal places.
 *                   Returns 0 for an empty array.
 * @throws {RangeError} If any item has a negative or non-finite quantity or price.
 */
export function total(items) {
  if (!Array.isArray(items)) {
    throw new RangeError('total(items) expects an array of items');
  }

  let sum = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const quantity = item.quantity;
    const price = item.price;

    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
      throw new RangeError(
        `Item at index ${i} has an invalid quantity: expected a non-negative finite number, got ${String(quantity)}`
      );
    }

    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      throw new RangeError(
        `Item at index ${i} has an invalid price: expected a non-negative finite number, got ${String(price)}`
      );
    }

    sum += quantity * price;
  }

  // Round to 2 decimal places.
  return Math.round(sum * 100) / 100;
}