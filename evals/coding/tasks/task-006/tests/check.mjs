import { totalUnits, inStock } from "../src/inventory.js";

const items = [{ qty: 2 }, { qty: 0 }, { qty: 5 }];
if (totalUnits(items) !== 7) {
  console.error(`totalUnits = ${totalUnits(items)}, expected 7`);
  process.exit(1);
}
if (totalUnits([]) !== 0) {
  console.error("totalUnits([]) should be 0");
  process.exit(1);
}
if (inStock(items).length !== 2) {
  console.error("inStock should keep only positive quantities");
  process.exit(1);
}
console.log("task-006 ok");
