/**
 * First-party binary inspection (ALL_SERVICES §14): magic identification, PE/ELF
 * header tables, printable strings and entropy — the offline core that always runs.
 * The subject is NEVER executed. Everything lands as ReFindings with sha256 evidence.
 */
import { createHash } from "node:crypto";
import { evidenceOf } from "./types.js";
import type { ReEvidence, ReFinding } from "./types.js";

export interface BinaryIdentity {
  format: string;
  arch?: string;
  bits?: number;
  sections?: Array<{ name: string; size: number }>;
  notes: string[];
}

const shannon = (buf: Buffer): number => {
  if (buf.length === 0) return 0;
  const freq = new Array<number>(256).fill(0);
  for (const b of buf) freq[b]!++;
  let h = 0;
  for (const f of freq) if (f > 0) { const p = f / buf.length; h -= p * Math.log2(p); }
  return h;
};

export function identify(buf: Buffer): BinaryIdentity {
  const notes: string[] = [];
  // PE: MZ + e_lfanew pointing at PE\0\0
  if (buf.length > 0x40 && buf[0] === 0x4d && buf[1] === 0x5a) {
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff > 0 && peOff + 6 < buf.length && buf.readUInt32LE(peOff) === 0x00004550) {
      const machine = buf.readUInt16LE(peOff + 4);
      const arch = machine === 0x8664 ? "x86_64" : machine === 0x14c ? "x86" : machine === 0xaa64 ? "arm64" : `machine_0x${machine.toString(16)}`;
      notes.push(`PE signature at 0x${peOff.toString(16)}`);
      return { format: "PE", arch, bits: arch === "x86" ? 32 : 64, notes };
    }
    return { format: "MZ (no PE)", notes };
  }
  // ELF
  if (buf.length >= 20 && buf[0] === 0x7f && buf.subarray(1, 4).toString() === "ELF") {
    const bits = buf[4] === 2 ? 64 : 32;
    const machine = bits === 64 ? buf.readUInt16LE(18) : buf.readUInt16LE(18);
    const arch = { 0x3e: "x86_64", 0x03: "x86", 0xb7: "aarch64", 0x28: "arm" }[machine] ?? `machine_0x${machine.toString(16)}`;
    return { format: "ELF", arch, bits, notes };
  }
  // Mach-O
  if (buf.length > 12 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(buf.readUInt32BE(0))) {
    const magic = buf.readUInt32BE(0);
    const bits = magic === 0xfeedfacf || magic === 0xcffaedfe ? 64 : 32;
    const arch = bits === 64 ? `cputype_${buf.readUInt32LE(4)}` : `cputype_${buf.readUInt32BE(4)}`;
    return { format: "Mach-O", arch, bits, notes };
  }
  // Containers / script formats
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    // Zip family: APK has AndroidManifest.xml + classes.dex names visible early
    const head = buf.subarray(0, Math.min(buf.length, 4096)).toString("latin1");
    if (head.includes("AndroidManifest.xml") && head.includes("classes.dex")) return { format: "APK (zip)", notes: ["Android manifest + dex visible in the central directory"] };
    if (head.includes("META-INF/MANIFEST.MF")) return { format: "JAR (zip)", notes };
    return { format: "Zip archive", notes };
  }
  if (buf.subarray(0, 4).toString("hex") === "cafebabe") return { format: "Java class", notes };
  if (buf.subarray(0, 5).toString() === "%PDF-") return { format: "PDF", notes };
  return { format: "unknown", notes };
}

export function printableStrings(buf: Buffer, min = 6, cap = 200): string[] {
  const out: string[] = [];
  let run = "";
  const push = (): void => { if (run.length >= min) out.push(run); run = ""; };
  for (const b of buf.subarray(0, Math.min(buf.length, 8 * 1024 * 1024))) {
    if (b >= 0x20 && b < 0x7f) run += String.fromCharCode(b);
    else push();
    if (out.length >= cap) { push(); return out; }
  }
  push();
  return out;
}

const SUSPICIOUS_STRING = /(http:\/\/(?!127\.|localhost)|https?:\/\/[a-z0-9.-]+\.(?:onion|ru|tk|top)\b|\/bin\/(ba)?sh|cmd\.exe|powershell -|CreateRemoteThread|VirtualAlloc|LoadLibrary[AW]?)/i;

/** Static analysis pass: identity, entropy, sections and interesting strings — no execution. */
export function analyzeBinary(file: string, buf: Buffer): { identity: BinaryIdentity; findings: ReFinding[] } {
  const evidence: ReEvidence[] = [];
  const identity = identify(buf);
  evidence.push(evidenceOf("magic", file, `${identity.format}${identity.arch ? ` ${identity.arch}` : ""}${identity.bits ? ` ${identity.bits}-bit` : ""}`));

  const entropy = shannon(buf.subarray(0, Math.min(buf.length, 1024 * 1024)));
  evidence.push(evidenceOf("entropy", file, `shannon=${entropy.toFixed(3)} over ${Math.min(buf.length, 1024 * 1024)} bytes`));

  const findings: ReFinding[] = [{
    engine: "re", ruleId: "re-identify", severity: "info", target: file,
    title: `${identity.format}${identity.arch ? ` (${identity.arch}${identity.bits ? `, ${identity.bits}-bit` : ""})` : ""}`,
    detail: `sha256=${createHash("sha256").update(buf).digest("hex").slice(0, 16)}… entropy=${entropy.toFixed(2)} ${identity.notes.join("; ")}`,
    evidence: [],
  }];
  if (entropy > 7.2 && buf.length > 4096) {
    findings.push({ engine: "re", ruleId: "re-packed", severity: "medium", target: file,
      title: "High entropy suggests packing/encryption",
      detail: `Entropy ${entropy.toFixed(2)} (>7.2) over the sampled window.`,
      remediation: "Expect a packer/crypter; unpack before deeper static analysis.",
      evidence: [evidenceOf("entropy", file, `packed: ${entropy.toFixed(3)}`)] });
  }
  const strings = printableStrings(buf);
  evidence.push(evidenceOf("strings", file, `${strings.length} printable strings (first pass)`));
  const suspicious = strings.filter((s) => SUSPICIOUS_STRING.test(s)).slice(0, 10);
  if (suspicious.length > 0) {
    findings.push({ engine: "re", ruleId: "re-suspicious-strings", severity: "low", target: file,
      title: `${suspicious.length} notable string(s)`,
      detail: suspicious.map((s) => JSON.stringify(s.slice(0, 100))).join(", "),
      evidence: [evidenceOf("strings", file, suspicious.join(" | ").slice(0, 200))] });
  }
  findings[0]!.evidence = evidence;
  return { identity, findings };
}
