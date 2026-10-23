import { lineTotal, grandTotal } from "../src/checkout.ts";
import { formatCents } from "../src/money.ts";

const failures = [];
const eq = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

eq("formatCents(0)", formatCents(0), "$0.00");
eq("formatCents(5)", formatCents(5), "$0.05");
eq("formatCents(1999)", formatCents(1999), "$19.99");
eq("formatCents(100000)", formatCents(100000), "$1000.00");
eq("lineTotal(2, 3.5)", lineTotal(2, 3.5), "$7.00");
eq("grandTotal([[2, 3.5], [1, 1.25]])", grandTotal([[2, 3.5], [1, 1.25]]), "$8.25");

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("task-003 ok");
