import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runVisualCheck, declaresRtl, expectsRtl, parseVisualVerdict } from "../visual.js";
import type { ShotResult } from "../../preview/shot.js";

function shots(errors: string[] = [], ok = true): ShotResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-visual-"));
  const file = path.join(dir, "mobile.png"); fs.writeFileSync(file, Buffer.from([137, 80, 78, 71]));
  return { ok, url: "http://127.0.0.1:1/", dir, shots: [{ viewport: { name: "mobile", width: 375, height: 812 }, file, relative: ".loam/swarm/visual/1/mobile.png", errors: [] }], errors, warnings: [], elapsedMs: 5 };
}
const AR = '<html lang="ar" dir="rtl"><body><h1>مهامي</h1></body></html>';

test("RTL detection", () => {
  assert.equal(declaresRtl(AR), true);
  assert.equal(declaresRtl("<html><body dir='rtl'>"), true);
  assert.equal(declaresRtl("<html lang=ar>"), false);
  assert.equal(expectsRtl("Arabic RTL HTML", "<p>x</p>"), true);
  assert.equal(expectsRtl("a todo app", "<p>hello</p>"), false);
});

test("pass, fail on page errors, fail on missing dir=rtl", async () => {
  const pass = await runVisualCheck({ url: "u", brief: "Arabic RTL app", html: AR, capture: async () => shots() });
  assert.equal(pass.status, "pass");
  assert.equal(pass.rtl, true);
  const errs = await runVisualCheck({ url: "u", brief: "x", html: "<p>x</p>", capture: async () => shots(["pageerror: boom"]) });
  assert.equal(errs.status, "fail");
  const rtl = await runVisualCheck({ url: "u", brief: "واجهة عربية", html: "<html><body>مهامي</body></html>", capture: async () => shots() });
  assert.equal(rtl.status, "fail");
  assert.ok(rtl.errors.some(e => e.includes("dir=\"rtl\"")));
});

test("unavailable browser and thrown capture never throw", async () => {
  const un = await runVisualCheck({ url: "u", brief: "x", html: "", capture: async () => ({ ...shots(), unavailable: true, message: "no browser" }) });
  assert.equal(un.status, "unavailable");
  const thrown = await runVisualCheck({ url: "u", brief: "x", html: "", capture: async () => { throw new Error("playwright missing"); } });
  assert.equal(thrown.status, "unavailable");
});

test("vision verdicts are parsed strictly and a failing review is recorded, not thrown", async () => {
  assert.deepEqual(parseVisualVerdict('{"verdict":"pass","reason":"ok","issues":[]}'), { verdict: "pass", reason: "ok", issues: [] });
  assert.equal(parseVisualVerdict('{"verdict":"pass","issues":["clipped"]}')!.verdict, "revise", "pass with issues is not a pass");
  assert.equal(parseVisualVerdict("looks fine"), null);
  const reviewed = await runVisualCheck({ url: "u", brief: "x", html: "<p>x</p>", capture: async () => shots(), review: async images => { assert.equal(images.length, 1); return { content: '{"verdict":"revise","reason":"r","issues":["overlap"]}', model: "vision-x" }; } });
  assert.equal(reviewed.status, "pass", "deterministic checks passed; the verdict is separate");
  assert.equal(reviewed.verdict?.verdict, "revise");
  assert.equal(reviewed.model, "vision-x");
  const failed = await runVisualCheck({ url: "u", brief: "x", html: "<p>x</p>", capture: async () => shots(), review: async () => { throw new Error("timeout"); } });
  assert.match(failed.note ?? "", /unavailable/);
});
