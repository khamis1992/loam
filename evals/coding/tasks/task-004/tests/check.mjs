import { applyTax } from "../src/cart.ts";

const cases = [
  [[100, 0.2], 120],
  [[9.99, 0.1], 10.99],
  [[0, 0.5], 0],
  [[1.005, 0], 1],
];

for (const [args, expected] of cases) {
  const actual = applyTax(...args);
  if (actual !== expected) {
    console.error(`applyTax(${args.join(", ")}) = ${actual}, expected ${expected}`);
    process.exit(1);
  }
}

console.log("task-004 ok");
