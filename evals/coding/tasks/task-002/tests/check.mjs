import { lastN } from "../src/window.ts";

const cases = [
  [[1, 2, 3, 4], 2, [3, 4]],
  [[1, 2, 3, 4], 1, [4]],
  [[1, 2, 3], 3, [1, 2, 3]],
  [[1, 2, 3], 9, [1, 2, 3]],
  [[1, 2, 3], 0, []],
  [[], 2, []],
];

for (const [items, n, expected] of cases) {
  const actual = lastN(items, n);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`lastN(${JSON.stringify(items)}, ${n}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    process.exit(1);
  }
}

console.log("task-002 ok");
