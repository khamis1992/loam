/**
 * Max effort control panel (BUILD_SPEC §5.9 S16).
 *
 * Segmented control: Medium / High / Extra / Ultra. Default High.
 */
import type { EffortLevel } from "./types";

const LEVELS: EffortLevel[] = ["medium", "high", "extra", "ultra"];

const LABELS: Record<EffortLevel, { en: string; ar: string }> = {
  medium: { en: "Medium", ar: "متوسط" },
  high: { en: "High", ar: "عالٍ" },
  extra: { en: "Extra", ar: "إضافي" },
  ultra: { en: "Ultra", ar: "فائق" },
};

export interface EffortPanelProps {
  effort: EffortLevel;
  locale: "en" | "ar";
  onChange: (effort: EffortLevel) => void;
}

export function EffortPanel({ effort, locale, onChange }: EffortPanelProps) {
  return (
    <div className="w-[260px] rounded-card bg-bg-menu p-3 shadow-menu">
      <div className="relative h-[62px] overflow-hidden rounded-control bg-fill-tsp-white-light">
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-text-tertiary">
            Effort
          </span>
        </div>
      </div>

      <div className="mt-2 flex rounded-control border border-border-main bg-fill-tsp-gray-main p-px">
        {LEVELS.map((level) => {
          const active = level === effort;
          const label = LABELS[level][locale];
          return (
            <button
              key={level}
              type="button"
              onClick={() => onChange(level)}
              className={`flex-1 rounded-[6px] py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "bg-fill-white text-text-primary shadow-sm"
                  : "text-text-tertiary hover:text-text-secondary"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
