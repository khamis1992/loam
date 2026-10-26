/**
 * Real fuzz target for the lockfile/SBOM parsers (ALL_SERVICES §15 self-hardening):
 * feeds arbitrary bytes to every parser — none may throw. Discovered by
 * discoverFuzzTargets; run by jazzer.js campaigns (fuzz_run).
 */
import { parseCycloneDx, parseGoMod, parseLines, parsePomXml, parseSpdxJson, parseSpdxTagValue, parseYarnBerry, parsePurl } from "./lockfiles.js";

const PARSERS: Array<[string, (t: string) => unknown]> = [
  ["packageLock", (t) => JSON.parse(t)],
  ["cyclonedx", (t) => parseCycloneDx(t, "bom.json")],
  ["spdxJson", (t) => parseSpdxJson(t, "s.json")],
  ["spdxTagValue", (t) => parseSpdxTagValue(t, "s.spdx")],
  ["yarnBerry", (t) => parseYarnBerry(t, "yarn.lock")],
  ["goMod", (t) => parseGoMod(t, "go.mod")],
  ["pomXml", (t) => parsePomXml(t, "pom.xml")],
  ["freeLines", (t) => parseLines(t, "deps.txt")],
  ["purl", (t) => parsePurl(t, "bom.json")],
];

export function fuzz(data: Buffer): void {
  const text = data.toString("utf8");
  for (const [, parse] of PARSERS) {
    try { parse(text); } catch { /* parser contract: never throw on arbitrary bytes */ }
  }
  // The JSON parser above may legitimately throw; the invariant under test is that
  // OUR parsers never do — so re-run only ours here without JSON.parse.
  const ours = PARSERS.slice(1);
  for (const [, parse] of ours) parse(text);
}
