/** check:asar-surface — release self-audit for the packaged ASAR surface
 *  (Cap B §10, OD-4; REA_INTO_LOAM §10 projection).
 *
 *  Modes:
 *    (default)            offline self-test: a planted new IPC channel in a fixture
 *                         surface built from the committed baseline MUST be detected.
 *    --current F.json     audit a fresh `analyze_javascript_application` record
 *                         export against qa/asar-baseline.json.
 *    --update F.json      rewrite the baseline from a record export (review the
 *                         printed diff in the PR that bumps it).
 *
 *  Env: LOAM_ASAR_AUDIT = "warn" (default: print delta, exit 0) | "fail"
 *  (exit 1 when any ipc / contextBridge / preload / endpoint surface was ADDED and
 *  is not listed in qa/asar-baseline-allowlist.json). Removals are always
 *  report-only — only *added* surface can fail the gate. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { diffAsarSurface, extractAsarSurface, type AsarSurface } from "../security/reaAsarSurface.js";
import type { ReaEvidenceRecord } from "../security/reaEvidence.js";
import pkg from "../../package.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASELINE = path.join(ROOT, "qa", "asar-baseline.json");
const ALLOWLIST = path.join(ROOT, "qa", "asar-baseline-allowlist.json");
const MODE = (process.env.LOAM_ASAR_AUDIT ?? "warn").toLowerCase() === "fail" ? "fail" : "warn";

interface BaselineFile {
  loamVersion: string;
  generatedAt: string;
  surface: AsarSurface;
}

const readBaseline = (): BaselineFile => JSON.parse(fs.readFileSync(BASELINE, "utf8")) as BaselineFile;
const readAllowlist = (): string[] => {
  try {
    const raw = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const readRecord = (file: string): ReaEvidenceRecord => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as ReaEvidenceRecord;
  if (typeof raw.evidence_id !== "string" || !raw.normalized_result) {
    throw new Error(`${file} is not an analyze_javascript_application record export`);
  }
  return raw;
};

const flag = process.argv.find((a) => a === "--current" || a === "--update");
const value = flag ? process.argv[process.argv.indexOf(flag!) + 1] : undefined;

if (flag && !value) {
  console.error(`usage: ${flag} <analyze-record.json>`);
  process.exit(2);
}

if (flag === "--update") {
  const surface = extractAsarSurface(readRecord(value!));
  const out: BaselineFile = { loamVersion: pkg.version, generatedAt: new Date().toISOString(), surface };
  fs.writeFileSync(BASELINE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`baseline updated from ${value} (v${pkg.version}) — review the diff in the bump PR`);
  process.exit(0);
}

if (flag === "--current") {
  const baseline = readBaseline();
  const current = extractAsarSurface(readRecord(value!));
  const delta = diffAsarSurface(baseline.surface, current);
  const allowed = new Set(readAllowlist());
  const additions = [
    ...delta.addedIpcChannels,
    ...delta.addedContextBridgeKeys,
    ...delta.addedPreloadEntryPoints,
    ...delta.addedHardcodedEndpoints,
  ].filter((x) => !allowed.has(x));
  const report = (label: string, items: string[]): void => {
    if (items.length) console.log(`${label}: ${items.join(", ")}`);
  };
  report("added ipc channels", delta.addedIpcChannels);
  report("removed ipc channels (review only)", delta.removedIpcChannels);
  report("added contextBridge keys", delta.addedContextBridgeKeys);
  report("added preload entrypoints", delta.addedPreloadEntryPoints);
  report("added hardcoded endpoints", delta.addedHardcodedEndpoints);
  if (delta.browserWindowsDelta !== 0) console.log(`browser windows delta: ${delta.browserWindowsDelta}`);
  if (additions.length === 0) {
    console.log(`asar surface OK (mode=${MODE}, ${delta.removedIpcChannels.length} removals reported)`);
    process.exit(0);
  }
  if (MODE === "fail") {
    console.error(`asar surface FAILED (${MODE}): ${additions.length} new surface item(s) not in the baseline allowlist`);
    process.exit(1);
  }
  console.warn(`asar surface WARN (${MODE}): ${additions.length} new item(s) printed above; add them to the baseline via --update or allowlist them deliberately`);
  process.exit(0);
}

// Default: offline detector self-test. The baseline ships the known surface; a
// planted unknown IPC channel must surface in the delta, and the untouched copy
// must stay clean. This proves the gate works without the REA server (Cap B P5).
{
  const baseline = readBaseline();
  const clean = structuredClone(baseline.surface);
  const planted = structuredClone(baseline.surface);
  planted.ipcChannels = [...planted.ipcChannels, "planted-self-test-channel"].sort();
  assert.equal(diffAsarSurface(baseline.surface, clean).addedIpcChannels.length, 0, "clean surface must not add anything");
  const delta = diffAsarSurface(baseline.surface, planted);
  assert.deepEqual(delta.addedIpcChannels, ["planted-self-test-channel"], "planted channel must be detected");
  const plantedBridge = structuredClone(baseline.surface);
  plantedBridge.contextBridgeKeys = [...plantedBridge.contextBridgeKeys, "plantedBridgeApi"].sort();
  assert.deepEqual(diffAsarSurface(baseline.surface, plantedBridge).addedContextBridgeKeys, ["plantedBridgeApi"]);
  console.log(`check:asar-surface OK — detector verified against qa/asar-baseline.json (v${baseline.loamVersion}, ${baseline.surface.ipcChannels.length} channels, mode=${MODE})`);
}
