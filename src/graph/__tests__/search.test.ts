/**
 * Neo N18: search across canvas nodes.
 *
 * The acceptance rule is that a search finds the nodes that mention the term
 * (case- and accent-insensitively), reports *where* the term matched so the
 * canvas can highlight the span, and never returns more than the limit.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { normaliseText, searchCanvasNodes, searchMatches, type CanvasSearchHit } from "../search.js";

interface Node {
  id: string;
  type: string;
  status: string;
  data?: Record<string, unknown>;
  position?: number;
}

function node(id: string, data: Record<string, unknown>, type = "recipe_step", status = "finished"): Node {
  return { id, type, status, data, position: Number(id.replace(/\D/g, "")) || 0 };
}

describe("canvas search normalisation", () => {
  it("folds case, accents and whitespace", () => {
    assert.equal(normaliseText("  Café   AU LAIT "), "cafe au lait");
    assert.equal(normaliseText("naïve"), "naive");
    assert.equal(normaliseText(""), "");
  });
});

describe("canvas node search", () => {
  const nodes: Node[] = [
    node("1", { title: "Gather sources", query: "quarterly revenue", tool: "web_search" }, "search", "running"),
    node("2", { title: "Draft the report", path: "report.md" }, "document", "finished"),
    node("3", { title: "Fetch the page", url: "https://example.com/quarterly" }, "webpage", "failed"),
    node("4", { title: "Unrelated step" }),
    node("5", { summary: "Café au lait sources" }),
  ];

  it("finds nodes by any searchable field, in graph order", () => {
    const hits = searchCanvasNodes(nodes, "quarterly");
    assert.deepEqual(
      hits.map((hit) => hit.nodeId),
      ["1", "3"],
    );
    // The first hit matched the `query` field, the second the `url`.
    assert.deepEqual(
      hits.map((hit) => hit.matches[0]!.field),
      ["query", "url"],
    );
    assert.equal(hits[0]!.matches[0]!.snippet, "quarterly");
  });

  it("reports the exact span of every match, including repeats", () => {
    const hits = searchCanvasNodes(nodes, "report");
    assert.deepEqual(hits.map((hit) => hit.nodeId), ["2"]);
    assert.deepEqual(
      hits[0]!.matches.map((match) => [match.field, match.start, match.length]),
      [
        // Offsets are in the node's original text, not the folded copy: folding
        // collapses whitespace, so "report" starts at 10 in "Draft the report".
        ["title", 10, 6],
        ["path", 0, 6],
      ],
    );
  });

  it("maps a folded span back to the accented characters it came from", () => {
    const hits = searchCanvasNodes(nodes, "cafe");
    assert.deepEqual(hits.map((hit) => hit.nodeId), ["5"]);
    const match = hits[0]!.matches[0]!;
    assert.deepEqual({ start: match.start, length: match.length }, { start: 0, length: 4 });
    assert.equal(match.snippet, "Café", "the snippet is the original text, accents and all");
  });

  it("matches case-insensitively and accent-insensitively by default", () => {
    assert.deepEqual(searchCanvasNodes(nodes, "CAFÉ").map((hit) => hit.nodeId), ["5"]);
    assert.deepEqual(searchCanvasNodes(nodes, "cafe").map((hit) => hit.nodeId), ["5"]);
  });

  it("can be made exact and diacritic-sensitive", () => {
    assert.deepEqual(searchCanvasNodes(nodes, "Café", { fold: false, ignoreCase: false }).map((hit) => hit.nodeId), ["5"]);
    assert.deepEqual(searchCanvasNodes(nodes, "cafe", { fold: false, ignoreCase: false }), [], "no accent, no hit");
  });

  it("returns nothing for an empty or unmatched term", () => {
    assert.deepEqual(searchCanvasNodes(nodes, ""), []);
    assert.deepEqual(searchCanvasNodes(nodes, "   "), []);
    assert.deepEqual(searchCanvasNodes(nodes, "zzz"), []);
  });

  it("filters by node type when one is given", () => {
    assert.deepEqual(searchCanvasNodes(nodes, "quarterly", { types: ["webpage"] }).map((hit) => hit.nodeId), ["3"]);
    assert.deepEqual(searchCanvasNodes(nodes, "quarterly", { types: ["document"] }), []);
    assert.deepEqual(searchCanvasNodes(nodes, "quarterly", { types: [] }).map((hit) => hit.nodeId), ["1", "3"]);
  });

  it("stops at the limit instead of returning every match", () => {
    const many: Node[] = Array.from({ length: 10 }, (_, index) => node(String(index), { title: `report ${index}` }));
    const hits = searchCanvasNodes(many, "report", { limit: 3 });
    assert.equal(hits.length, 3);
    assert.deepEqual(hits.map((hit) => hit.nodeId), ["0", "1", "2"]);
  });

  it("matches the node type itself, so a user can search for a kind", () => {
    assert.deepEqual(searchCanvasNodes(nodes, "webpage").map((hit) => hit.nodeId), ["3"]);
  });

  it("exposes the matched node ids as a highlight set", () => {
    const hits: CanvasSearchHit[] = [{ nodeId: "a", nodeType: "note", nodeStatus: "finished", title: "a", matches: [] }];
    assert.deepEqual([...searchMatches(hits)], ["a"]);
    assert.deepEqual([...searchMatches([])], []);
  });
});
