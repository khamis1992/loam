/**
 * Nutrio meal-subscription fixtures for the MiroFish swarm e2e gate.
 *
 * The brief deliberately names Nutrio in English and Arabic and the new keto
 * plan so the report-stage assertions have real text to match. The location
 * varies across fixtures so locale inference and derivation are exercised.
 */
import type { SimulationSettings } from "../../types.js";

export const NUTRIO_BRAND_EN = "Nutrio";
export const NUTRIO_BRAND_AR = "نتريو";

export const NUTRIO_BRIEF = [
  `${NUTRIO_BRAND_EN} (also written ${NUTRIO_BRAND_AR}) is a meal-subscription service.`,
  "We are raising the monthly price from QAR 1200 to QAR 1450 and adding a new keto plan.",
  "Simulate how buyers react to the new keto plan at the new price.",
].join(" ");

export interface NutrioBrief {
  label: string;
  settings: SimulationSettings;
}

function baseSettings(location: SimulationSettings["location"]): SimulationSettings {
  return {
    brief: NUTRIO_BRIEF,
    docs: [],
    location,
    agents: 12,
    rounds: 3,
    variable: { name: "price", baseline: 1200, scenario: 1450, unit: "QAR" },
    language: "auto",
    seed: 20261022,
  };
}

export const NUTRIO_DOHA: NutrioBrief = {
  label: "nutrio-doha",
  settings: baseSettings({ country: "Qatar", city: "Doha", region: "Doha Governorate" }),
};

export const NUTRIO_LONDON: NutrioBrief = {
  label: "nutrio-london",
  settings: baseSettings({ country: "United Kingdom", city: "London", region: "England" }),
};

/** No location set: the pipeline must infer Qatar/QAR from the Nutrio brief. */
export const NUTRIO_NO_LOCATION: NutrioBrief = {
  label: "nutrio-inferred",
  settings: baseSettings(null),
};

/** Same brief with a different active price (scenario value). */
export function withPrice(brief: NutrioBrief, scenario: number): NutrioBrief {
  const variable = brief.settings.variable;
  return {
    label: `${brief.label}-price-${scenario}`,
    settings: {
      ...brief.settings,
      variable: variable ? { ...variable, scenario } : null,
    },
  };
}
