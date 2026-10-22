import test from "node:test";
import assert from "node:assert/strict";
import { SubagentRegistry } from "../registry.js";
import { Semaphore } from "../semaphore.js";
import type { SubagentProvider, SubagentProviderType, SubagentResult, SubagentRunHandle, SubagentStartOptions } from "../types.js";

function makeHandle(): SubagentRunHandle {
  const result: SubagentResult = { stopReason: "completed", text: "" };
  return {
    id: "h",
    events: (async function* () {})(),
    result: () => Promise.resolve(result),
    cancel() {
      /* noop */
    },
  };
}

test("registry registers, looks up, and lists providers", () => {
  const reg = new SubagentRegistry();
  const provider: SubagentProvider = {
    name: "test",
    start(_opts: SubagentStartOptions): Promise<SubagentRunHandle> {
      return Promise.resolve(makeHandle());
    },
  };
  reg.register("test", provider);
  assert.equal(reg.has("test"), true);
  assert.equal(reg.get("test"), provider);
  assert.deepEqual(reg.names(), ["test"]);
  assert.throws(() => reg.register("test", provider), /already registered/);
});

test("registry.start rejects unknown providers", async () => {
  const reg = new SubagentRegistry();
  await assert.rejects(
    () => reg.start({ provider: "nope" as SubagentProviderType, prompt: "x", cwd: "/" }),
    /unknown subagent provider/,
  );
});

test("semaphore bounds concurrent holders and releases", async () => {
  const sem = new Semaphore(2);
  const releaseA = await sem.acquire();
  const releaseB = await sem.acquire();
  assert.equal(sem.activeCount, 2);

  let third = false;
  const pending = sem.acquire().then((release) => {
    third = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(third, false, "third acquire must block while at capacity");

  releaseA();
  const releaseC = await pending;
  assert.equal(third, true);
  assert.equal(sem.activeCount, 2);
  releaseB();
  releaseC();
  assert.equal(sem.activeCount, 0);
});

test("registry.setLimit raises the concurrency bound and wakes waiters", async () => {
  const reg = new SubagentRegistry(1);
  assert.equal(reg.maxConcurrentChildren, 1);
  const release = await reg.acquireChild();

  let second = false;
  const pending = reg.acquireChild().then((r) => {
    second = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(second, false);

  reg.setMaxConcurrentChildren(2);
  assert.equal(reg.maxConcurrentChildren, 2);
  const release2 = await pending;
  assert.equal(second, true);

  release();
  release2();
});
