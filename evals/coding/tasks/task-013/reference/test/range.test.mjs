import assert from "node:assert/strict";
import { range } from "../src/range.ts";

assert.deepEqual(range(0, 3), [0, 1, 2]);
assert.deepEqual(range(0, 0), []);
assert.deepEqual(range(2, -1, -1), [2, 1, 0]);
assert.deepEqual(range(0, 6, 2), [0, 2, 4]);
assert.deepEqual(range(5, 5), []);
assert.throws(() => range(0, 1, 0));

console.log("range tests passed");
