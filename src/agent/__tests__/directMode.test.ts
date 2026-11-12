import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldUseConciseTools } from "../directMode.js";

describe("direct mode tool filtering", () => {
  it("keeps service-pack artifact tools instead of reducing the run to read-only tools", () => {
    assert.equal(shouldUseConciseTools(true, "loam-slides"), false);
    assert.equal(shouldUseConciseTools(true, "loam-video"), false);
  });

  it("keeps the concise toolset for simple runs without a service pack", () => {
    assert.equal(shouldUseConciseTools(true), true);
    assert.equal(shouldUseConciseTools(false), false);
  });
});
