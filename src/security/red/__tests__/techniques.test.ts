/**
 * Tradecraft registry tests (RED_TEAM_BUILD_SPEC §6.12): every technique is
 * documented at concept level AND carries a usable detection signature.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectionSignatures, getTechnique, listTechniques, TECHNIQUES } from "../techniques/index.js";

describe("technique registry", () => {
  it("covers the four tradecraft tools with concept + detection", () => {
    assert.deepEqual(
      TECHNIQUES.map((t) => t.id).sort(),
      ["function-stomping", "hashdump-bypass-edr", "mrkaplan-anti-forensics", "venom-stealth-comms"],
    );
    for (const t of TECHNIQUES) {
      assert.match(t.attackId, /^T\d{4}/, `${t.id} needs an ATT&CK id`);
      assert.ok(t.concept.length > 80, `${t.id} concept must be substantive`);
      assert.ok(t.detection.signature.length > 40, `${t.id} detection signature must be actionable`);
      assert.ok(t.detection.surface.length > 0);
      assert.ok(t.source.length > 0);
    }
  });

  it("listTechniques returns a copy; getTechnique finds by id", () => {
    const list = listTechniques();
    assert.equal(list.length, TECHNIQUES.length);
    list.pop();
    assert.equal(listTechniques().length, TECHNIQUES.length, "copies are detached");
    assert.equal(getTechnique("mrkaplan-anti-forensics")!.attackId, "T1070");
    assert.equal(getTechnique("nope"), undefined);
  });

  it("detectionSignatures is the blue hand-off surface", () => {
    const sigs = detectionSignatures();
    assert.equal(sigs.length, TECHNIQUES.length);
    assert.ok(sigs.every((s) => s.techniqueId && s.attackId && s.surface && s.signature));
    assert.ok(sigs.some((s) => s.surface.includes("image-integrity") || s.surface.includes("edr")));
    assert.ok(sigs.some((s) => s.surface.includes("log-integrity")));
  });
});
