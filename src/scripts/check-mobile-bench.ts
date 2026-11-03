import assert from "node:assert/strict";
import { runMobileParserBenchmark } from "../security/bench/mobile.js";

const result = runMobileParserBenchmark();
assert.equal(result.cases, 4);
assert.equal(result.tp, 2);
assert.equal(result.fp, 0);
assert.equal(result.fn, 0);
assert.equal(result.tn, 2);
assert.equal(result.precision, 1);
assert.equal(result.recall, 1);
console.log(`check:mobile-bench PASS — ${result.cases} independent fixtures, precision=${result.precision}, recall=${result.recall}; small parser gate, not a general detection-rate claim`);
