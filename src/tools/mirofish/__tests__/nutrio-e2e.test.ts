/**
 * M7 e2e gate for the MiroFish swarm simulation.
 *
 * Runs the full pipeline (seed -> simulate -> report) through the same
 * conversational entry point the `mirofish_chat` tool uses, with a deterministic
 * fake {@link ModelCaller} whose replies depend on prompt content, so price and
 * location genuinely change the outcome.
 *
 * The pipeline stages are not implemented yet on manus-parity. Rather than
 * failing (or using test.todo), each scenario is guarded by the single
 * {@link mirofishPipelineReady} capability check: when false the scenarios skip
 * and the suite prints which checks are pending. A later stage task flips its
 * capability flag and the matching assertions turn on automatically.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { mirofishPipelineReady, runMirofishChat } from "../pipeline.js";
import type {
  LocaleProfile,
  ModelCallInput,
  ModelCallOutput,
  ModelCaller,
  Persona,
  PipelineResult,
} from "../types.js";
import { NUTRIO_DOHA, NUTRIO_LONDON, NUTRIO_NO_LOCATION, withPrice } from "./fixtures/nutrio-briefs.js";
import type { NutrioBrief } from "./fixtures/nutrio-briefs.js";

const ready = mirofishPipelineReady();

const SCENARIO_NAMES = [
  "doha: report mentions Nutrio, keto, prices; personas use QAR + Arabic/Gulf",
  "price sensitivity: 1200 / 1450 / 99999 produce different metrics",
  "location: London uses GBP/English and differs from Doha; unset infers from brief",
  "static gate: no hard-coded result numbers / fake personas / folder scanning",
];

after(() => {
  if (ready) return;
  console.log(`\n[mirofish-e2e] ${SCENARIO_NAMES.length} scenario(s) pending until the swarm pipeline stages land:`);
  for (const name of SCENARIO_NAMES) console.log(`  - ${name}`);
});

// ---------------------------------------------------------------------------
// Deterministic fake model caller
// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Purchase intent implied by the active price; content-dependent on purpose. */
function intentForPrice(price: number): number {
  if (price <= 1300) return 0.78;
  if (price <= 1600) return 0.46;
  return 0.03;
}

/**
 * A model double that reads the prompt and answers with JSON for the matching
 * stage. The same brief with a different price or location produces different
 * output, which is what the e2e assertions rely on.
 */
class DeterministicFakeCaller implements ModelCaller {
  readonly calls: ModelCallInput[] = [];

  async chat(input: ModelCallInput): Promise<ModelCallOutput> {
    this.calls.push(input);
    const haystack = `${input.system}\n${input.prompt}`;
    return { content: this.respond(haystack, input.role), model: "deterministic-fake" };
  }

  /** Dispatch on prompt content, the way the other stage fakes do. */
  private respond(haystack: string, role?: ModelCallInput["role"]): string {
    if (/market-research analyst/.test(haystack)) return this.localeJson(haystack);
    if (/customer-persona designer/.test(haystack)) return this.personaJson(haystack);
    if (/swarm-simulation report writer/.test(haystack)) return this.reportJson(haystack);
    if (/role-playing ONE specific/.test(haystack)) return this.simulateJson(haystack);
    if (role === "report") return this.reportJson(haystack);
    return "{}";
  }

