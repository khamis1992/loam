import { lookupKey, canonicalize } from "../src/users.js";
import { normalizeKey } from "../src/text.js";

const failures = [];
const eq = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
};

eq("lookupKey padded", lookupKey("  Ada@Example.COM "), "ada@example.com");
eq("lookupKey number", lookupKey(42), "42");
eq("normalizeKey", normalizeKey(" X "), "x");
eq("canonicalize", canonicalize(["B@x.com", "a@x.com"]), ["a@x.com", "b@x.com"]);
eq("canonicalize empty", canonicalize([]), []);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("task-015 ok");
