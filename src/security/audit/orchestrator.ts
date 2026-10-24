/**
 * Audit orchestrator. State machine:
 * INIT > SCAN > BUDGET_GATE > RECON > WAVE_PLAN > HUNT > TIER_A > CRITIC > VALIDATE > WRITE_FINDINGS > REPORT.
 * Every stage row and file is written before the next stage starts. All writes go under the run directory,
 * never into the target repository. Target code and scanner output are untrusted input.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BudgetMeter, createLimiter, runAgentJson } from "./agentIO.js";
import type { AgentDeps, ModelCallResult } from "./agentIO.js";
import { CLASSES } from "./blocks/classes.js";
import { DOMAINS } from "./blocks/domains.js";
import { findPriorRun, knownFindingsFor, priorStatusFor, SOURCE_HASHES_FILE } from "./carry.js";
import type { PriorRun, SourceHashes } from "./carry.js";
import { finalizeConfirmed } from "./confirm.js";
import { deriveCoverageId } from "./coverageId.js";
import { dedupeDeterministic, judgeDuplicates } from "./dedupe.js";
import type { InferiorDupeMap } from "./dedupe.js";
import { evidenceGate } from "./evidenceGate.js";
import { fastPath } from "./fastPath.js";
import { tierA } from "./fpFilter.js";
import type { Candidate } from "./fpFilter.js";
import { criticPrompt, hunterPrompt, reconPrompt, verifierPrompt } from "./prompts.js";
import type { ReconFocus } from "./prompts.js";
import { renderDetail, renderNeedsValidation, renderReport, runMetadata, toSarif } from "./reports.js";
import type { ReportInput, ScannerLine } from "./reports.js";
import { RunStore } from "./runStore.js";
import { DYNAMIC_BLOCKER } from "./sandbox.js";
import { runScanners } from "./scanners.js";
import type { Exec } from "./scanners.js";
import { strArr, text } from "./schema.js";
import type { SchemaObject } from "./schema.js";
import { readCapability } from "./safeRead.js";
import { envFor } from "./repoPath.js";
import type {
  AuditOptions, Confirmed, EvidenceItem, FindingRecord, LedgerUnit, NeedsValidation, PriorStatus, ReconHit, RunResult, Score, TraceStep,
} from "./types.js";
import { expectedAssurance, validateFindings } from "./validateFindings.js";
import { validateLedger } from "./validateLedger.js";

export interface AuditSettings {
  fpFloor: number;
  scanners: string[];
  severityModel: "impact" | "cvss";
  verifierModel?: string;
  /** Opt-in dynamic mode: enables the bounded fuzz executor and crash proofs. Default off. */
  dynamic?: boolean;
}
export const DEFAULT_SETTINGS: AuditSettings = {
  fpFloor: 0.7, scanners: ["loam-secrets", "loam-pkg", "gitleaks", "osv", "guarddog", "opengrep"], severityModel: "impact", dynamic: false,
};

export interface OrchestratorDeps extends Omit<AgentDeps, "budget" | "signal"> {
  settings?: Partial<AuditSettings>;
  /** Scanner process runner (test hook). */
  exec?: Exec;
  signal?: AbortSignal;
  /** Used when opts.target is not given. */
  workspace?: string;
  /** Optional extra risk hints for the risks recon agent. */
  riskHints?: (rootDir: string) => string[];
}