  private localeJson(prompt: string): string {
    const uk = /london|united kingdom|\buk\b|britain|gbp/i.test(prompt);
    const profile: LocaleProfile = uk
      ? {
          country: "United Kingdom",
          ...(/london/i.test(prompt) ? { city: "London" } : {}),
          region: "England",
          currency: "GBP",
          languages: ["en-GB"],
          dialect: "British English",
          incomeBands: [
            { label: "low", min: 0, max: 25000, currency: "GBP" },
            { label: "mid", min: 25000, max: 60000, currency: "GBP" },
            { label: "high", min: 60000, max: 200000, currency: "GBP" },
          ],
          demographics: ["Urban UK meal-subscription buyers evaluating a new keto plan."],
        }
      : {
          country: "Qatar",
          ...(/doha/i.test(prompt) ? { city: "Doha" } : {}),
          region: "Doha Governorate",
          currency: "QAR",
          languages: ["ar", "en"],
          dialect: "Gulf Arabic",
          incomeBands: [
            { label: "low", min: 0, max: 8000, currency: "QAR" },
            { label: "mid", min: 8000, max: 25000, currency: "QAR" },
            { label: "high", min: 25000, max: 80000, currency: "QAR" },
          ],
          demographics: ["Qatari and expatriate meal-subscription buyers in Doha."],
        };
    return JSON.stringify(profile);
  }

  private personaJson(prompt: string): string {
    const gbp = /GBP|United Kingdom|London|British/i.test(prompt);
    const currency = gbp ? "GBP" : "QAR";
    const country = gbp ? "United Kingdom" : "Qatar";
    const city = gbp ? "London" : "Doha";
    const dialect = gbp ? "British English" : "Gulf Arabic";
    const language = gbp ? "en" : "ar";
    const names = gbp
      ? ["Amelia Clarke", "Oliver Bennett", "Priya Shah", "Daniel Wright", "Sophie Turner", "Marcus Reid"]
      : ["Layla Hassan", "Omar Al-Thani", "Sara Khalil", "Khalid Mansour", "Noura Al-Kuwari", "Youssef Adel"];
    const personas: Persona[] = names.map((name, index) => ({
      id: `agent_${index + 1}`,
      name,
      bio: gbp
        ? `London professional weighing the Nutrio keto plan priced in ${currency}.`
        : `شخص مقيم في الدوحة يقيّم خطة كيتو من نتريو بسعر ${currency}.`,
      persona: gbp ? "pragmatic subscriber" : "مشترك عملي",
      age: 24 + index * 5,
      gender: index % 2 === 0 ? "female" : "male",
      nationality: gbp ? "British" : "Qatari",
      household: index % 2 === 0 ? "single" : "family with young children",
      incomeAmount: gbp ? 42000 : 18000,
      mbti: ["INTJ", "ENFP", "ISTJ", "ENTP", "ISFJ", "ESTP"][index] ?? "INTJ",
      country,
      city,
      occupation: gbp ? "Nutrition consultant" : "أخصائي تغذية",
      channel: gbp ? "Instagram" : "TikTok",
      attitude: gbp ? "pragmatic" : "مهتم",
      habits: gbp ? ["meal preps on Sundays"] : ["يحضر وجبات الأسبوع أحد"],
      profession: gbp ? "Nutrition consultant" : "أخصائي تغذية",
      interestedTopics: gbp ? ["keto meals", "subscriptions", "health"] : ["وجبات كيتو", "اشتراكات", "صحة"],
      currency,
      language,
      dialect,
      incomeBand: "mid",
    }));
    return JSON.stringify(personas);
  }

