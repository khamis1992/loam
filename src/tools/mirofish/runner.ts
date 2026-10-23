/**
 * MiroFish runner (M3 wiring): turn a conversational request into a real swarm
 * simulation.
 *
 * The conversational surface (`src/tools/mirofish.ts`) stays a plain,
 * synchronous, dependency-free function so existing callers and tests keep
 * working. Everything that needs the model lives here:
 *
 *   runSeed      -> M2: locale + entities + personas
 *   runSimulation -> M3: N agents x R rounds, one model call per agent-turn
 *   render*       -> M4-lite: numbers, quotes and a baseline/scenario comparison
 *
 * Nothing is ever fabricated. When the model layer is unavailable (no config,
 * provider down, every call failed) the run still completes: personas come from
 * the deterministic rule-based fallback, the turns are logged as skipped with
 * `ok:false`, and the reply says so plainly.
 */
import fs from "node:fs";
import path from "node:path";
import { createLoamModelCaller, type ModelCaller } from "./model.js";
import { runSeed, type SeedOptions } from "./seed.js";
import { runSimulation, type SimulationOptions } from "./simulate.js";
import type {
  ArmComparison,
  ArmId,
  SeedResult,
  SimulationArmResult,
  SimulationProgressEvent,
  SimulationResult,
} from "./types.js";

/** Default number of simulation rounds when the caller does not name one. */
export const DEFAULT_RUN_ROUNDS = 3;
/** Default agent count (spec: 12). */
export const DEFAULT_RUN_AGENTS = 12;
/** Model calls are run 2 at a time (RAM light, per spec). */
export const DEFAULT_RUN_CONCURRENCY = 2;
/** Per-call timeout; the agent budget keeps long runs from stalling. */
export const DEFAULT_RUN_CALL_TIMEOUT_MS = 120_000;

/** The model-facing half of the tool: everything the runner needs to call out. */
export interface RunnerModelDeps {
  cfg: Parameters<typeof createLoamModelCaller>[0];
  /** Provider client. When omitted a local client is built from cfg. */
  ollama?: Parameters<typeof createLoamModelCaller>[1];
  /** Test seam: a deterministic caller replaces the whole provider chain. */
  caller?: ModelCaller;
}

export interface RunnerOptions extends RunnerModelDeps {
  workspace: string;
  message: string;
  docs?: string[];
  location?: { city?: string; country?: string; region?: string };
  agents?: number;
  rounds?: number;
  variable?: { name: string; baseline: string | number; scenario: string | number; unit?: string };
  seed?: number;
  language?: string;
  /** Public simulation id allocated by the tool; M3 artifacts are placed under it. */
  simulationId?: string;
  /** Extra progress sink (the tool forwards it to the run's event bus). */
  onProgress?: (event: SimulationProgressEvent) => void;
  /** Cancellation signal from the surrounding run. */
  signal?: AbortSignal;
  /** Root the MiroFish artifacts (seed.json / simulations / reports) live in. */
  root: string;
}

export interface SwarmRun {
  ok: boolean;
  /** The seed step result: locale, entities, personas and how they were made. */
  seedResult: SeedResult;
  /** The simulation result; undefined when the personas step produced nothing. */
  simulation?: SimulationResult;
  /** True when every agent-turn was skipped because no caller was available. */
  modelUnavailable: boolean;
  /** Baseline/scenario comparison, when the request varied a variable. */
  comparison?: ArmComparison;
  /** Locale-aware personas written to the profile artifacts. */
  personaCount: number;
}

