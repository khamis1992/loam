/**
 * Neo N13: "Add to Knowledge Base" from a run node.
 *
 * A canvas node is text the agent produced, so the guarantees the action depends
 * on are about *provenance* and *not inventing content*:
 *   1. every seed records `source: "node"` plus the node id, the run id and which
 *      node version was captured, so a later `kb_search` hit traces back;
 *   2. the node text is split (not stored as one unusable block) and the titles
 *      come from the splitter, never from the caller;
 *   3. a node with no text returns zero seeds with a warning instead of throwing,
 *      because the canvas reports that inline;
 *   4. the preview is honest: it names the same seeds the real ingest would, and
 *      it never calls a model.
 *
 * The store is real (SQLite) behind a throwaway data directory, so the test
 * exercises the same write path the route uses. No network and no model calls.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { closeDb } from "../../server/sqliteStore.js";
import { getBase, listBases } from "../store.js";
import { searchKnowledge } from "../search.js";
import { fixedSplit } from "../splitter.js";
import { NODE_SEED_TAG, ingestNode, nodeProvenance, previewNodeSeeds } from "../fromNode.js";

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN = "task_from_node_1";
const NODE = "node_doc_from_node_1";

describe("node -> knowledge garden", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-from-node-"));
    prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
    else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmpDir = "";
  });

  it("stamps every seed with node provenance", async () => {
    const result = await ingestNode({
      runId: RUN,
      nodeId: NODE,
      nodeType: "document",
      title: "Quarterly report",
      content: "# Billing\nOur billing service charges per seat and invoices monthly.\n\n# Deploy\nThe deploy pipeline runs on GitHub Actions and is idempotent.",
      tags: ["finance"],
      split: "fixed",
      version: 3,
    });

    // Assert the number the default splitter really produces rather than guessing.
    assert.equal(
      result.seeds.length,
      fixedSplit("# Billing\nOur billing service charges per seat and invoices monthly.\n\n# Deploy\nThe deploy pipeline runs on GitHub Actions and is idempotent.").length,
      "one seed per splitter chunk",
    );
    for (const seed of result.seeds) {
      assert.equal(seed.provenance?.source, "node", "the seed names its real origin");
      assert.equal(seed.provenance?.ref, NODE, "the provenance points at the node");
      assert.equal(seed.provenance?.runId, RUN, "the provenance names the run");
      assert.equal(seed.provenance?.nodeType, "document");
      assert.equal(seed.provenance?.nodeVersion, 3, "the captured version is recorded");
      assert.ok(seed.tags.includes(NODE_SEED_TAG), "node seeds are recognisable in the garden");
      assert.ok(seed.tags.includes("finance"), "caller tags survive");
    }
    assert.equal(result.baseName, "Quarterly report", "the node title names the base");

    // The seeds are really stored, so a later search finds them.
    assert.equal(getBase(result.baseId)?.seeds.length, result.seeds.length);
    assert.equal(listBases().some((base) => base.id === result.baseId), true);
  });

  it("reports the split strategy honestly in the provenance", async () => {
    const fixed = await ingestNode({
      runId: RUN,
      nodeId: NODE,
      title: "Notes",
      content: "alpha\nbeta\ngamma",
      split: "fixed",
    });
    assert.equal(fixed.smartSplit, false);
    for (const seed of fixed.seeds) assert.equal(seed.provenance?.split, "fixed");

    // An unavailable smart splitter is not a failure: the fallback is reported.
    const fallback = await ingestNode({
      runId: RUN,
      nodeId: NODE,
      title: "Notes",
      content: "alpha\nbeta\ngamma",
      split: "llm",
    });
    assert.equal(fallback.smartSplit, false, "no splitter wired means the fixed fallback");
    assert.ok(fallback.warnings.some((warning) => warning.includes("fallback")), "the fallback is surfaced");
    for (const seed of fallback.seeds) assert.equal(seed.provenance?.split, "fixed");
  });

  it("reuses an existing base instead of duplicating it", async () => {
    const first = await ingestNode({ runId: RUN, nodeId: NODE, title: "Runbook", content: "restart the service" });
    const second = await ingestNode({ runId: RUN, nodeId: "node_doc_other", title: "Runbook", content: "rotate the keys" });
    assert.equal(second.baseId, first.baseId, "the same base name lands in one base");
    // `listBases` reports the stored count; `getBase` returns the whole row.
    const summary = listBases().find((row) => row.id === first.baseId);
    assert.equal(summary?.seeds, first.seeds.length + second.seeds.length);
    const base = getBase(first.baseId);
    assert.equal(base?.seeds.length, first.seeds.length + second.seeds.length);
  });

  it("returns zero seeds with a warning for a node that carries no text", async () => {
    const result = await ingestNode({ runId: RUN, nodeId: NODE, title: "Empty", content: "   " });
    assert.equal(result.seeds.length, 0);
    assert.ok(result.warnings.some((warning) => warning.includes("no text")));
    // No empty base is created for nothing.
    assert.equal(listBases().length, 0);
  });

  it("previews the same split the real ingest uses, without a model", () => {
    // The preview runs the fixed splitter, so it must match that splitter's own
    // output: same titles, same bodies, plus the tag the real ingest adds.
    const content = "# Alpha\nfirst section body\n\n# Beta\nsecond section body\n\n# Gamma\nthird section body";
    const expected = fixedSplit(content);
    const preview = previewNodeSeeds({ runId: RUN, nodeId: NODE, title: "Doc", content, tags: ["x"] });
    assert.deepEqual(preview.map((seed) => seed.title), expected.map((chunk) => chunk.title));
    assert.deepEqual(preview.map((seed) => seed.body), expected.map((chunk) => chunk.body));
    assert.ok(preview.every((seed) => seed.tags.includes(NODE_SEED_TAG)));

    // The preview is a read-only estimate: nothing was written.
    assert.equal(listBases().length, 0);

    assert.deepEqual(previewNodeSeeds({ runId: RUN, nodeId: NODE, content: "" }), []);
  });

  it("makes node-sourced seeds findable by content", async () => {
    await ingestNode({
      runId: RUN,
      nodeId: NODE,
      title: "Infra notes",
      content: "The postgres replica is promoted by the failover controller when the primary stops accepting writes.",
      split: "fixed",
    });
    const result = await searchKnowledge("failover controller promotes the replica", { k: 5 });
    assert.ok(result.hits.length > 0, "the seed is retrievable by its content");
    // The hit names the seed, so the provenance is one lookup away: the search
    // itself never has to invent it.
    const base = getBase(result.hits[0]!.baseId);
    const seed = base?.seeds.find((row) => row.id === result.hits[0]!.seedId);
    assert.equal(seed?.provenance?.source, "node", "the seed carries its provenance back");
    assert.equal(seed?.provenance?.ref, NODE);
  });

  it("builds provenance without ingesting anything", () => {
    assert.deepEqual(nodeProvenance({ runId: RUN, nodeId: NODE, nodeType: "webpage", version: 2 }), {
      source: "node",
      ref: NODE,
      runId: RUN,
      split: "fixed",
      nodeType: "webpage",
      nodeVersion: 2,
    });
    const bare = nodeProvenance({ runId: RUN, nodeId: NODE });
    assert.equal(bare.nodeType, undefined, "omitted fields stay omitted");
    assert.equal(bare.nodeVersion, undefined);
  });
});
