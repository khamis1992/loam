/**
 * Model switcher menu (chat composer, BUILD_SPEC §5.9 S15).
 *
 * The fictional "{product} 2.0 Max/Lite/Flex" tier rows were removed — the
 * product ships no models of its own. The menu is the shared RealModelPicker:
 * every reachable model (Ollama, cloud providers, freellmapi, the registry's
 * native Anthropic/Gemini adapters) plus the Flex BYOK form. onSelect keeps
 * the tier contract for persistence ('standard' local / 'flex' cloud).
 */
import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import clsx from "clsx";
import type { AgentMode, FlexModel } from "./types";
import { RealModelPicker, useModelDirectory } from "./RealModelPicker";

export interface ModelMenuProps {
  currentMode: AgentMode;
  product: string;
  locale: "en" | "ar";
  /** Legacy Grok-style saved Flex credentials (kept for type compat; the
   *  picker's own Flex form is the active BYOK surface now). */
  flexModels?: FlexModel[];
  currentFlexModel?: FlexModel | null;
  onSelect: (mode: AgentMode, flexModel?: FlexModel) => void;
}

export function ModelMenu({
  currentMode,
  locale,
  currentFlexModel,
  onSelect,
}: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { activeId } = useModelDirectory();

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const fallback =
    currentMode === "flex" && currentFlexModel
      ? currentFlexModel.name
      : locale === "ar"
        ? "النموذج"
        : "Model";

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-1 rounded-control px-2 text-sm font-medium text-text-primary hover:bg-fill-hover"
      >
        {activeId ? (
          <span className="max-w-[180px] truncate" title={activeId}>{activeId}</span>
        ) : (
          fallback
        )}
        <ChevronDown className={clsx("size-3.5 text-text-tertiary transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open && (
        <div
          className="absolute z-50 mt-1 w-[366px] rounded-card bg-bg-menu p-1 shadow-menu"
          style={{ backdropFilter: "blur(40px)" }}
        >
          <RealModelPicker
            onTier={(tier) => onSelect(tier)}
            forceFlexForm={currentMode === "flex"}
          />
        </div>
      )}
    </div>
  );
}