/** Deterministic per-run RNG seed so a rerun of the same brief is comparable. */
export function runSeedValue(message: string, explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return Math.floor(explicit) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < message.length; i++) {
    h ^= message.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

/** Coerce a config-like value into the shape {@link createLoamModelCaller} takes. */
function toCallerCfg(cfg: RunnerModelDeps["cfg"]): Parameters<typeof createLoamModelCaller>[0] {
  const raw = (cfg ?? {}) as unknown as Record<string, unknown>;
  const model = typeof raw.model === "string" && raw.model ? raw.model : "glm-5.3-flash:cloud";
  const ollamaUrl = typeof raw.ollamaUrl === "string" && raw.ollamaUrl ? raw.ollamaUrl : "http://127.0.0.1:11434";
  const fallbackModel = typeof raw.fallbackModel === "string" && raw.fallbackModel ? raw.fallbackModel : undefined;
  const agentRaw = (raw.agent ?? {}) as { temperature?: unknown; requestTimeoutMs?: unknown; maxSteps?: unknown };
  const agent = {
    maxSteps: typeof agentRaw.maxSteps === "number" ? agentRaw.maxSteps : 1,
    temperature: typeof agentRaw.temperature === "number" ? agentRaw.temperature : 0.2,
    requestTimeoutMs: typeof agentRaw.requestTimeoutMs === "number" ? agentRaw.requestTimeoutMs : 600_000,
  };
  const out: Record<string, unknown> = { model, ollamaUrl, agent };
  if (fallbackModel) out.fallbackModel = fallbackModel;
  return out as unknown as Parameters<typeof createLoamModelCaller>[0];
}

/**
 * Build the {@link ModelCaller}. Prefer an explicitly injected caller (tests),
 * then the runtime provider client, and only construct a local client as a last
 * resort. Returns undefined when there is no provider to talk to at all.
 */
export function resolveCaller(deps: RunnerModelDeps): ModelCaller | undefined {
  if (deps.caller) return deps.caller;
  if (deps.ollama) return createLoamModelCaller(toCallerCfg(deps.cfg), deps.ollama);
  return undefined;
}

/** Write the M2 seed artifact next to the M3 simulation outputs. */
export function writeSeedArtifact(rootDir: string, seedResult: SeedResult): void {
  try {
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "seed.json"),
      JSON.stringify(
        {
          locale: seedResult.locale,
          entities: seedResult.entities,
          personas: seedResult.personas,
          locale_source: seedResult.localeSource,
          model_calls: seedResult.modelCalls,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    /* the artifact is a convenience; never fail the run over it */
  }
}

/**
 * Run the seeded swarm simulation for one conversational request.
 *
 * The seed step is always attempted with the model when a caller exists, and
 * degrades to the rule-based locale/entities/personas fallback otherwise. The
 * simulation step then runs the M3 loop with whatever personas exist.
 */
export async function runSwarmSimulation(opts: RunnerOptions): Promise<SwarmRun> {
  const caller = resolveCaller(opts);
  const rngSeed = runSeedValue(opts.message, opts.seed);
  const rounds = Math.max(1, Math.floor(opts.rounds ?? DEFAULT_RUN_ROUNDS));
  const agents = Math.max(1, Math.floor(opts.agents ?? DEFAULT_RUN_AGENTS));

  const seedOpts: SeedOptions = {
    caller,
    workspace: opts.workspace,
    concurrency: DEFAULT_RUN_CONCURRENCY,
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.docs && opts.docs.length > 0 ? { docs: opts.docs } : {}),
  };

  const seedResult = await runSeed(
    {
      brief: opts.message,
      ...(opts.docs && opts.docs.length > 0 ? { docs: opts.docs } : {}),
      ...(opts.location && (opts.location.country || opts.location.city || opts.location.region)
        ? {
            location: {
              ...(opts.location.country ? { country: opts.location.country } : {}),
              ...(opts.location.city ? { city: opts.location.city } : {}),
              ...(opts.location.region ? { region: opts.location.region } : {}),
            },
          }
        : {}),
      agents,
      rounds,
      ...(opts.variable
        ? {
            variable: {
              name: opts.variable.name,
              baseline: opts.variable.baseline,
              scenario: opts.variable.scenario,
              ...(opts.variable.unit ? { unit: opts.variable.unit } : {}),
            },
          }
        : {}),
      ...(opts.language ? { language: opts.language } : {}),
      seed: rngSeed,
    },
    seedOpts,
  );

  writeSeedArtifact(path.join(opts.root, "seeds"), seedResult);

  const m3SessionId = `sim_${rngSeed.toString(16)}`;
  const simDir = path.join(opts.root, "simulations", m3SessionId);
  const simulationOpts: SimulationOptions = {
    caller,
    seed: rngSeed,
    agents,
    rounds,
    concurrency: DEFAULT_RUN_CONCURRENCY,
    perCallTimeoutMs: DEFAULT_RUN_CALL_TIMEOUT_MS,
    taskDir: simDir,
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  let simulation: SimulationResult | undefined;
  if (seedResult.personas.length > 0) {
    simulation = await runSimulation(
      m3SessionId,
      {
        seed: seedResult,
        brief: opts.message,
        ...(opts.variable
          ? {
              variable: {
                name: opts.variable.name,
                baseline: opts.variable.baseline,
                scenario: opts.variable.scenario,
                ...(opts.variable.unit ? { unit: opts.variable.unit } : {}),
              },
            }
          : {}),
      },
      simulationOpts,
    );
    // The tool allocates the public simulation id; keep the M3 artifacts under it
    // so the JSONL/metrics land next to the profile files the UI already reads.
    if (opts.simulationId && opts.simulationId !== m3SessionId) {
      const target = path.join(opts.root, "simulations", opts.simulationId);
      fs.mkdirSync(target, { recursive: true });
      for (const file of ["simulation_events.jsonl", "metrics.json"]) {
        const from = path.join(simDir, file);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(target, file));
      }
      simulation = {
        ...simulation,
        logPath: path.join(target, "simulation_events.jsonl"),
        metricsPath: path.join(target, "metrics.json"),
      };
    }
  }

  const acted = (simulation?.arms ?? []).reduce((sum, arm) => sum + arm.turns.filter((t) => t.ok).length, 0);
  const modelUnavailable = acted === 0;

  return {
    ok: true,
    seedResult,
    ...(simulation ? { simulation } : {}),
    modelUnavailable,
    ...(simulation?.comparison ? { comparison: simulation.comparison } : {}),
    personaCount: seedResult.personas.length,
  };
}

// ---------------------------------------------------------------------------
// Report rendering (M4-lite: everything below is derived from the recorded log)
// ---------------------------------------------------------------------------

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number, digits = 3): string {
  const v = Number(value.toFixed(digits));
  return v > 0 ? `+${v}` : String(v);
}

