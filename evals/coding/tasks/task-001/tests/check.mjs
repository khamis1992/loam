import { calculateTotal } from "../src/total.ts";

const cases = [
  [[], 0],
  [[7], 7],
  [[1, 2, 3], 6],
  [[-1, 1, 4], 4],
  [[0.5, 0.25], 0.75],
];

for (const [input, expected] of cases) {
  const actual = calculateTotal(input);
  if (actual !== expected) {
    console.error(`calculateTotal(${JSON.stringify(input)}) = ${actual}, expected ${expected}`);
    process.exit(1);
  }
}

console.log("task-001 ok");
