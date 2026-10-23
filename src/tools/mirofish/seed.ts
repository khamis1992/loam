/**
 * MiroFish seed step (M2): documents -> locale -> entities -> personas.
 *
 * Everything derives from the user's brief/docs and an optional user-selected
 * location. The heavy lifting is delegated to the model through {@link ModelCaller};
 * when the model is unavailable, deterministic rule-based fallbacks keep the
 * pipeline usable. No country, currency or language is hard-coded here.
 */
import fs from "node:fs";
import path from "node:path";
import { extractAnyDocumentText } from "../attachments.js";
import { resolveRead } from "../../policy/paths.js";
import {
  askJson,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  createRng,
  mapWithConcurrency,
  type ModelCaller,
} from "./model.js";
import { resolveLocale } from "./locale.js";
import type {
  EntitySet,
  EntityRef,
  Persona,
  PricePoint,
  SeedResult,
  SimulationSettings,
  SimulationVariable,
} from "./types.js";

/** Personas requested per model call. */
export const PERSONA_BATCH_SIZE = 4;
/** Default concurrency for model calls (RAM light). */
export const DEFAULT_CONCURRENCY = 2;

const MAX_DOC_CHARS = 60_000;

/**
 * Load and extract text from uploaded documents (text/markdown/pdf/office).
 * Unreadable or unsupported files are skipped rather than failing the seed.
 */
