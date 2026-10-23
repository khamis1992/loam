import assert from "node:assert/strict";
import { add, multiply, average } from "../src/math.js";

assert.equal(add(2, 3), 5);
assert.equal(add(-1, 1), 0);

assert.equal(multiply(3, 4), 12);
assert.equal(multiply(5, 0), 0);

assert.equal(average([]), 0);
assert.equal(average([2, 4, 6]), 4);
assert.equal(average([1.5, 2.5]), 2);

console.log("math tests passed");
