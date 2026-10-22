import { firstPositive, firstEven } from "../src/limits.ts";

const failures = [];
const eq = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

eq("firstPositive([-1,0,2])", firstPositive([-1, 0, 2]), 2);
eq("firstPositive([])", firstPositive([]), undefined);
eq("firstPositive([-1,-2])", firstPositive([-1, -2]), undefined);
eq("firstEven([1,3,4])", firstEven([1, 3, 4]), 4);
eq("firstEven([1])", firstEven([1]), undefined);
eq("firstEven([0])", firstEven([0]), 0);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("task-018 ok");
