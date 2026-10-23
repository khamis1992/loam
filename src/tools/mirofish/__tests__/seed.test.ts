/**
 * Tests for the MiroFish M2 seed step (locale resolution, entity extraction,
 * persona generation).
 *
 * Guarantees under test:
 *  - a user-selected location is authoritative (Doha/QAR/Arabic and London/GBP/English)
 *  - when no location is set the locale is inferred from the brief/docs
 *  - a missing/failing model degrades to a neutral rule-based fallback
 *  - entities and personas come from the model when available and fall back otherwise
 *  - persona generation batches its calls and never exceeds the concurrency cap (2)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { ModelCaller, ModelRequest, ModelResponse } from "../model.js";
import { resolveLocale } from "../locale.js";
import { extractEntities, generatePersonas, loadSeedDocs, runSeed, ruleBasedPersonas } from "../seed.js";
import type { EntitySet, LocaleProfile, SimulationSettings } from "../types.js";

interface FakeState {
  calls: ModelRequest[];
  inFlight: number;
  maxInFlight: number;
  fail: boolean;
}

/** Deterministic model double: dispatches canned JSON by prompt topic. */
function makeFakeCaller(responder: (req: ModelRequest) => string, state: FakeState = { calls: [], inFlight: 0, maxInFlight: 0, fail: false }): ModelCaller {
  return {
    async chat(req: ModelRequest): Promise<ModelResponse> {
      state.calls.push(req);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.fail) throw new Error("model unavailable");
        return { content: responder(req), model: "fake-model" };
      } finally {
        state.inFlight -= 1;
      }
    },
  };
}

function localeJson(req: ModelRequest): string {
  const p = req.prompt;
  if (p.includes("Doha")) {
    return JSON.stringify({
      country: "Qatar",
      city: "Doha",
      region: "",
      currency: "QAR",
      languages: ["ar-QA", "en"],
      dialect: "Gulf Arabic",
      incomeBands: [
        { label: "low", min: 4000, max: 9000, currency: "QAR" },
        { label: "middle", min: 9000, max: 22000, currency: "QAR" },
        { label: "affluent", min: 22000, currency: "QAR" },
      ],
      demographics: ["large expatriate population", "high smartphone penetration"],
      timezone: "Asia/Qatar",
    });
  }
  if (p.includes("London")) {
    return JSON.stringify({
      country: "United Kingdom",
      city: "London",
      region: "England",
      currency: "GBP",
      languages: ["en-GB", "en"],
      dialect: "British English",
      incomeBands: [
        { label: "low", min: 1500, max: 2500, currency: "GBP" },
        { label: "middle", min: 2500, max: 5000, currency: "GBP" },
        { label: "affluent", min: 5000, currency: "GBP" },
      ],
      demographics: ["high cost of living", "diverse international population"],
      timezone: "Europe/London",
    });
  }
  return JSON.stringify({
    country: "Germany",
    city: "Berlin",
    region: "",
    currency: "EUR",
    languages: ["de-DE", "en"],
    dialect: "Standard German",
    incomeBands: [{ label: "middle", min: 2000, currency: "EUR" }],
    demographics: ["strong freelance economy"],
    timezone: "Europe/Berlin",
  });
}

function entitiesJson(): string {
  return JSON.stringify({
    products: [{ name: "Nutrio", kind: "service", detail: "meal-planning subscription" }],
    prices: [{ product: "Nutrio", amount: 1200, currency: "QAR", period: "month" }],
    competitors: [{ name: "MealPrep Co", kind: "competitor" }],
    audiences: ["busy professionals", "fitness enthusiasts"],
    variable: { name: "price", baseline: 1200, scenario: 1450, unit: "QAR / month" },
    summary: "A meal-planning subscription for health-conscious professionals.",
  });
}

