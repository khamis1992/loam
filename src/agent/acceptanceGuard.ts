import fs from "node:fs";
import { resolveRead } from "../policy/paths.js";
import { parseAppContract } from "./appVerification.js";
import { canonicalRows } from "./sqliteChecks.js";
import { canonicalApiJson } from "./apiChecks.js";
import { extractJson } from "./planner.js";

/** Deliberate narrow command syntax; do not infer a mandatory contract from examples. */
export function explicitUserContract(request: string): string | undefined {
  // Commands inside Markdown code examples are data, even if their spelling
  // matches the explicit command grammar. A JSON fence after an outside
  // command remains supported.
  const outsideLines = new Set<number>();
  let offset = 0, fence: { char: string; length: number } | undefined;
  for (const line of request.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/.exec(line);
    if (!fence) {
      if (marker) fence = { char: marker[1]![0]!, length: marker[1]!.length };
      else outsideLines.add(offset);
    } else if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    offset += line.length + 1;
  }
  const commands = [...request.matchAll(/^(?:احفظ app-verification\.json بهذا العقد بالضبط:|احفظ عقد الاختبار التالي دون تغيير:|Save app-verification\.json with exactly this contract:)\s*/gm)].filter(m => outsideLines.has(m.index!));
  if (!commands.length) return undefined;
  if (commands.length !== 1) throw new Error("Multiple explicit acceptance contracts; provide one unambiguous contract");
  const match = commands[0]!;
  let tail = request.slice(match.index! + match[0].length).trimStart();
  if (tail.startsWith("```json")) tail = tail.slice(7).trimStart();
  else if (tail.startsWith("```")) tail = tail.slice(3).trimStart();
  if (!tail.startsWith("{")) throw new Error("Explicit acceptance contract requires a JSON object immediately after the command");
  const value = extractJson(tail.slice(0, 256_000));
  if (!value) throw new Error("Explicit acceptance contract is invalid or exceeds its size budget");
  const raw = JSON.stringify(value);
  parseAppContract(raw);
  return raw;
}

// Owned by the runtime, never read back from a worker-writable evidence file.
// Explicit user contracts freeze before execution. Otherwise freeze at first
// final verification after initial implementation has chosen its selectors.
export class AcceptanceGuard {
  private baseline?: string;
  constructor(restored?: string, request?: string) {
    const initial = restored ?? (request ? explicitUserContract(request) : undefined);
    if (initial !== undefined) { parseAppContract(initial); this.baseline = initial; }
  }
  snapshot(): string | undefined { return this.baseline; }
  /** Runtime-only handoff of the exact reviewed bytes; never replaces a frozen contract. */
  freezeReviewedContract(raw: string): void {
    if (this.baseline !== undefined) throw new Error('Cannot replace a frozen acceptance contract with an audit');
    parseAppContract(raw);
    this.baseline = raw;
  }
  /** Validate frozen coverage without changing it, and isolate only unreviewed additions. */
  contractForReview(raw: string): string | undefined {
    if (raw.length > 256_000) throw new Error("Acceptance contract exceeds the 256000-character verification budget");
    const current = parseAppContract(raw);
    if (this.baseline === undefined) return raw;
    const previous = parseAppContract(this.baseline);
    const signature = (s: typeof current.scenarios[number]) => JSON.stringify([s.steps.map(step => [step.action, step.selector, step.value, step.count]), (s.expectedResponses ?? []).map(r => JSON.stringify([r.method, r.path, r.status, r.count ?? 1])).sort(), (s.sqliteChecks ?? []).map(c => JSON.stringify([c.database, c.table, c.columns, canonicalRows(c.rows)])).sort(), (s.apiChecks ?? []).map(g => [g.requests.map(r => [r.method, r.path, r.body, Object.hasOwn(r, "expectedJson"), Object.hasOwn(r, "expectedJson") ? canonicalApiJson(r.expectedJson) : null]), [...g.statuses].sort()])]);
    const remaining = current.scenarios.map((scenario, index) => ({ signature: signature(scenario), index }));
    if (current.entry !== previous.entry || current.runtime?.type !== previous.runtime?.type || current.runtime?.entry !== previous.runtime?.entry) throw new Error("Frozen acceptance application entry/runtime changed during repair");
    for (const scenario of previous.scenarios) {
      const index = remaining.findIndex(row => row.signature === signature(scenario));
      if (index < 0) throw new Error(`Frozen acceptance scenario was removed or changed during repair: ${scenario.name}`);
      remaining.splice(index, 1);
    }
    if (!remaining.length) return undefined;
    // Use the original JSON representation so no parser defaults change test meaning.
    const subset = JSON.parse(raw);
    subset.scenarios = remaining.map(row => subset.scenarios[row.index]);
    return JSON.stringify(subset);
  }
  check(workspace: string): void {
    const file = resolveRead(workspace, "app-verification.json", false);
    if (!fs.existsSync(file)) {
      if (this.baseline !== undefined) throw new Error("Frozen acceptance contract was removed during repair");
      return;
    }
    const raw = fs.readFileSync(file, "utf8");
    this.contractForReview(raw);
    // Added checks become part of the baseline too; renaming/reordering intact
    // scenarios is harmless, but step order and expected values remain exact.
    this.baseline = raw;
  }
}
