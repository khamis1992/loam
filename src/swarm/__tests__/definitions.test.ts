import { test } from "node:test";
import assert from "node:assert/strict";
import { SwarmService, DEFAULT_OPTIONS, RECOMMENDED_OPTIONS } from "../service.js";

const ids = (defs: Array<[string, string, string, string[]]>) => defs.map(d => d[0]);
const deps = (defs: Array<[string, string, string, string[]]>, id: string) => defs.find(d => d[0] === id)![3];
const { effort: _effort, ...recommended } = RECOMMENDED_OPTIONS;

test("default options keep the existing pipelines unchanged", () => {
  assert.deepEqual(ids(SwarmService.buildDefinitions("full", "api", DEFAULT_OPTIONS)), ["discovery", "ux", "requirements", "architecture", "research", "repo", "implementation", "review", "testgen", "qa", "delivery", "deploy", "merge"]);
  const web = SwarmService.buildDefinitions("full", "web", DEFAULT_OPTIONS);
  assert.deepEqual(deps(web, "review"), ["impl-api", "impl-ui"]);
  assert.deepEqual(ids(SwarmService.buildDefinitions("solo", "web", RECOMMENDED_OPTIONS)), ["solo", "deploy", "merge"], "solo ignores lifecycle insertions");
});

test("lite is five model stages plus the engine stages", () => {
  const lite = SwarmService.buildDefinitions("lite", "library", DEFAULT_OPTIONS);
  assert.deepEqual(ids(lite), ["requirements", "implementation", "review", "testgen", "qa", "deploy", "merge"]);
});

test("the recommended profile inserts intake, approval, two-stage review and visual", () => {
  const web = SwarmService.buildDefinitions("full", "web", { ...recommended, approval: "required" });
  assert.equal(ids(web)[0], "intake");
  assert.deepEqual(deps(web, "discovery"), ["intake"]);
  assert.deepEqual(deps(web, "approval"), ["architecture", "research", "repo"]);
  assert.deepEqual(deps(web, "impl-api"), ["approval"]);
  assert.deepEqual(deps(web, "impl-ui"), ["approval"]);
  assert.deepEqual(deps(web, "review-spec"), ["impl-api", "impl-ui"]);
  assert.deepEqual(deps(web, "review-quality"), ["review-spec"]);
  assert.deepEqual(deps(web, "testgen"), ["review-quality"]);
  assert.deepEqual(deps(web, "visual"), ["qa"]);
  assert.deepEqual(deps(web, "delivery"), ["visual"]);
  assert.ok(!ids(web).includes("review"));
  const api = SwarmService.buildDefinitions("full", "api", { ...recommended, approval: "required" });
  assert.ok(!ids(api).includes("visual"), "visual only for the web track");
  const liteWeb = SwarmService.buildDefinitions("lite", "web", { ...recommended, approval: "required" });
  assert.deepEqual(deps(liteWeb, "deploy"), ["visual"]);
  assert.deepEqual(deps(liteWeb, "approval"), ["requirements"]);
});

test("every stage dependency exists and the graph is acyclic", () => {
  for (const effort of ["lite", "full"] as const) for (const track of ["web", "api", "library", "mobile", "desktop", "ai"] as const) {
    const defs = SwarmService.buildDefinitions(effort, track, { ...recommended, approval: "required" });
    const known = new Set(ids(defs));
    const done = new Set<string>();
    for (const [id, , , d] of defs) { for (const x of d) { assert.ok(known.has(x), `${effort}/${track}: ${id} depends on unknown ${x}`); assert.ok(done.has(x), `${effort}/${track}: ${id} listed before ${x}`); } done.add(id); }
  }
});