function personasJson(req: ModelRequest, batch: number): string {
  const count = Number((req.prompt.match(/EXACTLY (\d+)/) ?? [])[1] ?? 2);
  const names = ["Layla Haddad", "James Whitfield", "Omar Al-Mansoori", "Priya Sharma", "Tom Becker", "Sara Ali", "Elena Rossi", "Daniel Cole", "Mona Saleh", "Ahmed Khan", "Grace Lee", "Yusuf Nazir"];
  const out = [];
  for (let i = 0; i < count; i++) {
    const index = batch * count + i;
    out.push({
      id: `persona_${index}`,
      name: names[index % names.length],
      age: 24 + i * 3,
      gender: i % 2 === 0 ? "female" : "male",
      nationality: "Qatari",
      country: "Qatar",
      city: "Doha",
      incomeBand: "middle",
      incomeAmount: 15000,
      currency: "QAR",
      household: "family with young children",
      occupation: "accountant",
      channel: "Instagram",
      attitude: "curious",
      habits: ["compares prices before buying"],
      language: "ar-QA",
      dialect: "Gulf Arabic",
      bio: "A local professional exploring meal plans.",
    });
  }
  return JSON.stringify(out);
}

function makeSeedResponder(): (req: ModelRequest) => string {
  let personaBatch = 0;
  return (req: ModelRequest): string => {
    const p = req.prompt;
    if (p.includes("market-research analyst")) return localeJson(req);
    if (p.includes("market-analysis engine")) return entitiesJson();
    if (p.includes("customer-persona designer")) return personasJson(req, personaBatch++);
    return "{}";
  };
}

const DOHA_SETTINGS: SimulationSettings = {
  brief: "A meal-planning subscription for busy professionals in Doha.",
  location: { country: "Qatar", city: "Doha" },
  agents: 8,
  rounds: 3,
};

const LONDON_SETTINGS: SimulationSettings = {
  brief: "A budgeting app for freelancers in London.",
  location: { country: "United Kingdom", city: "London" },
  agents: 8,
  rounds: 3,
};

describe("resolveLocale", () => {
  it("keeps a user-selected Doha location authoritative (QAR / Arabic)", async () => {
    const state: FakeState = { calls: [], inFlight: 0, maxInFlight: 0, fail: false };
    const { locale, source } = await resolveLocale(DOHA_SETTINGS.location, DOHA_SETTINGS.brief, undefined, { caller: makeFakeCaller(localeJson, state) });
    assert.equal(source, "user");
    assert.equal(locale.country, "Qatar");
    assert.equal(locale.city, "Doha");
    assert.equal(locale.currency, "QAR");
    assert.ok(locale.languages.includes("ar-QA"), `expected Arabic in ${locale.languages.join(",")}`);
    assert.ok(locale.incomeBands.length > 0);
    for (const band of locale.incomeBands) assert.equal(band.currency, "QAR");
  });

  it("keeps a user-selected London location authoritative (GBP / English)", async () => {
    const { locale, source } = await resolveLocale(LONDON_SETTINGS.location, LONDON_SETTINGS.brief, undefined, { caller: makeFakeCaller(localeJson) });
    assert.equal(source, "user");
    assert.equal(locale.country, "United Kingdom");
    assert.equal(locale.city, "London");
    assert.equal(locale.currency, "GBP");
    assert.ok(locale.languages.some((l) => l.startsWith("en")));
    for (const band of locale.incomeBands) assert.equal(band.currency, "GBP");
  });

  it("infers the locale from the brief when no location is set", async () => {
    const { locale, source } = await resolveLocale(undefined, "A fintech for freelancers in Berlin.", undefined, { caller: makeFakeCaller(localeJson) });
    assert.equal(source, "inferred");
    assert.equal(locale.country, "Germany");
    assert.equal(locale.city, "Berlin");
    assert.equal(locale.currency, "EUR");
  });

  it("degrades to a neutral fallback when no caller is supplied", async () => {
    const { locale, source } = await resolveLocale({ country: "Qatar", city: "Doha" }, "any brief");
    assert.equal(source, "fallback");
    assert.equal(locale.country, "Qatar");
    assert.equal(locale.city, "Doha");
  });

  it("falls back when the model fails", async () => {
    const { locale, source } = await resolveLocale(undefined, "any brief", undefined, { caller: makeFakeCaller(localeJson, { calls: [], inFlight: 0, maxInFlight: 0, fail: true }) });
    assert.equal(source, "fallback");
    assert.equal(locale.country, "Global");
  });
});

