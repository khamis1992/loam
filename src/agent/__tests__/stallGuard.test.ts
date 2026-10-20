/**
 * MF2 unit tests: the tool-loop stall guard.
 *
 * The guard exists because mode-specific tools (office, studio, pentest,
 * browser) were being retried forever — or replaced by hand-written shell
 * scripts — instead of reporting the blocker. It must stay quiet while the
 * model makes progress, and speak up exactly when a call repeats or fails.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  createStallGuard,
  dedicatedFailureNotice,
  isDedicatedTool,
  STALL_NOTICE,
} from "../stallGuard.js";

describe("stall guard", () => {
  it("stays quiet while the model makes progress", () => {
    const guard = createStallGuard();
    assert.equal(guard("file_read", { path: "a.md" }, true), null);
    assert.equal(guard("file_read", { path: "b.md" }, true), null);
    assert.equal(guard("loam_studio", { op: "read" }, true), null);
  });

  it("nudges after six consecutive failing calls", () => {
    const guard = createStallGuard();
    for (let i = 0; i < 5; i++) assert.equal(guard("shell_run", { cmd: "x" }, false), null);
    assert.equal(guard("shell_run", { cmd: "x" }, false), STALL_NOTICE);
  });

  it("nudges after six consecutive identical calls", () => {
    const guard = createStallGuard();
    for (let i = 0; i < 6; i++) assert.equal(guard("file_read", { path: "a.md" }, true), null);
    assert.equal(guard("file_read", { path: "a.md" }, true), STALL_NOTICE);
  });

  it("restarts the counter after a different successful call", () => {
    const guard = createStallGuard();
    for (let i = 0; i < 5; i++) guard("shell_run", { cmd: "x" }, false);
    assert.equal(guard("file_read", { path: "a.md" }, true), null);
    assert.equal(guard("shell_run", { cmd: "x" }, false), null);
  });

  it("does not flag alternating successful tools as a stall", () => {
    const guard = createStallGuard();
    for (let i = 0; i < 20; i++) {
      const name = i % 2 === 0 ? "file_read" : "file_list";
      assert.equal(guard(name, { path: "a.md" }, true), null);
    }
  });

  it("warns once when a dedicated tool fails twice", () => {
    const guard = createStallGuard();
    assert.equal(guard("loam_studio", { op: "write" }, false), null);
    const notice = guard("loam_studio", { op: "write" }, false);
    assert.ok(notice);
    assert.match(notice, /loam_studio/);
    assert.match(notice, /failed twice/);
    // The same tool must not keep nagging once the model was told to stop.
    assert.equal(guard("loam_studio", { op: "write" }, false), null);
  });

  it("clears the dedicated failure count after a success", () => {
    const guard = createStallGuard();
    assert.equal(guard("office_export", {}, false), null);
    assert.equal(guard("office_export", {}, true), null);
    assert.equal(guard("office_export", {}, false), null);
  });

  it("keeps office failures on the office tool instead of a shell fallback", () => {
    const notice = dedicatedFailureNotice("office_export");
    assert.match(notice, /office_export/);
    assert.match(notice, /do not switch to shell or Python/i);
  });

  it("classifies the mode-specific tools", () => {
    assert.equal(isDedicatedTool("office_export"), true);
    assert.equal(isDedicatedTool("loam_studio"), true);
    assert.equal(isDedicatedTool("loam_dataset"), true);
    assert.equal(isDedicatedTool("pentest_check"), true);
    assert.equal(isDedicatedTool("browser_open"), true);
    assert.equal(isDedicatedTool("file_read"), false);
    assert.equal(isDedicatedTool("shell_run"), false);
  });
});