const MIN_BUDGET = 6; // 4 recon + 1 critic reserve + 1 verifier
const PROFILE = {
  quick: { classes: ["injection", "access-control", "obvious"], units: 3, keepTop: 5 },
  standard: { classes: ["injection", "access-control", "resource-file", "crypto-secrets", "business-logic", "obvious"], units: 12, keepTop: 15 },
  deep: { classes: CLASSES.map((c) => c.id), units: 30, keepTop: 40 },
} as const;
const RECON_FOCI: ReconFocus[] = ["inventory", "entrypoints", "risks", "dependencies"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", "target", "vendor"]);

const arr = (items: SchemaObject, minItems = 0): SchemaObject => ({ type: "array", items, minItems });
const obj = (properties: Record<string, SchemaObject>, required: string[]): SchemaObject => ({
  type: "object", properties, required, additionalProperties: false,
});
const posInt = (): SchemaObject => ({ type: "integer", minimum: 1 });
const scoreS = (): SchemaObject => ({ type: "string", enum: ["informational", "low", "medium", "high", "critical"] });

const RECON_SCHEMA = obj({
  facts: arr(obj({ file: text(), line: posInt(), fact: text() }, ["file", "line", "fact"])),
  summary: { type: "string" },
}, ["facts", "summary"]);

const HUNT_SCHEMA = obj({
  candidates: arr(obj({
    title: text(), description: text(), root_cause: text(),
    trace: arr(obj({ kind: { type: "string", enum: ["entrypoint", "propagation", "sink"] }, file: text(), line: posInt(), description: text() }, ["kind", "file", "line", "description"]), 1),
    evidence: arr(obj({ file: text(), line: posInt(), description: text() }, ["file", "line", "description"]), 1),
    impact: scoreS(), likelihood: scoreS(), remediation: text(),
  }, ["title", "description", "root_cause", "trace", "evidence", "impact", "likelihood", "remediation"])),
  coverage: { type: "string", enum: ["covered", "blocked"] },
  checks: arr(obj({ description: text(), paths: strArr(0) }, ["description", "paths"])),
  unresolved: strArr(0),
}, ["candidates", "coverage", "checks", "unresolved"]);

const VERIFY_SCHEMA = obj({
  evidence_vector: arr(obj({
    source: { type: "string", enum: ["llm"] }, state: { type: "string", enum: ["confirmed", "refuted", "unknown"] },
    ref: text(), note: { type: "string" },
  }, ["source", "state", "ref"])),
  production_viable: { type: ["boolean", "string"], enum: [true, false, "unknown"] },
  reason: { type: "string" },
}, ["evidence_vector", "production_viable", "reason"]);

const CRITIC_SCHEMA = obj({
  gaps: arr(obj({ coverage_id: text(), reason: text() }, ["coverage_id", "reason"])),
  merge: arr({ type: "array", items: text(), minItems: 2 }),
}, ["gaps", "merge"]);

type ReconFact = { file: string; line: number; fact: string };

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
const sha16 = (s: string): string => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

function existsUnder(root: string, rel: string): boolean {
  const n = norm(rel);
  if (!n || n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split("/").includes("..")) return false;
  try { return fs.statSync(path.join(root, n)).isFile(); } catch { return false; }
}
const inScope = (rel: string, scope: string[] | undefined): boolean =>
  !scope || scope.length === 0 || scope.some((s) => { const x = norm(s).replace(/\/$/, ""); return x === "" || rel === x || rel.startsWith(`${x}/`); });

function walk(root: string, scope: string[] | undefined, limit = 400): string[] {
  const out: string[] = [];
  const rec = (dir: string): void => {
    if (out.length >= limit) return;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) rec(rel); }
      else if (e.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|cs|kt|swift|sh|ya?ml)$/i.test(e.name) && inScope(rel, scope)) out.push(rel);
    }
  };
  rec("");
  return out;
}

const subsystemOf = (f: string): string => (f.includes("/") ? f.split("/")[0]! : "root");

function companionsFor(paths: string[]): string[] {
  const j = paths.join(" ").toLowerCase();
  const ids: string[] = [];
  const add = (cond: boolean, slug: string): void => { if (cond) ids.push(`loam-audit/${slug}`); };
  add(/auth|session|token|oauth|login/.test(j), "webProtocolAuth");
  add(/prompt|llm|model|agent/.test(j), "aiAndLlm");
  add(/package\.json|\.github|workflow|install|release/.test(j), "supplyChainRelease");
  add(/electron|ipc|preload|main\./.test(j), "desktopMobileIpc");
  return ids.filter((id) => DOMAINS.some((d) => d.id === id));
}

