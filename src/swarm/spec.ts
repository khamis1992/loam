/**
 * Requirements spec, living spec and project guide (BUILD_SPEC §6.3, proposal 3).
 *
 * - EARS requirements: every requirement is one REQ-n line written in one of
 *   the five EARS patterns (English or Arabic) with a Verify line naming how
 *   it is tested. The engine validates the shape; a malformed spec is a gate.
 * - Living spec: `.loam/specs/requirements.json|md` persists across runs. A
 *   run that continues a delivered run (baseRun) writes ADDED / MODIFIED /
 *   REMOVED deltas that the engine merges, instead of rediscovering scope.
 * - Project guide: the delivered workspace receives an AGENTS.md block with
 *   the real commands, structure and decisions, bounded by markers so a
 *   user-written AGENTS.md is preserved.
 */

export type EarsPattern = "ubiquitous" | "event" | "state" | "unwanted" | "optional" | "complex";

export interface EarsRequirement {
  id: string;
  text: string;
  pattern: EarsPattern;
  verify: string;
  traces: string[];
}

export interface LivingSpec {
  version: number;
  updatedAt: string;
  runId: string;
  requirements: EarsRequirement[];
  history: Array<{ runId: string; at: string; added: string[]; modified: string[]; removed: string[] }>;
}

export const MIN_REQUIREMENTS = 3;
export const MAX_REQUIREMENTS = 60;
export const SPEC_DIR = ".loam/specs";
export const SPEC_JSON = `${SPEC_DIR}/requirements.json`;
export const SPEC_MD = `${SPEC_DIR}/requirements.md`;
export const AGENTS_BEGIN = "<!-- loam:project-guide:begin -->";
export const AGENTS_END = "<!-- loam:project-guide:end -->";

const REQ_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(REQ-\d{1,3})(?:\*\*)?\s*[:：.-]\s*(.+?)\s*$/;
const VERIFY_LINE = /^\s*(?:[-*]\s*)?(?:verify|verification|التحقق|تحقق)\s*[:：]\s*(.+?)\s*$/i;
const TRACE_LINE = /^\s*(?:[-*]\s*)?(?:traces?|يغطي|المرجع)\s*[:：]\s*(.+?)\s*$/i;

/** Classifies a requirement sentence into an EARS pattern, or null when it is not EARS-shaped. */
export function earsPattern(sentence: string): EarsPattern | null {
  const s = sentence.trim();
  const en = /\bshall\b/i.test(s);
  const ar = /يجب/.test(s);
  if (!en && !ar) return null;
  if (en) {
    if (/^while\b[^,]+,\s*when\b[^,]+,\s*the\b.+\bshall\b/i.test(s)) return "complex";
    if (/^when\b[^,]+,\s*the\b.+\bshall\b/i.test(s)) return "event";
    if (/^while\b[^,]+,\s*the\b.+\bshall\b/i.test(s)) return "state";
    if (/^if\b[^,]+,\s*then\s+the\b.+\bshall\b/i.test(s)) return "unwanted";
    if (/^where\b[^,]+,\s*the\b.+\bshall\b/i.test(s)) return "optional";
    if (/^the\b.+\bshall\b/i.test(s)) return "ubiquitous";
    return null;
  }
  if (/^(?:أثناء|بينما)[^،,]+[،,]\s*(?:و)?عندما[^،,]+[،,].*يجب/.test(s)) return "complex";
  if (/^عندما[^،,]+[،,].*يجب/.test(s)) return "event";
  if (/^(?:أثناء|بينما|طالما)[^،,]+[،,].*يجب/.test(s)) return "state";
  if (/^إذا[^،,]+[،,]\s*(?:ف(?:إن|يجب)|فإنه).*/.test(s) && /يجب/.test(s)) return "unwanted";
  if (/^(?:حيثما|في حال توفر|حيث يتوفر)[^،,]+[،,].*يجب/.test(s)) return "optional";
  if (/^يجب\s+(?:على|أن)/.test(s)) return "ubiquitous";
  return null;
}

