import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ReaEvidenceRecord } from "../reaEvidence.js";
import { diffAsarSurface, extractAsarSurface, hasSurfaceAdditions, unexplainedAdditions } from "../reaAsarSurface.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rea-goldens.json");
const goldens = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as { records: ReaEvidenceRecord[] };
const analyzeRecord = goldens.records.find((r) => r.operation === "analyze_javascript_application")!;

test("extracts the real fixture surface: one renderer IPC channel, zero bridge/preload", () => {
  const surface = extractAsarSurface(analyzeRecord);
  assert.deepEqual(surface.ipcChannels, ["calib-ping"]);
  assert.deepEqual(surface.ipcRendererTransmissions, ["calib-ping"]);
  assert.deepEqual(surface.contextBridgeKeys, []);
  assert.deepEqual(surface.preloadEntryPoints, []);
  assert.equal(surface.browserWindows, 0);
  assert.equal(surface.contentDigest, analyzeRecord.evidence_id);
  assert.ok(surface.artifactDigest && /^[a-f0-9]{64}$/.test(surface.artifactDigest));
  // Summary counts are kept verbatim for stable diffing.
  const ipc = surface.summary["ipc"] as Record<string, unknown>;
  assert.equal(ipc.literal_channels, 1);
  assert.equal(ipc.renderer_transmissions, 1);
});

test("diff detects a planted new IPC channel and an added contextBridge key", () => {
  const baseline = extractAsarSurface(analyzeRecord);
  const current: typeof baseline = {
    ...baseline,
    ipcChannels: ["calib-ping", "evil-takeover"],
    contextBridgeKeys: ["electronAPI"],
    browserWindows: 1,
  };
  const delta = diffAsarSurface(baseline, current);
  assert.deepEqual(delta.addedIpcChannels, ["evil-takeover"]);
  assert.deepEqual(delta.removedIpcChannels, []);
  assert.deepEqual(delta.addedContextBridgeKeys, ["electronAPI"]);
  assert.equal(delta.browserWindowsDelta, 1);
  assert.equal(hasSurfaceAdditions(delta), true);
});

test("removals are reported but never count as gate failures", () => {
  const baseline = extractAsarSurface(analyzeRecord);
  const current: typeof baseline = { ...baseline, ipcChannels: [] };
  const delta = diffAsarSurface(baseline, current);
  assert.deepEqual(delta.removedIpcChannels, ["calib-ping"]);
  assert.equal(hasSurfaceAdditions(delta), false);
});

test("the reviewed allowlist covers approved additions; uncovered ones stay unexplained", () => {
  const baseline = extractAsarSurface(analyzeRecord);
  const current: typeof baseline = { ...baseline, ipcChannels: ["calib-ping", "approved-channel", "evil-takeover"] };
  const unexplained = unexplainedAdditions(diffAsarSurface(baseline, current), { ipcChannels: ["approved-channel"] });
  assert.deepEqual(unexplained.addedIpcChannels, ["evil-takeover"]);
  assert.equal(hasSurfaceAdditions(unexplained), true);
});

test("identical surfaces produce an empty delta", () => {
  const surface = extractAsarSurface(analyzeRecord);
  const delta = diffAsarSurface(surface, { ...surface });
  assert.equal(hasSurfaceAdditions(delta), false);
  assert.deepEqual(delta.addedIpcChannels, []);
});
