import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScorerInput, ToolPair } from "../types.js";
import { HeuristicScorer } from "../heuristicScorer.js";

let n = 0;
const mk = (over: Partial<ToolPair> & { tool: string }): ToolPair => ({
  id: over.id ?? `p${n++}`, assistantIndex: 1, callIndex: 0, toolIndex: 2, argsJson: `{"i":${n}}`,
  resultChars: 100, ok: true, stepsAgo: 0, pinned: false, ...over,
});

function input(pairs: ToolPair[], bodies: Record<string, string> = {}, over: Partial<ScorerInput> = {}, later = ""): ScorerInput {
  return {
    goal: "", query: "", pairs, bodies: new Map(Object.entries(bodies)),
    laterAssistantText: () => later, ...over,
  };
}

const s = new HeuristicScorer();
const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("a read superseded by a later read of the same path scores keepResult 0.1", async () => {
  const a = mk({ tool: "file_read", path: "src/a.ts", argsJson: '{"o":1}' });
  const b = mk({ tool: "file_read", path: "src/a.ts", argsJson: '{"o":2}' });
  const out = await s.score(input([a, b]));
  assert.equal(out.get(a.id)!.keepResult, 0.1);
  assert.equal(out.get(a.id)!.keepCall, 0.55);
});

test("a later identical call supersedes and lowers keepCall to 0.2", async () => {
  const a = mk({ tool: "web_search", argsJson: '{"q":"x"}' });
  const b = mk({ tool: "web_search", argsJson: '{"q":"x"}' });
  const r = (await s.score(input([a, b]))).get(a.id)!;
  assert.deepEqual(r, { keepCall: 0.2, keepResult: 0.1 });
});

test("the latest failing call scores 0.9", async () => {
  const a = mk({ tool: "shell_run", ok: false, argsJson: '{"c":1}' });
  const b = mk({ tool: "file_read", path: "x" });
  assert.equal((await s.score(input([a, b]))).get(a.id)!.keepResult, 0.9);
});

test("an error followed by an ok call of the same tool without a path scores 0.2", async () => {
  const a = mk({ tool: "web_fetch", ok: false, argsJson: '{"u":1}' });
  const b = mk({ tool: "web_fetch", ok: true, argsJson: '{"u":2}' });
  assert.equal((await s.score(input([a, b]))).get(a.id)!.keepResult, 0.2);
});

test("an error fixed by a later ok call on the same path is superseded (0.1)", async () => {
  const a = mk({ tool: "file_edit", ok: false, path: "src/a.ts", argsJson: '{"e":1}' });
  const b = mk({ tool: "file_edit", ok: true, path: "src/a.ts", argsJson: '{"e":2}' });
  assert.equal((await s.score(input([a, b]))).get(a.id)!.keepResult, 0.1);
});

test("side-effect tools get keepCall 0.8; custom sets are honoured", async () => {
  const a = mk({ tool: "file_write", path: "p" });
  const b = mk({ tool: "my_tool" });
  const out = await s.score(input([a, b]));
  assert.equal(out.get(a.id)!.keepCall, 0.8);
  assert.equal(out.get(b.id)!.keepCall, 0.55);
  const custom = await new HeuristicScorer(["my_tool"]).score(input([a, b]));
  assert.equal(custom.get(b.id)!.keepCall, 0.8);
  assert.equal(custom.get(a.id)!.keepCall, 0.55);
});

test("relevance and recency: matching body beats unrelated, older decays", async () => {
  const a = mk({ tool: "file_read", path: "a", stepsAgo: 0 });
  const b = mk({ tool: "file_read", path: "b", stepsAgo: 0 });
  const c = mk({ tool: "file_read", path: "c", stepsAgo: 10 });
  const bodies = { [a.id]: "zebra zebra zebra", [b.id]: "completely different words", [c.id]: "zebra zebra zebra" };
  const out = await s.score(input([a, b, c], bodies, { query: "zebra" }));
  near(out.get(a.id)!.keepResult, 0.75);
  near(out.get(b.id)!.keepResult, 0.15);
  near(out.get(c.id)!.keepResult, 0.15 + 0.6 * 0.97 ** 10);
});

test("referenced identifiers add 0.25; huge bodies lose 0.1", async () => {
  const a = mk({ tool: "shell_run", path: undefined, resultChars: 9000 });
  const b = mk({ tool: "file_read", path: "src/other.ts" });
  const bodies = { [a.id]: "see build_output_dir for details", [b.id]: "nothing" };
  const plain = await s.score(input([a, b], bodies));
  near(plain.get(a.id)!.keepResult, 0.05);
  const ref = await s.score(input([a, b], bodies, {}, "I checked build_output_dir already"));
  near(ref.get(a.id)!.keepResult, 0.3);
  const byPath = await s.score(input([a, b], bodies, {}, "edited src/other.ts"));
  near(byPath.get(b.id)!.keepResult, 0.4);
});

test("empty bodies and empty query never produce NaN; scores stay in [0,1]", async () => {
  const pairs = [mk({ tool: "a", resultChars: 0 }), mk({ tool: "b", resultChars: 99999, ok: false })];
  for (const q of ["", "anything"]) {
    const out = await s.score(input(pairs, {}, { query: q }));
    for (const v of out.values()) {
      for (const x of [v.keepCall, v.keepResult]) assert.ok(Number.isFinite(x) && x >= 0 && x <= 1);
    }
  }
  assert.equal((await s.score(input([]))).size, 0);
});

test("deterministic: three runs on the same input are identical", async () => {
  const pairs = [
    mk({ tool: "file_read", path: "a", stepsAgo: 3 }), mk({ tool: "file_read", path: "a", stepsAgo: 2 }),
    mk({ tool: "shell_run", ok: false, stepsAgo: 1 }), mk({ tool: "web_fetch", stepsAgo: 0 }),
  ];
  const bodies = Object.fromEntries(pairs.map((p, i) => [p.id, `body ${i} alpha beta gamma`]));
  const run = async (): Promise<string> => JSON.stringify([...(await s.score(input(pairs, bodies, { query: "alpha gamma" }))).entries()]);
  const [r1, r2, r3] = [await run(), await run(), await run()];
  assert.equal(r1, r2);
  assert.equal(r2, r3);
});
