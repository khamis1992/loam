import assert from "node:assert/strict";
import { slugify, truncate, titleCase } from "../src/strings.ts";

assert.equal(slugify("  Hello, World!  "), "hello-world");
assert.equal(slugify("already-slug"), "already-slug");
assert.equal(slugify("!!!"), "");

assert.equal(truncate("abcdef", 10), "abcdef");
assert.equal(truncate("abcdef", 4), "abc…");
assert.equal(truncate("abcdef", 0), "");

assert.equal(titleCase("hello   world"), "Hello World");
assert.equal(titleCase("MIXED case"), "Mixed Case");

console.log("strings tests passed");