export async function loadSeedDocs(docs: string[], workspace?: string): Promise<string> {
  const parts: string[] = [];
  for (const doc of docs ?? []) {
    const raw = doc?.trim();
    if (!raw) continue;
    let abs = raw;
    try {
      abs = resolveRead(workspace ?? process.cwd(), raw, false);
    } catch {
      abs = path.isAbsolute(raw) ? raw : path.resolve(workspace ?? process.cwd(), raw);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    try {
      const text = (await extractAnyDocumentText(abs)).slice(0, MAX_DOC_CHARS).trim();
      if (text) parts.push(`### ${path.basename(abs)}\n${text}`);
    } catch {
      /* skip unreadable document */
    }
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateEntitySet(value: unknown): EntitySet {
  const rec = asRecord(value);
  if (!rec) throw new Error("entities: expected a JSON object");

  const products: EntityRef[] = [];
  for (const item of asRecordArray(rec.products ?? rec.product)) {
    const name = asString(item.name ?? item.product);
    if (!name) continue;
    const kind = asString(item.kind);
    const detail = asString(item.detail);
    products.push({ name, ...(kind ? { kind } : {}), ...(detail ? { detail } : {}) });
  }

  const competitors: EntityRef[] = [];
  for (const item of asRecordArray(rec.competitors ?? rec.competitor)) {
    const name = asString(item.name ?? item.competitor);
    if (!name) continue;
    const kind = asString(item.kind);
    const detail = asString(item.detail);
    competitors.push({ name, ...(kind ? { kind } : {}), ...(detail ? { detail } : {}) });
  }

  const prices: PricePoint[] = [];
  for (const item of asRecordArray(rec.prices ?? rec.price_points)) {
    const priceRec = asRecord(item);
    if (!priceRec) continue;
    const amount = asNumber(priceRec.amount ?? priceRec.price ?? priceRec.value);
    if (amount === null) continue;
    const product = asString(priceRec.product);
    const currency = asString(priceRec.currency);
    const period = asString(priceRec.period);
    prices.push({
      ...(product ? { product } : {}),
      amount,
      currency: (currency ?? "USD").toUpperCase(),
      ...(period ? { period } : {}),
    });
  }

  const audiences = asStringArray(rec.audiences ?? rec.audience, 30);
  const summary = asString(rec.summary);

  let variable: SimulationVariable | undefined;
  const varRec = asRecord(rec.variable ?? rec.variation);
  if (varRec) {
    const name = asString(varRec.name ?? varRec.variable);
    if (name) {
      const baseline = asNumber(varRec.baseline) ?? asString(varRec.baseline);
      const scenario = asNumber(varRec.scenario ?? varRec.target) ?? asString(varRec.scenario ?? varRec.target);
      variable = {
        name,
        ...(baseline !== null ? { baseline } : {}),
        ...(scenario !== null ? { scenario } : {}),
        ...(asString(varRec.unit) ? { unit: varRec.unit! } : {}),
      } as SimulationVariable;
    }
  }

  return {
    products,
    prices,
    competitors,
    audiences,
    ...(variable ? { variable } : {}),
    ...(summary ? { summary } : {}),
  };
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (rec) out.push(rec);
  }
  return out;
}

/** Validate + normalize a model-produced persona list. */
export function validatePersonas(value: unknown): Persona[] {
  const list = Array.isArray(value) ? value : asRecord(value) ? (value as Record<string, unknown>).personas : null;
  const arr = Array.isArray(list) ? list : [];
  const out: Persona[] = [];
  for (const item of arr) {
    const rec = asRecord(item);
    if (!rec) continue;
    const name = asString(rec.name ?? rec.full_name);
    if (!name) continue;
    const incomeBand = asString(rec.incomeBand ?? rec.income_band ?? rec.income) ?? "middle";
    const currency = (asString(rec.currency) ?? "USD").toUpperCase();
    const city = asString(rec.city);
    const diet = asString(rec.diet);
    const dialect = asString(rec.dialect);
    out.push({
      id: asString(rec.id) ?? `persona_${out.length}`,
      name,
      age: asNumber(rec.age) ?? 30,
      gender: asString(rec.gender) ?? "unspecified",
      nationality: asString(rec.nationality) ?? asString(rec.country) ?? "Global",
      country: asString(rec.country) ?? "Global",
      ...(city ? { city } : {}),
      incomeBand,
      incomeAmount: asNumber(rec.incomeAmount ?? rec.income_amount) ?? 0,
      currency,
      household: asString(rec.household) ?? "single",
      occupation: asString(rec.occupation ?? rec.profession) ?? "professional",
      channel: asString(rec.channel ?? rec.primary_channel) ?? "social media",
      attitude: asString(rec.attitude ?? rec.stance) ?? "neutral",
      habits: asStringArray(rec.habits, 10),
      ...(diet ? { diet } : {}),
      language: asString(rec.language) ?? "en",
      ...(dialect ? { dialect } : {}),
      bio: asString(rec.bio ?? rec.biography ?? rec.persona) ?? name,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule-based fallbacks
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  "﷼": "SAR",
  "د.إ": "AED",
  "ر.ق": "QAR",
  "د.ك": "KWD",
  "ر.س": "SAR",
  "ر.ع": "OMR",
  "د.ب": "BHD",
  "ر.ي": "YER",
  "ج.م": "EGP",
  "د.ج": "DZD",
  "د.م": "MAD",
  "د.ت": "TND",
};

function detectCurrency(text: string, fallback: string): string {
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) return code;
  }
  return fallback;
}

/** Keyword-based entity extraction used only when the model is unavailable. */
export function ruleBasedEntities(brief: string, docText: string, localeCurrency = "USD"): EntitySet {
  const text = `${brief}\n${docText}`;
  const prices: PricePoint[] = [];
  const priceRe = /([$€£¥﷼د.إر.قد.كر.سر.عد.بр.يج.مд.جд.мд.т])\s*([\d][\d,]*(?:\.\d+)?)|([\d][\d,]*(?:\.\d+)?)\s*([A-Z]{3})/g;
  for (const m of text.matchAll(priceRe)) {
    const symbol = m[1];
    const amount = m[2] ?? m[3];
    const code = m[4];
    const n = Number(String(amount).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    prices.push({ amount: n, currency: code ?? (symbol ? CURRENCY_SYMBOLS[symbol] ?? detectCurrency(text, localeCurrency) : localeCurrency) });
    if (prices.length >= 20) break;
  }

  const products: EntityRef[] = [];
  const productRe = /(?:app|application|product|service|platform|plan|tier)\s+(?:called|named)?\s*["'“]?([A-Z][A-Za-z0-9.-]{2,})/g;
  for (const m of text.matchAll(productRe)) {
    const found = m[1];
    if (found && !products.some((p) => p.name === found)) products.push({ name: found, kind: "product" });
    if (products.length >= 10) break;
  }

  const audiences = [...new Set((text.match(/\b(?:students|professionals|parents|families|freelancers|developers|businesses|travelers|gamers|creators|small businesses|enterprises|teenagers|seniors)\b/gi) ?? []).map((s) => s.toLowerCase()))].slice(0, 10);

  return {
    products,
    prices,
    competitors: [],
    audiences,
    summary: brief.slice(0, 400),
  };
}

const NEUTRAL_FIRST_NAMES = [
  "Amara", "Yusuf", "Layla", "Omar", "Nadia", "Karim", "Sofia", "Daniel", "Maya", "Elias",
  "Ines", "Tariq", "Hana", "Ravi", "Zara", "Noor", "Adam", "Leila", "Samir", "Aisha",
  "Marcus", "Elena", "Farid", "Dana", "Khalid", "Rina", "Hassan", "Mira", "Bilal", "Sana",
];

const NEUTRAL_OCCUPATIONS = ["software engineer", "teacher", "nurse", "small-business owner", "student", "accountant", "freelance designer", "retail manager", "driver", "marketing specialist"];
const NEUTRAL_CHANNELS = ["Instagram", "X (Twitter)", "TikTok", "YouTube", "Facebook", "word of mouth", "search", "app store"];
const NEUTRAL_ATTITUDES = ["enthusiastic", "cautious", "price-sensitive", "quality-focused", "skeptical", "loyal", "curious", "indifferent"];
const NEUTRAL_HOUSEHOLDS = ["single", "couple", "family with young children", "shared flat", "multigenerational household", "family with teenagers"];
const NEUTRAL_HABITS = ["checks phone first thing in the morning", "compares prices before buying", "reads reviews", "follows influencers", "shops in person on weekends", "uses cash more than cards", "subscribes to several services", "tries free tiers first"];

/** Deterministic persona fallback consistent with the locale's bands/language. */
export function ruleBasedPersonas(n: number, locale: { country: string; city?: string; currency: string; languages: string[]; incomeBands: Array<{ label: string; min: number; max?: number; currency: string }> }, entities: EntitySet, seed = 1): Persona[] {
  const rng = createRng(seed);
  const bands = locale.incomeBands.length > 0 ? locale.incomeBands : [{ label: "middle", min: 0, currency: locale.currency }];
  const primaryLang = locale.languages[0] ?? "en";
  const product = entities.products[0]?.name ?? entities.summary?.slice(0, 40) ?? "the product";
  const out: Persona[] = [];
  for (let i = 0; i < n; i++) {
    const band = bands[i % bands.length]!;
    const bandMax = band.max ?? band.min * 2;
    const income = Math.round(band.min + rng() * Math.max(1, bandMax - band.min));
    const name = NEUTRAL_FIRST_NAMES[Math.floor(rng() * NEUTRAL_FIRST_NAMES.length)]!;
    const household = NEUTRAL_HOUSEHOLDS[Math.floor(rng() * NEUTRAL_HOUSEHOLDS.length)]!;
    const occupation = NEUTRAL_OCCUPATIONS[Math.floor(rng() * NEUTRAL_OCCUPATIONS.length)]!;
    const channel = NEUTRAL_CHANNELS[Math.floor(rng() * NEUTRAL_CHANNELS.length)]!;
    const attitude = NEUTRAL_ATTITUDES[Math.floor(rng() * NEUTRAL_ATTITUDES.length)]!;
    const habit = NEUTRAL_HABITS[Math.floor(rng() * NEUTRAL_HABITS.length)]!;
    out.push({
      id: `persona_${i}`,
      name,
      age: 18 + Math.floor(rng() * 55),
      gender: rng() < 0.5 ? "female" : "male",
      nationality: locale.country,
      country: locale.country,
      ...(locale.city ? { city: locale.city } : {}),
      incomeBand: band.label,
      incomeAmount: income,
      currency: band.currency || locale.currency,
      household,
      occupation,
      channel,
      attitude,
      habits: [habit],
      language: primaryLang,
      bio: `${name} is a ${occupation} in ${locale.city ?? locale.country} considering ${product}.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model-driven extraction / generation
// ---------------------------------------------------------------------------

function entitiesPrompt(context: string, language?: string): string {
  return [
    "You are a market-analysis engine extracting structured facts for a customer-simulation.",
    "Read the product brief and any documents, then return ONE JSON object with this exact shape:",
    "{",
    '  "products": [{"name":"...","kind":"product|service|plan","detail":"short note"}],',
    '  "prices": [{"product":"...","amount":1200,"currency":"ISO","period":"month|year|one-time"}],',
    '  "competitors": [{"name":"...","kind":"competitor","detail":"short note"}],',
    '  "audiences": ["segment 1","segment 2"],',
    '  "variable": {"name":"price","baseline":1200,"scenario":1450,"unit":"QAR / month"},',
    '  "summary": "one neutral paragraph describing the product and market"',
    "}",
    "",
    "Rules:",
    "- Extract only facts supported by the brief/documents; do not invent competitors.",
    "- `prices` must use real numeric amounts and an ISO 4217 currency code found in the text.",
    "- `variable` is the single most important thing the user wants to vary (price, fee, plan). Use null if none is stated.",
    "- Keep `audiences` to concrete, distinct customer segments.",
    "- Respond with JSON only, no prose, no code fence.",
    language && language !== "auto" ? `- Prefer ${language} for labels and the summary.` : "",
    "",
    "--- INPUT ---",
    context || "(no brief provided)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function personasPrompt(count: number, locale: { country: string; city?: string; currency: string; languages: string[]; dialect?: string; incomeBands: Array<{ label: string; min: number; max?: number; currency: string }>; demographics: string[] }, entities: EntitySet, seed: number): string {
  const bands = locale.incomeBands
    .map((b) => `${b.label}: ${b.min}${b.max ? `-${b.max}` : "+"} ${b.currency}`)
    .join("; ");
  return [
    "You are a customer-persona designer for a realistic market simulation.",
    `Create EXACTLY ${count} diverse, believable customer personas for the target market below. Return a JSON array of ${count} objects.`,
    "",
    "Each object must have this exact shape:",
    "{",
    '  "name": "real local first and last name",',
    '  "age": 28,',
    '  "gender": "female|male|non-binary|unspecified",',
    '  "nationality": "nationality realistic for the place",',
    '  "country": "country",',
    '  "city": "city or empty string",',
    '  "incomeBand": "one of the locale income-band labels",',
    '  "incomeAmount": 4200,',
    '  "currency": "ISO code",',
    '  "household": "e.g. single, couple, family with young children",',
    '  "occupation": "realistic local profession",',
    '  "channel": "primary channel (social platform, search, word of mouth, ...)",',
    '  "attitude": "baseline attitude toward the product category",',
    '  "habits": ["everyday habit 1","everyday habit 2"],',
    '  "diet": "diet/consumption preference or empty string",',
    '  "language": "primary language tag",',
    '  "dialect": "dialect or empty string",',
    '  "bio": "two-sentence first-person bio grounded in the locale"',
    "}",
    "",
    "Locale facts (use these exactly; do not invent a different place):",
    `- Country: ${locale.country}${locale.city ? ` | City: ${locale.city}` : ""}`,
    `- Currency: ${locale.currency}`,
    `- Languages: ${locale.languages.join(", ")}${locale.dialect ? ` | Dialect: ${locale.dialect}` : ""}`,
    `- Income bands (monthly, local currency): ${bands || "unspecified"}`,
    locale.demographics.length > 0 ? `- Demographics: ${locale.demographics.join("; ")}` : "",
    "",
    "Target context:",
    `- Products: ${entities.products.map((p) => p.name).join(", ") || "unspecified"}`,
    `- Prices: ${entities.prices.map((p) => `${p.amount} ${p.currency}`).join(", ") || "unspecified"}`,
    `- Competitors: ${entities.competitors.map((c) => c.name).join(", ") || "unspecified"}`,
    `- Audiences: ${entities.audiences.join(", ") || "unspecified"}`,
    entities.variable ? `- Variable to explore: ${entities.variable.name} (${String(entities.variable.baseline)} -> ${String(entities.variable.scenario)})` : "",
    "",
    "Rules:",
    "- Names must be culturally realistic for the locale and varied (different backgrounds, ages, genders).",
    "- IncomeAmount must fall inside the persona's income band and use the locale currency.",
    "- Each persona must be distinct; avoid duplicates.",
    `- Deterministic variation seed for this batch: ${seed}.`,
    "- Respond with a JSON array only, no prose, no code fence.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export interface SeedOptions {
  caller?: ModelCaller;
  workspace?: string;
  concurrency?: number;
  docText?: string;
  language?: string;
}

/** Extract products/prices/competitors/audiences/variable from brief + docs. */
export async function extractEntities(
  brief: string,
  docs: string[] | undefined,
  opts: SeedOptions = {},
  localeCurrencyHint?: string,
): Promise<{ entities: EntitySet; source: "model" | "fallback" }> {
  let docText = opts.docText ?? "";
  if (!docText && docs && docs.length > 0) {
    try {
      docText = await loadSeedDocs(docs, opts.workspace);
    } catch {
      docText = "";
    }
  }
  const context = [brief.trim(), docText.trim()].filter((s) => s.length > 0).join("\n\n--- DOCUMENTS ---\n\n");

  if (opts.caller) {
    try {
      const entities = await askJson<EntitySet>(opts.caller, {
        system: "You are a precise market-analysis engine. Return strictly valid JSON matching the requested shape.",
        prompt: entitiesPrompt(context, opts.language),
        temperature: 0.2,
        validate: validateEntitySet,
      });
      return { entities, source: "model" };
    } catch {
      /* fall through to the rule-based fallback */
    }
  }

  return { entities: ruleBasedEntities(brief, docText, localeCurrencyHint), source: "fallback" };
}

/** Generate `n` diverse personas consistent with the locale, batched with concurrency 2. */
export async function generatePersonas(
  n: number,
  locale: SeedResult["locale"],
  entities: EntitySet,
  opts: SeedOptions = {},
): Promise<{ personas: Persona[]; source: "model" | "fallback" }> {
  const count = Math.max(1, Math.min(100, Math.floor(n)));
  if (!opts.caller) {
    return { personas: ruleBasedPersonas(count, locale, entities, 1), source: "fallback" };
  }

  const batches: number[] = [];
  for (let remaining = count; remaining > 0; remaining -= PERSONA_BATCH_SIZE) {
    batches.push(Math.min(PERSONA_BATCH_SIZE, remaining));
  }

  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  try {
    const batchResults = await mapWithConcurrency(batches, limit, async (batchSize, index) => {
      return askJson<Persona[]>(opts.caller!, {
        system: "You are a customer-persona designer. Return strictly valid JSON matching the requested array shape.",
        prompt: personasPrompt(batchSize, locale, entities, (opts.language ? hashString(opts.language) : 0) + index * 7919 + batchSize),
        temperature: 0.7,
        retries: 2,
        validate: validatePersonas,
      });
    });

    const personas: Persona[] = [];
    for (const batch of batchResults) {
      for (const persona of batch) {
        if (persona.name && !personas.some((p) => p.name === persona.name)) personas.push(persona);
      }
    }
    if (personas.length === 0) {
      return { personas: ruleBasedPersonas(count, locale, entities, 1), source: "fallback" };
    }
    // Trim to the requested count while preserving diversity order.
    return { personas: personas.slice(0, count), source: "model" };
  } catch {
    return { personas: ruleBasedPersonas(count, locale, entities, 1), source: "fallback" };
  }
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Run the full M2 seed step: load docs -> resolve locale -> extract entities ->
 * generate personas. Returns a {@link SeedResult} describing what was produced.
 */
export async function runSeed(settings: SimulationSettings, opts: SeedOptions = {}): Promise<SeedResult> {
  const docs = settings.docs ?? [];
  const docText = opts.docText ?? (await loadSeedDocs(docs, opts.workspace));

  // Count every model chat attempt so the caller can report real usage.
  let modelCalls = 0;
  const countingCaller: ModelCaller | undefined = opts.caller
    ? {
        chat: (request) => {
          modelCalls += 1;
          return opts.caller!.chat(request);
        },
      }
    : undefined;
  const countedOpts: SeedOptions = { ...opts, caller: countingCaller };

  const { locale, source } = await resolveLocale(settings.location, settings.brief, docs, {
    ...countedOpts,
    docText,
  });
  const { entities } = await extractEntities(settings.brief, docs, { ...countedOpts, docText }, locale.currency);
  const agentCount = settings.agents ?? 12;
  const { personas } = await generatePersonas(agentCount, locale, entities, countedOpts);

  return {
    locale,
    entities,
    personas,
    localeSource: source,
    modelCalls,
  };
}