function armLabel(arm: ArmId, isAr: boolean): string {
  if (isAr) return arm === "baseline" ? "الأساس" : "السيناريو";
  return arm === "baseline" ? "baseline" : "scenario";
}

/** The most convincing quote for a stance: real agent words from the JSONL log. */
function bestQuote(arm: SimulationArmResult, want: "positive" | "negative"): string | null {
  const turns = arm.turns.filter((t) => t.ok && t.text.trim().length > 0);
  const pool = want === "positive" ? turns.filter((t) => t.stance > 0.2) : turns.filter((t) => t.stance < -0.2);
  const sorted = [...pool].sort((a, b) =>
    want === "positive" ? b.purchaseIntent - a.purchaseIntent : a.purchaseIntent - b.purchaseIntent,
  );
  for (const turn of sorted) {
    const text = turn.text.replace(/\s+/g, " ").trim();
    if (text.length >= 20) return `${turn.agentName}: "${text.slice(0, 220)}${text.length > 220 ? "..." : ""}"`;
  }
  return null;
}

function variableText(
  variable: { name: string; baseline: string | number; scenario: string | number; unit?: string } | undefined,
): string | null {
  if (!variable) return null;
  const unit = variable.unit ? ` ${variable.unit}` : "";
  return `${variable.name}: ${String(variable.baseline)}${unit} -> ${String(variable.scenario)}${unit}`;
}

/** How the report/reply describe the market location, Arabic or English. */
function marketLabel(location: { city: string | null; country: string | null; region: string | null }, isAr: boolean): string {
  const parts = [location.city, location.region, location.country].filter((p) => Boolean(p && p.trim()));
  if (parts.length === 0) return isAr ? "عالمي" : "Global";
  return parts.join(isAr ? "، " : ", ");
}

/**
 * Render the report body. Every number comes from the recorded turns; the
 * quotes are the agents' own words from the JSONL log.
 */