/** Parses REQ-n lines with their Verify/Traces continuation lines. */
export function parseRequirements(text: string): { requirements: EarsRequirement[]; problems: string[] } {
  const requirements: EarsRequirement[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let current: EarsRequirement | null = null;
  for (const line of text.split(/\r?\n/)) {
    const req = REQ_LINE.exec(line);
    if (req) {
      const id = req[1]!; const sentence = req[2]!.replace(/\*\*/g, "").trim();
      if (seen.has(id)) { problems.push(`${id} is defined twice`); current = null; continue; }
      seen.add(id);
      const pattern = earsPattern(sentence);
      if (!pattern) problems.push(`${id} is not in an EARS pattern (The/When/While/If…then/Where … shall …, or يجب/عندما/أثناء/إذا/حيثما): "${sentence.slice(0, 120)}"`);
      current = { id, text: sentence.slice(0, 600), pattern: pattern ?? "ubiquitous", verify: "", traces: [] };
      requirements.push(current);
      continue;
    }
    if (!current) continue;
    const verify = VERIFY_LINE.exec(line);
    if (verify) { current.verify = verify[1]!.slice(0, 300); continue; }
    const trace = TRACE_LINE.exec(line);
    if (trace) { current.traces = trace[1]!.split(/[,،\s]+/).map(t => t.trim()).filter(t => /^(?:US|AC)-?\d+/i.test(t)).slice(0, 10); continue; }
  }
  for (const r of requirements) if (!r.verify) problems.push(`${r.id} has no "Verify:" line naming the test that proves it`);
  return { requirements: requirements.slice(0, MAX_REQUIREMENTS), problems };
}

/** The requirements gate: enough EARS requirements, each verifiable. */
export function validateRequirements(text: string, opts: { minCount?: number } = {}): { ok: boolean; missing: string[]; requirements: EarsRequirement[] } {
  const { requirements, problems } = parseRequirements(text);
  const min = opts.minCount ?? MIN_REQUIREMENTS;
  const missing = [...problems];
  if (requirements.length < min) missing.unshift(`at least ${min} REQ-n requirements (found ${requirements.length})`);
  return { ok: missing.length === 0, missing: missing.slice(0, 12), requirements };
}

/** Splits a delta answer into its ADDED / MODIFIED / REMOVED sections. */
export function parseDelta(text: string): { added: string; modified: string; removed: string[]; isDelta: boolean } {
  const sections: Record<"added" | "modified" | "removed", string[]> = { added: [], modified: [], removed: [] };
  let mode: keyof typeof sections | null = null;
  let isDelta = false;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^\s*#{1,4}\s*(ADDED|MODIFIED|REMOVED|مضاف(?:ة)?|معدل(?:ة)?|محذوف(?:ة)?)\b/i.exec(line);
    if (heading) {
      const h = heading[1]!.toUpperCase();
      mode = h.startsWith("ADD") || h.startsWith("مضاف") ? "added" : h.startsWith("MOD") || h.startsWith("معدل") ? "modified" : "removed";
      isDelta = true;
      continue;
    }
    if (/^\s*#{1,4}\s/.test(line)) { mode = null; continue; }
    if (mode) sections[mode].push(line);
  }
  const removed = sections.removed.join("\n").match(/REQ-\d{1,3}/g) ?? [];
  return { added: sections.added.join("\n"), modified: sections.modified.join("\n"), removed: [...new Set(removed)], isDelta };
}

const nextId = (used: Set<string>): string => {
  let n = 1; while (used.has(`REQ-${n}`)) n++;
  return `REQ-${n}`;
};

/**
 * Merges a requirements answer into the living spec. Without a previous spec,
 * or when the answer carries no delta headings, the answer is the full spec.
 * ADDED ids that collide are renumbered; MODIFIED ids must exist.
 */
export function mergeSpec(previous: LivingSpec | null, text: string, runId: string, at = new Date().toISOString()): { spec: LivingSpec; problems: string[] } {
  const delta = parseDelta(text);
  if (!previous || !delta.isDelta) {
    const { requirements, problems } = parseRequirements(text);
    const spec: LivingSpec = { version: (previous?.version ?? 0) + 1, updatedAt: at, runId, requirements, history: [...(previous?.history ?? []), { runId, at, added: requirements.map(r => r.id), modified: [], removed: previous ? previous.requirements.map(r => r.id) : [] }].slice(-50) };
    return { spec, problems };
  }
  const problems: string[] = [];
  const byId = new Map(previous.requirements.map(r => [r.id, r]));
  const added = parseRequirements(delta.added); problems.push(...added.problems);
  const modified = parseRequirements(delta.modified); problems.push(...modified.problems);
  const used = new Set(byId.keys());
  const addedIds: string[] = [];
  for (const r of added.requirements) {
    const id = used.has(r.id) ? nextId(used) : r.id;
    used.add(id); byId.set(id, { ...r, id }); addedIds.push(id);
  }
  const modifiedIds: string[] = [];
  for (const r of modified.requirements) {
    if (!byId.has(r.id)) { problems.push(`MODIFIED ${r.id} does not exist in the living spec`); continue; }
    byId.set(r.id, r); modifiedIds.push(r.id);
  }
  const removedIds: string[] = [];
  for (const id of delta.removed) { if (byId.delete(id)) removedIds.push(id); else problems.push(`REMOVED ${id} does not exist in the living spec`); }
  const requirements = [...byId.values()].sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
  return { spec: { version: previous.version + 1, updatedAt: at, runId, requirements, history: [...previous.history, { runId, at, added: addedIds, modified: modifiedIds, removed: removedIds }].slice(-50) }, problems };
}

/** Human-readable living spec written next to the JSON. */
export function renderSpecMarkdown(spec: LivingSpec): string {
  const lines = [`# Requirements (living spec v${spec.version})`, "", `Updated ${spec.updatedAt} by run ${spec.runId}. Format: EARS. Edit through a new company run that continues this one (baseRun), so history stays consistent.`, ""];
  for (const r of spec.requirements) {
    lines.push(`- **${r.id}** (${r.pattern}): ${r.text}`);
    if (r.verify) lines.push(`  - Verify: ${r.verify}`);
    if (r.traces.length) lines.push(`  - Traces: ${r.traces.join(", ")}`);
  }
  lines.push("", "## History", "");
  for (const h of spec.history) lines.push(`- ${h.at} ${h.runId}: +${h.added.length} ~${h.modified.length} -${h.removed.length}`);
  return `${lines.join("\n")}\n`;
}

/** Requirement ids that no test file mentions (by id in a test name or comment). */
export function specCoverage(spec: Pick<LivingSpec, "requirements">, testTexts: Record<string, string>): { covered: string[]; uncovered: string[] } {
  const corpus = Object.values(testTexts).join("\n");
  const covered: string[] = []; const uncovered: string[] = [];
  for (const r of spec.requirements) (new RegExp(`\\b${r.id}\\b`).test(corpus) ? covered : uncovered).push(r.id);
  return { covered, uncovered };
}

export interface ProjectGuideInput {
  brief: string;
  track?: string;
  verificationCommand?: string;
  startCommand?: string;
  independentTests: string[];
  structure: Array<{ path: string; kind: string }>;
  decisions: Array<{ stage: string; text: string }>;
  requirementCount: number;
  runId: string;
}

/** The engine-written AGENTS.md block: facts only, never instructions aimed at overriding a reader. */
export function renderProjectGuide(input: ProjectGuideInput): string {
  const fence = (cmd: string) => `\`${cmd.replaceAll("`", "")}\``;
  const lines = [
    AGENTS_BEGIN,
    "## Project guide (maintained by Loam)",
    "",
    `Product: ${input.brief.replace(/\s+/g, " ").slice(0, 300)}`,
    ...(input.track ? [`Track: ${input.track}`] : []),
    "",
    "### Commands",
    `- Verify: ${input.verificationCommand ? fence(input.verificationCommand) : "no verification command was recorded"}`,
    ...(input.startCommand ? [`- Start: ${fence(input.startCommand)} (port from the PORT environment variable)`] : []),
    ...(input.independentTests.length ? [`- Independent acceptance tests: ${fence(`node --test --test-force-exit ${input.independentTests.join(" ")}`)}`] : []),
    "",
    "### Structure",
    ...input.structure.slice(0, 40).map(file => `- ${file.path} (${file.kind})`),
    "",
    "### Requirements",
    `- ${input.requirementCount} EARS requirements live in ${SPEC_MD}; change them through a follow-up company run so the history stays consistent.`,
    "",
    "### Decisions",
    ...(input.decisions.length ? input.decisions.slice(-12).map(d => `- [${d.stage}] ${d.text.replace(/\s+/g, " ").slice(0, 200)}`) : ["- none recorded"]),
    "",
    "### Conventions",
    "- Keep tests passing before every change; never delete or weaken existing tests.",
    "- Independent acceptance test files are protected by content hashes in Loam runs.",
    "",
    `Generated for run ${input.runId}.`,
    AGENTS_END,
  ];
  return lines.join("\n");
}

/** Inserts or replaces the Loam block, preserving any user-written AGENTS.md content. */
export function upsertProjectGuide(existing: string | null, block: string): string {
  if (!existing || !existing.trim()) return `# AGENTS.md\n\n${block}\n`;
  const begin = existing.indexOf(AGENTS_BEGIN);
  const end = existing.indexOf(AGENTS_END);
  if (begin >= 0 && end > begin) return `${existing.slice(0, begin)}${block}${existing.slice(end + AGENTS_END.length)}`;
  return `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
}
