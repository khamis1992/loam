/** Test helpers: an in-memory corpus loaded from the FIXTURE packs (fictional laws, years 2088–2095). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LegalCorpus, legalTextSha256, makeAvid, sha256, type LegalPack } from "../corpusStore.js";

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadFixtureCorpus(dbPath = ":memory:"): LegalCorpus {
  const corpus = new LegalCorpus(dbPath);
  const dir = path.join(FIXTURE_DIR, "corpus");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    corpus.importPack(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as LegalPack);
  }
  return corpus;
}

export function attestPackForTest(pack: LegalPack): LegalPack {
  const at = "2096-01-03T00:00:00.000Z";
  return {
    ...pack,
    source: {
      ...pack.source,
      verifiedBy: "مراجع أول اختباري", verifiedAt: at,
      secondVerifiedBy: "مراجع ثان اختباري", secondVerifiedAt: at,
      sourceSha256: sha256(JSON.stringify(pack.source)), reviewedTextSha256: legalTextSha256(pack),
      usageRights: { basis: "fictional test fixture", reference: "TEST-ONLY", confirmedBy: "مراجع الحقوق", confirmedAt: at },
    },
  };
}

/** Replace {{articleKey@effectiveFrom}} placeholders with the deterministic avid. */
export function fillAvids(text: string): string {
  return text.replace(/\{\{([^@}]+)@(\d{4}-\d{2}-\d{2})\}\}/g, (_m, key: string, from: string) => makeAvid(key, from));
}
