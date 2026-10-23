/**
 * Locale resolution for the MiroFish seed step.
 *
 * The location is a *user setting*: any country/city/region worldwide. When it
 * is set we keep it authoritative and only ask the model to fill the derived
 * facts (currency, languages, dialect, income bands, demographics). When it is
 * not set we infer the whole profile from the brief/docs. When the model is
 * unavailable we degrade to a neutral global profile rather than guessing a
 * country or currency.
 */
import { askJson, asNumber, asRecord, asString, asStringArray } from "./model.js";
import { loadSeedDocs } from "./seed.js";
import type { IncomeBand, LocaleProfile, LocationSetting } from "./types.js";

export interface ResolveLocaleOptions {
  caller?: import("./model.js").ModelCaller;
  /** Workspace used to resolve relative document paths. */
  workspace?: string;
  /** Pre-loaded document text; skips path loading when provided. */
  docText?: string;
  /** Output language preference forwarded to the model. */
  language?: string;
}

const NEUTRAL_CURRENCY = "USD";

/** Validate + normalize a model-produced locale object. Throws when unusable. */
export function validateLocaleProfile(value: unknown): LocaleProfile {
  const rec = asRecord(value);
  if (!rec) throw new Error("locale: expected a JSON object");

  const countryRaw = asString(rec.country ?? rec.country_name ?? rec.nation);
  const cityRaw = asString(rec.city);
  const regionRaw = asString(rec.region ?? rec.state ?? rec.province);
  const currencyRaw = asString(rec.currency ?? rec.currency_code ?? rec.currencyCode);
  const dialectRaw = asString(rec.dialect ?? rec.language_variant);
  const timezoneRaw = asString(rec.timezone ?? rec.time_zone);

  const languages = asStringArray(rec.languages ?? rec.language, 12);
  const demographics = asStringArray(rec.demographics ?? rec.demographic_notes ?? rec.notes, 20);

  const bandsValue: unknown = rec.incomeBands ?? rec.income_bands;
  const rawBands = Array.isArray(bandsValue) ? bandsValue : [];
  const currency = (currencyRaw ?? NEUTRAL_CURRENCY).toUpperCase();
  const incomeBands: IncomeBand[] = [];
  for (const band of rawBands) {
    const bandRec = asRecord(band);
    if (!bandRec) continue;
    const label = asString(bandRec.label ?? bandRec.name ?? bandRec.band);
    const min = asNumber(bandRec.min ?? bandRec.from ?? bandRec.lower);
    const max = asNumber(bandRec.max ?? bandRec.to ?? bandRec.upper);
    if (!label || min === null) continue;
    incomeBands.push({
      label,
      min,
      ...(max !== null ? { max } : {}),
      currency: asString(bandRec.currency) ?? currency,
    });
  }

  return {
    country: countryRaw ?? "Global",
    ...(cityRaw ? { city: cityRaw } : {}),
    ...(regionRaw ? { region: regionRaw } : {}),
    currency,
    languages: languages.length > 0 ? languages : ["en"],
    ...(dialectRaw ? { dialect: dialectRaw } : {}),
    incomeBands,
    demographics,
    ...(timezoneRaw ? { timezone: timezoneRaw } : {}),
  };
}

/** Neutral, locale-agnostic fallback used only when the model cannot answer. */
export function ruleBasedLocale(location?: LocationSetting | null): LocaleProfile {
  // A city-only selection is still a real market: the country falls back to the
  // city (then the region) rather than to "Global", so the personas the run
  // derives keep the place the user actually named.
  const country =
    location?.country?.trim() || location?.city?.trim() || location?.region?.trim() || "Global";
  return {
    country,
    ...(location?.city?.trim() ? { city: location.city.trim() } : {}),
    ...(location?.region?.trim() ? { region: location.region.trim() } : {}),
    currency: NEUTRAL_CURRENCY,
    languages: ["en"],
    incomeBands: [
      { label: "low", min: 0, max: 1500, currency: NEUTRAL_CURRENCY },
      { label: "middle", min: 1500, max: 4000, currency: NEUTRAL_CURRENCY },
      { label: "affluent", min: 4000, currency: NEUTRAL_CURRENCY },
    ],
    demographics: [],
    notes: "neutral global fallback (model unavailable)",
  };
}