function mkTrace(t: { kind: TraceStep["kind"]; file: string; line: number; description: string }[], keep: (f: string) => string | null): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const s of t) {
    const f = keep(s.file);
    if (f) steps.push({ kind: s.kind, file: f, line: s.line, scope: subsystemOf(f), description: s.description });
  }
  if (steps.length === 0) return steps;
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  if (steps.length === 1) return first.kind === "propagation" ? [{ ...first, kind: "sink" }] : steps;
  const fixed = steps.map((s, i) => (i === 0 ? { ...s, kind: "entrypoint" as const } : i === steps.length - 1 ? { ...s, kind: "sink" as const } : { ...s, kind: "propagation" as const }));
  void last;
  return fixed;
}

function emptyUnit(refs: { surface: string; boundary: string; subsystem: string; attack_class: string }, paths: string[], cls: string, companions: string[], prior: PriorStatus): LedgerUnit {
  return {
    coverage_id: deriveCoverageId(refs), canonical_refs: { ...refs }, ...refs,
    starting_paths: paths, ordinary_attack_class_block: cls, selected_companion_blocks: companions, excluded_blocks: [],
    prior_status: prior, attempts: [], wave: 1, status: "planned", agent_id: null,
    reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: [],
  };
}

export async function orchestrate(opts: AuditOptions, deps: OrchestratorDeps, preStore?: RunStore): Promise<RunResult> {
  const settings: AuditSettings = { ...DEFAULT_SETTINGS, ...deps.settings };
  const target = path.resolve(opts.target ?? deps.workspace ?? process.cwd());
  const profile = opts.profile ?? "standard";
  const prof = PROFILE[profile];
  const budget = new BudgetMeter(opts.budget ?? null);
  const outcomes: ModelCallResult[] = [];
  const agentDeps: AgentDeps = {
    ...deps, budget, signal: deps.signal, verifierModel: settings.verifierModel ?? deps.verifierModel,
    limiter: deps.limiter ?? createLimiter(4),
    onOutcome: (e) => { outcomes.push(e); deps.onOutcome?.(e); },
  };
  const store = preStore ?? RunStore.create(path.basename(target), opts.output_dir);
  const dupeMap: InferiorDupeMap = {};
  let judgeFailures = 0;
  let prior: PriorRun | null = null;
  let hashes: SourceHashes = {};
  const priorRejected = new Set<string>();
  const scanLines: ScannerLine[] = [];
  let findings: FindingRecord[] = [];
  let units: LedgerUnit[] = [];
  let incomplete: string | undefined;
  const cancelled = (): boolean => deps.signal?.aborted === true;
  const sync = (): void => store.setBudget(budget.limit, budget.spent);
  const stage = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    store.stageStart(name);
    try { const r = await fn(); store.stageEnd(name, "done"); return r; }
    catch (e) { store.stageEnd(name, "failed", e instanceof Error ? e.message : String(e)); throw e; }
  };
  const finish = (): RunResult => {
    sync();
    try { store.writeJson("model-failures.json", { ...summarizeOutcomes(outcomes), failures: outcomes.filter((o) => !o.ok) }); } catch { /* best effort */ }
    store.stageStart("DONE");
    store.stageEnd("DONE", "done", incomplete);
    store.close();
    return { run_id: store.runId, output_dir: store.dir, run_status: incomplete ? "incomplete" : "complete", ...(incomplete ? { incomplete_reason: incomplete } : {}) };
  };

  try {
    await stage("INIT", () => { sync(); store.writeJson("run-options.json", { target: path.basename(target), profile, scope_paths: opts.scope_paths ?? [], budget: opts.budget ?? null }); });

    // SCAN
    let records: (Confirmed | NeedsValidation)[] = [];
    let hints: ReconHit[] = [];
    await stage("SCAN", async () => {
      const scratch = store.path("scratch");
      fs.mkdirSync(scratch, { recursive: true });
      const out = await runScanners({ target, scratch, tools: settings.scanners, signal: deps.signal, exec: deps.exec, dynamic: settings.dynamic });
      for (const r of out.reports) scanLines.push({ tool: r.tool, status: r.status, hitCount: r.hitCount, detail: r.detail });
      store.writeJson("scanners.sarif", out.sarif);
      const fp = fastPath(out.hits);
      records = fp.records;
      hints = fp.hints;
    });

    const needed = MIN_BUDGET;
    let planned = true;
    await stage("BUDGET_GATE", () => {
      if (budget.limit !== null && budget.limit < needed) {
        incomplete = "budget_cannot_fund_reconnaissance_and_reserves";
        planned = false;
      }
    });

    // RECON
    const facts: ReconFact[] = [];
    if (planned && !cancelled()) {
      await stage("RECON", async () => {
        const riskHints = (deps.riskHints?.(target) ?? []).map((h) => String(h).slice(0, 160));
        const outs = await Promise.all(RECON_FOCI.map((focus) =>
          runAgentJson<{ facts: ReconFact[]; summary: string }>(agentDeps, {
            role: "audit-research", prompt: reconPrompt(focus, focus === "risks" ? riskHints : []), schema: RECON_SCHEMA,
          })));
        sync();
        const summaries: string[] = [];
        outs.forEach((o, i) => {
          store.agentRecord({ agent_id: `recon-${RECON_FOCI[i]}`, role: "audit-research", wave: 0, coverage_ids: [], status: o.ok ? "done" : "failed" });
          if (o.ok) { facts.push(...o.value.facts); summaries.push(`## ${RECON_FOCI[i]}\n\n${o.value.summary}`); }
        });
        const words = summaries.join("\n\n").split(/\s+/).slice(0, 1000).join(" ");
        store.writeText("architecture.md", `# Architecture notes\n\n${words}\n`);
        if (cancelled()) incomplete = "cancelled";
      });
    }

    // WAVE_PLAN
    if (planned && !incomplete) {
      await stage("WAVE_PLAN", () => {
        const candidates = new Set<string>();
        for (const f of facts) { const n = norm(f.file); if (existsUnder(target, n) && inScope(n, opts.scope_paths)) candidates.add(n); }
        for (const f of walk(target, opts.scope_paths)) { if (candidates.size >= 60) break; candidates.add(f); }
        const bySub = new Map<string, string[]>();
        for (const f of [...candidates].sort()) { const s = subsystemOf(f); (bySub.get(s) ?? bySub.set(s, []).get(s)!).push(f); }
        const reserve = 2; // critic + at least one verifier
        const cap = Math.min(prof.units, budget.limit === null ? prof.units : Math.max(0, budget.remaining - reserve));
        hashes = {};
        for (const f of candidates) {
          try { hashes[f] = crypto.createHash("sha1").update(fs.readFileSync(path.join(target, f))).digest("hex"); } catch { /* unreadable file: no hash */ }
        }
        store.writeJson(SOURCE_HASHES_FILE, hashes);
        prior = opts.prior_runs === "none" ? null : findPriorRun(store.dir);
        for (const f of prior?.findings ?? []) if (f.verdict === "rejected") priorRejected.add(f.fingerprint);
        const seen = new Set<string>();
        outer: for (const cls of prof.classes) {
          for (const [sub, files] of bySub) {
            if (units.length >= cap) break outer;
            const refs = { surface: sub === "root" ? "repository root" : sub, boundary: "repository", subsystem: sub, attack_class: cls };
            const u = emptyUnit(refs, files.slice(0, 12), cls, companionsFor(files), "new");
            if (seen.has(u.coverage_id)) continue;
            u.prior_status = opts.prior_runs === "none" ? "none" : priorStatusFor(u, prior, hashes);
            seen.add(u.coverage_id);
            units.push(u);
          }
        }
        units.sort((a, b) => (a.coverage_id < b.coverage_id ? -1 : a.coverage_id > b.coverage_id ? 1 : 0));
        store.writeJson("coverage-ledger.json", units);
      });
    }

    // HUNT
    const hunted: Candidate[] = [];
    if (planned && !incomplete) {
      await stage("HUNT", async () => {
        const keep = (f: string): string | null => { const n = norm(f); return existsUnder(target, n) ? n : null; };
        const runs = units.map(async (u, idx) => {
          if (cancelled()) return;
          if (!budget.canLaunch(2)) { // keep one for the critic reserve
            u.status = "deferred"; u.unresolved = ["budget exhausted before this unit was hunted"]; return;
          }
          const unitHints = hints.filter((h) => u.starting_paths.includes(norm(h.file)));
          const o = await runAgentJson<{ candidates: { title: string; description: string; root_cause: string; trace: { kind: TraceStep["kind"]; file: string; line: number; description: string }[]; evidence: { file: string; line: number; description: string }[]; impact: Score; likelihood: Score; remediation: string }[]; coverage: "covered" | "blocked"; checks: { description: string; paths: string[] }[]; unresolved: string[] }>(
            agentDeps, { role: "audit-hunter", prompt: hunterPrompt({ coverage_id: u.coverage_id, paths: u.starting_paths, classId: u.ordinary_attack_class_block ?? "wildcard" }, u.selected_companion_blocks, unitHints, knownFindingsFor(u, prior, hashes)), schema: HUNT_SCHEMA });
          const agent_id = `hunter-${idx + 1}`;
          store.agentRecord({ agent_id, role: "audit-hunter", wave: 1, coverage_ids: [u.coverage_id], status: o.ok ? "done" : "failed" });
          if (!o.ok) {
            if (o.reason === "cancelled") return;
            u.status = "deferred"; u.unresolved = [`hunter failed: ${o.reason}`.slice(0, 300)]; return;
          }
          const v = o.value;
          const paths = [...new Set(v.checks.flatMap((c) => c.paths).map(keep).filter((x): x is string => x !== null))];
          const reviewed = paths.length ? paths : u.starting_paths;
          const fps: string[] = [];
          for (const c of v.candidates) {
            const trace = mkTrace(c.trace, keep);
            const evidence = c.evidence.map((e) => ({ ...e, file: keep(e.file) })).filter((e): e is { file: string; line: number; description: string } => e.file !== null);
            if (trace.length === 0 || evidence.length === 0) continue;
            const fingerprint = `hunt:${u.ordinary_attack_class_block ?? "x"}:${sha16(`${trace[0]!.file}|${c.title}`)}`;
            if (fps.includes(fingerprint) || hunted.some((h) => h.fingerprint === fingerprint)) continue;
            // A claim rejected before, on source that has not changed, is not raised again.
            if (u.prior_status === "prior_covered_same_source" && priorRejected.has(fingerprint)) continue;
            fps.push(fingerprint);
            hunted.push({
              verdict: "confirmed", fingerprint, title: c.title, description: c.description, root_cause: c.root_cause,
              intended_behavior: "The code should reject or neutralise this input before the sink.",
              trace, evidence, conditions: [],
              execution: { attacker_perspective: c.description, payloads: [], instructions: [], observed_result: "Not executed: static analysis only." },
              remediation: { strategy: c.remediation },
              severity: { likelihood: { score: c.likelihood, reason: "Estimated by the hunter from the trace." }, impact: { score: c.impact, reason: "Estimated by the hunter from the trace." }, overall_severity: c.impact },
              confidence: { score: "medium", reason: "Single-pass static hunt, not yet verified." },
              evidence_vector: [{ source: "llm", state: "unknown", ref: trace[0]!.file }],
              evidence_assurance: "source-only", cls: u.ordinary_attack_class_block ?? undefined, primary_file: trace[0]!.file,
            });
          }
          const checks = v.checks.length ? v.checks : [{ description: "Reviewed the unit paths", paths: reviewed }];
          u.agent_id = agent_id;
          u.reviewed_paths = reviewed;
          u.local_checks = checks.map((c) => ({ agent_id, reviewed_paths: c.paths.map(keep).filter((x): x is string => x !== null).length ? c.paths.map(keep).filter((x): x is string => x !== null) : reviewed, invariant: c.description, method: "source" as const, result: "reviewed", artifact: null, assurance: null }));
          u.reviewed_paths = [...new Set(u.local_checks.flatMap((c) => c.reviewed_paths))].sort();
          if (fps.length) { u.status = "candidate"; u.result_fingerprints = fps.sort(); u.unresolved = []; }
          else if (v.coverage === "blocked") { u.status = "blocked"; u.unresolved = v.unresolved.length ? v.unresolved : ["hunter reported the unit blocked"]; }
          else { u.status = "covered"; u.unresolved = []; }
        });
        await Promise.all(runs);
        sync();
        if (cancelled()) incomplete = "cancelled";
        store.writeJson("coverage-ledger.json", units);
      });
    }

    // TIER_A
    let survivors: Candidate[] = [];
    if (planned && !incomplete) {
      await stage("TIER_A", () => {
        const d = dedupeDeterministic(hunted, dupeMap);
        const r = tierA(d.kept, { fpFloor: settings.fpFloor, keepTop: prof.keepTop });
        survivors = r.kept;
        store.writeJson("tier-a-dropped.json", r.dropped);
      });
    }

    // CRITIC
    let criticMerge: string[][] = [];
    if (planned && !incomplete) {
      await stage("CRITIC", async () => {
        if (!budget.canLaunch()) { incomplete = "critic_budget_exhausted"; return; }
        const summary = JSON.stringify({ units: units.map((u) => ({ id: u.coverage_id, status: u.status, n: u.result_fingerprints.length })), candidates: survivors.map((s) => ({ fp: s.fingerprint, title: s.title })) }).slice(0, 12000);
        const o = await runAgentJson<{ gaps: { coverage_id: string; reason: string }[]; merge: string[][] }>(agentDeps, { role: "audit-research", prompt: criticPrompt(summary), schema: CRITIC_SCHEMA });
        sync();
        if (o.ok) { store.writeJson("critic.json", o.value); criticMerge = o.value.merge; }
        else if (o.reason === "budget_exhausted") incomplete = "critic_budget_exhausted";
        else if (o.reason === "cancelled") incomplete = "cancelled";
      });
    }

    // DEDUPE: a model judge confirms same-file pairs and the critic's merge proposals. It fails open.
    if (planned && !incomplete) {
      await stage("DEDUPE", async () => {
        if (survivors.length < 2 || !budget.canLaunch(2)) return; // keep one for a verifier
        const r = await judgeDuplicates(agentDeps, survivors, criticMerge, dupeMap);
        sync();
        survivors = r.kept;
        judgeFailures = r.judgeFailures.length;
        if (r.judgeFailures.length) store.writeJson("dedupe-judge-failures.json", r.judgeFailures);
      });
    }
    try { store.writeJson("inferior-dupe-map.json", dupeMap); } catch { /* best effort */ }

    // VALIDATE
    const final: FindingRecord[] = [...records];
    if (planned && !incomplete) {
      await stage("VALIDATE", async () => {
        for (const c of survivors) {
          if (cancelled()) { incomplete = "cancelled"; break; }
          if (!budget.canLaunch()) { incomplete = "validation_budget_exhausted"; break; }
          const { cls: _c, primary_file: _p, ...rec } = c as Confirmed & { cls?: string; primary_file?: string };
          void _c; void _p;
          const o = await runAgentJson<{ evidence_vector: EvidenceItem[]; production_viable: boolean | "unknown"; reason: string }>(
            agentDeps, { role: "audit-verifier", prompt: verifierPrompt(JSON.stringify({ title: rec.title, description: rec.description, root_cause: rec.root_cause, trace: rec.trace, evidence: rec.evidence })), schema: VERIFY_SCHEMA, model: agentDeps.verifierModel });
          store.agentRecord({ agent_id: `verifier-${sha16(rec.fingerprint).slice(0, 8)}`, role: "audit-verifier", wave: 2, coverage_ids: [], status: o.ok ? "done" : "failed" });
          sync();
          if (!o.ok) {
            if (o.reason === "cancelled") { incomplete = "cancelled"; break; }
            final.push(toNeedsValidation(rec, [`verification failed: ${o.reason}`.slice(0, 200)]));
            continue;
          }
          const vector = o.value.evidence_vector.map((e) => ({ ...e, note: e.note ?? undefined }));
          const gate = evidenceGate(vector);
          const withVec: Confirmed = { ...rec, evidence_vector: vector, production_viable: o.value.production_viable };
          if (gate === "reject") {
            final.push({
              verdict: "rejected", fingerprint: rec.fingerprint, title: rec.title, description: rec.description,
              claimed_root_cause: rec.root_cause, trace: rec.trace, evidence: rec.evidence,
              reason: o.value.reason.trim() || "The verifier refuted the claim.", evidence_assurance: "source-only",
            });
          } else if (gate === "needs_validation") {
            final.push(toNeedsValidation(withVec, ["the verifier could not confirm the claim from source"], vector));
          } else {
            final.push(finalizeConfirmed(withVec, { severityModel: settings.severityModel, viabilityRequired: true }));
          }
        }
      });
    }
    findings = final;

    // WRITE_FINDINGS (also runs for incomplete runs so partial work is kept)
    await stage("WRITE_FINDINGS", () => {
      for (const u of units) if (u.status === "planned" && incomplete) { u.status = "deferred"; u.unresolved = [incomplete]; }
      findings = findings.map((f) => ({ ...f, evidence_assurance: expectedAssurance(units, f.fingerprint) }) as FindingRecord);
      findings.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
      const lb = store.writeJson("coverage-ledger.json", units);
      const fb = store.writeJson("findings.json", findings);
      const lv = validateLedger(lb, { runDir: store.dir });
      if (!lv.ok) throw new Error(`coverage-ledger.json invalid: ${lv.errors.slice(0, 3).join("; ")}`);
      const fv = validateFindings(fb, { runDir: store.dir });
      if (!fv.ok) throw new Error(`findings.json invalid: ${fv.errors.slice(0, 3).join("; ")}`);
    });

    // REPORT
    await stage("REPORT", () => {
      const entries = Object.values(dupeMap);
      const input = reportInput(store, {
        target, profile, findings, units, scanLines, budget, incomplete,
        modelFailures: summarizeOutcomes(outcomes),
        dupes: { total: entries.length, deterministic: entries.filter((e) => e.by === "deterministic").length, judge: entries.filter((e) => e.by === "judge").length, judgeFailures },
      });
      store.writeText("REPORT.md", renderReport(input));
      store.writeText("FINDINGS-DETAIL.md", renderDetail(input));
      store.writeText("NEEDS-VALIDATION.md", renderNeedsValidation(input));
      store.writeJson("findings.sarif", toSarif(input));
      store.writeJson("run-metadata.json", runMetadata(input));
    });
  } catch (e) {
    incomplete = incomplete ?? `failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
    try {
      store.writeJson("run-metadata.json", { run_id: store.runId, run_status: "incomplete", incomplete_reason: incomplete });
    } catch { /* best effort */ }
  }
  return finish();
}

function toNeedsValidation(c: Confirmed, blockers: string[], vector?: EvidenceItem[]): NeedsValidation {
  return {
    verdict: "needs_validation", fingerprint: c.fingerprint, title: c.title, description: c.description,
    claimed_root_cause: c.root_cause, trace: c.trace, evidence: c.evidence, blockers,
    validation_plan: { local: `Re-check the trace by hand. ${DYNAMIC_BLOCKER}` },
    evidence_vector: vector ?? c.evidence_vector, evidence_assurance: "source-only",
  };
}

function countPromotions(store: RunStore): { full: number; reduced_win32: number } {
  const out = { full: 0, reduced_win32: 0 };
  const dir = store.path("agents");
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(dir, n, "promotions.json"), "utf8")) as { assurance?: string }[];
      for (const p of list) if (p.assurance === "reduced-win32") out.reduced_win32++; else out.full++;
    } catch { /* no promotions for this agent */ }
  }
  return out;
}

/** Counts per call result; reasons are collapsed to their first words so the report stays short. */
function summarizeOutcomes(list: ModelCallResult[]): { calls: number; failed: number; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  let failed = 0;
  for (const o of list) {
    if (o.ok) continue;
    failed++;
    const key = o.reason.replace(/\s+/g, " ").slice(0, 60);
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  return { calls: list.length, failed, reasons };
}

function reportInput(store: RunStore, x: {
  target: string; profile: string; findings: FindingRecord[]; units: LedgerUnit[]; scanLines: ScannerLine[]; budget: BudgetMeter; incomplete?: string;
  modelFailures?: ReportInput["modelFailures"]; dupes?: ReportInput["dupes"];
}): ReportInput {
  const cap = readCapability(envFor(undefined));
  return {
    runId: store.runId, repo: path.basename(x.target), profile: x.profile,
    runStatus: x.incomplete ? "incomplete" : "complete", incompleteReason: x.incomplete,
    findings: x.findings, units: x.units, scanners: x.scanLines, promotions: countPromotions(store),
    hostPlatform: process.platform, readAssurance: cap.assurance,
    budget: { spent: x.budget.spent, limit: x.budget.limit },
    ...(x.modelFailures ? { modelFailures: x.modelFailures } : {}),
    ...(x.dupes ? { dupes: x.dupes } : {}),
  };
}

/** Start an audit in the background. Returns as soon as the run directory exists. */
export function startAudit(opts: AuditOptions, deps: OrchestratorDeps): { run_id: string; output_dir: string; done: Promise<RunResult> } {
  const target = path.resolve(opts.target ?? deps.workspace ?? process.cwd());
  const store = RunStore.create(path.basename(target), opts.output_dir);
  const done = orchestrate(opts, deps, store).catch((e): RunResult => ({
    run_id: store.runId, output_dir: store.dir, run_status: "incomplete", incomplete_reason: `failed: ${String(e).slice(0, 200)}`,
  }));
  return { run_id: store.runId, output_dir: store.dir, done };
}

const ZERO_LEDGER = { planned: 0, in_progress: 0, covered: 0, blocked: 0, candidate: 0, deferred: 0, out_of_scope: 0, not_applicable: 0 };

export function getAuditStatus(runId: string): Record<string, unknown> | null {
  const store = RunStore.open(runId);
  if (!store) return null;
  try {
    const units = store.readJson<LedgerUnit[]>("coverage-ledger.json") ?? [];
    const ledger_counts: Record<string, number> = { ...ZERO_LEDGER };
    for (const u of units) ledger_counts[u.status] = (ledger_counts[u.status] ?? 0) + 1;
    const fs_ = store.readJson<FindingRecord[]>("findings.json") ?? [];
    const candidate_counts = { confirmed: 0, needs_validation: 0, rejected: 0 };
    for (const f of fs_) candidate_counts[f.verdict]++;
    const meta = store.readJson<{ scanners?: ScannerLine[]; run_status?: string; incomplete_reason?: string }>("run-metadata.json");
    return {
      run_id: runId, stage: store.currentStage(), wave: 1, budget: store.budget(), ledger_counts, candidate_counts,
      promotions: countPromotions(store),
      scanners: (meta?.scanners ?? []).map((s) => ({ tool: s.tool, status: s.status, hitCount: s.hitCount })),
      ...(meta?.run_status ? { run_status: meta.run_status } : {}),
      ...(meta?.incomplete_reason ? { incomplete_reason: meta.incomplete_reason } : {}),
    };
  } finally { store.close(); }
}

export function getAuditReport(runId: string): { paths: Record<string, string>; firstSection: string; in_progress: boolean } | null {
  const store = RunStore.open(runId);
  if (!store) return null;
  try {
    const report = store.readText("REPORT.md");
    const paths = {
      report: store.path("REPORT.md"), detail: store.path("FINDINGS-DETAIL.md"),
      needsValidation: store.path("NEEDS-VALIDATION.md"), sarif: store.path("findings.sarif"),
    };
    if (report === null) return { paths, firstSection: "", in_progress: true };
    const idx = report.indexOf("## 2.");
    return { paths, firstSection: (idx > 0 ? report.slice(0, idx) : report).slice(0, 4000), in_progress: false };
  } finally { store.close(); }
}
