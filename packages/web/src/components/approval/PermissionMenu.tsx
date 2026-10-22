/**
 * Local permission mode menu (BUILD_SPEC §5.9 S17).
 *
 * Three rows: Ask for approval / Approve for me / Full access.
 * The selected row shows a check. Dangerous rows use error colour.
 */
import { useState, useRef, useEffect } from "react";
import { Hand, ShieldCheck, ShieldAlert, Check, ChevronDown } from "lucide-react";
import type { LocalPermissionMode, PermissionModeInfo } from "./types";

const MODES: LocalPermissionMode[] = ["ask_for_approval", "approve_for_me", "full_access"];

const MODE_INFO: Record<LocalPermissionMode, PermissionModeInfo> = {
  ask_for_approval: {
    mode: "ask_for_approval",
    title: "Ask for approval",
    titleAr: "اطلب الموافقة",
    description: "Always asks for approval before local actions.",
    descriptionAr: "يطلب الموافقة دائمًا قبل الإجراءات المحلية.",
    icon: "hand",
    isDangerous: false,
  },
  approve_for_me: {
    mode: "approve_for_me",
    title: "Approve for me",
    titleAr: "الموافقة عني",
    description: "Reviews and auto-approves safe local actions.",
    descriptionAr: "تراجع الموافقة التلقائية على الإجراءات المحلية الآمنة.",
    icon: "shield-check",
    isDangerous: false,
  },
  full_access: {
    mode: "full_access",
    title: "Full access",
    titleAr: "وصول كامل",
    description: "Runs local actions without approval.",
    descriptionAr: "تشغيل الإجراءات المحلية دون موافقة.",
    icon: "shield-alert",
    isDangerous: true,
  },
};

export interface PermissionMenuProps {
  currentMode: LocalPermissionMode;
  locale: "en" | "ar";
  narrow?: boolean;
  onChange: (mode: LocalPermissionMode) => void;
}

export function PermissionMenu({ currentMode, locale, narrow, onChange }: PermissionMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const info = MODE_INFO[currentMode];

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const label = locale === "ar" ? info.titleAr : info.title;
  const titleClass = info.isDangerous ? "text-function-error" : "text-text-primary";

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-1.5 rounded-full border border-border-main px-2 text-xs font-medium text-text-secondary hover:bg-fill-hover"
      >
        <ModeIcon icon={info.icon} className={titleClass} />
        {!narrow && <span className={titleClass}>{label}</span>}
        <ChevronDown className="size-3 text-text-tertiary" aria-hidden />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 min-w-[240px] max-w-[320px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu p-1 shadow-menu">
          {MODES.map((mode) => {
            const m = MODE_INFO[mode];
            const selected = mode === currentMode;
            const rowTitle = locale === "ar" ? m.titleAr : m.title;
            const rowDesc = locale === "ar" ? m.descriptionAr : m.description;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  onChange(mode);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2 rounded-row p-2 text-start hover:bg-fill-hover"
              >
                <ModeIcon
                  icon={m.icon}
                  className={m.isDangerous ? "mt-0.5 text-function-error" : "mt-0.5 text-text-primary"}
                />
                <div className="flex-1">
                  <div className={m.isDangerous ? "text-sm text-function-error" : "text-sm text-text-primary"}>
                    {rowTitle}
                  </div>
                  <div className="text-xs text-text-tertiary">{rowDesc}</div>
                </div>
                {selected && <Check className="size-4 text-text-primary" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModeIcon({
  icon,
  className,
}: {
  icon: PermissionModeInfo["icon"];
  className?: string;
}) {
  const cn = `size-4 ${className ?? ""}`;
  if (icon === "hand") return <Hand className={cn} aria-hidden />;
  if (icon === "shield-check") return <ShieldCheck className={cn} aria-hidden />;
  return <ShieldAlert className={cn} aria-hidden />;
}
