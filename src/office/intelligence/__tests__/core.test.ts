import assert from "node:assert";
import { describe, it } from "node:test";
import type { StudioArtifact } from "../../../studio/store.js";
import { createSourceAnchor, verifySourceAnchor } from "../citations.js";
import { applyOfficeChangeSet, createOfficeChangeSet } from "../changesets.js";
import { canAccessOfficeScope, requireOfficeAccess, type OfficeIdentity } from "../authorization.js";
import { parseArtifactRef, type ArtifactRef } from "../contracts.js";
import { sanitizeModelOps } from "../capabilities.js";

const ref: ArtifactRef = {
  taskId: "task_1",
  path: "uploads/case.docx",
  kind: "document",
  revision: 0,
  contentHash: "a".repeat(64),
  tenantId: "local",
};

const documentArtifact = (): StudioArtifact => ({
  kind: "document",
  title: "Case",
  revision: 0,
  content: { blocks: [{ type: "paragraph", text: "Original" }, { type: "paragraph", text: "Untouched" }] },
});

describe("Office intelligence contracts and citations", () => {
  it("validates artifact references", () => {
    assert.deepEqual(parseArtifactRef(ref), ref);
    assert.throws(() => parseArtifactRef({ ...ref, contentHash: "bad" }), /contentHash/);
    assert.throws(() => parseArtifactRef({ ...ref, revision: -1 }), /revision/);
  });

  it("verifies source content and detects stale or changed sources", () => {
    const anchor = createSourceAnchor({ artifact: ref, kind: "block", anchor: "1", text: "  الأولى\nنص الدليل  " });
    assert.equal(verifySourceAnchor(anchor, { artifact: ref, text: anchor.excerpt }), "valid");
    assert.equal(verifySourceAnchor(anchor, { artifact: ref, text: "different" }), "changed");
    assert.equal(verifySourceAnchor(anchor, { artifact: { ...ref, revision: 1 }, text: anchor.excerpt }), "stale");
    assert.equal(verifySourceAnchor(anchor, undefined), "missing");
  });
});

describe("Office authorization", () => {
  const identity: OfficeIdentity = {
    id: "lawyer_1",
    tenantIds: ["firm"],
    roles: ["associate"],
    matterIds: ["matter-1", "matter-2"],
    ethicalWallMatterIds: ["matter-2"],
  };

  it("enforces permissions, tenant, matter scope and ethical walls", () => {
    const scope = { tenantId: "firm", matterId: "matter-1" };
    assert.equal(canAccessOfficeScope(identity, scope), true);
    assert.doesNotThrow(() => requireOfficeAccess(identity, scope, "office:ai"));
    assert.throws(() => requireOfficeAccess(identity, scope, "office:approve"), /permission denied/);
    assert.equal(canAccessOfficeScope(identity, { tenantId: "firm", matterId: "matter-2" }), false);
    assert.equal(canAccessOfficeScope(identity, { tenantId: "other", matterId: "matter-1" }), false);
  });
});

describe("Office change sets", () => {
  it("applies targeted operations without changing other blocks", () => {
    const changeSet = createOfficeChangeSet(ref, [{ op: "set-block-text", block: 1, value: "Edited" }]);
    const result = applyOfficeChangeSet(documentArtifact(), changeSet);
    assert.equal(result.artifact.kind, "document");
    if (result.artifact.kind === "document") {
      assert.equal(result.artifact.content.blocks[0]?.text, "Edited");
      assert.equal(result.artifact.content.blocks[1]?.text, "Untouched");
    }
    assert.equal(result.applied.length, 1);
  });

  it("rejects stale revisions and invalid operations atomically", () => {
    const changeSet = createOfficeChangeSet(ref, [{ op: "set-block-text", block: 99, value: "bad" }]);
    assert.throws(() => applyOfficeChangeSet(documentArtifact(), changeSet), /not applied/);
    assert.throws(() => applyOfficeChangeSet(documentArtifact(), { ...changeSet, expectedRevision: 1 }), /changed/);
  });

  it("accepts only bounded model operations", () => {
    assert.deepEqual(sanitizeModelOps([{ op: "set-cell", address: "b2", value: "42" }]), [{ op: "set-cell", address: "B2", value: "42" }]);
    assert.throws(() => sanitizeModelOps([{ op: "delete-file", path: "secret" }]), /unsupported/);
    assert.throws(() => sanitizeModelOps([{ op: "set-block-text", block: 0, value: "bad" }]), /invalid/);
  });
});
