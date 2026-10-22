/** Selection helpers for the queue view. */

export function firstPositive(values: number[]): number | undefined {
  return values.find((value) => value > 0);
}

export function firstEven(values: number[]): number | undefined {
  return values.find((value) => value % 2 === 0);
}
