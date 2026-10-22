import { renderReport } from "../src/report.ts";
import { totalAmount, regions } from "../src/aggregate.ts";

const sales = [
  { region: "eu", amount: 10 },
  { region: "us", amount: 5 },
  { region: "eu", amount: 2 },
];

const failures = [];
const eq = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
};

eq("renderReport", renderReport(sales), "2 regions, total 17");
eq("renderReport([])", renderReport([]), "0 regions, total 0");
eq("totalAmount", totalAmount(sales), 17);
eq("totalAmount([])", totalAmount([]), 0);
eq("regions", regions(sales), ["eu", "us"]);
eq("regions([])", regions([]), []);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("task-012 ok");
