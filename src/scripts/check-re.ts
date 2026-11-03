/**
 * check:re — RE-core smoke gate: identity table over fixture binaries, evidence-id
 * stability, rebuild-verify bands, and the three re tools over a fixture workspace
 * (offline analyze + honest engine degradation + proposal-only rebuild verify).
 */
process.env.MANUS_LOCAL_DATA_DIR ??= `${process.env.TEMP ?? "/tmp"}/loam-check-re-${process.pid}`;

const pass = (m: string): void => console.log(`PASS  ${m}`);
const fail = (m: string, e: unknown): void => { console.log(`FAIL  ${m}: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; };

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { identify } = await import("../re/binary.js");
const { rebuildVerify } = await import("../re/rebuildVerify.js");
const { evidenceOf } = await import("../re/types.js");
const { createReTools } = await import("../tools/reTools.js");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-re-fixture-"));
try {
  try {
    const pe = Buffer.alloc(0x100);
    pe.write("MZ", 0, "latin1"); pe.writeUInt32LE(0x80, 0x3c); pe.writeUInt32LE(0x00004550, 0x80); pe.writeUInt16LE(0x14c, 0x84);
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x03, 0x00]);
    const zip = Buffer.alloc(600); zip.write("PK\x03\x04", 0, "latin1"); zip.write("META-INF/MANIFEST.MF", 60, "latin1");
    const cases: Array<[Buffer, string, string | null]> = [
      [pe, "PE", "x86"], [elf, "ELF", "x86"], [zip, "JAR (zip)", null], [Buffer.from("just text"), "unknown", null],
    ];
    for (const [buf, format, arch] of cases) {
      const id = identify(buf);
      if (id.format !== format) throw new Error(`identify(${format}) -> ${id.format}`);
      if (arch && id.arch !== arch) throw new Error(`identify(${format}).arch -> ${id.arch}`);
    }
    pass("binary identity: PE/ELF/JAR/unknown with architecture");
  } catch (e) { fail("identity", e); }

  try {
    if (evidenceOf("magic", "f", "n").id !== evidenceOf("magic", "f", "n").id) throw new Error("ids not deterministic");
    if (evidenceOf("magic", "f", "n").id === evidenceOf("magic", "f", "x").id) throw new Error("ids not content-bound");
    pass("evidence ids deterministic and content-bound");
  } catch (e) { fail("evidence ids", e); }

  try {
    const a = path.join(ws, "a.js"); const b = path.join(ws, "b.js");
    fs.writeFileSync(a, "const x = 1;\nfunction f(y) { return y + 1; }\n");
    fs.writeFileSync(b, "const x=1;function f(y){return y+1;}");
    if (rebuildVerify(a, b, "js").verdict !== "match") throw new Error("minified-equivalent JS must match");
    if (rebuildVerify(a, a, "bytes").verdict !== "match") throw new Error("identical bytes must match");
    fs.writeFileSync(b, "export default 42;\n");
    if (rebuildVerify(a, b, "js").verdict !== "mismatch") throw new Error("different JS must mismatch");
    pass("rebuild-verify verdict bands (js tokens + bytes shingles)");
  } catch (e) { fail("rebuild-verify", e); }

  try {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...Buffer.alloc(0x80)]);
    fs.writeFileSync(path.join(ws, "s.elf"), elf);
    fs.writeFileSync(path.join(ws, "r.js"), "const q = 1;\n");
    const tools = createReTools();
    const by = new Map(tools.map((t) => [t.name, t]));
    const ctx = { workspace: ws } as never;
    const sum = await by.get("re_analyze")!.run({ file: "s.elf" }, ctx);
    if (!sum.ok || !sum.content.includes("ELF") || !/rea-agents (available|not installed)/.test(sum.content)) throw new Error(`analyze: ${sum.content.slice(0, 160)}`);
    const rv = await by.get("re_rebuild_verify")!.run({ original: "r.js", rebuilt: "r.js", kind: "js" }, ctx);
    if (!rv.ok || !rv.content.includes("match")) throw new Error("rebuild_verify tool failed");
    const miss = await by.get("re_analyze")!.run({ file: "absent.bin" }, ctx);
    if (miss.ok) throw new Error("missing file must refuse");
    pass("re tools: offline analyze + rebuild_verify + refusal (engine status stated)");
  } catch (e) { fail("re tools", e); }

  if (!process.exitCode) console.log("all checks passed");
} finally {
  try { fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* WAL/AV lag */ }
}
