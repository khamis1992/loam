/** Test helpers: an in-memory corpus loaded from the FIXTURE packs (fictional laws, years 2088–2095). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LegalCorpus, makeAvid, type LegalPack } from "../corpusStore.js";

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadFixtureCorpus(): LegalCorpus {
  const corpus = new LegalCorpus(":memory:");
  const dir = path.join(FIXTURE_DIR, "corpus");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    corpus.importPack(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as LegalPack);
  }
  return corpus;
}

/** Replace {{articleKey@effectiveFrom}} placeholders with the deterministic avid. */
export function fillAvids(text: string): string {
  return text.replace(/\{\{([^@}]+)@(\d{4}-\d{2}-\d{2})\}\}/g, (_m, key: string, from: string) => makeAvid(key, from));
}