export function renderSwarmReport(input: {
  run: SwarmRun;
  message: string;
  isAr: boolean;
  location: { city: string | null; country: string | null; region: string | null };
  targetName: string;
  graphId: string;
  reportId: string;
}): string {
  const { run, message, isAr, location, targetName, graphId } = input;
  const { seedResult } = run;
  const sim = run.simulation;
  const comparison = run.comparison;
  const varText = variableText(comparison?.variable);
  const market = marketLabel(location, isAr);
  const personaCount = sim?.agents ?? seedResult.personas.length;

  const lines: string[] = [];
  lines.push(
    isAr
      ? `# تقرير ذكاء السرب MiroFish: ${targetName}`
      : `# MiroFish Swarm Intelligence Report: ${targetName}`,
  );
  lines.push("");
  lines.push(
    isAr
      ? `> **Market Location**: ${market}${varText ? ` — **Injected Variables**: ${varText}` : ""}`
      : `> **Market Location**: ${market}${varText ? ` — **Injected Variables**: ${varText}` : ""}`,
  );
  lines.push("");

  lines.push(isAr ? "## 1. البذور والسياق المحلي (M2)" : "## 1. Seed & locale context (M2)");
  lines.push("");
  const localeBits = isAr
    ? [
        `- **السوق المستهدف**: ${market} — العملة: ${seedResult.locale.currency} — اللغات: ${seedResult.locale.languages.join("، ")}.`,
        `- **كيف حُلّ السوق**: ${
          seedResult.localeSource === "user"
            ? "اختيار المستخدم"
            : seedResult.localeSource === "inferred"
              ? "استدلال النموذج من الوصف"
              : "بديل محايد (النموذج غير متاح)"
        }.`,
      ]
    : [
        `- **Target market**: ${market} — currency ${seedResult.locale.currency} — languages ${seedResult.locale.languages.join(", ")}.`,
        `- **How the market was resolved**: ${
          seedResult.localeSource === "user"
            ? "user selection"
            : seedResult.localeSource === "inferred"
              ? "model inference from the brief"
              : "neutral fallback (model unavailable)"
        }.`,
      ];
  lines.push(...localeBits);
  const products = seedResult.entities.products.map((p) => p.name).join(", ");
  const prices = seedResult.entities.prices
    .map((p) => `${p.amount} ${p.currency}${p.period ? `/${p.period}` : ""}`)
    .join(", ");
  const audiences = seedResult.entities.audiences.join(", ");
  if (products) lines.push(isAr ? `- **المنتجات المستخرجة**: ${products}.` : `- **Products extracted**: ${products}.`);
  if (prices) lines.push(isAr ? `- **الأسعار المستخرجة**: ${prices}.` : `- **Prices extracted**: ${prices}.`);
  if (audiences) lines.push(isAr ? `- **الشرائح المستهدفة**: ${audiences}.` : `- **Audiences**: ${audiences}.`);
  lines.push(
    isAr
      ? `- **الشخصيات**: ${seedResult.personas.length} شخصية مستخدم مشتقة من السياق المحلي (وليست قائمة ثابتة).`
      : `- **Personas**: ${seedResult.personas.length} user personas derived from the locale (not a fixed list).`,
  );
  lines.push("");

  lines.push(isAr ? "## 2. ديناميكيات السرب (محاكاة فعلية)" : "## 2. Swarm dynamics (real simulation)");
  lines.push("");
  if (!sim || sim.arms.length === 0) {
    lines.push(
      isAr
        ? "- لم تبدأ المحاكاة: لم تتوفر شخصيات لإجرائها."
        : "- The simulation did not start: no personas were available to run it.",
    );
    lines.push("");
  } else {
    lines.push(
      isAr
        ? `**ملخص المحاكاة**: نفّذت ${sim.agents} شخصية وكلاء ${sim.rounds} جولات (بذرة قابلة لإعادة الإنتاج: ${sim.seed})، مع استدعاء نموذج حقيقي لكل دور على الوكيل.`
        : `**Simulation summary**: ${sim.agents} agent personas ran ${sim.rounds} rounds (reproducible seed ${sim.seed}), with a real model call for every agent-turn.`,
    );
    lines.push("");
    for (const arm of sim.arms) {
      const acted = arm.turns.filter((t) => t.ok).length;
      const last = arm.rounds[arm.rounds.length - 1];
      lines.push(
        isAr
          ? `- **${armLabel(arm.arm, true)}**: ${acted}/${arm.turns.length} دوراً ناجحاً${last ? ` | متوسط نية الشراء في الجولة الأخيرة ${last.meanIntent}` : ""}${last ? ` | الأسهم ${last.actionCounts.share}` : ""}${last ? ` | موضوعات مهيمنة: ${last.topThemes.slice(0, 3).map((t) => t.theme).join("، ")}` : ""}.`
          : `- **${armLabel(arm.arm, false)}**: ${acted}/${arm.turns.length} successful turns${last ? ` | last-round mean purchase intent ${last.meanIntent}` : ""}${last ? ` | shares ${last.actionCounts.share}` : ""}${last ? ` | top themes ${last.topThemes.slice(0, 3).map((t) => t.theme).join(", ")}` : ""}.`,
      );
      const positive = bestQuote(arm, "positive");
      const negative = bestQuote(arm, "negative");
      if (positive) lines.push(`  > ${isAr ? "مؤيد" : "Supportive"} — ${positive}`);
      if (negative) lines.push(`  > ${isAr ? "معارض" : "Critical"} — ${negative}`);
    }
    if (comparison) {
      lines.push("");
      lines.push(
        isAr
          ? `**مقارنة الأساس/السيناريو**: نيّة الشراء ${signed(comparison.intentDelta)}، حصة الإيجابيين ${signed(comparison.positiveShareDelta)}، معدل الشراء ${signed(comparison.buyRateDelta)} (الأساس ${pct(comparison.baselineBuyRate)} -> السيناريو ${pct(comparison.scenarioBuyRate)}).`
          : `**Baseline vs scenario**: purchase intent ${signed(comparison.intentDelta)}, positive share ${signed(comparison.positiveShareDelta)}, buy rate ${signed(comparison.buyRateDelta)} (baseline ${pct(comparison.baselineBuyRate)} -> scenario ${pct(comparison.scenarioBuyRate)}).`,
      );
    }
    lines.push("");
    lines.push(
      isAr
        ? `- **سجل الأحداث**: \`${sim.logPath}\` | **المقااييس**: \`${sim.metricsPath}\`.`
        : `- **Event log**: \`${sim.logPath}\` | **Metrics**: \`${sim.metricsPath}\`.`,
    );
    lines.push("");
  }

  lines.push(isAr ? "## 3. حدود الأمان والتوصيات" : "## 3. Security boundaries & recommendations");
  lines.push("");
  if (comparison && comparison.intentDelta < -0.05) {
    lines.push(
      isAr
        ? `- **توصية**: السيناريو أضعف من الأساس بنحو ${pct(Math.abs(comparison.intentDelta))} من نيّة الشراء — يلزم إعادة النظر في القيمة أو تخفيف أثرها (تقسيط، نسخة مجانية، أو تثبيت السعر للفئة الحساسة).`
        : `- **Recommendation**: the scenario is about ${pct(Math.abs(comparison.intentDelta))} weaker on purchase intent than the baseline — revisit the value or soften it (installments, a free tier, or price-locking the price-sensitive segment).`,
    );
  } else if (comparison && comparison.intentDelta > 0.05) {
    lines.push(
      isAr
        ? `- **توصية**: السيناريو أقوى من الأساس بنحو ${pct(comparison.intentDelta)} من نيّة الشراء — يمكن اعتماده مع مراقبة معدل الإلغاء.`
        : `- **Recommendation**: the scenario is about ${pct(comparison.intentDelta)} stronger on purchase intent than the baseline — adoptable, while monitoring the cancel rate.`,
    );
  } else if (comparison) {
    lines.push(
      isAr
        ? `- **توصية**: الفرق بين الأساس والسيناريو طفيف (${signed(comparison.intentDelta)})، لذا تبقى أدلة السرب غير حاسمة لهذه القيمة.`
        : `- **Recommendation**: the baseline/scenario difference is marginal (${signed(comparison.intentDelta)}), so the swarm evidence is not decisive for this value.`,
    );
  } else {
    lines.push(
      isAr
        ? `- **توصية**: لم يُحدَّد متغير للمقارنة؛ المحاكاة تقيس رد الفعل على الوضع الراهن فقط.`
        : `- **Recommendation**: no variable was supplied, so this run measures reaction to the status quo only.`,
    );
  }
  if (run.modelUnavailable) {
    lines.push(
      isAr
        ? `- **تحذير منهجي**: تعذّر الوصول إلى النموذج، لذا سُجّلت جميع الأدوار كأدوار متخطاة دون اختراع أي سلوك. أعد التشغيل مع نموذج متاح للحصول على مقاييس فعلية.`
        : `- **Methodology warning**: the model was unreachable, so every turn was recorded as skipped and no behaviour was invented. Re-run with a model available for real metrics.`,
    );
  }
  lines.push(
    isAr
      ? `- **إخلاء مسؤولية**: المحاكاة تقدير استكشافي مبني على ${personaCount} شخصية اصطناعية؛ ليست بحثاً سوقياً ولا ضماناً لسلوك العملاء الفعلي.`
      : `- **Disclaimer**: this simulation is an exploratory estimate built from ${personaCount} synthetic personas; it is not market research and not a guarantee of real customer behaviour.`,
  );
  lines.push("");
  lines.push(
    isAr
      ? `> الرسم المعرفي الزمني \`${graphId}\` | الإبلاغ \`${input.reportId}\` | سجل الأحداث \`${sim?.logPath ?? "(لم تبدأ)"}.\``
      : `> Temporal graph \`${graphId}\` | Report \`${input.reportId}\` | Event log \`${sim?.logPath ?? "(not started)"}.\``,
  );

  return lines.join("\n");
}

