import fs from "node:fs";
import type { EvidenceCipher } from "../enterprise/crypto.js";
import type { MobileEngagement } from "./engagement.js";
import { buildMobileReport } from "./report.js";

export interface ProtectedMobileReport {
  markdownPath: string;
  sarifPath: string;
  encrypted: boolean;
}

export async function buildProtectedMobileReport(state: MobileEngagement, outDir: string, cipher?: EvidenceCipher | null): Promise<ProtectedMobileReport> {
  const plain = buildMobileReport(state, outDir);
  if (!cipher) return { ...plain, encrypted: false };
  for (const [kind, file] of [["report", plain.markdownPath], ["sarif", plain.sarifPath]] as const) {
    const encrypted = await cipher.encrypt(state.tenantId, state.id, kind, fs.readFileSync(file));
    fs.writeFileSync(`${file}.enc.json`, JSON.stringify(encrypted), { mode: 0o600 });
    fs.unlinkSync(file);
  }
  return { markdownPath: `${plain.markdownPath}.enc.json`, sarifPath: `${plain.sarifPath}.enc.json`, encrypted: true };
}

export async function readProtectedMobileMarkdown(report: ProtectedMobileReport, state: MobileEngagement, cipher?: EvidenceCipher | null): Promise<string> {
  if (!report.encrypted) return fs.readFileSync(report.markdownPath, "utf8");
  if (!cipher) throw new Error("KMS is required to decrypt the report");
  const encrypted = JSON.parse(fs.readFileSync(report.markdownPath, "utf8")) as Parameters<EvidenceCipher["decrypt"]>[3];
  return (await cipher.decrypt(state.tenantId, state.id, "report", encrypted)).toString("utf8");
}
