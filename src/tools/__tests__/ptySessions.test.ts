/**
 * D19 tests: the pty release hook used when a session sleeps.
 *
 * A sleeping session must give up its terminals so their resources are
 * reclaimed. The bug this pins: the release hook used to iterate `listSessions()`
 * and kill only sessions already marked `exited` — which is exactly the set that
 * no longer holds a process, so nothing was ever reclaimed. `killAllSessions`
 * must kill the sessions that are still live and leave the registry empty.
 *
 * The backend is injected via `setPtyModule`, so no real terminal is spawned.
 */
import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  disposePty,
  killAllSessions,
  listSessions,
  setPtyModule,
  startSession,
} from "../pty.js";

interface FakeProcess {
  killed: boolean;
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** Install an in-process fake backend and return the processes it creates. */
function installFakeBackend(): FakeProcess[] {
  const processes: FakeProcess[] = [];
  const spawn = (): FakeProcess => {
    const proc: FakeProcess = {
      killed: false,
      pid: 4242,
      onData() { /* no terminal output in tests */ },
      onExit() { /* not exercised here */ },
      write() { /* ignore */ },
      resize() { /* ignore */ },
      kill() { proc.killed = true; },
    };
    processes.push(proc);
    return proc;
  };
  setPtyModule({ spawn });
  return processes;
}

describe("pty session release (D19)", () => {
  let processes: FakeProcess[];

  beforeEach(() => {
    processes = installFakeBackend();
  });

  afterEach(() => {
    disposePty();
    setPtyModule(null);
  });

  it("kills every live session and returns their ids", () => {
    const first = startSession("powershell", process.cwd(), 120, 30);
    const second = startSession("cmd", process.cwd(), 120, 30);
    assert.equal(listSessions().length, 2);
    assert.equal(processes.length, 2);

    const killed = killAllSessions();
    assert.equal(killed.length, 2);
    assert.deepEqual([...killed].sort(), [first.id, second.id].sort());
    assert.equal(listSessions().length, 0);
    assert.equal(processes.every((p) => p.killed), true, "both terminals must be killed");
  });

  it("is idempotent and returns nothing the second time", () => {
    startSession("powershell", process.cwd(), 120, 30);
    assert.equal(killAllSessions().length, 1);
    assert.deepEqual(killAllSessions(), []);
    assert.equal(listSessions().length, 0);
  });

  it("does nothing when there are no live sessions", () => {
    assert.deepEqual(killAllSessions(), []);
    assert.equal(listSessions().length, 0);
    assert.equal(processes.length, 0);
  });
});
