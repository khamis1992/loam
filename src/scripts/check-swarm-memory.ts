/** Roadmap §5: deterministic check of the project-memory search layer (searchIndex/
 * searchBriefForPrompt) — keyword scoring, dependency-aware lifts, and empty-query safety. */
import assert from "node:assert/strict";
import { buildProjectIndex, searchBriefForPrompt, searchIndex, type ProjectIndex } from "../swarm/projectMemory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-swarm-memory-"));
fs.mkdirSync(path.join(root, "lib"), { recursive: true });
fs.writeFileSync(path.join(root, "lib", "server.cjs"), "module.exports = { start() { return 1; } };\n");
fs.writeFileSync(path.join(root, "lib", "server.utils.cjs"), "module.exports = 2;\n");
fs.writeFileSync(path.join(root, "app.cjs"), "require('./lib/server.cjs');\nmodule.exports = 3;\n");
fs.writeFileSync(path.join(root, "store.cjs"), "module.exports = 4;\n");
fs.writeFileSync(path.join(root, "README.md"), "# docs\n");

const index: ProjectIndex = buildProjectIndex(root);
assert.equal(index.edges.some(e => e.from === "app.cjs" && e.to === "lib/server.cjs"), true, "dependency edge app->lib/server must exist");

const hits = searchIndex(index, "server");
assert.ok(hits.length >= 2, `server query must hit at least 2 files, got ${hits.length}`);
assert.equal(hits[0]!.path, "lib/server.cjs", "exact segment match outranks substring utils");
assert.ok(hits[0]!.score > (hits.find(h => h.path === "lib/server.utils.cjs")?.score ?? 0), "segment scoring beats substring scoring");
assert.ok(hits.find(h => h.path === "lib/server.cjs")?.dependedOnBy.includes("app.cjs"), "dependency-aware lift: dependents listed");

const multi = searchIndex(index, "server store");
assert.ok(multi.some(h => h.path === "store.cjs"), "multi-term queries match each term independently");
assert.equal(searchIndex(index, "").length, 0, "empty query returns nothing");
assert.equal(searchIndex(index, "a ab xyz-nothing").length, 0, "short/junk terms are ignored");

const brief = searchBriefForPrompt(index, "fix the server startup and the store");
assert.match(brief, /lib\/server\.cjs/, "prompt-facing search surfaces the server file");
assert.match(brief, /store\.cjs/, "and the store file");
assert.ok(brief.length <= 601, "prompt-facing search is bounded");
const noHit = searchBriefForPrompt(index, "keyboard navigation unrelated");
assert.equal(noHit, "", "no hits means no prompt injection");

// Reports are never search hits — they are engine artifacts, not project code.
assert.ok(!searchIndex(index, "qa").some(h => h.path.startsWith(".loam/")), "reports stay out of search results");

fs.rmSync(root, { recursive: true, force: true });
console.log("PASS swarm memory search");
