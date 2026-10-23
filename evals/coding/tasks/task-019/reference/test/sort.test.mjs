import assert from "node:assert/strict";
import { insertionSort } from "../src/sort.ts";

const sample = [5, 3, 9, 1, 3, -2];
assert.deepEqual(insertionSort(sample), [-2, 1, 3, 3, 5, 9]);
assert.deepEqual(sample, [5, 3, 9, 1, 3, -2], "input must not be mutated");
assert.deepEqual(insertionSort([]), []);
assert.deepEqual(insertionSort([7]), [7]);

// Deterministic pseudo-random generator keeps the run reproducible.
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

for (let trial = 0; trial < 60; trial += 1) {
  const size = Math.floor(rand() * 20);
  const input = Array.from({ length: size }, () => Math.round(rand() * 200) - 100);
  const snapshot = [...input];
  const result = insertionSort(input);

  assert.equal(result.length, input.length, `length changed on trial ${trial}`);
  for (let i = 1; i < result.length; i += 1) {
    assert.ok(result[i - 1] <= result[i], `not sorted at index ${i} on trial ${trial}`);
  }
  assert.deepEqual([...result].sort((a, b) => a - b), [...snapshot].sort((a, b) => a - b));
  assert.deepEqual(input, snapshot, `input mutated on trial ${trial}`);
}

console.log("sort property tests passed");
