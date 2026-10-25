import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wrapMcpCommandForSandbox } from "../mcpWrap.js";
import { srtCliEntry, srtSettingsFile } from "../policy.js";

test("wrap is opt-in per server (C4): no flag or mode off leaves the command untouched", () => {
  assert.equal(wrapMcpCommandForSandbox({ command: "node", args: ["server.js"] }, "D:/ws", { sandboxMode: "all_shell" }), null);
  assert.equal(wrapMcpCommandForSandbox({ command: "node", args: ["server.js"], sandbox: true }, "D:/ws", { sandboxMode: "off" }), null);
  assert.equal(wrapMcpCommandForSandbox({ command: "node", args: ["server.js"], sandbox: false }, "D:/ws", { sandboxMode: "all_shell" }), null);
  assert.equal(wrapMcpCommandForSandbox({ command: "node", args: ["server.js"], sandbox: true }, "D:/ws", {}), null);
});

test("wrap rewrites to node srt --settings <loam file> -- <original…> with fresh settings", async () => {
  const wrapped = wrapMcpCommandForSandbox({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "D:/ws"], sandbox: true }, "D:/ws", { sandboxMode: "untrusted_only", sandboxAllowedDomains: ["Example.com"] });
  assert.ok(wrapped);
  assert.equal(wrapped.command, process.execPath);
  assert.equal(wrapped.args[0], srtCliEntry());
  assert.equal(wrapped.args[1], "--settings");
  assert.equal(wrapped.args[2], srtSettingsFile());
  assert.equal(wrapped.args[3], "--");
  assert.equal(wrapped.args[4], "npx");
  assert.deepEqual(wrapped.args.slice(5), ["-y", "@modelcontextprotocol/server-filesystem", "D:/ws"]);
  assert.ok(wrapped.settingsFile.endsWith("loam-srt-settings.json"));
  // The refreshed settings file carries the normalized allowlist + workspace roots.
  const settings = JSON.parse(fs.readFileSync(wrapped.settingsFile, "utf8")) as { network: { allowedDomains: string[] }; filesystem: { allowWrite: string[] } };
  assert.deepEqual(settings.network.allowedDomains, ["example.com"]);
  assert.ok(settings.filesystem.allowWrite.includes("D:/ws"));
});

test("settings file is Loam-owned, never ~/.srt-settings.json", () => {
  const wrapped = wrapMcpCommandForSandbox({ command: "node", args: [], sandbox: true }, "D:/ws", { sandboxMode: "all_shell" });
  assert.ok(wrapped);
  // The invariant: never ~/.srt-settings.json itself (the home ROOT), which would
  // clash with Claude Code — a data-dir nested under the profile is fine.
  assert.notEqual(path.dirname(wrapped.settingsFile), os.homedir());
});
