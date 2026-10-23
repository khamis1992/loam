import { addPrices } from "../src/cart.js";

const cases = [
  [["2", "3"], 5],
  [[2, 3], 5],
  [["1.5", 2], 3.5],
  [["", 4], 4],
  [["-2", "2"], 0],
  [["0.1", "0.2"], 0.30000000000000004],
];

for (const [args, expected] of cases) {
  const actual = addPrices(...args);
  if (actual !== expected) {
    console.error(`addPrices(${args.map((a) => JSON.stringify(a)).join(", ")}) = ${actual}, expected ${expected}`);
    process.exit(1);
  }
  if (typeof actual !== "number") {
    console.error(`addPrices returned ${typeof actual}, expected number`);
    process.exit(1);
  }
}
console.log("task-020 ok");
