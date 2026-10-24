/**
 * Model switcher menu (BUILD_SPEC §5.9 S15).
 *
 * Items: {product} 2.0 Max, {product} 2.0, {product} 2.0 Lite, {product} Flex.
 * Selecting persists immediately via the caller's `onSelect`.
 */
import { useState, useRef, useEffect } from "react";
import { Check, ChevronDown, Gem, Zap, Feather, SlidersHorizontal } from "lucide-react";
import type { AgentMode, ModelMenuItem, FlexModel } from "./types";

const ITEMS: ModelMenuItem[] = [
  {
    mode: "max",
    title: "{product} 2.0 Max",
    titleAr: "{product} 2.0 Max",
    description: "High-performance agent designed for complex tasks.",
    descriptionAr: "وكيل عالي الأداء مصمم للمهام المعقدة.",
  },
  {
    mode: "standard",
    title: "{product} 2.0",
    titleAr: "{product} 2.0",
    description: "Versatile agent capable of most tasks.",
    descriptionAr: "وكيل متعدد الاستخدامات قادر على معظم المهام.",
  },
  {
    mode: "lite",
    title: "{product} 2.0 Lite",
    titleAr: "{product} 2.0 Lite",
    description: "A lightweight agent for everyday tasks.",
    descriptionAr: "وكيل خفيف للمهام اليومية.",
  },
  {
    mode: "flex",
    title: "{product} Flex",
    titleAr: "{product} Flex",
    description: "Bring your own model API key to power {product}.",
    descriptionAr: "استخدم مفتاح API الخاص بنموذجك لتشغيل {product}.",
  },
];

function interpolateProduct(template: string, product: string): string {
  return template.replace(/\{product\}/g, product);
}

export interface ModelMenuProps {
  currentMode: AgentMode;
  product: string;
  locale: "en" | "ar";
  flexModels?: FlexModel[];
  currentFlexModel?: FlexModel | null;
  onSelect: (mode: AgentMode, flexModel?: FlexModel) => void;
}

export function ModelMenu({
  currentMode,
  product,
  locale,
  flexModels,
  currentFlexModel,
  onSelect,
}: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const currentItem = ITEMS.find((i) => i.mode === currentMode) ?? ITEMS[1];
  const triggerLabel = interpolateProduct(
    locale === "ar" ? currentItem.titleAr : currentItem.title,
    product,
  );
  const flexSuffix =
    currentMode === "flex" && currentFlexModel ? ` · ${currentFlexModel.name}` : "";

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-1 rounded-control px-2 text-sm font-medium text-text-primary hover:bg-fill-hover"
      >
        {triggerLabel}
        {flexSuffix}
        <ChevronDown className="size-3.5 text-text-tertiary" aria-hidden />
      </button>

      {open && (
        <div
          className="absolute z-50 mt-1 w-[366px] rounded-card bg-bg-menu p-1 shadow-menu"
          style={{ backdropFilter: "blur(40px)" }}
        >
          {ITEMS.map((item) => {
            const selected = item.mode === currentMode;
            const title = interpolateProduct(locale === "ar" ? item.titleAr : item.title, product);
            const desc = interpolateProduct(locale === "ar" ? item.descriptionAr : item.description, product);
            return (
              <button
                key={item.mode}
                type="button"
                onClick={() => {
                  onSelect(item.mode);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-row p-3 text-start hover:bg-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-dark"
              >
                <ModelIcon mode={item.mode} />
                <div className="flex-1">
                  <div className="text-sm text-text-primary">{title}</div>
                  <div className="max-w-[220px] text-xs text-text-tertiary">{desc}</div>
                </div>
                {selected && <Check className="size-4 text-text-primary" aria-hidden />}
              </button>
            );
          })}

          {currentMode === "flex" && flexModels && flexModels.length > 0 && (
            <div className="border-t border-border-main p-2">
              <div className="mb-1 text-xs text-text-tertiary">
                {locale === "ar" ? "النماذج المتاحة" : "Available models"}
              </div>
              {flexModels.map((m) => (
                <button
                  key={m.flexCredentialUid}
                  type="button"
                  onClick={() => {
                    onSelect("flex", m);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded-row px-2 py-1.5 text-start hover:bg-fill-hover"
                >
                  <span className="text-sm text-text-primary">{m.name}</span>
                  {currentFlexModel?.flexCredentialUid === m.flexCredentialUid && (
                    <Check className="size-4 text-text-primary" aria-hidden />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelIcon({ mode }: { mode: AgentMode }) {
  const cn = "size-4 text-text-secondary";
  if (mode === "max") return <Zap className={cn} aria-hidden />;
  if (mode === "lite") return <Feather className={cn} aria-hidden />;
  if (mode === "flex") return <SlidersHorizontal className={cn} aria-hidden />;
  return <Gem className={cn} aria-hidden />;
}
