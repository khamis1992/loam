/**
 * Folder-access approval card (BUILD_SPEC §6.7 / §5.4).
 *
 * Strings match §5.8 exactly. The card is rendered inside the chat event list.
 */
import { Folder, Lock } from "lucide-react";
import type { FolderAccessRequestEvent } from "./types";

export interface ApprovalCardProps {
  request: FolderAccessRequestEvent;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onRespond: (decision: "deny" | "once" | "always") => void;
}

export function ApprovalCard({ request, t, onRespond }: ApprovalCardProps) {
  return (
    <div
      role="group"
      aria-label={t("Folder access request")}
      className="max-w-[560px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu p-4 shadow-card"
    >
      <div className="flex items-center gap-2 text-title-base text-text-primary">
        <Lock className="size-4" aria-hidden />
        {t("Folder access request")}
      </div>
      <div className="mt-1 flex items-center gap-2 text-sm text-text-secondary">
        <Folder className="size-4" aria-hidden />
        <code className="break-all text-xs">{request.path}</code>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => onRespond("deny")}
          className="h-row-sm rounded-control border border-border-main bg-transparent px-3 text-sm font-medium text-text-primary hover:bg-fill-hover"
        >
          {t("Deny")}
        </button>
        <button
          type="button"
          onClick={() => onRespond("once")}
          className="h-row-sm rounded-control bg-bg-menu px-3 text-sm font-medium text-text-primary shadow-card hover:bg-fill-hover"
        >
          {t("Allow once")}
        </button>
        <button
          type="button"
          onClick={() => onRespond("always")}
          className="h-row-sm rounded-control bg-text-primary px-3 text-sm font-medium text-text-onblack hover:opacity-90"
        >
          {t("Always allow in {product}")}
        </button>
      </div>
    </div>
  );
}
