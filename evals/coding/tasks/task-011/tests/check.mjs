import { median } from "../src/stats.ts";

const failures = [];
const eq = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

eq("median([])", median([]), null);
eq("median([5])", median([5]), 5);
eq("median([1,2,3])", median([1, 2, 3]), 2);
eq("median([1,2,3,4])", median([1, 2, 3, 4]), 2.5);
eq("median([4,1,3,2])", median([4, 1, 3, 2]), 2.5);
eq("median([-1,-2])", median([-1, -2]), -1.5);
eq("median([3,1])", median([3, 1]), 2);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("task-011 ok");