describe("loadSeedDocs", () => {
  it("extracts text from an uploaded markdown document", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirofish-docs-"));
    const doc = path.join(dir, "brief.md");
    fs.writeFileSync(doc, "# Nutrio\nMeal plans at 1200 QAR per month for busy professionals.", "utf8");
    try {
      const text = await loadSeedDocs([doc], dir);
      assert.match(text, /Nutrio/);
      assert.match(text, /1200 QAR/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips unreadable documents instead of failing the seed", async () => {
    const text = await loadSeedDocs(["/nonexistent/mirofish/missing.md"]);
    assert.equal(text, "");
  });
});

describe("extractEntities", () => {
  it("extracts products, prices, competitors, audiences and the variable", async () => {
    const { entities, source } = await extractEntities("Nutrio meal plans at QAR 1200/month rising to 1450.", undefined, { caller: makeFakeCaller(entitiesJson) });
    assert.equal(source, "model");
    assert.equal(entities.products[0]?.name, "Nutrio");
    assert.equal(entities.prices[0]?.amount, 1200);
    assert.equal(entities.prices[0]?.currency, "QAR");
    assert.equal(entities.competitors[0]?.name, "MealPrep Co");
    assert.ok(entities.audiences.includes("busy professionals"));
    assert.equal(entities.variable?.name, "price");
    assert.equal(entities.variable?.scenario, 1450);
  });

  it("uses the rule-based fallback when no caller is supplied", async () => {
    const { entities, source } = await extractEntities("Nutrio is a service called Nutrio at 1200 QAR per month.", undefined);
    assert.equal(source, "fallback");
    assert.ok(entities.products.length >= 1);
    assert.ok(entities.prices.length >= 1);
  });
});

describe("generatePersonas", () => {
  it("generates the requested number of personas within the concurrency cap", async () => {
    const locale: LocaleProfile = {
      country: "Qatar",
      city: "Doha",
      currency: "QAR",
      languages: ["ar-QA", "en"],
      incomeBands: [{ label: "middle", min: 9000, max: 22000, currency: "QAR" }],
      demographics: [],
    };
    const entities: EntitySet = { products: [{ name: "Nutrio" }], prices: [], competitors: [], audiences: [] };
    const state: FakeState = { calls: [], inFlight: 0, maxInFlight: 0, fail: false };
    const { personas, source } = await generatePersonas(8, locale, entities, { caller: makeFakeCaller(makeSeedResponder(), state), concurrency: 2 });
    assert.equal(source, "model");
    assert.equal(personas.length, 8);
    assert.ok(state.maxInFlight <= 2, `max in flight ${state.maxInFlight} exceeded cap 2`);
    assert.equal(state.calls.length, 2, "8 personas should be two batches of 4");
  });

  it("falls back to rule-based personas when the model fails", async () => {
    const locale: LocaleProfile = { country: "Qatar", currency: "QAR", languages: ["ar-QA"], incomeBands: [{ label: "middle", min: 9000, currency: "QAR" }], demographics: [] };
    const entities: EntitySet = { products: [], prices: [], competitors: [], audiences: [] };
    const { personas, source } = await generatePersonas(3, locale, entities, { caller: makeFakeCaller(makeSeedResponder(), { calls: [], inFlight: 0, maxInFlight: 0, fail: true }) });
    assert.equal(source, "fallback");
    assert.equal(personas.length, 3);
  });
});

describe("runSeed", () => {
  it("runs the full seed pipeline for a Doha brief and reports real model usage", async () => {
    const state: FakeState = { calls: [], inFlight: 0, maxInFlight: 0, fail: false };
    const result = await runSeed(DOHA_SETTINGS, { caller: makeFakeCaller(makeSeedResponder(), state) });
    assert.equal(result.localeSource, "user");
    assert.equal(result.locale.country, "Qatar");
    assert.equal(result.locale.currency, "QAR");
    assert.equal(result.entities.products[0]?.name, "Nutrio");
    assert.equal(result.personas.length, 8);
    assert.equal(result.modelCalls, state.calls.length);
    assert.ok(result.modelCalls >= 4, `expected locale+entities+2 persona calls, got ${result.modelCalls}`);
  });

  it("works without a model caller (fully rule-based)", async () => {
    const result = await runSeed(DOHA_SETTINGS, {});
    assert.equal(result.localeSource, "fallback");
    assert.equal(result.personas.length, 8);
    assert.equal(result.modelCalls, 0);
    assert.equal(ruleBasedPersonas(2, result.locale, result.entities).length, 2);
  });
});
