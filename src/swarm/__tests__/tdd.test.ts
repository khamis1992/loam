import { test } from "node:test";
import assert from "node:assert/strict";
import { TddGuard } from "../tdd.js";

const isTestPath = (rel: string) => /\.test\.[cm]?js$/.test(rel);
const guard = (exempt = false) => new TddGuard({ exempt, isTestPath, plannedTests: ["test/store.test.js"] });

test("code is refused until a test is written and run", () => {
  const g = guard();
  assert.equal(g.beforeWrite("src/store.js").allow, false);
  assert.equal(g.beforeWrite("package.json").allow, true, "support files are always allowed");
  assert.equal(g.beforeWrite("test/store.test.js").allow, true);
  g.afterWrite("test/store.test.js", true);
  const blocked = g.beforeWrite("src/store.js");
  assert.equal(blocked.allow, false);
  if (!blocked.allow) assert.match(blocked.message, /RUN THE TEST FIRST/);
  g.afterVerification(false, "1 failing");
  assert.equal(g.beforeWrite("src/store.js").allow, true);
  g.afterWrite("src/store.js", true);
  assert.equal(g.finish().ok, false, "no green run after the last code write");
  g.afterVerification(true, "pass 3");
  assert.equal(g.finish().ok, true);
  const snap = g.snapshot();
  assert.equal(snap.redObserved, true);
  assert.equal(snap.blockedWrites, 2);
});

test("infrastructure failures do not count as a red run", () => {
  const g = guard();
  g.afterWrite("test/store.test.js", true);
  g.afterVerification(false, "Error: connect ECONNREFUSED 127.0.0.1:3000");
  assert.equal(g.beforeWrite("src/store.js").allow, false);
});

test("a code write after green requires a new green run", () => {
  const g = guard();
  g.afterWrite("test/store.test.js", true); g.afterVerification(false, "fail");
  g.afterWrite("src/store.js", true); g.afterVerification(true, "ok");
  g.afterWrite("src/store.js", true);
  assert.equal(g.finish().ok, false);
});

test("exempt tasks (markup/config with a recorded reason) are never blocked or gated", () => {
  const g = guard(true);
  assert.equal(g.beforeWrite("public/index.html").allow, true);
  g.afterWrite("src/app.js", true);
  assert.equal(g.finish().ok, true, "the qa stage still verifies the whole product afterwards");
});

test("failed writes are ignored", () => {
  const g = guard();
  g.afterWrite("test/store.test.js", false);
  assert.equal(g.snapshot().phase, "need-test");
  assert.ok(TddGuard.isSupportFile("README.md") && !TddGuard.isSupportFile("server.cjs"));
});
