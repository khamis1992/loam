import { sum } from "../src/sum.js";

const cases = [
  [[1, 2, 3], 6],
  [[5], 5],
  [[], 0],
  [[-1, -2, -3], -6],
  [[0, 0], 0],
];

for (const [values, expected] of cases) {
  const actual = sum(values);
  if (actual !== expected) {
    console.error(`sum(${JSON.stringify(values)}) = ${actual}, expected ${expected}`);
    process.exit(1);
  }
}
console.log("task-014 ok");