  private simulateJson(prompt: string): string {
    const price = this.activePrice(prompt);
    const intent = round2(intentForPrice(price));
    const roundMatch = prompt.match(/\bround\s*[:#]?\s*(\d+)/i);
    const agentMatch = prompt.match(/agent[_\s#-]?(\d+)/i);
    const event = {
      round: roundMatch?.[1] ? Number(roundMatch[1]) : 1,
      agentId: agentMatch?.[1] ? `agent_${Number(agentMatch[1])}` : "agent_1",
      action: /comment/i.test(prompt) ? "comment" : "post",
      text:
        intent > 0.6
          ? `At ${price} the Nutrio keto plan is worth it, subscribing.`
          : intent > 0.2
            ? `At ${price} I might try the Nutrio keto plan.`
            : `At ${price} the Nutrio keto plan is far too expensive.`,
      stance: round2((intent - 0.5) * 2),
      purchaseIntent: intent,
      sharedWith: [],
    };
    return JSON.stringify(event);
  }

  private reportJson(prompt: string): string {
    const active = this.activePrice(prompt);
    const intent = round2(intentForPrice(active));
    const prices = [...new Set([...prompt.matchAll(/\b(\d{3,6})\b/g)].map((m) => Number(m[1]!)))].sort(
      (a, b) => a - b,
    );
    const locale = /QAR|Qatar|Doha/i.test(prompt)
      ? "Qatar"
      : /GBP|United Kingdom|London/i.test(prompt)
        ? "the United Kingdom"
        : "the target market";
    const priceLine = prices.length > 0 ? `Price values considered: ${prices.join(", ")}.` : "";
    const markdown = [
      `# Nutrio keto plan swarm report (${locale})`,
      ``,
      `The swarm simulated the Nutrio (نتريو) meal subscription in ${locale}.`,
      `The new keto plan was evaluated at the active price of ${active}.`,
      priceLine,
      `Aggregate purchase intent: ${(intent * 100).toFixed(1)}%.`,
      ``,
      `> ${intent > 0.6 ? "At this price the keto plan is worth it." : "At this price the keto plan is questionable."}`,
    ].join("\n");
    return JSON.stringify({
      title: `Nutrio keto plan swarm report (${locale})`,
      markdown,
      summary: `Purchase intent ${(intent * 100).toFixed(1)}% at price ${active}.`,
      purchaseIntent: intent,
      meanStance: round2((intent - 0.5) * 2),
      rounds: 3,
      agents: 12,
      metrics: { purchaseIntent: intent, meanStance: round2((intent - 0.5) * 2) },
      quotes: [{ agentId: "agent_1", agentName: "agent_1", text: "The keto plan at this price is worth it." }],
      disclaimer: "Simulated personas; not real market data.",
    });
  }

  private activePrice(prompt: string): number {
    // Preferred sources: the settings JSON, then an explicit labeled variable.
    const settings = prompt.match(/"scenario"\s*:\s*(\d+(?:\.\d+)?)/);
    if (settings?.[1]) return Number(settings[1]);
    const labeled = prompt.match(/(?:Active|Scenario|Variable)\s+(?:price|value)?\s*[:=]\s*(\d+(?:\.\d+)?)/i);
    if (labeled?.[1]) return Number(labeled[1]);
    // Fallback: the last price-like number, which the simulate/report prompt
    // appends after the brief.
    const all = [...prompt.matchAll(/\b(\d{3,6})\b/g)].map((m) => Number(m[1]!));
    return all.length > 0 ? all[all.length - 1]! : 1200;
  }
}

// ---------------------------------------------------------------------------
// Static gate: the pipeline sources must not hard-code simulation results
// ---------------------------------------------------------------------------

const STATIC_PATTERNS: Array<{ id: string; re: RegExp }> = [
  {
    id: "hard-coded persona type",
    re: /\bname:\s*["'](?:EndUser|PowerUser|Developer|SecurityAuditor|ProductManager|DevOpsEngineer|SoftwarePlatform|MarketAnalyst)["']/,
  },
  { id: "hard-coded percentage", re: /\d+(?:\.\d+)?\s*%/ },
  { id: "folder scanning", re: /readdirSync\s*\(/ },
  { id: "hard-coded result key", re: /approval_rate_(?:before|after)/ },
];

function scanMirofishSources(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pipelineDir = path.resolve(here, "..");
  const toolsDir = path.resolve(here, "..", "..");
  const targets: string[] = [];
  const legacy = path.join(toolsDir, "mirofish.ts");
  if (fs.existsSync(legacy)) targets.push(legacy);
  if (fs.existsSync(pipelineDir)) {
    for (const entry of fs.readdirSync(pipelineDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.includes(".test.")) continue;
      targets.push(path.join(pipelineDir, entry.name));
    }
  }
  const findings: string[] = [];
  for (const file of targets) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
    for (const { id, re } of STATIC_PATTERNS) {
      const match = text.match(re);
      if (match) findings.push(`${rel}: ${id} (${JSON.stringify(match[0])})`);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirofish-e2e-"));

async function runNutrio(brief: NutrioBrief, caller: ModelCaller = new DeterministicFakeCaller()): Promise<PipelineResult> {
  return runMirofishChat({
    workspace: path.join(workspaceRoot, brief.label),
    message: brief.settings.brief,
    settings: brief.settings,
    caller,
  });
}

describe("nutrio e2e gate", () => {
  it("doha: report mentions Nutrio, keto, prices; personas use QAR + Arabic/Gulf", { skip: !ready }, async () => {
    const result = await runNutrio(NUTRIO_DOHA);
    const text = `${result.report.title}\n${result.report.markdown}\n${result.report.summary}`;
    assert.match(text, /nutrio/i, "report must mention Nutrio");
    assert.match(text, /كيتو|keto/i, "report must mention the keto plan");
    assert.match(text, /1,?200/, "report must include the 1200 baseline price");
    assert.match(text, /1,?450/, "report must include the 1450 scenario price");
    assert.equal(result.locale.currency, "QAR", "locale currency must be QAR");
    assert.match(result.locale.dialect ?? "", /gulf|arabic|qatar/i, "dialect must be Gulf/Arabic");
    assert.ok(result.personas.length > 0, "expected at least one persona");
    for (const persona of result.personas) {
      assert.equal(persona.currency, "QAR", `persona ${persona.name} must use QAR`);
    }
    const arabic = result.personas.some((p) => /[\u0600-\u06FF]/.test(`${p.name} ${p.bio} ${p.dialect}`));
    assert.ok(arabic, "at least one persona must use Arabic");
  });

  it("price sensitivity: 1200 / 1450 / 99999 produce different metrics", { skip: !ready }, async () => {
    const at1200 = await runNutrio(withPrice(NUTRIO_DOHA, 1200));
    const at1450 = await runNutrio(withPrice(NUTRIO_DOHA, 1450));
    const at99999 = await runNutrio(withPrice(NUTRIO_DOHA, 99999));
    const intents = [
      at1200.report.purchaseIntent,
      at1450.report.purchaseIntent,
      at99999.report.purchaseIntent,
    ];
    assert.equal(new Set(intents).size, 3, `purchase intent must differ by price, got ${JSON.stringify(intents)}`);
    assert.ok(intents[0]! > intents[1]!, "the lower price must raise purchase intent");
    assert.ok(intents[1]! > intents[2]!, "a far higher price must collapse purchase intent");
    assert.notEqual(at1200.report.markdown, at99999.report.markdown, "report text must differ by price");
  });

  it("location: London uses GBP/English and differs from Doha; unset infers from brief", { skip: !ready }, async () => {
    const doha = await runNutrio(NUTRIO_DOHA);
    const london = await runNutrio(NUTRIO_LONDON);
    assert.equal(london.locale.currency, "GBP", "London locale currency must be GBP");
    assert.match(london.locale.dialect ?? "", /english|british|uk/i, "London dialect must be British English");
    assert.ok(london.personas.length > 0, "expected at least one persona");
    for (const persona of london.personas) {
      assert.equal(persona.currency, "GBP", `persona ${persona.name} must use GBP`);
    }
    assert.notEqual(doha.locale.currency, london.locale.currency, "locale currency must follow location");
    assert.notEqual(doha.report.markdown, london.report.markdown, "report must differ by location");

    const inferred = await runNutrio(NUTRIO_NO_LOCATION);
    assert.match(inferred.locale.country, /qatar/i, "unset location must infer Qatar from the Nutrio brief");
    assert.equal(inferred.locale.currency, "QAR", "inferred locale currency must be QAR");
  });

  it("static gate: no hard-coded result numbers / fake personas / folder scanning", { skip: !ready }, () => {
    const findings = scanMirofishSources();
    assert.deepEqual(
      findings,
      [],
      `mirofish sources must not contain hard-coded simulation results:\n${findings.join("\n")}`,
    );
  });
});