function localePrompt(opts: { location?: LocationSetting | null; context: string; language?: string }): string {
  const place = opts.location
    ? [opts.location.country, opts.location.region, opts.location.city].filter((p) => p && p.trim()).join(", ")
    : "";
  return [
    "You are a market-research analyst building a customer-simulation locale profile.",
    "Resolve the geographic and economic context for the product brief below so that simulated customers feel locally real.",
    "",
    place
      ? `The user explicitly selected this location: ${place}. Treat it as authoritative: keep the country/city/region exactly as given and do NOT substitute a different place.`
      : "No location was selected. Infer the most plausible target market from the brief and documents, choosing a single primary country/city/region.",
    "",
    "Return ONE JSON object with this exact shape:",
    "{",
    '  "country": "ISO country name",',
    '  "city": "primary city or empty string",',
    '  "region": "state/province/region or empty string",',
    '  "currency": "ISO 4217 currency code for the market you resolved",',
    '  "languages": ["primary language tags in order of prominence"],',
    '  "dialect": "dialect/register note or empty string",',
    '  "incomeBands": [{"label":"low|middle|affluent","min":0,"max":1500,"currency":"ISO"}, ...],',
    '  "demographics": ["short demographic/market notes"],',
    '  "timezone": "IANA timezone or empty string"',
    "}",
    "",
    "Rules:",
    "- Income bands MUST be monthly household income expressed in the local currency (the currency you return).",
    "- Languages must reflect what real people in that place actually speak and read, ordered by prominence.",
    "- Be specific and realistic; never invent a country when the brief is ambiguous — pick the single best fit.",
    "- Respond with JSON only, no prose, no code fence.",
    "",
    `Output language preference: ${opts.language && opts.language !== "auto" ? opts.language : "match the locale's primary language for labels"}`,
    "",
    "--- BRIEF ---",
    opts.context || "(no brief provided)",
  ].join("\n");
}

/**
 * Resolve a {@link LocaleProfile} from the user location, brief and docs.
 *
 * User location wins; otherwise the profile is inferred via the model; if the
 * model is missing or fails, a neutral global profile is returned.
 */
export async function resolveLocale(
  location: LocationSetting | null | undefined,
  brief: string,
  docs?: string[],
  opts: ResolveLocaleOptions = {},
): Promise<{ locale: LocaleProfile; source: "user" | "inferred" | "fallback" }> {
  let docText = opts.docText ?? "";
  if (!docText && docs && docs.length > 0) {
    try {
      docText = await loadSeedDocs(docs, opts.workspace);
    } catch {
      docText = "";
    }
  }
  const context = [brief.trim(), docText.trim()].filter((s) => s.length > 0).join("\n\n--- DOCUMENTS ---\n\n");
  const userProvided = Boolean(location && (location.country?.trim() || location.city?.trim() || location.region?.trim()));

  if (opts.caller) {
    try {
      const locale = await askJson<LocaleProfile>(opts.caller, {
        role: "locale",
        system:
          "You are a precise market-research analyst. You return strictly valid JSON that matches the requested shape.",
        prompt: localePrompt({ location, context, language: opts.language }),
        temperature: 0.2,
        validate: validateLocaleProfile,
      });
      // The user's explicit selection is authoritative and must survive validation.
      if (userProvided) {
        if (location!.country?.trim()) locale.country = location!.country.trim();
        if (location!.city?.trim()) locale.city = location!.city.trim();
        if (location!.region?.trim()) locale.region = location!.region.trim();
      }
      return { locale, source: userProvided ? "user" : "inferred" };
    } catch {
      /* fall through to the neutral profile */
    }
  }

  return { locale: ruleBasedLocale(location), source: "fallback" };
}
