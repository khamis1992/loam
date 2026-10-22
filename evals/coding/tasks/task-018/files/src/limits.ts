/** Selection helpers for the queue view. */

const isPositive = (value: number): boolean => value > 0;
const isEven = (value: number): boolean => value % 2 === 0;

export function firstPositive(values: number[]): number | undefined {
  return values.find((value) => isPositive(value));
}

export function firstEven(values: number[]): number | undefined {
  return values.find((value) => isEven(value));
}