/** The chat reply shown to the user, in the language of their message. */
export function renderSwarmReply(input: {
  run: SwarmRun;
  message: string;
  isAr: boolean;
  location: { city: string | null; country: string | null; region: string | null };
  targetName: string;
  reportPath: string;
  reportId: string;
  graphId: string;
}): string {
  const { run, isAr, location, targetName, reportPath, reportId, graphId } = input;
  const sim = run.simulation;
  const comparison = run.comparison;
  const varText = comparison?.variable
    ? `${comparison.variable.name} ${String(comparison.variable.baseline)} -> ${String(comparison.variable.scenario)}`
    : null;
  const market = marketLabel(location, isAr);

  if (isAr) {
    const lines = [
      `تم تشغيل محاكاة **MiroFish (ذكاء السرب)** الحقيقية لتطبيق **${targetName}**:`,
      `- **1. البذر والسياق المحلي (M2)**: تم اشتقاق ${run.personaCount} شخصية من السوق *${market}* (العملة ${run.seedResult.locale.currency}، اللغات ${run.seedResult.locale.languages.join("، ")}).`,
      sim
        ? `- **2. محاكاة السرب (M3)**: ${sim.agents} وكلاء × ${sim.rounds} جولات = ${sim.modelCalls} استدعاء نموذج فعلي${sim.failures > 0 ? ` (${sim.failures} فشل سُجّل كتخطٍّ ولم يُخترع)` : ""}، مع مقاييس انتشار الرأي لكل جولة.`
        : `- **2. محاكاة السرب (M3)**: لم تبدأ المحاكاة لعدم توفر شخصيات.`,
      varText && comparison
        ? `- **3. مقارنة المتغير**: ${varText} — الفرق في نيّة الشراء ${signed(comparison.intentDelta)} وفي معدل الشراء ${signed(comparison.buyRateDelta)}.`
        : `- **3. المتغير**: لم يُحدَّد متغير للمقارنة في هذه الجولة.`,
      `- **4. التقرير**: \`${reportPath}\` (المعرّف \`${reportId}\`).`,
      `\n💬 **تابع معي**: *"لو رفعنا السعر 1400؟"*، *"قابل الوكلاء"*، أو *"لخّص النتائج"*.`,
    ];
    if (run.modelUnavailable) lines.push(`\n⚠️ **تنبيه**: لم يكن النموذج متاحاً هذه الجولة، لذا لا تحمل الأرقام أعلاه أي قياس فعلي.`);
    return lines.join("\n");
  }

  const lines = [
    `Ran a real **MiroFish swarm simulation** for **${targetName}**:`,
    `- **1. Seed & locale (M2)**: derived ${run.personaCount} personas for the *${market}* market (currency ${run.seedResult.locale.currency}, languages ${run.seedResult.locale.languages.join(", ")}).`,
    sim
      ? `- **2. Swarm simulation (M3)**: ${sim.agents} agents x ${sim.rounds} rounds = ${sim.modelCalls} real model calls${sim.failures > 0 ? ` (${sim.failures} failures logged as skips, nothing invented)` : ""}, with per-round opinion-spread metrics.`
      : `- **2. Swarm simulation (M3)**: the simulation did not start because no personas were available.`,
    varText && comparison
      ? `- **3. Variable comparison**: ${varText} — purchase intent delta ${signed(comparison.intentDelta)}, buy-rate delta ${signed(comparison.buyRateDelta)}.`
      : `- **3. Variable**: none supplied, so this run measures the status quo only.`,
    `- **4. Report**: \`${reportPath}\` (id \`${reportId}\`).`,
    `\n💬 **Continue in chat**: ask *"what if we raise the price to 1400?"*, *"interview the agents"*, or *"summarize the results"*!`,
  ];
  if (run.modelUnavailable) lines.push(`\n⚠️ **Note**: no model was reachable this round, so the numbers above are not a real measurement.`);
  return lines.join("\n");
}
