/**
 * Shared types for the MiroFish swarm-simulation seed pipeline (M2).
 *
 * Everything here is provider-neutral: the seed step only knows about a
 * brief, optional documents, an optional user-selected location, and the
 * locale/entities/personas it derives from them. No country, currency or
 * language is hard-coded outside of test fixtures.
 */

/** A location the user explicitly selected. Any country/city/region worldwide. */
export interface LocationSetting {
  country?: string;
  city?: string;
  region?: string;
}

/** One income band expressed in the locale's own currency. */
export interface IncomeBand {
  /** Human label, e.g. "low", "middle", "affluent" (localized is fine). */
  label: string;
  /** Lower bound in local currency (monthly, per household unless noted). */
  min: number;
  /** Upper bound in local currency; omit for the open-ended top band. */
  max?: number;
  /** ISO 4217 currency code the bounds are expressed in. */
  currency: string;
}

/** Resolved, locale-aware context used to build personas and prompts. */
export interface LocaleProfile {
  country: string;
  city?: string;
  region?: string;
  /** ISO 4217 currency code (e.g. "QAR", "GBP", "USD"). */
  currency: string;
  /** Languages in order of prominence (BCP-47 tags, e.g. ["ar-QA", "en"]). */
  languages: string[];
  /** Dialect / register note, e.g. "Gulf Arabic", "Egyptian Arabic". */
  dialect?: string;
  /** Income bands expressed in the local currency. */
  incomeBands: IncomeBand[];
  /** Short demographic / market notes that shape persona diversity. */
  demographics: string[];
  /** IANA timezone name when known. */
  timezone?: string;
  /** Free-form note about how the locale was resolved. */
  notes?: string;
}

/** The variable the user wants to stress, e.g. a price change. */
export interface SimulationVariable {
  name: string;
  baseline: string | number;
  scenario: string | number;
  /** Optional unit, e.g. "QAR / month". */
  unit?: string;
}

/** Full simulation settings accepted by the tool/HTTP layer. */
export interface SimulationSettings {
  brief: string;
  /** Optional uploaded document paths (text/markdown/pdf-text/office). */
  docs?: string[];
  /** Optional user-selected location; inferred from brief/docs when absent. */
  location?: LocationSetting;
  /** Number of simulated agents. Default 12, max 20 unless explicitly raised. */
  agents?: number;
  /** Number of simulation rounds. Default 3. */
  rounds?: number;
  /** Optional variable to vary between rounds (e.g. price 1200 -> 1450). */
  variable?: SimulationVariable;
  /** Output language: "auto" (follow locale/user) or a BCP-47 tag. */
  language?: string;
  /** Optional RNG seed for reproducible runs. */
  seed?: number;
}

/** A named thing extracted from the brief/docs (product, competitor, ...). */
export interface EntityRef {
  name: string;
  kind?: string;
  detail?: string;
}

/** A price point extracted from the brief/docs. */
export interface PricePoint {
  product?: string;
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
  /** Billing period, e.g. "month", "year", "one-time". */
  period?: string;
}

/** The structured facts the seed step pulls out of the brief + docs. */
export interface EntitySet {
  products: EntityRef[];
  prices: PricePoint[];
  competitors: EntityRef[];
  audiences: string[];
  variable?: SimulationVariable;
  /** One-paragraph neutral summary of the target product/market. */
  summary?: string;
}

/** One simulated customer/agent persona. */
export interface Persona {
  id: string;
  name: string;
  age: number;
  gender: string;
  /** Nationality/cultural background, realistic for the locale. */
  nationality: string;
  country: string;
  city?: string;
  /** Income band label from the locale profile. */
  incomeBand: string;
  /** Representative monthly income in local currency. */
  incomeAmount: number;
  currency: string;
  /** Household composition, e.g. "single", "family of four". */
  household: string;
  occupation: string;
  /** Primary channel (e.g. "Instagram", "X", "word of mouth"). */
  channel: string;
  /** Baseline attitude toward the product category, e.g. "skeptical". */
  attitude: string;
  /** Everyday habits that shape how they discover and buy. */
  habits: string[];
  /** Diet / consumption preferences when relevant. */
  diet?: string;
  /** Language the persona primarily uses. */
  language: string;
  dialect?: string;
  /** Short first-person bio used as the agent's system prompt seed. */
  bio: string;
}

/** The complete output of the M2 seed step. */
export interface SeedResult {
  locale: LocaleProfile;
  entities: EntitySet;
  personas: Persona[];
  /** How the locale was resolved: user setting, model inference, or fallback. */
  localeSource: "user" | "inferred" | "fallback";
  /** Number of model calls actually made. */
  modelCalls: number;
}
