/**
 * Plan-approval card (D4).
 *
 * Renders a Loam `suggest_plan` request arriving as a `planApprovalRequested`
 * chat event: the plan summary, its steps and the files it will edit, with
 * Approve / Edit / Reject. Edit turns the steps into a textarea so the user can
 * revise the plan before approving it; the revised plan is sent back on the
 * `resolve_plan_approval` socket action.
 */
import { useState } from "react";
import { ListChecks, Pencil, ShieldCheck, X, Check } from "lucide-react";
import { t } from "@/i18n/t";
import type { PlanApprovalRequested } from "./types";

export type PlanApprovalDecision = "approve" | "reject" | "edit";

export interface PlanApprovalCardProps {
  request: PlanApprovalRequested;
  onRespond: (decision: PlanApprovalDecision, plan?: { summary: string; steps: string[]; files_to_edit: string[] }) => void;
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((s) => s.replace(/^\s*-\s*/, "").trim())
    .filter((s) => s.length > 0);
}

export function PlanApprovalCard({ request, onRespond }: PlanApprovalCardProps) {
  const [editing, setEditing] = useState(false);
  const [stepsDraft, setStepsDraft] = useState(() => request.steps.join("\n"));
  const [decided, setDecided] = useState<"approved" | "rejected" | "edited" | undefined>(undefined);

  const respond = (decision: PlanApprovalDecision, plan?: { summary: string; steps: string[]; files_to_edit: string[] }) => {
    if (decided) return;
    if (decision === "edit" && plan) {
      // Submit the revised plan and mark it approved in one step.
      setDecided("edited");
      onRespond("edit", plan);
      return;
    }
    setDecided(decision === "approve" ? "approved" : "rejected");
    onRespond(decision);
  };

  if (decided) {
    return (
      <div role="group" aria-label={t("Plan approval")} className="max-w-[560px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu p-4 shadow-card">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <ShieldCheck className={`size-4 ${decided !== "rejected" ? "text-func-success" : ""}`} aria-hidden />
          {decided === "rejected" ? t("Plan rejected") : decided === "edited" ? t("Plan updated") : t("Plan approved")}
        </div>
      </div>
    );
  }

  const btnBase = "h-row-sm rounded-control px-3 text-sm font-medium transition-colors";

  return (
    <div role="group" aria-label={t("Plan approval")} className="max-w-[560px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu shadow-card">
      <div className="flex items-center gap-2 border-b border-border-main px-4 py-3 text-sm font-medium text-text-primary">
        <ShieldCheck className="size-5" aria-hidden />
        {t("Plan approval")}
        {request.trivial && (
          <span className="ml-auto rounded-full bg-fill-tsp px-2 py-0.5 text-[11px] text-text-tertiary">{t("Trivial")}</span>
        )}
      </div>
      <div className="space-y-3 p-4">
        {request.summary && (
          <p className="text-sm text-text-secondary">{request.summary}</p>
        )}
        {request.steps.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
              <ListChecks className="size-3.5" aria-hidden />
              {t("Steps")}
            </div>
            {editing ? (
              <textarea
                aria-label={t("Steps")}
                value={stepsDraft}
                onChange={(e) => setStepsDraft(e.target.value)}
                rows={Math.max(4, request.steps.length + 1)}
                className="w-full rounded-control border border-border-main bg-fill-tsp-white-light p-3 font-mono text-xs text-text-primary outline-none focus:border-border-dark"
              />
            ) : (
              <ol className="list-decimal space-y-1 ps-5 text-sm text-text-primary">
                {request.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
          </div>
        )}
        {request.filesToEdit.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {request.filesToEdit.map((f) => (
              <code key={f} className="rounded-control bg-fill-tsp px-1.5 py-0.5 text-[11px] text-text-secondary">
                {f}
              </code>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border-main px-4 py-3">
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className={`${btnBase} border border-border-main bg-transparent text-text-primary hover:bg-fill-hover`}
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              onClick={() =>
                respond("edit", {
                  summary: request.summary,
                  steps: splitLines(stepsDraft),
                  files_to_edit: request.filesToEdit,
                })
              }
              className={`${btnBase} bg-text-primary text-text-onblack hover:opacity-90`}
            >
              {t("Save and approve")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => respond("reject")}
              className={`${btnBase} border border-border-main bg-transparent text-text-primary hover:bg-fill-hover`}
            >
              <X className="me-1 inline size-3.5" aria-hidden />
              {t("Reject")}
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={`${btnBase} border border-border-main bg-transparent text-text-primary hover:bg-fill-hover`}
            >
              <Pencil className="me-1 inline size-3.5" aria-hidden />
              {t("Edit")}
            </button>
            <button
              type="button"
              onClick={() => respond("approve")}
              className={`${btnBase} bg-text-primary text-text-onblack hover:opacity-90`}
            >
              <Check className="me-1 inline size-3.5" aria-hidden />
              {t("Approve")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
